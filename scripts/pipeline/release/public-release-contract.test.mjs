import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseTargets, versionedComponents } from './component-registry.mjs';
import {
  RELEASE_VALIDATION_PROFILES,
  RELEASE_VALIDATION_SUITES,
} from '../release-validation/registry.mjs';
import {
  buildPublicReleaseContractV1,
  PUBLIC_RELEASE_CONTRACT_KIND,
  PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION,
} from './public-release-contract.mjs';

test('public release contract v1 projects the canonical release targets and validation owners', () => {
  const contract = buildPublicReleaseContractV1();

  assert.equal(contract.schemaVersion, PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION);
  assert.equal(contract.kind, PUBLIC_RELEASE_CONTRACT_KIND);
  assert.deepEqual(
    contract.targets,
    Object.values(versionedComponents).map(({ id, baselineTagPrefix, changedWhen }) => ({
      id,
      baselineTagPrefix,
      changedWhen,
    })),
  );
  assert.deepEqual(contract.releaseTargets, releaseTargets);
  assert.deepEqual(
    contract.validationSuites,
    RELEASE_VALIDATION_SUITES.map((suite) => ({
      id: suite.id,
      supportsDirectSource: suite.supportsDirectSource,
      supportsUpdateSources: suite.supportsUpdateSources,
      ...(suite.supportedDirectSourceKinds
        ? { supportedDirectSourceKinds: suite.supportedDirectSourceKinds }
        : {}),
      ...(suite.supportedUpdateSourceKinds
        ? { supportedUpdateSourceKinds: suite.supportedUpdateSourceKinds }
        : {}),
      ...(suite.supportedUpdateSourcePairs
        ? { supportedUpdateSourcePairs: suite.supportedUpdateSourcePairs }
        : {}),
      executable: Boolean(suite.executorId),
    })),
  );
  assert.deepEqual(contract.validationProfiles, RELEASE_VALIDATION_PROFILES);
});

test('public release contract distinguishes automatic release profiles from deep manual certification', () => {
  const profiles = buildPublicReleaseContractV1().validationProfiles;
  const integrated = profiles.find((profile) => profile.id === 'integrated');
  const stable = profiles.find((profile) => profile.id === 'stable');
  const deep = profiles.find((profile) => profile.id === 'deep');

  assert.deepEqual(integrated?.automaticSuiteIds, [
    'artifact-verify',
    'binary-smoke',
    'session-continuity',
    'cli-update',
    'docker-release-assets',
  ]);
  assert.equal(integrated?.checksProfile, 'fast');
  assert.equal(stable?.normalRelease, true);
  assert.deepEqual(stable?.automaticSuiteIds, [
    'artifact-verify',
    'binary-smoke',
    'session-continuity',
    'cli-update',
    'docker-release-assets',
  ]);
  assert.equal(stable?.checksProfile, 'full');
  assert.equal(deep?.normalRelease, false);
  assert.equal(deep?.checksProfile, null);
  assert.deepEqual(deep?.automaticSuiteIds, []);
  assert.equal(
    deep?.manualEntrypoint,
    'skills/happier-release-validation/SKILL.md',
    'deep certification exposes a target-owned human entrypoint without becoming an executable normal profile',
  );
  assert.deepEqual(Object.keys(stable ?? {}).sort(), [
    'automaticSuiteIds',
    'checksProfile',
    'id',
    'normalRelease',
  ]);
});

test('public release contract exposes the manual exact SDK candidate validation suite', () => {
  const suite = buildPublicReleaseContractV1().validationSuites.find((candidate) => candidate.id === 'sdk-dual-origin');

  assert.deepEqual(suite, {
    id: 'sdk-dual-origin',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-pack'],
    executable: true,
  });
});
