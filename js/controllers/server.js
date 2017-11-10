'use strict';

var _ = require('../underscore_ext');
var Rx = require('../rx');
var {reifyErrors, collectResults} = require('./errors');
var {resetZoom, setCohort, fetchDatasets,
	userServers, fetchSamples, fetchColumnData} = require('./common');

var xenaQuery = require('../xenaQuery');
var {allFieldMetadata} = xenaQuery;
var {xenaFieldPaths, updateStrand} = require('../models/fieldSpec');
var identity = x => x;
var {parseBookmark} = require('../bookmark');
var {lift} = require('./shimComposite');

var phenoPat = /^phenotypes?$/i;
function featuresQuery(datasets) {
	var clinicalMatrices = _.filter(datasets, ds => ds.type === 'clinicalMatrix' && ds.dataSubType.match(phenoPat)),
		dsIDs = _.pluck(clinicalMatrices, 'dsID');

	// XXX note that datasetFeatures takes optional args, so don't pass it directly
	// to map.
	return Rx.Observable.zipArray(
				_.map(dsIDs, dsID => reifyErrors(allFieldMetadata(dsID), {dsID}))
			).flatMap(resps =>
				collectResults(resps, features => _.object(dsIDs, features)));
}

function fetchFeatures(serverBus, datasets) {
	serverBus.next(['features', featuresQuery(datasets)]);
}

var columnOpen = (state, id) => _.has(_.get(state, 'columns'), id);

var resetCohort = state => {
	let activeCohorts = _.filter(state.cohort, c => _.contains(state.wizard.cohorts, c.name));
	return _.isEqual(activeCohorts, state.cohort) ? state :
		setCohort(state, activeCohorts);
};

var resetLoadPending = state => _.dissoc(state, 'loadPending');

// Cohort metadata looks like
// {[cohort]: [tag, tag, ...], [cohort]: [tag, tag, ...], ...}
// We want data like
// {[tag]: [cohort, cohort, ...], [tag]: [cohort, cohort, ...], ...}
function invertCohortMeta(meta) {
	return _.fmap(
			_.groupBy(_.flatmap(meta, (tags, cohort) => tags.map(tag => [cohort, tag])),
				([, tag]) => tag),
			cohortTags => cohortTags.map(([cohort]) => cohort));
}

function parseBookmarkCheck(old, bookmark) {
	var state;
	try {
		state = parseBookmark(bookmark);
	} catch (e) {
		console.log('bookmark', e);
	}
	return _.has(state, 'wizardMode') ? state : _.assoc(old, 'stateError', 'bookmark');
}

var controls = {
	// XXX reset loadPending flag
	bookmark: (state, bookmark) => resetLoadPending(lift(parseBookmarkCheck(state, bookmark))),
	inlineState: (state, newState) => resetLoadPending(lift(newState)),
	cohorts: (state, cohorts) => resetCohort(_.assocIn(state, ["wizard", "cohorts"], cohorts)),
	'cohorts-post!': (serverBus, state, newState) => {
		let {cohort} = newState,
			user = userServers(newState);
		fetchSamples(serverBus, user, cohort, newState.allowOverSamples);
		fetchDatasets(serverBus, user, cohort);
	},
	datasets: (state, datasets) => _.assocIn(state, ['wizard', 'datasets'], datasets),
	'datasets-post!': (serverBus, state, newState, datasets) =>
		fetchFeatures(serverBus, datasets),
	features: (state, features) => _.assocIn(state, ['wizard', 'features'], features),
	samples: (state, {samples, over, hasPrivateSamples}) => {
		var newState = resetZoom(_.assoc(state,
					'cohortSamples', samples,
					'samplesOver', over,
					'hasPrivateSamples', hasPrivateSamples)),
			{columnOrder} = newState;
		return _.reduce(
				columnOrder,
				(acc, id) => _.assocIn(acc, ['data', id, 'status'], 'loading'),
				newState);
	},
	'samples-post!': (serverBus, state, newState, {samples}) =>
		_.mapObject(_.get(newState, 'columns', {}), (settings, id) =>
				fetchColumnData(serverBus, samples, id, settings)),
	'strand': (state, id, strand) => {
		// Update composite & all xena fields with strand info.
		var settings = _.assoc(_.getIn(state, ['columns', id]), 'strand', strand);
		return _.assocIn(state, ['columns', id], updateStrand(settings, xenaFieldPaths(settings), strand));
	},
	'strand-post!': (serverBus, state, newState, id) => {
		// Fetch geneProbe data after we have the gene info.
		fetchColumnData(serverBus, state.cohortSamples, id, _.getIn(newState, ['columns', id]));
	},
	// XXX Here we drop the update if the column is no longer open.
	'widget-data': (state, id, data) =>
		columnOpen(state, id) ?
			_.assocIn(state, ["data", id], _.assoc(data, 'status', 'loaded'))
			: state,
	'widget-data-error': (state, id) =>
		columnOpen(state, id) ?
			_.assocIn(state, ["data", id, 'status'], 'error') : state,
	'columnEdit-features': (state, list) => _.assocIn(state, ["columnEdit", 'features'], list),
	'columnEdit-examples': (state, list) => _.assocIn(state, ["columnEdit", 'examples'], list),
	'km-survival-data': (state, survival) => _.assoc(state, 'survival', survival),
	// XXX Here we should be updating application state. Instead we invoke a callback, because
	// chart.js can't handle passed-in state updates.
	'chart-average-data-post!': (serverBus, state, newState, offsets, thunk) => thunk(offsets),
	cohortMeta: (state, meta) => _.assocIn(state, ['wizard', 'cohortMeta'], invertCohortMeta(meta)),
	cohortPreferred: (state, cohortPreferred) => _.assocIn(state, ['wizard', 'cohortPreferred'],
			_.fmap(cohortPreferred,
				preferred => _.fmap(preferred, ({host, dataset}) => JSON.stringify({host, name: dataset})))),
	cohortPhenotype: (state, cohortPhenotype) => _.assocIn(state, ['wizard', 'cohortPhenotype'],
			_.fmap(cohortPhenotype,
				preferred => _.map(preferred, ({host, dataset, feature}) => ({dsID: JSON.stringify({host, name: dataset}), name: feature}))))
};

module.exports = {
	action: (state, [tag, ...args]) => (controls[tag] || identity)(state, ...args),
	postAction: (serverBus, state, newState, [tag, ...args]) => (controls[tag + '-post!'] || identity)(serverBus, state, newState, ...args)
};
