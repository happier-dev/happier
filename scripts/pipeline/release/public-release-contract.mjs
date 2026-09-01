#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from 'node:url';

import { releaseTargets, versionedComponents } from './component-registry.mjs';
import { RELEASE_VALIDATION_PROFILES, RELEASE_VALIDATION_SUITES } from '../release-validation/registry.mjs';

export const PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION = 1;
export const PUBLIC_RELEASE_CONTRACT_KIND = 'happier.public-release-contract.v1';

function projectValidationSuite(suite) {
  return {
    id: suite.id,
    supportsDirectSource: suite.supportsDirectSource,
    supportsUpdateSources: suite.supportsUpdateSources,
    ...(suite.supportedDirectSourceKinds ? { supportedDirectSourceKinds: [...suite.supportedDirectSourceKinds] } : {}),
    ...(suite.supportedUpdateSourceKinds ? { supportedUpdateSourceKinds: [...suite.supportedUpdateSourceKinds] } : {}),
    ...(suite.supportedUpdateSourcePairs
      ? { supportedUpdateSourcePairs: suite.supportedUpdateSourcePairs.map((pair) => ({ ...pair })) }
      : {}),
    executable: Boolean(suite.executorId),
  };
}

function projectValidationProfile(profile) {
  return {
    id: profile.id,
    normalRelease: profile.normalRelease,
    checksProfile: profile.checksProfile,
    automaticSuiteIds: [...profile.automaticSuiteIds],
    ...(profile.manualEntrypoint ? { manualEntrypoint: profile.manualEntrypoint } : {}),
  };
}

export function resolvePublicReleaseContract() {
  return {
    schemaVersion: PUBLIC_RELEASE_CONTRACT_SCHEMA_VERSION,
    kind: PUBLIC_RELEASE_CONTRACT_KIND,
    conductorProtocol: {
      version: 1,
      capabilities: ['release-analysis-v1', 'release-dispatch-plan-v3', 'ci-run-id', 'public-sdk-release-approval'],
    },
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

export function resolvePublicReleaseValidationProfile(raw) {
  const id = String(raw ?? '').trim();
  return resolvePublicReleaseContract().validationProfiles.find((profile) => profile.id === id) ?? null;
}

export function resolveHostedChecksProfileForReleaseProfile(raw) {
  const profile = resolvePublicReleaseValidationProfile(raw);
  if (!profile?.normalRelease) return null;
  return profile.checksProfile;
}

function main() {
  process.stdout.write(`${JSON.stringify(resolvePublicReleaseContract())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
