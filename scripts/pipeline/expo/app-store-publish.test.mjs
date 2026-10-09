import test from 'node:test';
import assert from 'node:assert/strict';
import { publishAppStoreVersion } from './app-store-publish.mjs';
import { ascRequest } from './asc-api.mjs';

// App Store Connect is the HTTP boundary; all publication logic stays real.
function store({ processingState = 'VALID', existing = false, state = 'PREPARE_FOR_SUBMISSION', attached = 'exact', phased = true, initialNotes = '', submitFailure = false, phasedMissing = false, phaseState = 'INACTIVE', releaseType = 'AFTER_APPROVAL', reviewType = 'APP_STORE', downloadable, locales = ['en-US'], localeNotes = {}, failLocalization = '', reviewItemErrors } = {}) {
  const writes = [];
  let version = existing ? { type: 'appStoreVersions', id: 'version', attributes: { platform: 'IOS', versionString: '1.2.3', appStoreState: state, releaseType, reviewType, downloadable }, relationships: { build: { data: { type: 'builds', id: attached } } } } : null;
  let submission = null;
  let item = null;
  const localizations = locales.map((locale) => ({ type: 'appStoreVersionLocalizations', id: locale === 'en-US' ? 'en' : locale,
    attributes: { locale, whatsNew: localeNotes[locale] ?? initialNotes } }));
  return { writes, request: async (input) => {
    const url = new URL(input.url);
    const route = url.pathname;
    const method = input.method ?? 'GET';
    if (method !== 'GET') writes.push(input);
    if (route === '/v1/builds') return { data: [{ type: 'builds', id: 'wrong-train', attributes: { version: '42', processingState: 'VALID' }, relationships: { preReleaseVersion: { data: { id: 'old' } } } }, { type: 'builds', id: 'exact', attributes: { version: '42', processingState }, relationships: { preReleaseVersion: { data: { id: 'current' } } } }], included: [{ type: 'preReleaseVersions', id: 'old', attributes: { version: '1.2.2', platform: 'IOS' } }, { type: 'preReleaseVersions', id: 'current', attributes: { version: '1.2.3', platform: 'IOS' } }] };
    if (route === '/v1/apps/app/appStoreVersions') return { data: version ? [version] : [] };
    if (route === '/v1/appStoreVersions' && method === 'POST') { version = { ...input.body.data, id: 'version', attributes: { ...input.body.data.attributes, appStoreState: 'PREPARE_FOR_SUBMISSION' } }; return { data: version }; }
    if (route === '/v1/appStoreVersions/version' && method === 'PATCH') { version.attributes = { ...version.attributes, ...input.body.data.attributes }; return { data: version }; }
    if (route === '/v1/appStoreVersions/version' && method === 'GET') return { data: version };
    if (route === '/v1/appStoreVersions/version/relationships/build') { version.relationships = { build: { data: input.body.data } }; return null; }
    if (route === '/v1/appStoreVersions/version/appStoreVersionLocalizations') {
      const second = url.searchParams.has('cursor');
      return { data: second ? localizations.slice(1) : localizations.slice(0, 1), links: { next: !second && localizations.length > 1 ? `${input.url}?cursor=next` : null } };
    }
    if (route === '/v1/appStoreVersionLocalizations' && method === 'POST') {
      const localization = { ...input.body.data, id: input.body.data.attributes.locale };
      localizations.push(localization); return { data: localization };
    }
    if (route.startsWith('/v1/appStoreVersionLocalizations/') && method === 'PATCH') {
      const localization = localizations.find((row) => route.endsWith(`/${row.id}`));
      if (localization.attributes.locale === failLocalization) { failLocalization = ''; throw new Error('HTTP transport interrupted'); }
      localization.attributes.whatsNew = input.body.data.attributes.whatsNew; return { data: localization };
    }
    if (route === '/v1/appStoreVersions/version/appStoreVersionPhasedRelease') {
      if (phasedMissing) throw Object.assign(new Error('No phased release'), { status: 404 });
      return { data: phased ? { id: 'phased', attributes: { phasedReleaseState: phaseState } } : null };
    }
    if (route === '/v1/appStoreVersionPhasedReleases/phased') { phased = false; return null; }
    if (route === '/v1/appStoreVersionReleaseRequests') { version.attributes.appStoreState = 'PROCESSING_FOR_DISTRIBUTION'; return { data: { id: 'release-request' } }; }
    if (route === '/v1/reviewSubmissions' && method === 'GET') return { data: submission ? [submission] : [] };
    if (route === '/v1/reviewSubmissions' && method === 'POST') { submission = { ...input.body.data, id: 'submission', attributes: { state: 'READY_FOR_REVIEW' } }; return { data: submission }; }
    if (route === '/v1/reviewSubmissions/submission/items') return { data: item ? [item] : [] };
    if (route === '/v1/reviewSubmissionItems') {
      const associatedErrors = Object.fromEntries(localizations.filter((row) => !row.attributes.whatsNew).map((row) => [
        `/v1/appStoreVersionLocalizations/${row.id}`, [{ status: '409', code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED', source: { pointer: '/data/attributes/whatsNew' } }],
      ]));
      if (reviewItemErrors || Object.keys(associatedErrors).length) return { errors: reviewItemErrors ?? [{ status: '409', code: 'STATE_ERROR.ENTITY_STATE_INVALID',
        detail: 'This resource cannot be reviewed, please check associated errors to see why.', meta: { associatedErrors } }] };
      item = { ...input.body.data, id: 'item' }; return { data: item };
    }
    if (route === '/v1/reviewSubmissions/submission' && method === 'PATCH') { if (submitFailure) { submitFailure = false; throw new Error('HTTP transport interrupted'); } submission.attributes.state = 'WAITING_FOR_REVIEW'; version.attributes.appStoreState = 'WAITING_FOR_REVIEW'; return { data: submission }; }
    throw new Error(`Unexpected ASC request: ${method} ${route}`);
  } };
}
const identity = { ascAppId: 'app', appVersion: '1.2.3', buildNumber: '42', whatsNew: 'Bound release notes.' };

function httpStore(t, options) {
  const api = store(options);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await api.request({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return Response.json(response, { status: response?.errors ? 409 : 200 });
  });
  return { ...api, request: (input) => ascRequest({ ...input, token: 'fixture-token' }) };
}

test('every existing paginated localization receives approved notes before review; partial success retries safely', async (t) => {
  const api = httpStore(t, { existing: true, locales: ['en-US', 'fr-FR', 'de-DE'], failLocalization: 'de-DE', phased: false });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /interrupted/);
  assert.equal(api.writes.some((w) => new URL(w.url).pathname === '/v1/reviewSubmissionItems'), false);
  api.writes.length = 0;
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
  assert.deepEqual(api.writes.filter((w) => new URL(w.url).pathname.startsWith('/v1/appStoreVersionLocalizations/'))
    .map((w) => w.body.data), [{ type: 'appStoreVersionLocalizations', id: 'de-DE', attributes: { whatsNew: identity.whatsNew } }]);
  assert.equal(api.writes.some((w) => new URL(w.url).pathname === '/v1/appStoreVersionLocalizations'), false);
  api.writes.length = 0;
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
  assert.deepEqual(api.writes, []);
});

test('existing non-English localizations are updated without inventing an English localization', async (t) => {
  const api = httpStore(t, { locales: ['fr-FR', 'de-DE'], phased: false });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
  assert.equal(api.writes.some((w) => new URL(w.url).pathname === '/v1/appStoreVersionLocalizations'), false);
});

test('immutable notes in a non-default localization are checked before any policy mutation', async (t) => {
  const api = httpStore(t, { existing: true, state: 'WAITING_FOR_REVIEW', releaseType: 'MANUAL', locales: ['en-US', 'fr-FR'],
    initialNotes: identity.whatsNew, localeNotes: { 'fr-FR': 'Different projection' } });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /bound projection/);
  assert.deepEqual(api.writes, []);
});

test('a version with no localizations creates only the requested default before review', async (t) => {
  const api = httpStore(t, { locales: [], phased: false });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
  const creations = api.writes.filter((w) => new URL(w.url).pathname === '/v1/appStoreVersionLocalizations');
  assert.equal(creations.length, 1);
  assert.deepEqual(creations[0].body.data.attributes, { locale: 'en-US', whatsNew: identity.whatsNew });
});

test('review readiness failure preserves associated errors in a typed status at the real HTTP boundary', async (t) => {
  const api = httpStore(t, { reviewItemErrors: [{ status: '409', code: 'STATE_ERROR.ENTITY_STATE_INVALID',
    detail: 'This resource cannot be reviewed, please check associated errors to see why.', meta: { associatedErrors: {
      '/v1/appStoreVersionLocalizations/fr-FR': [{ code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED', source: { pointer: '/data/attributes/whatsNew' }, detail: 'Private associated detail' }],
    } } }] });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), (error) => {
    assert.equal(error.code, 'asc_review_not_ready');
    assert.equal(error.httpStatus, 409);
    assert.equal(error.apiStatus, 'STATE_ERROR.ENTITY_STATE_INVALID');
    assert.deepEqual(error.associatedErrors, [{ resource: '/v1/appStoreVersionLocalizations/fr-FR', code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED', pointer: '/data/attributes/whatsNew' }]);
    assert.doesNotMatch(error.message, /Private associated detail/);
    return true;
  });
});

test('production publication creates the version, exact processed build, bound notes, automatic unphased App Store review and can repeat', async () => {
  const api = store();
  const result = await publishAppStoreVersion({ ...identity, request: api.request });
  assert.equal(result.status, 'waiting_for_review');
  assert.equal(result.buildId, 'exact');
  assert.equal(result.releaseType, 'AFTER_APPROVAL');
  const creation = api.writes.find((w) => new URL(w.url).pathname === '/v1/appStoreVersions');
  assert.equal(creation.body.data.attributes.releaseType, 'AFTER_APPROVAL');
  assert.equal(creation.body.data.attributes.versionString, '1.2.3');
  assert.deepEqual(api.writes.find((w) => new URL(w.url).pathname.endsWith('/relationships/build')).body.data, { type: 'builds', id: 'exact' });
  assert.equal(api.writes.find((w) => new URL(w.url).pathname === '/v1/appStoreVersionLocalizations/en').body.data.attributes.whatsNew, identity.whatsNew);
  assert.equal(api.writes.find((w) => new URL(w.url).pathname === '/v1/appStoreVersionPhasedReleases/phased').method, 'DELETE');
  assert.equal(api.writes.find((w) => new URL(w.url).pathname === '/v1/reviewSubmissions/submission').body.data.attributes.submitted, true);
  assert.ok(api.writes.every((w) => !/beta|Groups/.test(w.url)));
  api.writes.length = 0;
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
  assert.deepEqual(api.writes, []);
});

test('pending processing cannot attach or submit a build', async () => {
  const api = store({ processingState: 'PROCESSING' });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'processing');
  assert.deepEqual(api.writes, []);
});

test('an existing reviewed version must reference this exact build', async () => {
  const api = store({ existing: true, state: 'WAITING_FOR_REVIEW', attached: 'another-build' });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /build/i);
  assert.deepEqual(api.writes, []);
});

test('retry after submission transport failure reuses version and review item', async () => {
  const api = store({ submitFailure: true });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /interrupted/);
  api.writes.length = 0;
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
  assert.deepEqual(api.writes.map((w) => new URL(w.url).pathname), ['/v1/reviewSubmissions/submission']);
});

test('unconfigured phased release is a supported production default', async () => {
  const api = store({ phasedMissing: true });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'waiting_for_review');
});

test('published and rejected versions report the observed state without resubmitting', async () => {
  for (const [state, status] of [['READY_FOR_DISTRIBUTION', 'published'], ['REJECTED', 'rejected']]) {
    const api = store({ existing: true, state, phased: false, initialNotes: identity.whatsNew });
    assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, status);
    assert.deepEqual(api.writes, []);
  }
});

test('an already released version does not need its historical manual-release policy rewritten', async () => {
  const api = store({ existing: true, state: 'READY_FOR_DISTRIBUTION', releaseType: 'MANUAL', phased: false, initialNotes: identity.whatsNew });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'published');
  assert.deepEqual(api.writes, []);
});

test('failed processing and invalid bound notes prevent all store mutations', async () => {
  const api = store({ processingState: 'INVALID' });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /processing failed/);
  assert.deepEqual(api.writes, []);
  await assert.rejects(publishAppStoreVersion({ ...identity, whatsNew: '', request: async () => { throw new Error('Must validate before HTTP'); } }), /bound/);
});

test('already approved manual release becomes automatic and a running phased release completes for all users', async () => {
  const api = store({ existing: true, state: 'PENDING_DEVELOPER_RELEASE', releaseType: 'MANUAL', phaseState: 'ACTIVE', initialNotes: identity.whatsNew });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'pending_release');
  assert.equal(api.writes.find((w) => new URL(w.url).pathname === '/v1/appStoreVersions/version').body.data.attributes.releaseType, 'AFTER_APPROVAL');
  assert.equal(api.writes.find((w) => new URL(w.url).pathname === '/v1/appStoreVersionPhasedReleases/phased').body.data.attributes.phasedReleaseState, 'COMPLETE');
  assert.equal(api.writes.find((w) => new URL(w.url).pathname === '/v1/appStoreVersionReleaseRequests').body.data.relationships.appStoreVersion.data.id, 'version');
});

test('a distribution-ready version that is unavailable to download is not reported as published', async () => {
  const api = store({ existing: true, state: 'READY_FOR_DISTRIBUTION', downloadable: false, phased: false, initialNotes: identity.whatsNew });
  assert.equal((await publishAppStoreVersion({ ...identity, request: api.request })).status, 'action_required');
  assert.deepEqual(api.writes, []);
});

test('a notarization-only version cannot be mistaken for App Store publication', async () => {
  const api = store({ existing: true, state: 'READY_FOR_DISTRIBUTION', reviewType: 'NOTARIZATION', phased: false, initialNotes: identity.whatsNew });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /App Store review/);
  assert.deepEqual(api.writes, []);
});

test('immutable release notes cannot be silently replaced on retry', async () => {
  const api = store({ existing: true, state: 'WAITING_FOR_REVIEW', releaseType: 'MANUAL', initialNotes: 'Other release' });
  await assert.rejects(publishAppStoreVersion({ ...identity, request: api.request }), /bound projection/);
  assert.deepEqual(api.writes, []);
});
