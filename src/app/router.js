// Filename: router.js
//
define([
  'jquery',
  'deparam',
  'underscore',
  'backbone',
  'models/city',
  'models/scorecard',
  'collections/city_buildings',
  'views/map/map',
  'views/map/address_search_autocomplete',
  'views/map/year_control',
  'views/layout/activity_indicator',
  'views/layout/building_counts',
  'views/layout/compare_bar',
  'views/scorecards/building_scorecard',
  'views/scorecards/city_scorecard',
  'views/layout/button',
], function($, deparam, _, Backbone, CityModel, ScorecardModel,
            CityBuildings, MapView, AddressSearchView,
            YearControlView, ActivityIndicator,
            BuildingCounts, CompareBar, BuildingScorecard, CityScorecard, Button) {

  var RouterState = Backbone.Model.extend({
    queryFields: [
      'filters', 'categories', 'layer',
      'metrics', 'sort', 'order', 'lat',
      'lng', 'zoom', 'building', 'report_active', 'city_report_active', 'proptype'
    ],

    defaults: {
      metrics: [],
      categories: {},
      filters: [],
      selected_buildings: [],
      scorecard: new ScorecardModel()
    },

    toQuery: function () {
      var query, attributes = this.pick(this.queryFields);
      query = $.param(this.mapAttributesToParams(attributes));
      return '?' + query;
    },

    mapAttributesToParams: function(attributes) {
      if (attributes.hasOwnProperty('report_active') && !attributes.report_active) {
        delete attributes.report_active;
      }

      if (attributes.hasOwnProperty('city_report_active') && !attributes.city_report_active) {
        delete attributes.city_report_active;
      }

      if (attributes.hasOwnProperty('building') && _.isNull(attributes.building))  {
        delete attributes.building;
      }

      if (attributes.hasOwnProperty('proptype') && _.isNull(attributes.proptype))  {
        delete attributes.proptype;
      }

      return attributes;
    },

    mapParamsToState: function(params) {
      if (params.hasOwnProperty('report_active') && !_.isBoolean(params.report_active)) {
        params.report_active = (params.report_active === 'true');
      }

      if (params.hasOwnProperty('city_report_active') && !_.isBoolean(params.city_report_active)) {
        params.city_report_active = (params.city_report_active === 'true');
      }

      return params;
    },

    toUrl: function (){
      var path;
      if (this.get('year')) {
        path = "/" + this.get('url_name') + "/" + this.get('year') + this.toQuery();
      } else {
        path = "/" + this.get('url_name') + this.toQuery();
      }
      return path;
    },

    asBuildings: function () {
      return new CityBuildings(null, this.pick('tableName', 'cartoDbUser'));
    }
  });

  var StateBuilder = function(city, year, layer) {
    this.city = city;
    this.year = year;
    this.layer = layer;
  };

  StateBuilder.prototype.toYear = function() {
    var currentYear = this.year;
    var availableYears = _.chain(this.city.years).keys().sort();
    var defaultYear = availableYears.last().value();
    return availableYears.contains(currentYear).value() ? currentYear : defaultYear;
  };

  StateBuilder.prototype.toLayer = function(year) {
    var currentLayer = this.layer;
    var availableLayers = _.chain(this.city.map_layers).pluck('field_name');
    var defaultLayer = this.city.years[year].default_layer;
    return availableLayers.contains(currentLayer).value() ? currentLayer : defaultLayer;
  };

  StateBuilder.prototype.toState = function() {
    var year = this.toYear(),
        layer = this.toLayer(year);

    return {
      year: year,
      cartoDbUser: this.city.cartoDbUser,
      tableName: this.city.years[year].table_name,
      layer: layer,
      sort: layer,
      order: 'desc',
      categories: this.city.categoryDefaults || [],
    }
  };

  var Router = Backbone.Router.extend({
    state: new RouterState({}),
    routes:{
        "": "root",
        ":cityname": "city",
        ":cityname/": "city",
        ":cityname/:year": "year",
        ":cityname/:year/": "year",
        ":cityname/:year?:params": "year",
        ":cityname/:year/?:params": "year",
    },

    initialize: function(){
      var activityIndicator = new ActivityIndicator({state: this.state});
      var yearControlView = new YearControlView({state: this.state});
      var mapView = new MapView({state: this.state});
      var addressSearchView = new AddressSearchView({mapView: mapView, state: this.state});
      var buildingCounts = new BuildingCounts({state: this.state});
      var compareBar = new CompareBar({state: this.state});
      var buildingScorecard = new BuildingScorecard({state: this.state});
      var cityScorecard = new CityScorecard({state: this.state});
      var button = new Button({
        el: '#city-scorcard-toggle',
        onClick: _.bind(this.toggleCityScorecard, this),
        value: 'Citywide Report'
      });

      this.state.on('change', this.onChange, this);
    },

    toggleCityScorecard: function() {
      this.state.set({city_report_active: true});
    },

    onChange: function(){
      var changed = _.keys(this.state.changed);

      if (_.contains(changed, 'url_name')){
        this.onCityChange();
      } else if (_.contains(changed, 'year')) {
        this.onYearChange();
      }

      this.navigate(this.state.toUrl(), {trigger: false, replace: true});
    },

    onCityChange: function(){
      this.state.trigger("showActivityLoader");
      var city = new CityModel(this.state.pick('url_name', 'year'));
      city.fetch({success: _.bind(this.onCitySync, this)});

    },

    onYearChange: function() {
      var year = this.state.get('year');
      var previous = this.state.previous('year');

      // skip undefined since it's most likely the
      // user came to the site w/o a hash state
      if (typeof previous === 'undefined') return;

      this.onCityChange();
    },

    onCitySync: function(city, results) {
      var year = this.state.get('year');
      var layer = this.state.get('layer');
      var newState = new StateBuilder(results, year, layer).toState();
      var defaultMapState = {lat: city.get('center')[0], lng: city.get('center')[1], zoom: city.get('zoom')};
      var mapState = this.state.pick('lat', 'lng', 'zoom');

      _.defaults(mapState, defaultMapState);

      // set this to silent because we need to load buildings
      this.state.set(_.extend({city: city}, newState, mapState));

      var thisYear = this.state.get('year');
      if (!thisYear) console.error('Uh no, there is no year available!');

      this.fetchBuildings(thisYear);
    },

    fetchBuildings: function(year) {
      this.allBuildings = this.state.asBuildings();
      this.listenToOnce(this.allBuildings, 'sync', this.onBuildingsSync, this);

      this.allBuildings.fetch(year);
    },

    onBuildingsSync: function() {
      this.state.set({allbuildings: this.allBuildings});
      this.state.trigger("hideActivityLoader");
    },

    root: function () {
      // TODO: the path should come from config
      this.navigate('/seattle', {trigger: true, replace: true});
    },

    city: function(cityname){
      this.state.set({url_name: cityname});
    },

    year: function(cityname, year, params){
      params = params ? deparam(params) : {};

      this.state.set(_.extend({}, this.state.mapParamsToState(params), {url_name: cityname, year: year}));
    }
  });

  return Router;
});
