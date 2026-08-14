// @ts-check

import { releaseTargets, versionedComponents } from './component-registry.mjs';
import {
  RELEASE_VALIDATION_PROFILES,
  RELEASE_VALIDATION_SUITES,
} from '../release-validation/registry.mjs';

export const PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION = 1;
export const PUBLIC_RELEASE_CONTRACT_KIND = 'happier.public-release-contract.v1';

/**
 * @param {import('../release-validation/registry.mjs').ReleaseValidationSuiteDefinition} suite
 */
function projectValidationSuite(suite) {
  return {
    id: suite.id,
    supportsDirectSource: suite.supportsDirectSource,
    supportsUpdateSources: suite.supportsUpdateSources,
    ...(suite.supportedDirectSourceKinds
      ? { supportedDirectSourceKinds: [...suite.supportedDirectSourceKinds] }
      : {}),
    ...(suite.supportedUpdateSourceKinds
      ? { supportedUpdateSourceKinds: [...suite.supportedUpdateSourceKinds] }
      : {}),
    ...(suite.supportedUpdateSourcePairs
      ? { supportedUpdateSourcePairs: suite.supportedUpdateSourcePairs.map((pair) => ({ ...pair })) }
      : {}),
    executable: Boolean(suite.executorId),
  };
}

/**
 * @param {import('../release-validation/registry.mjs').ReleaseValidationProfileDefinition} profile
 */
function projectValidationProfile(profile) {
  return {
    id: profile.id,
    normalRelease: profile.normalRelease,
    checksProfile: profile.checksProfile,
    automaticSuiteIds: [...profile.automaticSuiteIds],
    ...(profile.manualEntrypoint ? { manualEntrypoint: profile.manualEntrypoint } : {}),
  };
}

/**
 * Produce the public, static release-planning contract. This deliberately
 * describes canonical targets and validation owners only: candidate identity,
 * approval, dispatch, publication, migration, and cutover stay with their
 * existing operational owners.
 */
export function buildPublicReleaseContractV1() {
  return {
    schemaVersion: PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION,
    kind: PUBLIC_RELEASE_CONTRACT_KIND,
    targets: Object.values(versionedComponents).map(({ id, baselineTagPrefix, changedWhen }) => ({
      id,
      baselineTagPrefix,
      changedWhen: [...changedWhen],
    })),
    releaseTargets: [...releaseTargets],
    validationSuites: RELEASE_VALIDATION_SUITES.map(projectValidationSuite),
    validationProfiles: RELEASE_VALIDATION_PROFILES.map(projectValidationProfile),
  };
}
