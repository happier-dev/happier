import test from 'node:test';
import assert from 'node:assert/strict';

import * as releaseRuntime from '../dist/index.js';

test('release-runtime exports release ring helpers and canonical ring identities', () => {
  assert.equal(typeof releaseRuntime.getReleaseRingCatalogEntry, 'function');
  assert.equal(typeof releaseRuntime.getReleaseRingPublicLabel, 'function');
  assert.equal(typeof releaseRuntime.resolvePublicReleaseRingIdForLabel, 'function');
  assert.equal(typeof releaseRuntime.resolvePublicReleaseRingLabelForId, 'function');
  assert.equal(typeof releaseRuntime.resolvePublicReleaseRingIdForAnyRingId, 'function');
  assert.equal(typeof releaseRuntime.normalizePublicReleaseRingLabel, 'function');
  assert.equal(typeof releaseRuntime.resolveCliInvokerNameForPublicRing, 'function');
  assert.equal(typeof releaseRuntime.resolvePublicReleaseRingIdForCliInvokerName, 'function');
  assert.equal(typeof releaseRuntime.listReleaseRingCatalogEntries, 'function');
  assert.equal(typeof releaseRuntime.listPublicReleaseRingLabels, 'function');
  assert.equal(typeof releaseRuntime.normalizeReleaseRingId, 'function');
  assert.equal(typeof releaseRuntime.normalizePublicReleaseRingId, 'function');

  const entries = releaseRuntime.listReleaseRingCatalogEntries();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['stable', 'preview', 'publicdev', 'internalpreview', 'internaldev'],
  );
  assert.deepEqual(
    entries.filter((entry) => entry.visibility === 'public').map((entry) => entry.id),
    ['stable', 'preview', 'publicdev'],
  );
  assert.deepEqual(releaseRuntime.listPublicReleaseRingLabels(), ['stable', 'preview', 'dev']);
  assert.equal(releaseRuntime.getReleaseRingPublicLabel('publicdev'), 'dev');
});

test('release-runtime normalizes public and legacy ring aliases to canonical ids', () => {
  assert.equal(releaseRuntime.normalizeReleaseRingId('dev'), 'publicdev');
  assert.equal(releaseRuntime.normalizeReleaseRingId('publicdev'), 'publicdev');
  assert.equal(releaseRuntime.normalizeReleaseRingId('internal-preview'), 'internalpreview');
  assert.equal(releaseRuntime.normalizeReleaseRingId('internal_dev'), 'internaldev');
  assert.equal(releaseRuntime.normalizeReleaseRingId('production'), 'stable');
  assert.equal(releaseRuntime.normalizePublicReleaseRingId('dev'), 'publicdev');
  assert.equal(releaseRuntime.normalizePublicReleaseRingId('production'), 'stable');
  assert.equal(releaseRuntime.normalizePublicReleaseRingId('internaldev'), '');
});

test('release-runtime resolves public ring labels and invoker names without exposing internal ids', () => {
  assert.equal(releaseRuntime.resolvePublicReleaseRingLabelForId('stable'), 'stable');
  assert.equal(releaseRuntime.resolvePublicReleaseRingLabelForId('preview'), 'preview');
  assert.equal(releaseRuntime.resolvePublicReleaseRingLabelForId('publicdev'), 'dev');

  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForLabel('stable'), 'stable');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForLabel('preview'), 'preview');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForLabel('dev'), 'publicdev');

  assert.equal(releaseRuntime.normalizePublicReleaseRingLabel('dev'), 'dev');
  assert.equal(releaseRuntime.normalizePublicReleaseRingLabel('publicdev'), 'dev');
  assert.equal(releaseRuntime.normalizePublicReleaseRingLabel('preview'), 'preview');
  assert.equal(releaseRuntime.normalizePublicReleaseRingLabel(''), '');
  assert.equal(releaseRuntime.normalizePublicReleaseRingLabel('unknown'), '');

  assert.equal(releaseRuntime.resolveCliInvokerNameForPublicRing('stable'), 'happier');
  assert.equal(releaseRuntime.resolveCliInvokerNameForPublicRing('preview'), 'hprev');
  assert.equal(releaseRuntime.resolveCliInvokerNameForPublicRing('publicdev'), 'hdev');

  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForCliInvokerName('happier'), 'stable');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForCliInvokerName('hprev'), 'preview');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForCliInvokerName('hdev'), 'publicdev');
});

test('release-runtime can derive the public ring id for internal ring ids', () => {
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForAnyRingId('stable'), 'stable');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForAnyRingId('preview'), 'preview');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForAnyRingId('publicdev'), 'publicdev');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForAnyRingId('internalpreview'), 'preview');
  assert.equal(releaseRuntime.resolvePublicReleaseRingIdForAnyRingId('internaldev'), 'publicdev');
});
