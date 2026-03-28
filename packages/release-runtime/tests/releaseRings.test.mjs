import test from 'node:test';
import assert from 'node:assert/strict';

import * as releaseRuntime from '../dist/index.js';

test('release-runtime exports release ring helpers and canonical ring identities', () => {
  assert.equal(typeof releaseRuntime.getReleaseRingCatalogEntry, 'function');
  assert.equal(typeof releaseRuntime.getReleaseRingPublicLabel, 'function');
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
