import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_VALIDATION_PROFILE_IDS,
  RELEASE_VALIDATION_PROFILES,
  RELEASE_VALIDATION_SOURCE_KINDS,
  RELEASE_VALIDATION_SUITE_IDS,
  resolveAutomaticReleaseValidationExecution,
  resolveReleaseValidationProfile,
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
    'sdk-dual-origin',
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
  assert.deepEqual(resolveReleaseValidationSuite('sdk-dual-origin')?.supportedDirectSourceKinds, ['local-pack']);
  assert.equal(resolveReleaseValidationSuite('unknown'), null);
});

test('release-validation registry is the single owner of candidate-aware automatic suite selection', () => {
  assert.deepEqual(
    resolveAutomaticReleaseValidationExecution('integrated', {
      hasCliCandidate: true,
      hasServerCandidate: false,
      hasPublishedRelayPredecessor: true,
      risks: {
        cliUpgrade: false,
        sessionContinuity: false,
        relayUpgrade: false,
      },
    }),
    {
      selectedSuiteIds: ['artifact-verify', 'binary-smoke'],
      skippedSuiteIds: ['session-continuity', 'cli-update', 'docker-release-assets'],
    },
  );

  assert.deepEqual(
    resolveAutomaticReleaseValidationExecution('stable', {
      hasCliCandidate: false,
      hasServerCandidate: true,
      hasPublishedRelayPredecessor: true,
      risks: {
        cliUpgrade: false,
        sessionContinuity: true,
        relayUpgrade: true,
      },
    }),
    {
      selectedSuiteIds: ['binary-smoke', 'session-continuity', 'docker-release-assets'],
      skippedSuiteIds: ['artifact-verify', 'cli-update'],
    },
  );

  assert.throws(
    () => resolveAutomaticReleaseValidationExecution('deep', {
      hasCliCandidate: true,
      hasServerCandidate: true,
      hasPublishedRelayPredecessor: true,
      risks: {
        cliUpgrade: true,
        sessionContinuity: true,
        relayUpgrade: true,
      },
    }),
    /normal release profile/,
  );
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

test('release-validation registry exposes only the implemented installer update direction', () => {
  const installers = resolveReleaseValidationSuite('installers-smoke');

  assert.deepEqual(installers?.supportedUpdateSourcePairs, [
    { from: 'published-channel', to: 'local-build' },
  ]);
});

test('release-validation registry exposes the immutable relay upgrade direction', () => {
  const relay = resolveReleaseValidationSuite('docker-release-assets');

  assert.deepEqual(relay?.supportedUpdateSourceKinds, [
    'published-channel',
    'published-tag',
    'local-build',
  ]);
  assert.deepEqual(relay?.supportedUpdateSourcePairs, [
    { from: 'published-channel', to: 'local-build' },
    { from: 'published-channel', to: 'published-tag' },
  ]);
});

test('release-validation registry owns the integrated, stable, and deep release profiles', () => {
  assert.deepEqual(RELEASE_VALIDATION_PROFILE_IDS, ['integrated', 'stable', 'deep']);

  const integrated = resolveReleaseValidationProfile(' integrated ');
  const stable = resolveReleaseValidationProfile('stable');
  const deep = resolveReleaseValidationProfile('deep');

  assert.deepEqual(integrated?.automaticSuiteIds, INTEGRATED_AUTOMATIC_RELEASE_VALIDATION_SUITES);
  assert.equal(integrated?.checksProfile, 'fast');
  assert.deepEqual(stable?.automaticSuiteIds, [
    ...INTEGRATED_AUTOMATIC_RELEASE_VALIDATION_SUITES,
  ]);
  assert.equal(stable?.checksProfile, 'full');
  assert.equal(deep?.normalRelease, false);
  assert.equal(deep?.checksProfile, null);
  assert.equal(deep?.manualEntrypoint, 'skills/happier-release-validation/SKILL.md');
  assert.deepEqual(deep?.automaticSuiteIds, []);
  assert.equal(integrated?.automaticSuiteIds.includes('sdk-dual-origin'), false);
  assert.equal(stable?.automaticSuiteIds.includes('sdk-dual-origin'), false);
  assert.deepEqual(Object.keys(integrated ?? {}).sort(), [
    'automaticSuiteIds',
    'checksProfile',
    'id',
    'normalRelease',
  ]);
  assert.equal(resolveReleaseValidationProfile('unknown'), null);
  assert.equal(RELEASE_VALIDATION_PROFILES.includes(deep), true);
});

const INTEGRATED_AUTOMATIC_RELEASE_VALIDATION_SUITES = [
  'artifact-verify',
  'binary-smoke',
  'session-continuity',
  'cli-update',
  'docker-release-assets',
];
