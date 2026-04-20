import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_VALIDATION_SOURCE_KINDS,
  RELEASE_VALIDATION_SUITE_IDS,
  resolveReleaseValidationSourceKind,
  resolveReleaseValidationSuite,
} from '../pipeline/release-validation/registry.mjs';

test('release-validation registry exposes the canonical suite and source ids', () => {
  assert.deepEqual(RELEASE_VALIDATION_SUITE_IDS, [
    'installers-smoke',
    'binary-smoke',
    'artifact-verify',
    'docker-release-assets',
    'cli-update',
    'server-upgrade',
    'daemon-continuity',
    'session-continuity',
  ]);

  assert.deepEqual(RELEASE_VALIDATION_SOURCE_KINDS, [
    'published-channel',
    'published-tag',
    'local-build',
    'local-pack',
    'git-ref-build',
  ]);

  assert.equal(resolveReleaseValidationSourceKind(' local-build '), 'local-build');
  assert.equal(resolveReleaseValidationSourceKind('unknown'), null);
  assert.equal(resolveReleaseValidationSuite(' cli-update ')?.executorId, 'cli-update');
  assert.equal(resolveReleaseValidationSuite('unknown'), null);
});

test('release-validation registry encodes supported cli-update source direction', () => {
  const cliUpdate = resolveReleaseValidationSuite('cli-update');

  assert.deepEqual(cliUpdate?.supportedUpdateSourcePairs, [
    { from: 'published-channel', to: 'published-channel' },
    { from: 'published-channel', to: 'published-tag' },
    { from: 'published-channel', to: 'local-build' },
    { from: 'published-channel', to: 'local-pack' },
    { from: 'published-tag', to: 'published-channel' },
    { from: 'published-tag', to: 'published-tag' },
    { from: 'published-tag', to: 'local-build' },
    { from: 'published-tag', to: 'local-pack' },
  ]);
});
