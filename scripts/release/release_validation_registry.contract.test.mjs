import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_VALIDATION_PROFILES,
  RELEASE_VALIDATION_SOURCE_KINDS,
  RELEASE_VALIDATION_SUITE_IDS,
  resolveAutomaticReleaseValidationExecution,
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

test('release-validation registry is the single owner of candidate-aware automatic suite selection', () => {
  assert.deepEqual(resolveAutomaticReleaseValidationExecution('integrated', {
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: true,
  }), {
    selectedSuiteIds: ['artifact-verify', 'binary-smoke', 'cli-update'],
    skippedSuiteIds: ['session-continuity', 'docker-release-assets'],
  });

  assert.deepEqual(resolveAutomaticReleaseValidationExecution('stable', {
    hasCliCandidate: false,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
  }), {
    selectedSuiteIds: ['binary-smoke', 'session-continuity', 'docker-release-assets'],
    skippedSuiteIds: ['artifact-verify', 'cli-update'],
  });

  assert.throws(() => resolveAutomaticReleaseValidationExecution('deep', {
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
  }), /normal release profile/);
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

test('normal release profiles only name executable canonical suites automatically', () => {
  for (const profile of RELEASE_VALIDATION_PROFILES) {
    for (const suiteId of profile.automaticSuiteIds) {
      assert.ok(
        resolveReleaseValidationSuite(suiteId)?.executorId,
        `${profile.id} automatic suite '${suiteId}' must resolve to an executable canonical suite`,
      );
    }
  }
});
