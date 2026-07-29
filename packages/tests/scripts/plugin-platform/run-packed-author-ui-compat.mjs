#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, request as requestHttp } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { lstat, readFile, realpath, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as tar from 'tar';
import { sanitizePackageArtifactEnv } from '../../../../scripts/pipeline/npm/sanitize-package-artifact-env.mjs';
import { readPluginInstallReviewRequiredEnvelope } from '../../src/testkit/pluginPlatform/pluginInstallReviewRequiredEnvelope.mjs';
import {
  createEphemeralTlsServerFixture,
} from '../../src/testkit/tls/ephemeralTlsServerFixture.mjs';
import {
  assertPackedCliEntrypoint,
  assertPackedAuthorCandidateArchivesSafe,
  assertPackedPackageIdentity,
  readPackedPackageManifest,
  sha512Sri,
} from './packed-author-artifact-boundary.mjs';
import {
  parseArtifactChecksums,
} from '../../../../scripts/pipeline/release/lib/artifact-checksums.mjs';

const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const CLI_PACKAGE_NAME = '@happier-dev/cli';
export const PACKED_AUTHOR_NATIVE_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
]);
const NATIVE_TYPESCRIPT_DEPENDENCY_SPEC = 'npm:typescript@7.0.2';
const SYSTEM_PACKAGE_MANAGER_BASENAMES = new Set([
  'npm', 'npm.cmd', 'npx', 'npx.cmd', 'pnpm', 'pnpm.cmd',
  'yarn', 'yarn.cmd', 'yarnpkg', 'yarnpkg.cmd', 'bunx', 'bunx.exe',
]);
const packedAuthorCommandOutputCapture = new AsyncLocalStorage();
const PACKED_NOVEL_QA_HANDOFF_KIND =
  'happier_packed_novel_connected_account_qa_handoff_v1';
const PACKED_NOVEL_QA_HANDOFF_MANIFEST_FILE =
  'packed-novel-connected-account-qa.json';
const PACKED_NOVEL_QA_HANDOFF_MARKER_FILE = '.packed-novel-qa-root.json';
const PACKED_NOVEL_QA_PLUGIN_ID = 'acme.vertical-a';
const PACKED_NOVEL_QA_SERVICE = Object.freeze({
  pluginId: PACKED_NOVEL_QA_PLUGIN_ID,
  localId: 'novel-cloud',
});
const PACKED_NOVEL_QA_AUTHENTICATION_MODE_IDS =
  Object.freeze(['manual', 'oauth', 'device']);
const PACKED_NOVEL_QA_CALLBACK_URL =
  'http://localhost:1455/auth/callback';
const PACKED_AUTHOR_SYNTHETIC_CREDENTIAL_SENTINELS = Object.freeze([
  'synthetic-private-token-v1',
  'synthetic-private-token-v2',
  'configured-notification-token',
  'invalid-notification-token',
  'packed-claude-setup-token-initial',
  'packed-claude-setup-token-reconnected',
  'packed-oauth-client-secret',
  'packed-device-account-secret',
  'stale-configuration',
  'slow-token',
  'outcome-unknown',
  'device:device-account',
  'token-a-reconnected',
  'token-a',
  'token-b',
]);

export {
  assertPackedCliEntrypoint,
  assertPackedPackageIdentity,
  readPackedPackageManifest,
  sha512Sri,
};

export function sanitizePackedAuthorArtifactEnv(env) {
  return sanitizePackageArtifactEnv(env);
}

export const VERTICAL_A_REQUIRED_STAGE_IDS = Object.freeze([
  'artifact-integrity',
  'sdk-identity',
  'candidate-registry',
  'cli-identity',
  'daemon-agent-carrier-fail-closed',
  'create',
  'create-contract',
  'author-install',
  'author-typecheck',
  'author-build',
  'author-test',
  'plugin-pack',
  'public-registry-profile-lifecycle',
  'marketplace-exact-daemon-lifecycle',
  'private-registry-profile-lifecycle',
  'daemon-review-and-commit',
  'prepared-activation-registration',
  'declared-action-invocation',
  'packed-connected-account-producer',
  'packed-builtin-multimode-connected-account',
  'packed-retained-capabilities-lifecycle',
  'packed-notification-delivery-lifecycle',
  'packed-scm-runtime-auth-projection',
  'packed-external-sessions-lifecycle',
  'response-loss-currentness-query',
  'trusted-development-response-loss-currentness',
  'descriptor-only-static-lifecycle',
  'ordinary-disable-enable',
  'takeover-stale-incarnation-fenced',
  'restart-applied-generation',
  'packed-connected-account-restart-durability',
  'packed-connected-account-established-operations',
  'failed-update-preservation',
  'successful-update-replacement',
  'post-restart-peer-isolation',
  'packed-connected-account-generation-lifecycle',
  'explicit-rollback',
  'continuous-health-role-transition',
  'automatic-lkg-recovery',
  'quarantined-explicit-rollback',
  'no-eligible-lkg-disable',
  'try-once-reinstall-quarantine',
  'cleanup-failure-later-mutation',
  'uninstall-action-currentness-absence',
  'packed-scm-uninstall-stale-absence',
  'canonical-current-owner',
  'cleanup',
]);

export const VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS = Object.freeze({
  ownerFault: Object.freeze([
    'daemon-agent-carrier-fail-closed',
    'response-loss-currentness-query',
    'trusted-development-response-loss-currentness',
    'takeover-stale-incarnation-fenced',
    'failed-update-preservation',
    'post-restart-peer-isolation',
    'continuous-health-role-transition',
    'automatic-lkg-recovery',
    'quarantined-explicit-rollback',
    'no-eligible-lkg-disable',
    'try-once-reinstall-quarantine',
    'cleanup-failure-later-mutation',
    'canonical-current-owner',
  ]),
  packedExternalBlackBox: Object.freeze([
    'artifact-integrity',
    'sdk-identity',
    'candidate-registry',
    'cli-identity',
    'create',
    'create-contract',
    'author-install',
    'author-typecheck',
    'author-build',
    'author-test',
    'plugin-pack',
    'public-registry-profile-lifecycle',
    'marketplace-exact-daemon-lifecycle',
    'private-registry-profile-lifecycle',
    'declared-action-invocation',
    'packed-connected-account-producer',
    'packed-builtin-multimode-connected-account',
    'packed-retained-capabilities-lifecycle',
    'packed-notification-delivery-lifecycle',
    'packed-scm-runtime-auth-projection',
    'packed-external-sessions-lifecycle',
  ]),
  authenticatedDaemon: Object.freeze([
    'daemon-review-and-commit',
    'prepared-activation-registration',
    'descriptor-only-static-lifecycle',
    'ordinary-disable-enable',
    'restart-applied-generation',
    'packed-connected-account-restart-durability',
    'packed-connected-account-established-operations',
    'successful-update-replacement',
    'packed-connected-account-generation-lifecycle',
    'explicit-rollback',
    'uninstall-action-currentness-absence',
    'packed-scm-uninstall-stale-absence',
    'cleanup',
  ]),
});

export function assertDiscardedDisableCurrentness({
  discardedDisableResponse,
  installedPlugin,
  installation,
  runtimeCatalog,
  expectedGeneration,
}) {
  if (
    discardedDisableResponse.responseBodyDiscarded !== true
    || installedPlugin?.enabled !== false
    || installedPlugin.desiredGeneration !== expectedGeneration
    || installedPlugin.appliedGeneration !== null
    || installation?.enabled !== false
    || runtimeCatalog?.state?.enabled !== false
  ) {
    fail(`Ordinary current-state query did not resolve a discarded disable response: ${JSON.stringify({
      discardedDisableResponse,
      installedPlugin,
      installation,
      runtimeCatalog,
      expectedGeneration,
    })}`);
  }
}

export function assertExplicitHealthHistoryClear({
  pluginId,
  fingerprint,
  afterDefaultUninstall,
  clearEnvelope,
  afterExplicitClear,
}) {
  const preserved = afterDefaultUninstall.revision.healthTombstones?.find((entry) => (
    entry.pluginId === pluginId && entry.fingerprint === fingerprint
  ));
  const remaining = afterExplicitClear.revision.healthTombstones?.filter((entry) => (
    entry.pluginId === pluginId
  )) ?? [];
  if (
    preserved?.state !== 'quarantined'
    || clearEnvelope.data?.pluginId !== pluginId
    || clearEnvelope.data?.alreadyUninstalled !== true
    || remaining.length !== 0
  ) {
    fail(`Explicit health-history clear did not preserve then irreversibly forget plugin health: ${JSON.stringify({
      pluginId,
      fingerprint,
      preserved,
      clearData: clearEnvelope.data,
      remaining,
    })}`);
  }
  return {
    preservedFingerprint: fingerprint,
    explicitClear: true,
  };
}

function analyzeStageCoverage(
  stages,
  requiredStageIds,
  { allowOtherStageIds = false } = {},
) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const stageIdCounts = new Map();
  for (const stage of stages) {
    stageIdCounts.set(stage.id, (stageIdCounts.get(stage.id) ?? 0) + 1);
  }
  const requiredStageIdSet = new Set(requiredStageIds);
  const missingStageIds = requiredStageIds.filter((id) => !byId.has(id));
  const failedStageIds = requiredStageIds.filter(
    (id) => byId.has(id) && byId.get(id)?.ok !== true,
  );
  const duplicateStageIds = [...stageIdCounts.entries()]
    .filter(([id, count]) => requiredStageIdSet.has(id) && count > 1)
    .map(([id]) => id);
  const unexpectedStageIds = allowOtherStageIds
    ? []
    : [...stageIdCounts.keys()].filter((id) => !requiredStageIdSet.has(id));
  return {
    missingStageIds,
    failedStageIds,
    duplicateStageIds,
    unexpectedStageIds,
  };
}

function analyzeVerticalAStageCoverage(stages) {
  return analyzeStageCoverage(stages, VERTICAL_A_REQUIRED_STAGE_IDS);
}

export function buildVerticalAEvidenceLayerResult(layerId, stages) {
  const requiredStageIds = VERTICAL_A_EVIDENCE_LAYER_STAGE_IDS[layerId];
  if (!requiredStageIds) {
    fail(`Unknown Vertical-A evidence layer: ${String(layerId)}`);
  }
  const coverage = analyzeStageCoverage(stages, requiredStageIds, {
    allowOtherStageIds: true,
  });
  const incomplete = Object.values(coverage).some((ids) => ids.length > 0);
  return {
    ok: !incomplete,
    requiredStageIds,
    stages: stages.filter(({ id }) => requiredStageIds.includes(id)),
    ...(incomplete ? { error: coverage } : {}),
  };
}

export function assertVerticalAStageCoverage(stages) {
  const {
    missingStageIds,
    failedStageIds,
    duplicateStageIds,
    unexpectedStageIds,
  } = analyzeVerticalAStageCoverage(stages);
  if (missingStageIds.length > 0) {
    fail(`VERTICAL-A result is missing required stages: ${missingStageIds.join(', ')}`);
  }
  if (failedStageIds.length > 0) {
    fail(`VERTICAL-A required stages did not pass: ${failedStageIds.join(', ')}`);
  }
  if (duplicateStageIds.length > 0) {
    fail(`VERTICAL-A result has duplicate stage ids: ${duplicateStageIds.join(', ')}`);
  }
  if (unexpectedStageIds.length > 0) {
    fail(`VERTICAL-A result has unexpected stage ids: ${unexpectedStageIds.join(', ')}`);
  }
}

export function assertExactMarketplaceInstallationState({
  generation,
  installation,
  runtimeCatalog,
  expected,
}) {
  const matchesDistribution = (distribution) => (
    distribution?.kind === expected.distribution.kind
    && distribution?.registryOrigin === expected.distribution.registryOrigin
    && distribution?.packageName === expected.distribution.packageName
  );
  if (
    installation?.enabled !== true
    || generation?.pluginId !== expected.pluginId
    || generation?.manifestDigest !== expected.manifestDigest
    || generation?.installedArtifactRecord?.digest !== expected.manifestDigest
    || !/^sha256:[a-f0-9]{64}$/u.test(generation?.packageDigest ?? '')
    || installation?.trust?.pluginId !== expected.pluginId
    || installation?.trust?.state !== 'trusted'
    || !matchesDistribution(installation?.trust?.distribution)
    || !matchesDistribution(installation?.source?.distribution)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(expected.marketplaceIntegrity)
    || installation?.source?.admittedIntegrity !== generation.packageDigest
    || installation?.updatePolicy !== expected.updatePolicy
    || runtimeCatalog?.state?.enabled !== true
    || runtimeCatalog?.source?.resolvedVersion !== expected.version
    || runtimeCatalog?.source?.resolvedDigest !== expected.manifestDigest
    || runtimeCatalog?.install?.manifestDigest !== expected.manifestDigest
    || runtimeCatalog?.install?.updatePolicy !== expected.updatePolicy
    || !matchesDistribution(runtimeCatalog?.install?.trust?.distribution)
  ) {
    fail(`Exact marketplace install did not persist exact artifact and durable distribution identity: ${JSON.stringify({
      installation,
      generation,
      runtimeCatalog,
    })}`);
  }
}

export function assertNoEligibleLkgDisabled({
  state,
  pluginId,
  failedGenerationId,
  explicitRollbackGenerationId,
  healthyPluginInvocation,
}) {
  const currentGeneration = state.commit.pluginGenerations?.[pluginId]?.immutableGenerationId;
  const failedHealth = state.revision.health?.[failedGenerationId];
  const explicitRollbackHealth = state.revision.health?.[explicitRollbackGenerationId];
  const explicitRollback = state.revision.rollbackRetention?.find((entry) => (
    entry.pluginId === pluginId
    && entry.immutableGenerationId === explicitRollbackGenerationId
  ));
  const tombstone = state.revision.healthTombstones?.find((entry) => (
    entry.pluginId === pluginId
    && entry.fingerprint === failedHealth?.fingerprint
  ));
  const automaticRecoveryEntry = state.revision.rollbackRetention?.find((entry) => (
    entry.pluginId === pluginId && entry.automaticRecoveryEligible === true
  ));
  if (automaticRecoveryEntry) {
    fail(`No-LKG recovery left automatic recovery eligible: ${JSON.stringify(automaticRecoveryEntry)}`);
  }
  if (
    currentGeneration !== failedGenerationId
    || state.revision.plugins?.[pluginId]?.enabled !== false
    || state.revision.runtimeCatalog?.plugins?.[pluginId]?.state?.enabled !== false
    || failedHealth?.state !== 'quarantined'
    || new Set(failedHealth?.consumedAttemptIds ?? []).size < 3
    || tombstone?.state !== 'quarantined'
    || explicitRollback?.automaticRecoveryEligible !== false
    || explicitRollback?.byteAvailability !== 'available'
    || !['userRollback', 'quarantined'].includes(explicitRollback?.role)
    || (
      explicitRollback?.role === 'quarantined'
      && explicitRollbackHealth?.tryOnce !== 'available'
    )
  ) {
    fail(`No-LKG recovery did not quarantine and disable only the current plugin while retaining explicit rollback: ${JSON.stringify({
      currentGeneration,
      failedHealth,
      tombstone,
      explicitRollback,
      explicitRollbackHealth,
      installation: state.revision.plugins?.[pluginId],
      runtimeCatalog: state.revision.runtimeCatalog?.plugins?.[pluginId],
    })}`);
  }
  if (
    !healthyPluginInvocation
    || typeof healthyPluginInvocation.pluginId !== 'string'
    || healthyPluginInvocation.pluginId === pluginId
    || typeof healthyPluginInvocation.version !== 'string'
    || !Number.isInteger(healthyPluginInvocation.pid)
    || typeof healthyPluginInvocation.activationInstanceId !== 'string'
  ) {
    fail(`No-LKG recovery did not prove a healthy control plugin remained callable: ${JSON.stringify({
      pluginId,
      healthyPluginInvocation,
    })}`);
  }
  return {
    failedFingerprint: failedHealth.fingerprint,
    distinctFatalAttempts: new Set(failedHealth.consumedAttemptIds).size,
    explicitRollbackRole: explicitRollback.role,
    healthyPluginId: healthyPluginInvocation.pluginId,
    healthyPluginVersion: healthyPluginInvocation.version,
  };
}

export function assertTryOnceReinstallQuarantine({
  state,
  pluginId,
  originalGenerationId,
  reinstalledGenerationId,
  fingerprint,
  rejectedSecondEnable,
  registrationCountBeforeRestart,
  registrationCountAfterReinstall,
}) {
  const currentGeneration = state.commit.pluginGenerations?.[pluginId]?.immutableGenerationId;
  const originalHealth = state.revision.health?.[originalGenerationId];
  const reinstalledHealth = state.revision.health?.[reinstalledGenerationId];
  const tombstone = state.revision.healthTombstones?.find((entry) => (
    entry.pluginId === pluginId && entry.fingerprint === fingerprint
  ));
  const rejectedMessage = [
    rejectedSecondEnable?.error?.message,
    rejectedSecondEnable?.error?.causeMessage,
  ].filter((value) => typeof value === 'string').join(' ');
  if (
    originalGenerationId === reinstalledGenerationId
    || currentGeneration !== reinstalledGenerationId
    || state.revision.plugins?.[pluginId]?.enabled !== false
    || state.revision.runtimeCatalog?.plugins?.[pluginId]?.state?.enabled !== false
    || originalHealth?.fingerprint !== fingerprint
    || originalHealth?.state !== 'quarantined'
    || originalHealth?.tryOnce !== 'consumed'
    || reinstalledHealth?.fingerprint !== fingerprint
    || reinstalledHealth?.state !== 'quarantined'
    || reinstalledHealth?.tryOnce !== 'consumed'
    || tombstone?.state !== 'consumed'
    || rejectedSecondEnable?.ok !== false
    || rejectedSecondEnable?.kind !== 'plugins_enable'
    || rejectedSecondEnable?.error?.code !== 'failed'
    || !/Try once.*(?:unavailable|consumed)/iu.test(rejectedMessage)
    || !Number.isInteger(registrationCountBeforeRestart)
    || registrationCountBeforeRestart < 0
    || registrationCountAfterReinstall !== registrationCountBeforeRestart
  ) {
    fail(`Try once or exact-byte reinstall rearmed quarantined bytes: ${JSON.stringify({
      pluginId,
      originalGenerationId,
      reinstalledGenerationId,
      currentGeneration,
      fingerprint,
      originalHealth,
      reinstalledHealth,
      tombstone,
      rejectedSecondEnable,
      registrationCountBeforeRestart,
      registrationCountAfterReinstall,
      installation: state.revision.plugins?.[pluginId],
      runtimeCatalog: state.revision.runtimeCatalog?.plugins?.[pluginId],
    })}`);
  }
  return {
    originalGeneration: originalGenerationId,
    reinstalledGeneration: reinstalledGenerationId,
    fingerprint,
    tryOnce: reinstalledHealth.tryOnce,
    registrationCount: registrationCountAfterReinstall,
  };
}

export function assertRejectedCandidateNotAttributedToCurrentHealth({
  before,
  after,
  pluginId,
  currentGenerationId,
}) {
  const beforeCurrent = before.commit.pluginGenerations?.[pluginId]?.immutableGenerationId;
  const afterCurrent = after.commit.pluginGenerations?.[pluginId]?.immutableGenerationId;
  const beforeAttemptIds = [
    ...(before.revision.health?.[currentGenerationId]?.consumedAttemptIds ?? []),
  ];
  const afterAttemptIds = [
    ...(after.revision.health?.[currentGenerationId]?.consumedAttemptIds ?? []),
  ];
  if (
    beforeCurrent !== currentGenerationId
    || afterCurrent !== currentGenerationId
    || new Set(beforeAttemptIds).size !== beforeAttemptIds.length
    || new Set(afterAttemptIds).size !== afterAttemptIds.length
    || JSON.stringify(afterAttemptIds) !== JSON.stringify(beforeAttemptIds)
  ) {
    fail(`Health supervisor attributed a rejected candidate failure to the serving generation: ${JSON.stringify({
      pluginId,
      currentGenerationId,
      beforeCurrent,
      afterCurrent,
      beforeAttemptIds,
      afterAttemptIds,
    })}`);
  }
  return {
    currentGeneration: currentGenerationId,
    consumedAttemptIds: afterAttemptIds,
  };
}

export function assertContinuousHealthEvidence({
  startedAtMs,
  completedAtMs,
  requiredWindowMs,
  initialRegistration,
  healthyInvocation,
  candidateHealth,
  priorRetention,
  initialDistribution,
  candidateDistribution,
}) {
  const measuredWallDurationMs = completedAtMs - startedAtMs;
  if (
    !Number.isInteger(measuredWallDurationMs)
    || measuredWallDurationMs < requiredWindowMs
  ) {
    fail(`Measured continuous-health duration was shorter than the required window: ${JSON.stringify({
      startedAtMs,
      completedAtMs,
      measuredWallDurationMs,
      requiredWindowMs,
    })}`);
  }
  if (
    !initialRegistration
    || initialRegistration.pid !== healthyInvocation?.pid
    || initialRegistration.activationInstanceId !== healthyInvocation?.activationInstanceId
  ) {
    fail(`Continuous-health daemon activation changed before the healthy invocation: ${JSON.stringify({
      initialRegistration,
      healthyInvocation,
    })}`);
  }
  if (candidateHealth?.state !== 'healthy') {
    fail(`Continuous-health candidate did not become healthy: ${JSON.stringify({ candidateHealth })}`);
  }
  if (
    priorRetention?.role !== 'userRollback'
    || priorRetention?.automaticRecoveryEligible !== false
    || priorRetention?.byteAvailability !== 'available'
  ) {
    fail(`Continuous-health prior generation did not become explicit rollback only: ${JSON.stringify({
      priorRetention,
    })}`);
  }
  if (
    initialDistribution?.kind !== 'localPath'
    || candidateDistribution?.kind !== 'localPath'
    || typeof initialDistribution.canonicalPath !== 'string'
    || initialDistribution.canonicalPath.length === 0
    || candidateDistribution.canonicalPath !== initialDistribution.canonicalPath
  ) {
    fail(`Continuous-health transition did not preserve the same local-path distribution: ${JSON.stringify({
      initialDistribution,
      candidateDistribution,
    })}`);
  }
  return {
    measuredWallDurationMs,
    daemonPid: initialRegistration.pid,
    activationInstanceId: initialRegistration.activationInstanceId,
    candidateHealthState: candidateHealth.state,
    priorRole: priorRetention.role,
    priorAutomaticRecoveryEligible: priorRetention.automaticRecoveryEligible,
    distributionKind: initialDistribution.kind,
    distributionIdentity: initialDistribution.canonicalPath,
  };
}

export function assertDaemonAgentCarrierFailClosed(result) {
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  if (
    result?.code === 0
    || result?.signal !== null
    || !(
      /DAEMON_AGENT_RUNTIME_CARRIER_MISSING/u.test(output)
      || /Daemon-spawned native Agent backend 'auggie' is missing its runtime carrier/iu.test(output)
    )
  ) {
    fail(`Daemon-started native Agent did not fail closed at the daemon carrier owner: ${JSON.stringify({
      code: result?.code,
      signal: result?.signal,
      stdout: result?.stdout,
      stderr: result?.stderr,
    })}`);
  }
  return {
    backendId: 'auggie',
    errorCode: 'DAEMON_AGENT_RUNTIME_CARRIER_MISSING',
    processExitCode: result.code,
  };
}

export function assertPostRestartHealthyPeerIsolation({
  pluginId,
  before,
  after,
  registrationCountBefore,
  registrationCountAfter,
}) {
  if (
    before?.pluginId !== pluginId
    || after?.pluginId !== pluginId
    || typeof before.version !== 'string'
    || after.version !== before.version
    || !Number.isInteger(before.pid)
    || after.pid !== before.pid
    || typeof before.activationInstanceId !== 'string'
    || after.activationInstanceId !== before.activationInstanceId
    || !Number.isInteger(registrationCountBefore)
    || registrationCountBefore < 1
    || registrationCountAfter !== registrationCountBefore
  ) {
    fail(`Post-restart sibling mutation reactivated or retired the healthy peer: ${JSON.stringify({
      pluginId,
      before,
      after,
      registrationCountBefore,
      registrationCountAfter,
    })}`);
  }
  return {
    pluginId,
    version: before.version,
    daemonPid: before.pid,
    activationInstanceId: before.activationInstanceId,
    registrationCount: registrationCountBefore,
  };
}

export function assertQuarantinedExplicitRollback({
  pluginId,
  healthyGenerationId,
  quarantinedGenerationId,
  before,
  rollbackEnvelope,
  after,
  invocation,
}) {
  const beforeHealth = before.revision.health?.[quarantinedGenerationId];
  const beforeTombstone = before.revision.healthTombstones?.find((entry) => (
    entry.pluginId === pluginId && entry.fingerprint === beforeHealth?.fingerprint
  ));
  const afterHealth = after.revision.health?.[quarantinedGenerationId];
  const afterTombstone = after.revision.healthTombstones?.find((entry) => (
    entry.pluginId === pluginId && entry.fingerprint === beforeHealth?.fingerprint
  ));
  if (
    before.commit.pluginGenerations?.[pluginId]?.immutableGenerationId !== healthyGenerationId
    || before.revision.plugins?.[pluginId]?.enabled !== false
    || beforeHealth?.state !== 'quarantined'
    || beforeHealth?.tryOnce !== 'available'
    || typeof beforeHealth.fingerprint !== 'string'
    || beforeTombstone?.state !== 'quarantined'
    || rollbackEnvelope.data?.pluginId !== pluginId
    || rollbackEnvelope.data?.desiredGeneration !== quarantinedGenerationId
    || rollbackEnvelope.data?.appliedGeneration !== quarantinedGenerationId
    || !Array.isArray(rollbackEnvelope.data?.pendingSurfaces)
    || rollbackEnvelope.data.pendingSurfaces.length !== 0
    || after.commit.pluginGenerations?.[pluginId]?.immutableGenerationId !== quarantinedGenerationId
    || after.revision.plugins?.[pluginId]?.enabled !== true
    || after.revision.runtimeCatalog?.plugins?.[pluginId]?.state?.enabled !== true
    || afterHealth?.fingerprint !== beforeHealth.fingerprint
    || afterHealth?.state !== 'trial'
    || afterHealth?.tryOnce !== 'consumed'
    || afterTombstone?.state !== 'consumed'
    || invocation?.pluginId !== pluginId
    || invocation?.version !== '5.0.0'
    || !Number.isInteger(invocation?.pid)
    || typeof invocation?.activationInstanceId !== 'string'
  ) {
    fail(`Explicit rollback did not consume and serve the exact quarantined generation: ${JSON.stringify({
      pluginId,
      healthyGenerationId,
      quarantinedGenerationId,
      beforeCurrent: before.commit.pluginGenerations?.[pluginId],
      beforeHealth,
      beforeTombstone,
      rollback: rollbackEnvelope.data,
      afterCurrent: after.commit.pluginGenerations?.[pluginId],
      afterHealth,
      afterTombstone,
      invocation,
    })}`);
  }
  return {
    fromGeneration: healthyGenerationId,
    toGeneration: quarantinedGenerationId,
    fingerprint: afterHealth.fingerprint,
    tryOnce: afterHealth.tryOnce,
    servingVersion: invocation.version,
    activationInstanceId: invocation.activationInstanceId,
  };
}

export function assertCleanupFailureDidNotBlockLaterMutation({
  pluginId,
  retiredGenerationId,
  cleanupFailure,
  uninstallEnvelope,
  laterMutationEnvelope,
  laterInvocation,
}) {
  const laterChange = laterMutationEnvelope.change;
  if (
    cleanupFailure?.kind !== 'cleanup-failure'
    || cleanupFailure?.version !== '5.0.0'
    || typeof cleanupFailure.activationInstanceId !== 'string'
    || !Number.isInteger(cleanupFailure.pid)
    || uninstallEnvelope.data?.pluginId !== pluginId
    || uninstallEnvelope.data?.desiredGeneration !== null
    || uninstallEnvelope.data?.appliedGeneration !== null
    || !Array.isArray(uninstallEnvelope.data?.pendingSurfaces)
    || laterChange?.kind !== 'committed'
    || laterChange.pluginId !== pluginId
    || typeof laterChange.desiredGeneration !== 'string'
    || laterChange.desiredGeneration === retiredGenerationId
    || laterChange.appliedGeneration !== laterChange.desiredGeneration
    || !Array.isArray(laterChange.pendingSurfaces)
    || laterInvocation?.pluginId !== pluginId
    || laterInvocation?.version !== '6.0.0'
    || !Number.isInteger(laterInvocation?.pid)
    || typeof laterInvocation?.activationInstanceId !== 'string'
  ) {
    fail(`Activation cleanup failure stranded a later same-plugin mutation: ${JSON.stringify({
      pluginId,
      retiredGenerationId,
      cleanupFailure,
      uninstall: uninstallEnvelope.data,
      laterChange,
      laterInvocation,
    })}`);
  }
  return {
    retiredGeneration: retiredGenerationId,
    cleanupFailureVersion: cleanupFailure.version,
    cleanupFailureActivationInstanceId: cleanupFailure.activationInstanceId,
    laterGeneration: laterChange.desiredGeneration,
    laterServingVersion: laterInvocation.version,
  };
}

export function assertUniqueSupervisedAttemptProgress({
  initialConsumedAttemptIds,
  attempts,
}) {
  let prior = [...initialConsumedAttemptIds];
  if (new Set(prior).size !== prior.length) {
    fail(`Initial supervised attempt ids were not unique: ${JSON.stringify(prior)}`);
  }
  for (const attempt of attempts) {
    const current = [...attempt.consumedAttemptIds];
    const priorSet = new Set(prior);
    const added = current.filter((attemptId) => !priorSet.has(attemptId));
    if (
      new Set(current).size !== current.length
      || prior.some((attemptId) => !current.includes(attemptId))
      || added.length !== 1
      || current.length !== prior.length + 1
    ) {
      fail(`Fatal restart ${attempt.attemptNumber} did not add exactly one new supervised attempt id: ${JSON.stringify({
        prior,
        current,
        added,
      })}`);
    }
    prior = current;
  }
  return prior;
}

export async function waitForSupervisedAttemptProgress({
  generationId,
  priorConsumedAttemptIds,
  readState,
  timeoutMs,
  pollIntervalMs = 250,
  nowMs = Date.now,
  sleep = async (delayMs) => await new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
}) {
  const prior = [...priorConsumedAttemptIds];
  const priorSet = new Set(prior);
  if (priorSet.size !== prior.length) {
    fail(`Prior supervised attempt ids were not unique: ${JSON.stringify(prior)}`);
  }
  const startedAtMs = nowMs();
  while (true) {
    const state = await readState();
    const current = [...(state.revision.health?.[generationId]?.consumedAttemptIds ?? [])];
    const added = current.filter((attemptId) => !priorSet.has(attemptId));
    if (
      new Set(current).size !== current.length
      || prior.some((attemptId) => !current.includes(attemptId))
      || added.length > 1
      || current.length > prior.length + 1
    ) {
      fail(`Supervised fatal attempt persistence diverged while waiting: ${JSON.stringify({
        generationId,
        prior,
        current,
        added,
      })}`);
    }
    if (added.length === 1 && current.length === prior.length + 1) {
      return { state, consumedAttemptIds: current };
    }
    if (nowMs() - startedAtMs >= timeoutMs) {
      fail(`Timed out waiting for one supervised fatal attempt to persist: ${JSON.stringify({
        generationId,
        prior,
        current,
        timeoutMs,
      })}`);
    }
    await sleep(pollIntervalMs);
  }
}

export function assertRestartPreservedDesiredGeneration({
  initialCommit,
  restartCommit,
  pluginId,
  desiredGeneration,
}) {
  const initialGeneration = initialCommit.pluginGenerations?.[pluginId];
  const restartGeneration = restartCommit.pluginGenerations?.[pluginId];
  if (
    restartCommit.revision < initialCommit.revision
    || initialGeneration?.immutableGenerationId !== desiredGeneration
    || JSON.stringify(restartGeneration) !== JSON.stringify(initialGeneration)
  ) {
    fail(`Daemon restart changed durable desired generation: ${JSON.stringify({
      pluginId,
      desiredGeneration,
      initialRevision: initialCommit.revision,
      restartRevision: restartCommit.revision,
      initialGeneration,
      restartGeneration,
    })}`);
  }
}

export function assertReviewedCandidatePreservedCurrentness({
  initialCommit,
  currentCommit,
  pluginId,
  desiredGeneration,
  installedPlugin,
}) {
  const initialGeneration = initialCommit.pluginGenerations?.[pluginId];
  const currentGeneration = currentCommit.pluginGenerations?.[pluginId];
  if (
    currentCommit.revision < initialCommit.revision
    || initialGeneration?.immutableGenerationId !== desiredGeneration
    || JSON.stringify(currentGeneration) !== JSON.stringify(initialGeneration)
    || installedPlugin?.pluginId !== pluginId
    || installedPlugin.enabled !== true
    || installedPlugin.desiredGeneration !== desiredGeneration
    || installedPlugin.appliedGeneration !== desiredGeneration
  ) {
    fail(`Reviewed but uncommitted takeover candidate changed canonical currentness: ${JSON.stringify({
      pluginId,
      desiredGeneration,
      initialRevision: initialCommit.revision,
      currentRevision: currentCommit.revision,
      initialGeneration,
      currentGeneration,
      installedPlugin,
    })}`);
  }
}

function fail(message) {
  throw new Error(message);
}

export function formatPackedQualifiedConnectedAccountHttpFailure({
  method,
  path,
  status,
}) {
  let pathname = '<invalid-path>';
  try {
    pathname = new URL(path, 'http://packed-harness.invalid').pathname;
  } catch {
    // Keep malformed request identity out of diagnostics.
  }
  return `Packed Qualified Connected Account ${method} ${pathname} failed (${status})`;
}

export function summarizeBundledClaudeCleanupFailure({
  expectedCredentialRevision,
  cleanup,
}) {
  const credentialBeforeRevoke = cleanup?.credentialBeforeRevoke ?? null;
  const revoked = cleanup?.revoked ?? null;
  return Object.freeze({
    credentialBeforeRevokePresent: credentialBeforeRevoke !== null,
    credentialRevisionMatched:
      typeof credentialBeforeRevoke?.credentialRevision === 'string'
      && credentialBeforeRevoke.credentialRevision === expectedCredentialRevision,
    revoke: Object.freeze({
      status: typeof revoked?.status === 'string' ? revoked.status : null,
      code: typeof revoked?.code === 'string' ? revoked.code : null,
      remoteStatus:
        typeof revoked?.remoteStatus === 'string' ? revoked.remoteStatus : null,
    }),
    durableCredentialPresent: cleanup?.credentialAfterRevoke != null,
    durableAccountPresent: cleanup?.accountAfterRevoke != null,
  });
}

export function assertPackedAuthorCredentialSentinelsAbsent({
  commandOutputs,
  logs,
  markerLog,
  result,
  sentinels = PACKED_AUTHOR_SYNTHETIC_CREDENTIAL_SENTINELS,
}) {
  const surfaces = [
    ...(Array.isArray(commandOutputs)
      ? commandOutputs.flatMap((output) => [
          ['command stdout', String(output?.stdout ?? '')],
          ['command stderr', String(output?.stderr ?? '')],
        ])
      : []),
    ...(Array.isArray(logs)
      ? logs.map((log) => ['log', String(log ?? '')])
      : []),
    ['marker log', String(markerLog ?? '')],
    ['result', JSON.stringify(result ?? null)],
  ];
  for (const sentinel of sentinels) {
    if (typeof sentinel !== 'string' || sentinel.length === 0) {
      fail('Packed credential sentinels must be non-empty strings');
    }
    for (const [surface, evidence] of surfaces) {
      if (evidence.includes(sentinel)) {
        fail(`Packed credential sentinel reached ${surface}`);
      }
    }
  }
}

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
  return value;
}

export function parseRunnerArgs(argv) {
  const scenario = readFlagValue(argv, '--scenario');
  const sdkTarballPath = readFlagValue(argv, '--sdk-tarball');
  const cliTarballPath = readFlagValue(argv, '--cli-tarball');
  const packedNovelQaHandoffRoot = readFlagValue(
    argv,
    '--packed-novel-qa-handoff-root',
  );
  if (scenario !== 'vertical-a') fail('Only --scenario vertical-a is currently supported');
  if (!sdkTarballPath) fail('Missing --sdk-tarball <sdk-tarball>');
  if (!cliTarballPath) fail('Missing --cli-tarball <cli-tarball>');
  if (argv.includes('--candidate')) {
    fail('Ordinary Vertical-A admission does not accept --candidate');
  }
  return {
    scenario,
    sdkTarballPath,
    cliTarballPath,
    ...(packedNovelQaHandoffRoot === null
      ? {}
      : { packedNovelQaHandoffRoot }),
  };
}

async function readNaturalArtifactBytes({
  artifactPath,
  label,
  readFileImpl,
  lstatImpl,
}) {
  const stats = await lstatImpl(artifactPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail(`${label} must be an exact regular file`);
  }
  return Buffer.from(await readFileImpl(artifactPath));
}

export async function loadPackedAuthorNaturalArtifacts(
  argv,
  {
    cwd = process.cwd(),
    createRunId = () => `natural-${randomUUID()}`,
    readFileImpl = readFile,
    lstatImpl = lstat,
    createPackedAuthorCandidateImpl = async (params) => {
      const candidateCreator = await import('./create-packed-author-candidate.mjs');
      return await candidateCreator.createPackedAuthorCandidate(params);
    },
  } = {},
) {
  const {
    sdkTarballPath: sdkArgument,
    cliTarballPath: cliArgument,
  } = parseRunnerArgs(argv);
  const sdkTarballPath = resolve(cwd, sdkArgument);
  const cliTarballPath = resolve(cwd, cliArgument);
  const runId = createRunId();
  if (
    typeof runId !== 'string'
    || runId.length > 64
    || !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/u.test(runId)
  ) {
    fail('Natural artifact run identity must be a bounded lower-case identifier');
  }
  const candidate = await createPackedAuthorCandidateImpl({
    runId,
    sdkTarballPath,
    cliTarballPath,
  });
  const [currentSdkBytes, currentCliBytes] = await Promise.all([
    readNaturalArtifactBytes({
      artifactPath: sdkTarballPath,
      label: 'SDK tarball',
      readFileImpl,
      lstatImpl,
    }),
    readNaturalArtifactBytes({
      artifactPath: cliTarballPath,
      label: 'CLI tarball',
      readFileImpl,
      lstatImpl,
    }),
  ]);
  if (sha512Sri(currentSdkBytes) !== candidate.sdk.integrity) {
    fail('SDK tarball changed during admission');
  }
  if (sha512Sri(currentCliBytes) !== candidate.cli.integrity) {
    fail('CLI tarball changed during admission');
  }
  return candidate;
}

function resolveManifestPath(manifestDir, pathLike) {
  if (typeof pathLike !== 'string' || pathLike.trim().length === 0) {
    fail('Candidate artifact path must be a non-empty string');
  }
  return isAbsolute(pathLike) ? resolve(pathLike) : resolve(manifestDir, pathLike);
}

function assertExactCandidateRecordKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const normalizedExpectedKeys = [...expectedKeys].sort((left, right) => (
    left.localeCompare(right)
  ));
  if (
    actualKeys.length !== normalizedExpectedKeys.length
    || actualKeys.some((key, index) => key !== normalizedExpectedKeys[index])
  ) {
    fail(`Candidate ${label} has unexpected or missing fields`);
  }
}

function parseCandidateBoundFile({
  value,
  manifestDir,
  field,
  kind,
  fileName,
}) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.kind !== kind
    || value.fileName !== fileName
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes <= 0
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    fail(`Candidate ${field} must be an exact bound ${fileName} record`);
  }
  assertExactCandidateRecordKeys(
    value,
    ['kind', 'fileName', 'sizeBytes', 'sha256', 'filePath'],
    field,
  );
  const filePath = resolveManifestPath(manifestDir, value.filePath);
  const relativeFilePath = relative(manifestDir, filePath);
  if (
    basename(filePath) !== fileName
    || relativeFilePath === '..'
    || relativeFilePath.startsWith(`..${sep}`)
    || isAbsolute(relativeFilePath)
  ) {
    fail(`Candidate ${field} path must stay inside the manifest run root`);
  }
  return {
    kind,
    fileName,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    filePath,
  };
}

export function parseCandidateManifest(raw, manifestPath) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Candidate manifest must be an object');
  if (value.schemaVersion !== 1) fail('Candidate manifest schemaVersion must be 1');
  if (
    typeof value.runId !== 'string'
    || value.runId.length > 64
    || !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/u.test(value.runId)
  ) {
    fail('Candidate manifest runId must be a bounded lower-case identifier');
  }
  const manifestDir = dirname(manifestPath);
  const sdk = value.sdk;
  const cli = value.cli;
  const sourceBasis = value.sourceBasis;
  const standaloneCli = value.standaloneCli;
  const installers = value.installers;
  if (!sdk || typeof sdk !== 'object' || Array.isArray(sdk)) fail('Candidate manifest is missing sdk');
  if (!cli || typeof cli !== 'object' || Array.isArray(cli)) fail('Candidate manifest is missing cli');
  if (sdk.packageName !== SDK_PACKAGE_NAME) fail(`SDK packageName must be ${SDK_PACKAGE_NAME}`);
  if (typeof sdk.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(sdk.version)) {
    fail('SDK version must be a valid package semver');
  }
  if (typeof sdk.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(sdk.integrity)) {
    fail('SDK integrity must be sha512 SRI');
  }
  if (typeof cli.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(cli.integrity)) {
    fail('CLI integrity must be sha512 SRI');
  }
  if (cli.packageName !== CLI_PACKAGE_NAME) fail(`CLI packageName must be ${CLI_PACKAGE_NAME}`);
  if (typeof cli.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(cli.version)) {
    fail('CLI version must be a valid package semver');
  }
  const cliEntrypointSegments = typeof cli.entrypoint === 'string' ? cli.entrypoint.split('/') : [];
  if (
    cliEntrypointSegments.length < 2
    || cliEntrypointSegments[0] !== 'package'
    || cliEntrypointSegments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
  ) {
    fail('CLI entrypoint must be a forward-slash package-relative path contained by package/');
  }
  if (
    standaloneCli !== undefined
    && (
      !standaloneCli
      || typeof standaloneCli !== 'object'
      || Array.isArray(standaloneCli)
      || standaloneCli.product !== 'happier'
      || standaloneCli.version !== cli.version
      || typeof standaloneCli.os !== 'string'
      || !/^[a-z]+$/u.test(standaloneCli.os)
      || !['x64', 'arm64'].includes(standaloneCli.arch)
      || typeof standaloneCli.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(standaloneCli.sha256)
      || !Array.isArray(standaloneCli.archives)
    )
  ) {
    fail('Candidate standaloneCli must be a same-version canonical happier artifact record');
  }
  if (standaloneCli) {
    assertExactCandidateRecordKeys(
      standaloneCli,
      [
        'product',
        'version',
        'os',
        'arch',
        'sha256',
        'archivePath',
        'archives',
        'checksums',
        'signature',
        'notarization',
      ],
      'standaloneCli',
    );
  }
  const parsedStandaloneArchives = standaloneCli
    ? standaloneCli.archives.map((artifact, index) => {
        const expectedTarget = PACKED_AUTHOR_NATIVE_TARGETS[index];
        const [expectedOs, expectedArch] = expectedTarget?.split('-') ?? [];
        if (
          !artifact
          || typeof artifact !== 'object'
          || Array.isArray(artifact)
          || artifact.product !== 'happier'
          || artifact.version !== cli.version
          || artifact.os !== expectedOs
          || artifact.arch !== expectedArch
          || typeof artifact.sha256 !== 'string'
          || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        ) {
          fail('Candidate standaloneCli archives must be the exact five-target release matrix');
        }
        assertExactCandidateRecordKeys(
          artifact,
          [
            'product',
            'version',
            'os',
            'arch',
            'sha256',
            'archivePath',
          ],
          `standaloneCli.archives[${index}]`,
        );
        return {
          product: artifact.product,
          version: artifact.version,
          os: artifact.os,
          arch: artifact.arch,
          sha256: artifact.sha256,
          archivePath: resolveManifestPath(manifestDir, artifact.archivePath),
        };
      })
    : null;
  if (
    standaloneCli
    && parsedStandaloneArchives.length !== PACKED_AUTHOR_NATIVE_TARGETS.length
  ) {
    fail('Candidate standaloneCli archives must be the exact five-target release matrix');
  }
  const parsedStandaloneCli = standaloneCli
    ? {
        product: standaloneCli.product,
        version: standaloneCli.version,
        os: standaloneCli.os,
        arch: standaloneCli.arch,
        sha256: standaloneCli.sha256,
        archivePath:
          resolveManifestPath(manifestDir, standaloneCli.archivePath),
        archives: parsedStandaloneArchives,
        checksums: parseCandidateBoundFile({
          value: standaloneCli.checksums,
          manifestDir,
          field: 'standalone CLI checksums',
          kind: 'sha256-checksums',
          fileName: `checksums-happier-v${cli.version}.txt`,
        }),
        signature: standaloneCli.signature === null
          ? null
          : parseCandidateBoundFile({
              value: standaloneCli.signature,
              manifestDir,
              field: 'standalone CLI signature',
              kind: 'minisign-signature',
              fileName: `checksums-happier-v${cli.version}.txt.minisig`,
            }),
        notarization: Array.isArray(standaloneCli.notarization)
          ? standaloneCli.notarization.map((record, index) => {
              const target = PACKED_AUTHOR_NATIVE_TARGETS
                .filter((nativeTarget) => nativeTarget.startsWith('darwin-'))[index];
              if (
                !record
                || typeof record !== 'object'
                || Array.isArray(record)
                || record.target !== target
              ) {
                fail('Candidate standalone CLI notarization must bind both Darwin targets');
              }
              assertExactCandidateRecordKeys(
                record,
                ['target', 'evidence'],
                `standaloneCli.notarization[${index}]`,
              );
              return {
                target,
                evidence: parseCandidateBoundFile({
                  value: record.evidence,
                  manifestDir,
                  field: `${target} notarization evidence`,
                  kind: 'apple-notarization-evidence',
                  fileName: `${target}.cli.json`,
                }),
              };
            })
          : null,
      }
    : null;
  if (
    parsedStandaloneCli
    && parsedStandaloneCli.notarization?.length !== 2
  ) {
    fail('Candidate standalone CLI notarization must bind both Darwin targets');
  }
  if (parsedStandaloneCli) {
    const selected = parsedStandaloneCli.archives.find(
      (artifact) => (
        artifact.os === parsedStandaloneCli.os
        && artifact.arch === parsedStandaloneCli.arch
      ),
    );
    if (
      !selected
      || selected.sha256 !== parsedStandaloneCli.sha256
      || selected.archivePath !== parsedStandaloneCli.archivePath
    ) {
      fail('Candidate standaloneCli selection must reference its exact matrix member');
    }
  }
  if (
    !sourceBasis
    || typeof sourceBasis !== 'object'
    || Array.isArray(sourceBasis)
    || sourceBasis.algorithm !== 'sha256'
    || typeof sourceBasis.digest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(sourceBasis.digest)
  ) {
    fail('Candidate sourceBasis must be a canonical sha256 digest');
  }
  if (
    !installers
    || typeof installers !== 'object'
    || Array.isArray(installers)
    || installers.releaseChannel !== 'dev'
  ) {
    fail('Candidate installers must bind the dev release channel');
  }
  assertExactCandidateRecordKeys(
    installers,
    ['releaseChannel', 'shell', 'powershell', 'publicKey'],
    'installers',
  );
  const parsedInstallers = {
    releaseChannel: 'dev',
    shell: parseCandidateBoundFile({
      value: installers.shell,
      manifestDir,
      field: 'shell installer',
      kind: 'shell',
      fileName: 'install-dev.sh',
    }),
    powershell: parseCandidateBoundFile({
      value: installers.powershell,
      manifestDir,
      field: 'PowerShell installer',
      kind: 'powershell',
      fileName: 'install-dev.ps1',
    }),
    publicKey: parseCandidateBoundFile({
      value: installers.publicKey,
      manifestDir,
      field: 'installer public key',
      kind: 'minisign-public-key',
      fileName: 'happier-release.pub',
    }),
  };
  return {
    schemaVersion: 1,
    runId: value.runId,
    sourceBasis: {
      algorithm: sourceBasis.algorithm,
      digest: sourceBasis.digest,
    },
    installers: parsedInstallers,
    sdk: {
      packageName: sdk.packageName,
      version: sdk.version,
      integrity: sdk.integrity,
      tarballPath: resolveManifestPath(manifestDir, sdk.tarballPath),
    },
    cli: {
      packageName: cli.packageName,
      version: cli.version,
      integrity: cli.integrity,
      tarballPath: resolveManifestPath(manifestDir, cli.tarballPath),
      entrypoint: cli.entrypoint,
    },
    ...(parsedStandaloneCli
      ? {
          standaloneCli: parsedStandaloneCli,
        }
      : {}),
  };
}

export async function assertPackedAuthorCandidateInstallerArtifacts(
  candidate,
  {
    manifestPath,
    readFileImpl = readFile,
    lstatImpl = lstat,
    realpathImpl = realpath,
  } = {},
) {
  const manifestDir = dirname(resolve(manifestPath));
  const physicalManifestDir = await realpathImpl(manifestDir);
  for (const field of ['shell', 'powershell', 'publicKey']) {
    const artifact = candidate?.installers?.[field];
    const stats = await lstatImpl(artifact.filePath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.size !== artifact.sizeBytes
    ) {
      fail(`Candidate installer artifact is not an exact regular file: ${field}`);
    }
    const physicalArtifactPath = await realpathImpl(artifact.filePath);
    const relativeArtifactPath = relative(physicalManifestDir, physicalArtifactPath);
    if (
      relativeArtifactPath === '..'
      || relativeArtifactPath.startsWith(`..${sep}`)
      || isAbsolute(relativeArtifactPath)
    ) {
      fail(`Candidate installer artifact escaped the manifest run root: ${field}`);
    }
    const bytes = await readFileImpl(artifact.filePath);
    if (
      bytes.length !== artifact.sizeBytes
      || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    ) {
      fail(`Candidate installer artifact integrity mismatch: ${field}`);
    }
  }
}

async function readVerifiedCandidateArtifact({
  artifactPath,
  manifestDir,
  label,
  expectedSizeBytes = null,
  expectedSha256 = null,
  expectedSha512Sri = null,
  readFileImpl,
  lstatImpl,
  realpathImpl,
}) {
  const physicalManifestDir = await realpathImpl(manifestDir);
  const stats = await lstatImpl(artifactPath);
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || (expectedSizeBytes !== null && stats.size !== expectedSizeBytes)
  ) {
    fail(`Candidate ${label} is not an exact regular file`);
  }
  const physicalArtifactPath = await realpathImpl(artifactPath);
  const relativeArtifactPath = relative(physicalManifestDir, physicalArtifactPath);
  if (
    relativeArtifactPath === '..'
    || relativeArtifactPath.startsWith(`..${sep}`)
    || isAbsolute(relativeArtifactPath)
  ) {
    fail(`Candidate ${label} escaped the manifest run root`);
  }
  const bytes = Buffer.from(await readFileImpl(artifactPath));
  if (
    (expectedSizeBytes !== null && bytes.length !== expectedSizeBytes)
    || (
      expectedSha256 !== null
      && createHash('sha256').update(bytes).digest('hex') !== expectedSha256
    )
    || (
      expectedSha512Sri !== null
      && `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        !== expectedSha512Sri
    )
  ) {
    fail(`Candidate ${label} integrity mismatch`);
  }
  return bytes;
}

export async function assertPackedAuthorCandidateManifestArtifacts(
  candidate,
  {
    manifestPath,
    readFileImpl = readFile,
    lstatImpl = lstat,
    realpathImpl = realpath,
  } = {},
) {
  const manifestDir = dirname(resolve(manifestPath));
  const common = {
    manifestDir,
    readFileImpl,
    lstatImpl,
    realpathImpl,
  };
  await Promise.all([
    readVerifiedCandidateArtifact({
      ...common,
      artifactPath: candidate.sdk.tarballPath,
      label: 'SDK tarball',
      expectedSha512Sri: candidate.sdk.integrity,
    }),
    readVerifiedCandidateArtifact({
      ...common,
      artifactPath: candidate.cli.tarballPath,
      label: 'CLI tarball',
      expectedSha512Sri: candidate.cli.integrity,
    }),
    assertPackedAuthorCandidateInstallerArtifacts(candidate, {
      manifestPath,
      readFileImpl,
      lstatImpl,
      realpathImpl,
    }),
  ]);
  if (!candidate.standaloneCli) return;

  const [archiveResults, checksumsBytes] = await Promise.all([
    Promise.all(candidate.standaloneCli.archives.map((artifact) => (
      readVerifiedCandidateArtifact({
        ...common,
        artifactPath: artifact.archivePath,
        label: `standalone CLI archive ${artifact.os}-${artifact.arch}`,
        expectedSha256: artifact.sha256,
      })
    ))),
    readVerifiedCandidateArtifact({
      ...common,
      artifactPath: candidate.standaloneCli.checksums.filePath,
      label: 'standalone CLI checksums',
      expectedSizeBytes: candidate.standaloneCli.checksums.sizeBytes,
      expectedSha256: candidate.standaloneCli.checksums.sha256,
    }),
  ]);
  const checksumEntries = parseArtifactChecksums(checksumsBytes.toString('utf8'));
  const checksumEntriesByName = new Map(
    checksumEntries.map((entry) => [entry.name, entry.sha256]),
  );
  if (
    checksumEntries.length !== candidate.standaloneCli.archives.length
    || candidate.standaloneCli.archives.some((artifact, index) => (
      checksumEntriesByName.get(basename(artifact.archivePath))
        !== createHash('sha256').update(archiveResults[index]).digest('hex')
    ))
  ) {
    fail('Candidate standalone CLI checksums do not bind the exact five-archive matrix');
  }
  if (candidate.standaloneCli.signature) {
    await readVerifiedCandidateArtifact({
      ...common,
      artifactPath: candidate.standaloneCli.signature.filePath,
      label: 'standalone CLI signature',
      expectedSizeBytes: candidate.standaloneCli.signature.sizeBytes,
      expectedSha256: candidate.standaloneCli.signature.sha256,
    });
  }
  await Promise.all(candidate.standaloneCli.notarization.map((record) => (
    readVerifiedCandidateArtifact({
      ...common,
      artifactPath: record.evidence.filePath,
      label: `${record.target} notarization evidence`,
      expectedSizeBytes: record.evidence.sizeBytes,
      expectedSha256: record.evidence.sha256,
    })
  )));
}

export async function loadPackedAuthorCandidateManifest(
  argv,
  {
    cwd = process.cwd(),
    readFileImpl = async (manifestPath) => await readFile(manifestPath, 'utf8'),
    parseCandidateManifestImpl = parseCandidateManifest,
    assertCandidateArtifactsImpl = assertPackedAuthorCandidateManifestArtifacts,
  } = {},
) {
  const candidateArgument = readFlagValue(argv, '--candidate');
  if (!candidateArgument) fail('Missing --candidate <candidate-manifest>');
  const manifestPath = resolve(cwd, candidateArgument);
  const raw = await readFileImpl(manifestPath);
  const candidate = parseCandidateManifestImpl(
    typeof raw === 'string' ? raw : raw.toString('utf8'),
    manifestPath,
  );
  await assertCandidateArtifactsImpl(candidate, { manifestPath });
  return candidate;
}

function isPathInsideRoot(root, target) {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function assertExactPackedNovelQaKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`Packed novel QA ${label} must be an object`);
  }
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right));
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(`Packed novel QA ${label} has unexpected or missing fields`);
  }
}

function resolvePackedNovelQaContainedPath(root, pathLike, label) {
  if (
    typeof pathLike !== 'string'
    || pathLike.length === 0
    || isAbsolute(pathLike)
  ) {
    fail(`Packed novel QA ${label} must be a non-empty relative path`);
  }
  const target = resolve(root, pathLike);
  if (!isPathInsideRoot(root, target) || target === root) {
    fail(`Packed novel QA ${label} must remain inside its handoff root`);
  }
  return target;
}

function parsePackedNovelQaCandidateIdentity(value) {
  assertExactPackedNovelQaKeys(
    value,
    ['sdk', 'cli'],
    'candidate identity',
  );
  const parseArtifact = (artifact, packageName, label) => {
    assertExactPackedNovelQaKeys(
      artifact,
      ['packageName', 'version', 'integrity'],
      `${label} candidate identity`,
    );
    if (
      artifact.packageName !== packageName
      || typeof artifact.version !== 'string'
      || artifact.version.length === 0
      || typeof artifact.integrity !== 'string'
      || artifact.integrity.length === 0
    ) {
      fail(`Packed novel QA ${label} candidate identity is invalid`);
    }
    return Object.freeze({ ...artifact });
  };
  return Object.freeze({
    sdk: parseArtifact(value.sdk, SDK_PACKAGE_NAME, 'SDK'),
    cli: parseArtifact(value.cli, CLI_PACKAGE_NAME, 'CLI'),
  });
}

function parsePackedNovelQaConsumer(value, root, label) {
  assertExactPackedNovelQaKeys(
    value,
    ['root', 'happyHomeDir', 'databasePath'],
    `${label} consumer`,
  );
  const parsed = Object.freeze({
    root: resolvePackedNovelQaContainedPath(root, value.root, `${label} root`),
    happyHomeDir: resolvePackedNovelQaContainedPath(
      root,
      value.happyHomeDir,
      `${label} daemon home`,
    ),
    databasePath: resolvePackedNovelQaContainedPath(
      root,
      value.databasePath,
      `${label} database`,
    ),
  });
  const distinctPaths = new Set(Object.values(parsed));
  if (
    distinctPaths.size !== Object.keys(parsed).length
    || !isPathInsideRoot(parsed.root, parsed.happyHomeDir)
    || !isPathInsideRoot(parsed.root, parsed.databasePath)
  ) {
    fail(`Packed novel QA ${label} isolation paths are invalid`);
  }
  return parsed;
}

export function parsePackedNovelConnectedAccountQaHandoff(
  raw,
  manifestPath,
) {
  const value = JSON.parse(raw);
  assertExactPackedNovelQaKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'runId',
      'rootId',
      'candidate',
      'plugin',
      'lifecycle',
      'consumers',
      'oauth',
      'cleanup',
    ],
    'handoff manifest',
  );
  if (
    value.schemaVersion !== 1
    || value.kind !== PACKED_NOVEL_QA_HANDOFF_KIND
    || typeof value.runId !== 'string'
    || !/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(value.runId)
    || typeof value.rootId !== 'string'
    || !/^[a-f0-9-]{36}$/u.test(value.rootId)
  ) {
    fail('Packed novel QA handoff identity is invalid');
  }
  const root = dirname(resolve(manifestPath));
  if (basename(manifestPath) !== PACKED_NOVEL_QA_HANDOFF_MANIFEST_FILE) {
    fail(`Packed novel QA manifest must be named ${PACKED_NOVEL_QA_HANDOFF_MANIFEST_FILE}`);
  }
  const candidate = parsePackedNovelQaCandidateIdentity(value.candidate);
  assertExactPackedNovelQaKeys(
    value.plugin,
    [
      'pluginId',
      'version',
      'service',
      'authenticationModeIds',
      'archive',
    ],
    'plugin',
  );
  assertExactPackedNovelQaKeys(
    value.plugin.service,
    ['pluginId', 'localId'],
    'qualified service',
  );
  if (
    value.plugin.pluginId !== PACKED_NOVEL_QA_PLUGIN_ID
    || value.plugin.service.pluginId !== PACKED_NOVEL_QA_SERVICE.pluginId
    || value.plugin.service.localId !== PACKED_NOVEL_QA_SERVICE.localId
    || JSON.stringify(value.plugin.authenticationModeIds)
      !== JSON.stringify(PACKED_NOVEL_QA_AUTHENTICATION_MODE_IDS)
  ) {
    fail('Packed novel QA handoff must use the exact acme.vertical-a/novel-cloud fixture');
  }
  if (value.plugin.version !== '1.0.0') {
    fail('Packed novel QA plugin version is invalid');
  }
  assertExactPackedNovelQaKeys(
    value.plugin.archive,
    ['path', 'packOwner', 'packLabel', 'integrity', 'sha256', 'sizeBytes'],
    'archive',
  );
  if (
    value.plugin.archive.packOwner
      !== 'run-packed-author-ui-compat#packCurrentPlugin'
    || value.plugin.archive.packLabel !== 'initial-v1'
    || typeof value.plugin.archive.integrity !== 'string'
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.plugin.archive.integrity)
    || typeof value.plugin.archive.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.plugin.archive.sha256)
    || !Number.isSafeInteger(value.plugin.archive.sizeBytes)
    || value.plugin.archive.sizeBytes <= 0
  ) {
    fail('Packed novel QA archive provenance is invalid');
  }
  const archivePath = resolvePackedNovelQaContainedPath(
    root,
    value.plugin.archive.path,
    'archive path',
  );
  assertExactPackedNovelQaKeys(
    value.lifecycle,
    ['scenario', 'completedStageIds'],
    'lifecycle',
  );
  if (
    value.lifecycle.scenario !== 'vertical-a'
    || JSON.stringify(value.lifecycle.completedStageIds)
      !== JSON.stringify(VERTICAL_A_REQUIRED_STAGE_IDS)
  ) {
    fail('Packed novel QA handoff requires the complete canonical Vertical-A lifecycle');
  }
  assertExactPackedNovelQaKeys(
    value.consumers,
    ['browser', 'device'],
    'consumers',
  );
  const consumers = Object.freeze({
    browser: parsePackedNovelQaConsumer(value.consumers.browser, root, 'browser'),
    device: parsePackedNovelQaConsumer(value.consumers.device, root, 'device'),
  });
  if (
    Object.values(consumers.browser).some((path) => (
      Object.values(consumers.device).includes(path)
    ))
  ) {
    fail('Packed novel QA browser and device isolation roots must be distinct');
  }
  assertExactPackedNovelQaKeys(
    value.oauth,
    [
      'authorizationOriginConfigurationFieldId',
      'callbackUrl',
      'authorizePath',
      'transport',
    ],
    'OAuth handoff',
  );
  if (
    value.oauth.authorizationOriginConfigurationFieldId
      !== 'authorization-origin'
    || value.oauth.callbackUrl !== PACKED_NOVEL_QA_CALLBACK_URL
    || value.oauth.authorizePath !== '/authorize'
    || value.oauth.transport !== 'ephemeral-https-loopback'
  ) {
    fail('Packed novel QA OAuth handoff is invalid');
  }
  assertExactPackedNovelQaKeys(
    value.cleanup,
    ['owner', 'markerPath'],
    'cleanup',
  );
  if (
    value.cleanup.owner
      !== 'cleanupPackedNovelConnectedAccountQaHandoff'
  ) {
    fail('Packed novel QA cleanup owner is invalid');
  }
  const markerPath = resolvePackedNovelQaContainedPath(
    root,
    value.cleanup.markerPath,
    'cleanup marker',
  );
  if (basename(markerPath) !== PACKED_NOVEL_QA_HANDOFF_MARKER_FILE) {
    fail('Packed novel QA cleanup marker identity is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: PACKED_NOVEL_QA_HANDOFF_KIND,
    runId: value.runId,
    rootId: value.rootId,
    manifestPath: resolve(manifestPath),
    root,
    candidate,
    plugin: Object.freeze({
      pluginId: value.plugin.pluginId,
      version: value.plugin.version,
      service: Object.freeze({ ...value.plugin.service }),
      authenticationModeIds:
        Object.freeze([...value.plugin.authenticationModeIds]),
      archive: Object.freeze({
        ...value.plugin.archive,
        archivePath,
      }),
      archivePath,
    }),
    lifecycle: Object.freeze({
      scenario: 'vertical-a',
      completedStageIds:
        Object.freeze([...value.lifecycle.completedStageIds]),
    }),
    consumers,
    oauth: Object.freeze({ ...value.oauth }),
    cleanup: Object.freeze({
      owner: value.cleanup.owner,
      markerPath,
    }),
  });
}

async function assertPackedNovelQaRegularContainedFile({
  path,
  physicalRoot,
  label,
}) {
  const fileStats = await lstat(path);
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    fail(`Packed novel QA ${label} must be an exact regular file`);
  }
  const physicalPath = await realpath(path);
  if (!isPathInsideRoot(physicalRoot, physicalPath)) {
    fail(`Packed novel QA ${label} escaped its physical handoff root`);
  }
  return physicalPath;
}

async function assertPackedNovelQaContainedDirectory({
  path,
  physicalRoot,
  label,
}) {
  const directoryStats = await lstat(path);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    fail(
      `Packed novel QA ${label} must be an exact physically contained directory`,
    );
  }
  const physicalPath = await realpath(path);
  if (!isPathInsideRoot(physicalRoot, physicalPath)) {
    fail(
      `Packed novel QA ${label} must be an exact physically contained directory`,
    );
  }
  return physicalPath;
}

async function readAndVerifyPackedNovelQaMarker(handoff) {
  const rootStats = await lstat(handoff.root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail('Packed novel QA root must be an exact directory');
  }
  const physicalRoot = await realpath(handoff.root);
  await assertPackedNovelQaRegularContainedFile({
    path: handoff.cleanup.markerPath,
    physicalRoot,
    label: 'cleanup marker',
  });
  const marker = JSON.parse(
    await readFile(handoff.cleanup.markerPath, 'utf8'),
  );
  assertExactPackedNovelQaKeys(
    marker,
    ['kind', 'runId', 'rootId'],
    'cleanup marker',
  );
  if (
    marker.kind !== PACKED_NOVEL_QA_HANDOFF_KIND
    || marker.runId !== handoff.runId
    || marker.rootId !== handoff.rootId
  ) {
    fail('Packed novel QA cleanup marker does not match its handoff');
  }
  return physicalRoot;
}

export async function loadPackedNovelConnectedAccountQaHandoff({
  manifestPath,
}) {
  const resolvedManifestPath = resolve(manifestPath);
  const manifestStats = await lstat(resolvedManifestPath);
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    fail('Packed novel QA manifest must be an exact regular file');
  }
  const handoff = parsePackedNovelConnectedAccountQaHandoff(
    await readFile(resolvedManifestPath, 'utf8'),
    resolvedManifestPath,
  );
  const physicalRoot = await readAndVerifyPackedNovelQaMarker(handoff);
  await assertPackedNovelQaRegularContainedFile({
    path: handoff.plugin.archivePath,
    physicalRoot,
    label: 'archive',
  });
  const archiveBytes = await readFile(handoff.plugin.archivePath);
  if (
    archiveBytes.byteLength !== handoff.plugin.archive.sizeBytes
    || sha512Sri(archiveBytes) !== handoff.plugin.archive.integrity
    || createHash('sha256').update(archiveBytes).digest('hex')
      !== handoff.plugin.archive.sha256
  ) {
    fail('Packed novel QA archive integrity mismatch or archive size mismatch');
  }
  for (const [consumerId, consumer] of Object.entries(handoff.consumers)) {
    await Promise.all([
      assertPackedNovelQaContainedDirectory({
        path: consumer.root,
        physicalRoot,
        label: `${consumerId} root`,
      }),
      assertPackedNovelQaContainedDirectory({
        path: consumer.happyHomeDir,
        physicalRoot,
        label: `${consumerId} daemon home`,
      }),
      assertPackedNovelQaContainedDirectory({
        path: dirname(consumer.databasePath),
        physicalRoot,
        label: `${consumerId} database parent`,
      }),
    ]);
    try {
      await assertPackedNovelQaRegularContainedFile({
        path: consumer.databasePath,
        physicalRoot,
        label: `${consumerId} database`,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assertPackedAuthorCredentialSentinelsAbsent({
    commandOutputs: [],
    markerLog: '',
    result: handoff,
  });
  return handoff;
}

function packedNovelQaConsumerPaths(consumerId) {
  const root = join('consumers', consumerId);
  return Object.freeze({
    root,
    happyHomeDir: join(root, 'happier-home'),
    databasePath: join(root, 'server-data', 'happier-server-light.sqlite'),
  });
}

export async function createPackedNovelConnectedAccountQaHandoff({
  outputRoot,
  candidate,
  archiveBytes,
  pluginArtifact,
  stages,
}) {
  const resolvedOutputRoot = resolve(outputRoot);
  try {
    await lstat(resolvedOutputRoot);
    fail('Packed novel QA handoff root must not already exist');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (
    pluginArtifact?.label !== 'initial-v1'
    || pluginArtifact?.pluginId !== PACKED_NOVEL_QA_PLUGIN_ID
    || pluginArtifact?.version !== '1.0.0'
    || pluginArtifact.integrity !== sha512Sri(archiveBytes)
    || pluginArtifact.size !== archiveBytes.byteLength
  ) {
    fail('Packed novel QA handoff requires the exact initial pack-owner bytes');
  }
  const completedStageIds = stages.map(({ id, ok }) => ok === true ? id : null);
  if (
    completedStageIds.includes(null)
    || JSON.stringify(completedStageIds)
      !== JSON.stringify(VERTICAL_A_REQUIRED_STAGE_IDS)
  ) {
    fail('Packed novel QA handoff requires the complete canonical Vertical-A lifecycle');
  }
  const browser = packedNovelQaConsumerPaths('browser');
  const device = packedNovelQaConsumerPaths('device');
  const archiveRelativePath = join(
    'plugin',
    `${PACKED_NOVEL_QA_PLUGIN_ID}.happier-plugin.tgz`,
  );
  const markerRelativePath = PACKED_NOVEL_QA_HANDOFF_MARKER_FILE;
  const rootId = randomUUID();
  const oauth = Object.freeze({
    authorizationOriginConfigurationFieldId: 'authorization-origin',
    callbackUrl: PACKED_NOVEL_QA_CALLBACK_URL,
    authorizePath: '/authorize',
    transport: 'ephemeral-https-loopback',
  });
  const manifest = {
    schemaVersion: 1,
    kind: PACKED_NOVEL_QA_HANDOFF_KIND,
    runId: candidate.runId,
    rootId,
    candidate: {
      sdk: {
        packageName: candidate.sdk.packageName,
        version: candidate.sdk.version,
        integrity: candidate.sdk.integrity,
      },
      cli: {
        packageName: candidate.cli.packageName,
        version: candidate.cli.version,
        integrity: candidate.cli.integrity,
      },
    },
    plugin: {
      pluginId: PACKED_NOVEL_QA_PLUGIN_ID,
      version: pluginArtifact.version,
      service: PACKED_NOVEL_QA_SERVICE,
      authenticationModeIds: PACKED_NOVEL_QA_AUTHENTICATION_MODE_IDS,
      archive: {
        path: archiveRelativePath,
        packOwner: 'run-packed-author-ui-compat#packCurrentPlugin',
        packLabel: pluginArtifact.label,
        integrity: pluginArtifact.integrity,
        sha256: createHash('sha256').update(archiveBytes).digest('hex'),
        sizeBytes: archiveBytes.byteLength,
      },
    },
    lifecycle: {
      scenario: 'vertical-a',
      completedStageIds,
    },
    consumers: { browser, device },
    oauth,
    cleanup: {
      owner: 'cleanupPackedNovelConnectedAccountQaHandoff',
      markerPath: markerRelativePath,
    },
  };
  const manifestPath = join(
    resolvedOutputRoot,
    PACKED_NOVEL_QA_HANDOFF_MANIFEST_FILE,
  );
  try {
    await mkdir(resolvedOutputRoot, { recursive: false });
    await Promise.all([
      mkdir(dirname(join(resolvedOutputRoot, archiveRelativePath)), {
        recursive: true,
      }),
      ...[browser, device].flatMap((consumer) => [
        mkdir(join(resolvedOutputRoot, consumer.happyHomeDir), {
          recursive: true,
        }),
        mkdir(dirname(join(resolvedOutputRoot, consumer.databasePath)), {
          recursive: true,
        }),
      ]),
    ]);
    await Promise.all([
      writeFile(
        join(resolvedOutputRoot, archiveRelativePath),
        archiveBytes,
        { flag: 'wx' },
      ),
      writeFile(
        join(resolvedOutputRoot, markerRelativePath),
        `${JSON.stringify({
          kind: PACKED_NOVEL_QA_HANDOFF_KIND,
          runId: candidate.runId,
          rootId,
        }, null, 2)}\n`,
        { flag: 'wx' },
      ),
    ]);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' },
    );
    return await loadPackedNovelConnectedAccountQaHandoff({ manifestPath });
  } catch (error) {
    await rm(resolvedOutputRoot, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

export async function cleanupPackedNovelConnectedAccountQaHandoff({
  manifestPath,
}) {
  const resolvedManifestPath = resolve(manifestPath);
  const handoff = parsePackedNovelConnectedAccountQaHandoff(
    await readFile(resolvedManifestPath, 'utf8'),
    resolvedManifestPath,
  );
  await readAndVerifyPackedNovelQaMarker(handoff);
  await rm(handoff.root, { recursive: true, force: false });
  return Object.freeze({
    disposition: 'removed',
    runId: handoff.runId,
  });
}

export function assertPackedNovelConnectedAccountQaCandidate({
  handoff,
  candidate,
}) {
  const candidateIdentity = {
    sdk: {
      packageName: candidate.sdk.packageName,
      version: candidate.sdk.version,
      integrity: candidate.sdk.integrity,
    },
    cli: {
      packageName: candidate.cli.packageName,
      version: candidate.cli.version,
      integrity: candidate.cli.integrity,
    },
  };
  if (JSON.stringify(candidateIdentity) !== JSON.stringify(handoff.candidate)) {
    fail('Packed novel QA handoff does not belong to the exact SDK/CLI candidate');
  }
  return handoff;
}

export async function startPackedNovelConnectedAccountAuthorizationServer() {
  const tlsFixture = await createEphemeralTlsServerFixture();
  let key;
  let leafCertificate;
  let caCertificate;
  try {
    [key, leafCertificate, caCertificate] = await Promise.all([
      readFile(tlsFixture.privateKeyPath),
      readFile(tlsFixture.leafCertificatePath),
      readFile(tlsFixture.caCertificatePath),
    ]);
  } catch (error) {
    await tlsFixture.cleanup();
    throw error;
  }
  let origin = 'https://127.0.0.1';
  let authorizationRedirects = 0;
  let rejectedRequests = 0;
  let server;
  try {
    server = createHttpsServer({
      key,
      cert: Buffer.concat([
        leafCertificate,
        Buffer.from('\n'),
        caCertificate,
      ]),
    }, (request, response) => {
      const requestUrl = new URL(request.url ?? '/', origin);
      const state = requestUrl.searchParams.get('state');
      const redirectUri = requestUrl.searchParams.get('redirect_uri');
      const accepted = request.method === 'GET'
        && requestUrl.pathname === '/authorize'
        && requestUrl.searchParams.get('response_type') === 'code'
        && typeof state === 'string'
        && /^[A-Za-z0-9_-]{32,256}$/u.test(state)
        && redirectUri === PACKED_NOVEL_QA_CALLBACK_URL;
      if (!accepted) {
        rejectedRequests += 1;
        response.writeHead(400, {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        });
        response.end(JSON.stringify({
          error: 'packed_novel_authorization_request_invalid',
        }));
        return;
      }
      const callback = new URL(PACKED_NOVEL_QA_CALLBACK_URL);
      callback.searchParams.set('code', 'oauth-account');
      callback.searchParams.set('state', state);
      authorizationRedirects += 1;
      response.writeHead(302, {
        'cache-control': 'no-store',
        location: callback.href,
      });
      response.end();
    });
  } catch (error) {
    await tlsFixture.cleanup();
    throw error;
  } finally {
    key.fill(0);
  }
  let closePromise = null;
  const closeServer = () => {
    closePromise ??= (async () => {
      try {
        if (server.listening) {
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => (
              error ? rejectClose(error) : resolveClose()
            ));
          });
        }
      } finally {
        await tlsFixture.cleanup();
      }
    })().catch((error) => {
      closePromise = null;
      throw error;
    });
    return closePromise;
  };
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail('Packed novel authorization server did not expose a TCP address');
    }
    origin = `https://127.0.0.1:${address.port}`;
  } catch (error) {
    await closeServer();
    throw error;
  }
  return Object.freeze({
    origin,
    caCertificatePath: tlsFixture.caCertificatePath,
    callbackUrl: PACKED_NOVEL_QA_CALLBACK_URL,
    getRequestSummary() {
      return Object.freeze({
        authorizationRedirects,
        rejectedRequests,
      });
    },
    close: closeServer,
  });
}

export async function resolvePackedCliEntrypoint(extractionRoot, entrypoint) {
  const packagePath = join(extractionRoot, 'package');
  const packageStats = await lstat(packagePath);
  if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) {
    fail('Packed CLI package root must be an extracted directory');
  }
  const resolvedPackageRoot = await realpath(packagePath);
  const resolvedEntrypoint = await realpath(join(extractionRoot, entrypoint));
  const entrypointStats = await stat(resolvedEntrypoint);
  if (!entrypointStats.isFile() || !isPathInsideRoot(resolvedPackageRoot, resolvedEntrypoint)) {
    fail('Packed CLI entrypoint must be a contained regular file inside the extracted package');
  }
  return resolvedEntrypoint;
}

export async function assertPackedDaemonRuntimeIdentity({
  installedCliPackageRoot,
  candidateVersion,
  daemonState,
  expectedDaemonPid,
  runtime,
}) {
  const argv = Array.isArray(runtime?.argv) ? runtime.argv : [];
  if (
    typeof runtime?.execPath !== 'string'
    || runtime.execPath.trim().length === 0
    || argv.length < 2
    || argv.some((value) => typeof value !== 'string')
  ) {
    fail(`Packed daemon did not report its concrete runtime identity: ${JSON.stringify(runtime)}`);
  }
  const [resolvedPackageRoot, resolvedExecPath, resolvedEntrypoint] = await Promise.all([
    realpath(installedCliPackageRoot),
    realpath(runtime.execPath),
    realpath(argv[1]),
  ]);
  const packageRelativeEntrypoint = relative(resolvedPackageRoot, resolvedEntrypoint)
    .replaceAll('\\', '/');
  if (
    !isPathInsideRoot(resolvedPackageRoot, resolvedEntrypoint)
    || !['package-dist/index.mjs', 'dist/index.mjs'].includes(packageRelativeEntrypoint)
  ) {
    fail(`Packed daemon entrypoint is not the installed CLI runtime: ${resolvedEntrypoint}`);
  }
  if (daemonState?.startedWithCliVersion !== candidateVersion) {
    fail(`Packed daemon build identity mismatch: expected ${candidateVersion}, received ${String(daemonState?.startedWithCliVersion)}`);
  }
  if (
    !Number.isInteger(expectedDaemonPid)
    || expectedDaemonPid <= 0
    || daemonState?.pid !== expectedDaemonPid
  ) {
    fail(`Packed daemon process identity mismatch: expected ${String(expectedDaemonPid)}, received ${String(daemonState?.pid)}`);
  }
  return {
    pid: expectedDaemonPid,
    executable: resolvedExecPath,
    entrypoint: resolvedEntrypoint,
    packageRelativeEntrypoint,
    cliVersion: daemonState.startedWithCliVersion,
  };
}

export async function materializePackedCli({
  cliArtifact,
  installRoot,
  env = process.env,
  runImpl = run,
}) {
  await mkdir(installRoot, { recursive: true });
  const bootstrapManifest = {
    name: 'happier-packed-cli-candidate',
    private: true,
  };
  const bootstrapManifestPath = join(installRoot, 'package.json');
  try {
    await writeFile(
      bootstrapManifestPath,
      `${JSON.stringify(bootstrapManifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existingManifest = null;
    try {
      existingManifest = JSON.parse(await readFile(bootstrapManifestPath, 'utf8'));
    } catch {
      fail('Packed CLI materialization root is not the private packed CLI harness');
    }
    if (
      existingManifest?.name !== bootstrapManifest.name
      || existingManifest?.private !== bootstrapManifest.private
    ) {
      fail('Packed CLI materialization root is not the private packed CLI harness');
    }
  }

  const npmUserConfigPath = join(installRoot, '.packed-author-user.npmrc');
  const npmGlobalConfigPath = join(installRoot, '.packed-author-global.npmrc');
  for (const configPath of [npmUserConfigPath, npmGlobalConfigPath]) {
    try {
      await writeFile(configPath, '', { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST' || await readFile(configPath, 'utf8') !== '') {
        fail('Packed CLI materialization npm configuration is not the empty harness-owned file');
      }
    }
  }

  // This npm process belongs to the external test harness and materializes the same dependency
  // closure a published CLI install receives. Product author operations below still run only
  // through the packed CLI's managed, binary-safe toolchain.
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runImpl(npmCommand, [
    'install',
    '--no-package-lock',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--userconfig',
    npmUserConfigPath,
    '--globalconfig',
    npmGlobalConfigPath,
    '--cache',
    join(installRoot, '.npm-cache'),
    cliArtifact.tarballPath,
  ], {
    cwd: installRoot,
    env: sanitizePackedAuthorArtifactEnv(env),
  });
  assertCommandSucceeded(result, 'Packed CLI installation');

  const packageRoot = join(installRoot, 'node_modules', ...cliArtifact.packageName.split('/'));
  const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assertPackedPackageIdentity(packageManifest, cliArtifact, 'Installed packed CLI');
  assertPackedCliEntrypoint(packageManifest, cliArtifact);

  const packageRelativeEntrypoint = cliArtifact.entrypoint.slice('package/'.length);
  const resolvedPackageRoot = await realpath(packageRoot);
  const resolvedEntrypoint = await realpath(join(packageRoot, packageRelativeEntrypoint));
  const entrypointStats = await stat(resolvedEntrypoint);
  if (!entrypointStats.isFile() || !isPathInsideRoot(resolvedPackageRoot, resolvedEntrypoint)) {
    fail('Installed packed CLI entrypoint must be a contained regular file inside its package');
  }
  return resolvedEntrypoint;
}

async function verifyArtifactIntegrity(artifact, label) {
  const bytes = await readFile(artifact.tarballPath);
  const actual = sha512Sri(bytes);
  if (actual !== artifact.integrity) {
    fail(`${label} integrity mismatch: expected ${artifact.integrity}, received ${actual}`);
  }
  return bytes;
}

async function extractTarball(tarballPath, outputDir) {
  await mkdir(outputDir, { recursive: true });
  await tar.x({ file: tarballPath, cwd: outputDir, strict: true });
}

export async function startCandidateRegistry({ sdk, sdkBytes, packageManifest = {} }) {
  let registryOrigin = null;
  let closed = false;
  const tarballPathname = `/@happier-dev/plugin-sdk/-/plugin-sdk-${sdk.version}.tgz`;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', registryOrigin ?? 'http://127.0.0.1');
    const decodedPathname = decodeURIComponent(requestUrl.pathname).toLowerCase();
    if (requestUrl.pathname === tarballPathname) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(sdkBytes.byteLength),
        etag: `"${sdk.integrity}"`,
      });
      response.end(sdkBytes);
      return;
    }
    if (decodedPathname === `/${SDK_PACKAGE_NAME}`) {
      const metadata = {
        name: SDK_PACKAGE_NAME,
        'dist-tags': { latest: sdk.version },
        versions: {
          [sdk.version]: {
            name: SDK_PACKAGE_NAME,
            version: sdk.version,
            ...(packageManifest.dependencies ? { dependencies: packageManifest.dependencies } : {}),
            ...(packageManifest.optionalDependencies ? { optionalDependencies: packageManifest.optionalDependencies } : {}),
            ...(packageManifest.peerDependencies ? { peerDependencies: packageManifest.peerDependencies } : {}),
            ...(packageManifest.bundledDependencies ? { bundledDependencies: packageManifest.bundledDependencies } : {}),
            dist: {
              tarball: `${registryOrigin}${tarballPathname}`,
              integrity: sdk.integrity,
            },
          },
        },
      };
      const bytes = Buffer.from(JSON.stringify(metadata));
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(bytes.byteLength),
      });
      response.end(bytes);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'candidate_registry_not_found' }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') fail('Candidate registry did not expose a TCP address');
  registryOrigin = `http://127.0.0.1:${address.port}`;
  return {
    origin: registryOrigin,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

export function classifySyntheticNpmRegistryRequest({
  method,
  pathname,
  authorization,
  accept,
  connection,
  packageName,
  artifactPathnames,
}) {
  const normalizedMethod = String(method ?? '').toUpperCase();
  // Some harness environments probe newly opened localhost listeners with an
  // unauthenticated GET /. The daemon's local-service inventory owner uses a
  // narrower HEAD / signature. Keep only those ambient shapes separate so the
  // credential-boundary gates still reject every npm or unexpected request.
  if (
    pathname === '/'
    && authorization === null
    && (
      normalizedMethod === 'GET'
      || (
        normalizedMethod === 'HEAD'
        && accept === 'text/html,application/xhtml+xml,*/*;q=0.1'
        && connection === 'close'
      )
    )
  ) {
    return 'ambient-availability-probe';
  }
  let decodedPathname = null;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    // A malformed path is neither an npm protocol route nor an ambient root probe.
  }
  if (
    normalizedMethod === 'GET'
    && (
      pathname === '/-/ping'
      || decodedPathname === `/${packageName}`
      || artifactPathnames.includes(pathname)
    )
  ) {
    return 'registry-protocol';
  }
  return 'unexpected-registry-request';
}

export async function startPrivatePluginRegistry({
  packageName,
  artifacts,
  acceptedToken: initialAcceptedToken,
}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    fail('Private plugin registry requires at least one exact artifact');
  }
  const byVersion = new Map(artifacts.map((artifact) => [artifact.version, {
    ...artifact,
    integrity: sha512Sri(artifact.bytes),
  }]));
  if (byVersion.size !== artifacts.length) fail('Private plugin registry artifact versions must be unique');
  const tlsFixture = await createEphemeralTlsServerFixture();
  let key;
  let leafCertificate;
  let caCertificate;
  try {
    [key, leafCertificate, caCertificate] = await Promise.all([
      readFile(tlsFixture.privateKeyPath),
      readFile(tlsFixture.leafCertificatePath),
      readFile(tlsFixture.caCertificatePath),
    ]);
  } catch (error) {
    await tlsFixture.cleanup();
    throw error;
  }
  let registryOrigin = null;
  let acceptedToken = initialAcceptedToken;
  const requests = [];
  const packageSlug = packageName.split('/').at(-1);
  const artifactPathnames = [...byVersion.values()].map(
    (artifact) => `/${packageName}/-/${packageSlug}-${artifact.version}.tgz`,
  );
  let server;
  try {
    server = createHttpsServer({
      key,
      cert: Buffer.concat([
        leafCertificate,
        Buffer.from('\n'),
        caCertificate,
      ]),
    }, (request, response) => {
      const requestUrl = new URL(request.url ?? '/', registryOrigin ?? 'https://127.0.0.1');
      const authorization = request.headers.authorization ?? null;
      const accept = request.headers.accept ?? null;
      const connection = request.headers.connection ?? null;
      const method = request.method ?? null;
      requests.push({
        method,
        pathname: requestUrl.pathname,
        authorization,
        accept,
        connection,
        classification: classifySyntheticNpmRegistryRequest({
          method,
          pathname: requestUrl.pathname,
          authorization,
          accept,
          connection,
          packageName,
          artifactPathnames,
        }),
      });
      if (acceptedToken !== null && authorization !== `Bearer ${acceptedToken}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic_private_registry_authentication_failed' }));
        return;
      }
      if (requestUrl.pathname === '/-/ping') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (decodeURIComponent(requestUrl.pathname) === `/${packageName}`) {
        const versions = {};
        for (const artifact of byVersion.values()) {
          const tarballPathname = `/${packageName}/-/${packageSlug}-${artifact.version}.tgz`;
          versions[artifact.version] = {
            name: packageName,
            version: artifact.version,
            dist: {
              tarball: `${registryOrigin}${tarballPathname}`,
              integrity: artifact.integrity,
            },
          };
        }
        const latest = [...byVersion.keys()].at(-1);
        const bytes = Buffer.from(JSON.stringify({
          name: packageName,
          'dist-tags': { latest },
          versions,
        }));
        response.writeHead(200, {
          'content-type': 'application/vnd.npm.install-v1+json',
          'content-length': String(bytes.byteLength),
        });
        response.end(bytes);
        return;
      }
      const artifact = [...byVersion.values()].find((candidate) => (
        requestUrl.pathname === `/${packageName}/-/${packageSlug}-${candidate.version}.tgz`
      ));
      if (artifact) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(artifact.bytes.byteLength),
        });
        response.end(artifact.bytes);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'synthetic_private_registry_not_found' }));
    });
  } catch (error) {
    await tlsFixture.cleanup();
    throw error;
  } finally {
    key.fill(0);
  }
  let closePromise = null;
  const closeRegistry = () => {
    closePromise ??= (async () => {
      try {
        if (server.listening) {
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        }
      } finally {
        await tlsFixture.cleanup();
      }
    })().catch((error) => {
      closePromise = null;
      throw error;
    });
    return closePromise;
  };
  let address;
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    address = server.address();
    if (!address || typeof address === 'string') {
      fail('Private plugin registry did not expose a TCP address');
    }
  } catch (error) {
    await closeRegistry();
    throw error;
  }
  registryOrigin = `https://127.0.0.1:${address.port}`;
  return {
    origin: registryOrigin,
    caCertificatePath: tlsFixture.caCertificatePath,
    setAcceptedToken(token) {
      acceptedToken = token;
    },
    getRequests() {
      return requests.map((request) => ({ ...request }));
    },
    async close() {
      await closeRegistry();
    },
  };
}

export function createExtraCaBundleRefresher({ bundlePath }) {
  const certificatesByPath = new Map();
  return async (certificatePath) => {
    certificatesByPath.set(
      certificatePath,
      await readFile(certificatePath, 'utf8'),
    );
    await writeFile(
      bundlePath,
      `${[...certificatesByPath.values()].join('\n')}\n`,
      'utf8',
    );
  };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      packedAuthorCommandOutputCapture.getStore()?.push({
        stdout: result.stdout,
        stderr: result.stderr,
      });
      resolveRun(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function assertCommandSucceeded(result, label) {
  if (result.code !== 0 || result.signal !== null) {
    fail(`${label} failed (code=${String(result.code)}, signal=${String(result.signal)}):\n${result.stdout}${result.stderr}`);
  }
}

export function parseJsonEnvelope(stdout, label) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) fail(`${label} emitted no JSON result`);
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const line = lines[lineIndex];
    if (!line) continue;
    const objectStarts = [...line]
      .flatMap((character, index) => character === '{' ? [index] : []);
    for (const objectStart of objectStarts) {
      try {
        const parsed = JSON.parse(line.slice(objectStart));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // A terminal prompt can share the result line; keep looking for its JSON suffix.
      }
    }
  }
  fail(`${label} emitted invalid JSON: ${lines.at(-1)}`);
}

export function parseSuccessfulCommandEnvelope(stdout, expectedKind) {
  const envelope = parseJsonEnvelope(stdout, expectedKind);
  if (envelope?.ok !== true) fail(`${expectedKind} reported failure despite exiting successfully`);
  if (envelope.kind !== expectedKind) {
    fail(`${expectedKind} emitted the wrong result kind: ${String(envelope.kind)}`);
  }
  return envelope;
}

export function inspectGeneratedScaffoldPackage(packageJson, expectedSdkVersion) {
  const failures = [];
  const sdkSpec = packageJson?.dependencies?.[SDK_PACKAGE_NAME];
  if (sdkSpec !== expectedSdkVersion) {
    failures.push(`generated SDK dependency must equal ${expectedSdkVersion}; received ${String(sdkSpec)}`);
  }
  if (typeof sdkSpec === 'string' && /^(?:file:|workspace:|link:|portal:)/u.test(sdkSpec)) {
    failures.push(`generated SDK dependency is not ordinary semver: ${sdkSpec}`);
  }
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : {};
  const requiredScripts = {
    build: 'happier plugins author build .',
    typecheck: 'happier plugins author typecheck .',
    test: 'happier plugins test .',
    'pack:plugin': 'happier plugins pack .',
  };
  for (const [name, expectedCommand] of Object.entries(requiredScripts)) {
    if (scripts[name] !== expectedCommand) {
      failures.push(`generated author script ${name} must equal ${expectedCommand}; received ${String(scripts[name])}`);
    }
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    const words = command.split(/\s+/u).map((word) => word.trim().toLowerCase());
    if (words.some((word) => word === 'tsc' || SYSTEM_PACKAGE_MANAGER_BASENAMES.has(word))) {
      failures.push(`generated script ${name} invokes a forbidden bare tool: ${command}`);
    }
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = packageJson?.[section];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === 'string' && /^(?:file:|workspace:|link:|portal:)/u.test(spec)) {
        failures.push(`generated dependency ${name} in ${section} uses a repository/workspace path: ${spec}`);
      }
    }
  }
  const nativeTypeScriptSpec = packageJson?.devDependencies?.['@typescript/native'];
  if (nativeTypeScriptSpec !== NATIVE_TYPESCRIPT_DEPENDENCY_SPEC) {
    failures.push(`generated scaffold must depend on exact repository-selected @typescript/native ${NATIVE_TYPESCRIPT_DEPENDENCY_SPEC}`);
  }
  if (packageJson?.devDependencies?.typescript !== undefined) {
    failures.push('generated scaffold must not install the retained TypeScript 5 compiler API package');
  }
  return failures;
}

export async function runPackedCli({ cliEntrypoint, args, cwd, env, input }) {
  return await run(process.execPath, [cliEntrypoint, ...args], {
    cwd,
    env,
    ...(input === undefined ? {} : { input }),
  });
}

export async function runPackedCliJson(params, expectedKind) {
  const result = await runPackedCli(params);
  assertCommandSucceeded(result, expectedKind);
  return parseSuccessfulCommandEnvelope(result.stdout, expectedKind);
}

async function observePostTimeoutPluginCatalog({
  cliEntrypoint,
  cwd,
  env,
  pluginId,
  runCli,
}) {
  let result;
  try {
    result = await runCli({
      cliEntrypoint,
      cwd,
      env,
      args: ['plugins', 'list', '--json'],
    });
    const envelope = parseJsonEnvelope(result.stdout, 'plugins_list_after_review_timeout');
    if (
      result.code !== 0
      || result.signal !== null
      || envelope?.ok !== true
      || envelope?.kind !== 'plugins_list'
      || !Array.isArray(envelope?.data?.plugins)
    ) {
      return {
        classification: 'observation_unavailable',
        command: { code: result.code, signal: result.signal },
      };
    }
    const rawPlugin = envelope.data.plugins.find((plugin) => plugin?.pluginId === pluginId);
    if (!rawPlugin) {
      return {
        classification: 'not_committed',
        command: { code: result.code, signal: result.signal },
        plugin: null,
      };
    }
    const plugin = {
      pluginId: rawPlugin.pluginId,
      version: rawPlugin.version,
      enabled: rawPlugin.enabled,
      desiredGeneration: rawPlugin.desiredGeneration,
      appliedGeneration: rawPlugin.appliedGeneration,
    };
    const desiredGeneration = typeof plugin.desiredGeneration === 'string'
      && plugin.desiredGeneration.length > 0
      ? plugin.desiredGeneration
      : null;
    return {
      classification: desiredGeneration === null
        ? 'catalog_entry_without_desired_generation'
        : plugin.appliedGeneration === desiredGeneration
          ? 'committed_applied'
          : 'committed_not_applied',
      command: { code: result.code, signal: result.signal },
      plugin,
    };
  } catch {
    return {
      classification: 'observation_unavailable',
      command: result
        ? { code: result.code, signal: result.signal }
        : null,
    };
  }
}

export async function runPackedReviewedPluginInstall({
  cliEntrypoint,
  cwd,
  env,
  args,
  decideInstallReview,
  runCli = runPackedCli,
}) {
  if (args.includes('--install-and-trust')) {
    fail('Packed reviewed install must not use retired headless plugin approval');
  }
  if (!args.includes('--json')) {
    fail('Packed reviewed install requires the structured JSON review envelope');
  }
  if (typeof decideInstallReview !== 'function') {
    fail('Packed reviewed install requires an authenticated private decision boundary');
  }

  const prepareResult = await runCli({ cliEntrypoint, cwd, env, args });
  const prepareEnvelope = parseJsonEnvelope(prepareResult.stdout, 'plugins_install_review');
  if (
    prepareResult.code === 0
    || prepareResult.signal !== null
    || prepareEnvelope?.ok !== false
    || prepareEnvelope?.kind !== 'plugins_install'
    || prepareEnvelope?.error?.code !== 'review_required'
  ) {
    fail(`Packed install did not stage an exact daemon review: ${JSON.stringify({
      code: prepareResult.code,
      signal: prepareResult.signal,
      envelope: prepareEnvelope,
    })}`);
  }
  let pendingChangeId;
  let review;
  try {
    ({ pendingChangeId, review } = readPluginInstallReviewRequiredEnvelope(prepareEnvelope));
  } catch (error) {
    fail(`Packed install did not stage complete closed review facts: ${error instanceof Error ? error.message : String(error)}`);
  }
  const happyHomeDir = typeof env?.HAPPIER_HOME_DIR === 'string'
    ? env.HAPPIER_HOME_DIR.trim()
    : '';
  if (!happyHomeDir) {
    fail('Packed reviewed install requires the isolated authenticated home identity');
  }

  let change;
  try {
    change = await decideInstallReview({
      happyHomeDir,
      pendingChangeId,
      review,
    });
  } catch (error) {
    if (error?.code !== 'authenticated_plugin_install_review_timeout') throw error;
    const postTimeoutPluginCatalog = await observePostTimeoutPluginCatalog({
      cliEntrypoint,
      cwd,
      env,
      pluginId: review.pluginId,
      runCli,
    });
    const reported = Object.assign(
      new Error(
        `${error instanceof Error ? error.message : String(error)}; post-timeout plugin catalog: ${JSON.stringify(postTimeoutPluginCatalog)}`,
        { cause: error },
      ),
      {
        code: error.code,
        diagnostic: error?.diagnostic,
        postTimeoutPluginCatalog,
      },
    );
    throw reported;
  }
  return {
    pendingChangeId,
    review,
    change,
  };
}

export function shouldRetainPackedAuthorTempRoot({
  succeeded,
  retainFailedTempRequested,
}) {
  return succeeded !== true && retainFailedTempRequested === true;
}

async function readPackedDaemonState(happyHomeDir) {
  const settings = JSON.parse(await readFile(join(happyHomeDir, 'settings.json'), 'utf8'));
  const activeServerId = typeof settings?.activeServerId === 'string'
    ? settings.activeServerId.trim()
    : '';
  const serverDirectories = await readdir(join(happyHomeDir, 'servers'), { withFileTypes: true })
    .then((entries) => entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort())
    .catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
  const candidatePaths = [...new Set([
    ...(activeServerId ? [join(happyHomeDir, 'servers', activeServerId, 'daemon.state.json')] : []),
    ...serverDirectories.map((serverId) => join(happyHomeDir, 'servers', serverId, 'daemon.state.json')),
    join(happyHomeDir, 'daemon.state.json'),
  ])];
  for (const candidatePath of candidatePaths) {
    try {
      const state = JSON.parse(await readFile(candidatePath, 'utf8'));
      if (
        Number.isInteger(state?.pid)
        && state.pid > 0
        && Number.isInteger(state?.httpPort)
        && state.httpPort > 0
        && typeof state?.controlToken === 'string'
        && state.controlToken.length > 0
      ) {
        return { ...state, statePath: candidatePath };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  fail(`Packed daemon state was not readable from the isolated home: ${candidatePaths.join(', ')}`);
}

async function postPackedDaemonControl(state, path, body) {
  const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
    method: 'POST',
    headers: {
      Connection: 'close',
      'Content-Type': 'application/json',
      'x-happier-daemon-token': state.controlToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    fail(`Daemon control ${path} returned invalid JSON (${response.status}): ${text}`);
  }
  if (!response.ok) {
    const error = new Error(`Daemon control ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function postPackedDaemonControlDiscardingResponse(state, path, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return await new Promise((resolveRequest, rejectRequest) => {
    let responseStarted = false;
    const request = requestHttp({
      hostname: '127.0.0.1',
      port: state.httpPort,
      path,
      method: 'POST',
      headers: {
        Connection: 'close',
        'Content-Type': 'application/json',
        'Content-Length': String(payload.byteLength),
        'x-happier-daemon-token': state.controlToken,
      },
      timeout: 5_000,
    }, (response) => {
      responseStarted = true;
      const statusCode = response.statusCode ?? 0;
      response.destroy();
      if (statusCode < 200 || statusCode >= 300) {
        rejectRequest(new Error(`Daemon control ${path} rejected discarded-response request (${statusCode})`));
        return;
      }
      resolveRequest({ responseBodyDiscarded: true });
    });
    request.once('timeout', () => {
      request.destroy(new Error(`Daemon control ${path} timed out before its response could be discarded`));
    });
    request.once('error', (error) => {
      if (!responseStarted) rejectRequest(error);
    });
    request.end(payload);
  });
}

function classifyRetiredDaemonControlFailure(error) {
  if (error?.status === 401 || error?.status === 403) {
    return `rejected-http-${error.status}`;
  }
  const code = error?.cause?.code ?? error?.code;
  if (
    code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'EPIPE'
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
  ) {
    return `unreachable-${code ?? error.name}`;
  }
  throw error;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function configureVerticalAManifest({
  manifest,
  version,
  pluginId,
  fetchOrigin,
  connectedAccountOrigin,
}) {
  const developmentEntrypoint = manifest?.entrypoints?.development;
  const ownsRetainedCapabilities = pluginId === 'acme.vertical-a';
  if (typeof developmentEntrypoint !== 'string' || developmentEntrypoint.length === 0) {
    fail('Generated Vertical-A scaffold is missing entrypoints.development');
  }
  let canonicalFetchOrigin;
  try {
    const url = new URL(fetchOrigin);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.origin !== fetchOrigin
    ) {
      fail('Vertical-A fetch origin must be a canonical HTTP(S) origin');
    }
    canonicalFetchOrigin = url.origin;
  } catch {
    fail('Vertical-A fetch origin must be a canonical HTTP(S) origin');
  }
  let canonicalConnectedAccountOrigin = null;
  if (ownsRetainedCapabilities) {
    try {
      const url = new URL(connectedAccountOrigin);
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || url.origin !== connectedAccountOrigin
      ) {
        fail('Vertical-A Connected Account origin must be a canonical HTTPS origin');
      }
      canonicalConnectedAccountOrigin = url.origin;
    } catch {
      fail('Vertical-A Connected Account origin must be a canonical HTTPS origin');
    }
  }
  const scaffoldUi = manifest?.contributes?.ui;
  const scaffoldHostedWebRenderer = ownsRetainedCapabilities
    ? scaffoldUi?.renderers?.find((renderer) => (
        renderer?.id === 'main-web'
        && renderer?.kind === 'hostedWeb'
        && renderer?.source?.kind === 'artifact'
        && renderer?.source?.artifact === 'main-web'
      ))
    : null;
  if (ownsRetainedCapabilities && !scaffoldHostedWebRenderer) {
    fail('Generated Vertical-A retained-capability scaffold is missing its hostedWeb artifact renderer');
  }
  const retainedCapabilityUi = ownsRetainedCapabilities
    ? {
        ...scaffoldUi,
        renderers: [
          ...scaffoldUi.renderers
            .filter((renderer) => renderer.id !== 'roundtrip-card')
            .map((renderer) => (
              renderer.id === 'main-web'
                ? {
                    ...renderer,
                    requiredHostMethods: [
                      ...new Set([...(renderer.requiredHostMethods ?? []), 'executeAction']),
                    ],
                  }
                : renderer
            )),
          {
            id: 'roundtrip-card',
            kind: 'declarative',
            root: {
              kind: 'action',
              action: 'roundtrip',
              label: 'Run Vertical A roundtrip',
              input: { operation: 'structured-message-action' },
            },
            requiredHostMethods: ['executeAction'],
          },
        ],
      }
    : null;
  return {
    ...manifest,
    version,
    runtime: { apiVersion: 1 },
    entrypoints: {
      daemon: './dist/index.js',
      development: developmentEntrypoint,
    },
    activation: { events: [{ kind: 'startup' }] },
    hostAccess: {
      required: [{
        id: 'packed-notification-token',
        capability: 'secrets',
        reason: 'Authenticate the packed notification channel',
        scope: { secretIds: ['webhook.token'], access: ['read'] },
      }, ...(ownsRetainedCapabilities ? [{
        id: 'packed-fetch',
        capability: 'network',
        reason: 'Exercise the packed external fetch and Connected Account producer service',
        scope: {
          targets: [
            { kind: 'connectedAccountOrigin', service: 'novel-cloud' },
          ],
          methods: ['GET', 'POST'],
          privateNetwork: true,
        },
      }, {
        id: 'packed-interceptor-fetch-target',
        capability: 'network',
        reason: 'Fetch the packed interceptor target through the host service',
        scope: {
          targets: [
            { kind: 'fixedOrigin', origin: canonicalFetchOrigin },
          ],
          methods: ['GET'],
          privateNetwork: true,
        },
      }, {
        id: 'packed-novel-account',
        capability: 'connectedAccounts',
        reason: 'Materialize the selected packed Novel Cloud account',
        scope: {
          serviceRefs: ['novel-cloud'],
          operations: ['use', 'select'],
          materializationKinds: ['environment'],
        },
      }, {
        id: 'packed-claude-account',
        capability: 'connectedAccounts',
        reason: 'Materialize the selected bundled Claude setup-token account',
        scope: {
          serviceRefs: [{
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
          }],
          operations: ['use'],
          materializationKinds: ['environment'],
        },
      }, {
        id: 'packed-fetch-interceptor',
        capability: 'network.intercept',
        reason: 'Exercise the packed external request interceptor',
        scope: { origins: [canonicalFetchOrigin] },
      }] : [])],
      optional: [],
    },
    contributes: {
      actions: [{
        id: 'roundtrip',
        title: 'Vertical A roundtrip',
        scopes: ['global'],
        surfaces: ['agent', 'mcp', 'cli', 'ui'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
        ...(ownsRetainedCapabilities ? {
          hostAccess: [
            'packed-notification-token',
            'packed-fetch',
            'packed-interceptor-fetch-target',
            'packed-novel-account',
            'packed-claude-account',
          ],
        } : {}),
      }],
      ...(ownsRetainedCapabilities ? {
        tools: [{
          id: 'roundtrip-tool',
          name: 'vertical_a_roundtrip',
          title: 'Vertical A roundtrip tool',
          description: 'Invoke the packed Vertical A roundtrip action.',
          safety: 'safe',
          surfaces: ['agent', 'mcp', 'cli'],
          inputSchema: {
            type: 'object',
            additionalProperties: true,
          },
          outputSchema: {
            type: 'object',
            additionalProperties: true,
          },
          inputHints: {
            description: 'Input forwarded to the one declared roundtrip action.',
            fields: [{
              path: 'operation',
              title: 'Operation',
              widget: 'text',
            }],
          },
          examples: {
            mcp: { argsExample: '{"operation":"packed-tool-dispatch"}' },
          },
          promptSnippet: 'Use vertical_a_roundtrip for the packed Vertical A action.',
          promptGuidelines: ['Invoke the declared action through this presentation.'],
          action: 'roundtrip',
        }],
        structuredMessages: [{
          id: 'roundtrip-result',
          title: 'Vertical A roundtrip result',
          kind: 'acme.vertical-a/roundtrip-result.v1',
          payloadSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
          renderer: 'roundtrip-card',
          actions: ['roundtrip'],
          fallback: { kind: 'summary', template: 'Vertical A: {message}' },
        }],
        sessionHeaderActions: [{
          id: 'roundtrip-header',
          title: 'Run Vertical A roundtrip',
          action: 'roundtrip',
          order: 10,
        }],
        ui: retainedCapabilityUi,
      } : {}),
      events: [{
        id: 'notification-ready',
        kind: 'event',
        title: 'Packed notification ready',
        payloadSchema: {
          type: 'object',
          properties: { clientRequestId: { type: 'string' } },
          required: ['clientRequestId'],
          additionalProperties: false,
        },
      }, {
        id: 'observe-notification-ready',
        kind: 'subscription',
        event: 'notification-ready',
      }],
      ...(ownsRetainedCapabilities ? { requestInterceptors: [{
        id: 'observe-api',
        origins: [canonicalFetchOrigin],
        methods: ['GET'],
      }] } : {}),
      notifications: [{
        id: 'packed-ready',
        kind: 'activity',
        title: 'Packed notification ready',
        eventIds: ['notification-ready'],
        defaultChannels: ['webhook'],
      }],
      notificationChannels: [{
        id: 'webhook',
        kind: 'webhook',
        title: 'Packed webhook',
        configurable: true,
        defaultEnabled: true,
        settings: [{
          id: 'endpoint',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 1 },
        }, {
          id: 'token',
          title: 'Token',
          schema: { type: 'string', minLength: 8 },
          secret: true,
        }],
      }],
      commands: [{
        id: 'roundtrip-shared-command',
        title: 'Vertical A shared roundtrip',
        path: ['vertical-a', 'roundtrip'],
        action: 'roundtrip',
      }, {
        id: 'roundtrip-command',
        title: 'Vertical A roundtrip',
        path: ['vertical-a', pluginId.split('.').at(-1)],
        action: 'roundtrip',
      }],
      scmBackends: [{
        id: 'stacked',
        title: 'Packed Stacked SCM',
        description: 'Packed external SCM backend used by Vertical-A.',
        kind: 'packed-stacked',
        capabilities: ['detect', 'status'],
      }],
      scmHostingProviders: [{
        id: 'forge',
        title: 'Packed Forge',
        description: 'Packed external SCM hosting provider used by Vertical-A.',
        kind: 'packed-forge',
        capabilities: ['detect', 'clone'],
        authService: ownsRetainedCapabilities ? 'novel-cloud' : 'github',
      }],
      connectedAccountDescriptors: [{
        id: 'github',
        title: 'Packed Forge account',
        description: 'Connected account used by the packed external SCM provider.',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Token',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }],
        },
        capabilities: ['scmHostingToken'],
      }, ...(ownsRetainedCapabilities ? [{
        id: 'novel-cloud',
        title: 'Novel Cloud account',
        description: 'A packed Connected Account service that has no built-in legacy identity.',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            title: 'Manual token',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Token',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
            configuration: {
              scope: 'service',
              changeBehavior: 'reconnect',
              fields: [{
                id: 'api-origin',
                title: 'API origin',
                semantic: 'connectedAccountOrigin',
                schema: { type: 'string', minLength: 1 },
                presentation: {
                  control: 'text',
                  placeholder: 'https://api.example.com',
                },
                required: true,
              }],
            },
          }, {
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            title: 'OAuth',
            scopes: ['novel.read', 'novel.write'],
            pkce: 'required',
            outcomeReconciliation: 'providerCheck',
            configuration: {
              scope: 'service',
              changeBehavior: 'reconnect',
              fields: [{
                id: 'api-origin',
                title: 'API origin',
                semantic: 'connectedAccountOrigin',
                schema: { type: 'string', minLength: 1 },
                required: true,
              }, {
                id: 'authorization-origin',
                title: 'Authorization origin',
                schema: { type: 'string', minLength: 1 },
                required: true,
              }, {
                id: 'tenant',
                title: 'Tenant',
                schema: { type: 'string', minLength: 1 },
                required: true,
              }, {
                id: 'client-secret',
                title: 'OAuth client secret',
                schema: { type: 'string', minLength: 1 },
                secret: true,
                required: true,
              }],
            },
          }, {
            id: 'device',
            kind: 'oauthDeviceCode',
            title: 'Device authorization',
            scopes: ['novel.read'],
            outcomeReconciliation: 'lateEvidence',
            configuration: {
              scope: 'account',
              changeBehavior: 'refresh',
              fields: [{
                id: 'api-origin',
                title: 'API origin',
                semantic: 'connectedAccountOrigin',
                schema: { type: 'string', minLength: 1 },
                required: true,
              }, {
                id: 'workspace',
                title: 'Workspace',
                schema: { type: 'string', minLength: 1 },
                required: true,
              }, {
                id: 'account-secret',
                title: 'Account secret',
                schema: { type: 'string', minLength: 1 },
                secret: true,
                required: true,
              }],
            },
          }],
        },
        capabilities: ['packedNovelCloud'],
      }] : [])],
      resources: [{
        id: 'prompt',
        kind: 'prompt',
        path: 'resources/prompt.md',
        contentType: 'text/markdown',
      }, {
        id: 'skill',
        kind: 'skill',
        path: 'resources/skill.md',
        contentType: 'text/markdown',
      }, {
        id: 'template',
        kind: 'template',
        path: 'resources/template.txt',
        contentType: 'text/plain',
      }, {
        id: 'asset',
        kind: 'asset',
        path: 'resources/asset.json',
        contentType: 'application/json',
      }, {
        id: 'config',
        kind: 'config',
        path: 'resources/config.json',
        contentType: 'application/json',
      }],
      browserTargets: [{
        id: 'preview',
        title: 'Packed preview',
        url: 'https://preview.example.test/',
        launch: 'currentView',
        profile: 'user',
      }],
      browserActions: [{
        id: 'preview-roundtrip',
        title: 'Run packed roundtrip',
        action: 'roundtrip',
        target: 'preview',
        placement: 'toolbar',
        icon: 'play-outline',
      }, {
        id: 'preview-details',
        title: 'Inspect packed preview',
        action: 'roundtrip',
        target: 'preview',
        placement: 'detailsPanel',
        icon: 'search-outline',
      }, {
        id: 'preview-context',
        title: 'Copy packed preview URL',
        action: 'roundtrip',
        target: 'preview',
        placement: 'contextMenu',
        icon: 'copy-outline',
      }],
      ...(ownsRetainedCapabilities ? {
        agents: [{
          id: 'packed-external-agent',
          title: 'Packed external sessions Agent',
          cli: {
            displayName: 'Packed external sessions Agent CLI',
            executable: {
              binaryName: 'packed-external-agent',
              sourcePreference: 'system-first',
            },
            install: {
              managed: null,
              manual: { kind: 'none' },
            },
            auth: {
              support: 'unsupported',
              probe: {
                parser: 'none',
                backgroundChecks: 'safe',
                statusArgs: null,
              },
              loginLaunches: [],
            },
          },
          capabilities: { surfaces: ['externalSessions'] },
          surfaces: {
            externalSession: {
              sources: [{
                sourceKind: 'packedExternal',
                schema: {
                  passthrough: false,
                  fields: [
                    { name: 'kind', kind: 'literal', value: 'packedExternal' },
                    { name: 'scope', kind: 'literal', value: 'default' },
                  ],
                },
                key: {
                  segments: [
                    { kind: 'literal', value: 'packedExternal' },
                    { kind: 'field', field: 'scope' },
                  ],
                },
                instances: [{ kind: 'default', constants: { scope: 'default' } }],
              }],
            },
          },
        }],
      } : {}),
    },
  };
}

export function configureDescriptorOnlyManifest({ manifest, version }) {
  const {
    entrypoints: _entrypoints,
    activation: _activation,
    ...descriptor
  } = manifest;
  return {
    ...descriptor,
    version,
    runtime: { apiVersion: 1 },
    hostAccess: { required: [], optional: [] },
    contributes: {
      settings: [{
        id: 'preferences',
        title: 'Descriptor preferences',
        target: { kind: 'plugin' },
        scope: 'local',
        fields: [{
          id: 'enabled',
          title: 'Enabled',
          schema: { type: 'boolean' },
          default: true,
        }],
      }],
      ui: {
        views: [{
          id: 'settings',
          placement: 'app.settingsPage',
          renderer: 'settings-form',
          title: 'Descriptor-only settings',
        }],
        renderers: [{
          id: 'settings-form',
          kind: 'declarative',
          root: {
            kind: 'field',
            label: 'Enabled',
            control: { kind: 'toggle', settingId: 'enabled' },
          },
        }],
        translations: [],
      },
    },
  };
}

async function configureDescriptorOnlyPlugin(params) {
  const manifestPath = join(params.pluginRoot, '.happier-plugin', 'plugin.json');
  const packagePath = join(params.pluginRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  await writeFile(manifestPath, `${JSON.stringify(configureDescriptorOnlyManifest({
    manifest,
    version: params.version,
  }), null, 2)}\n`, 'utf8');
  await writeFile(packagePath, `${JSON.stringify({
    ...packageJson,
    version: params.version,
    files: Array.isArray(packageJson.files)
      ? packageJson.files.filter((entry) => entry !== 'dist')
      : packageJson.files,
  }, null, 2)}\n`, 'utf8');
}

export function verticalAResourcePayloads(version) {
  return {
    prompt: `# Packed prompt ${version}\n`,
    skill: `# Packed skill ${version}\n`,
    template: `Packed template ${version}\n`,
    asset: `${JSON.stringify({ kind: 'asset', version })}\n`,
    config: `${JSON.stringify({ kind: 'config', version })}\n`,
  };
}

export function resolvePackedScmRepositoryAuth(auth) {
  return auth ?? {
    state: 'unknown',
    profileKind: 'unknown',
  };
}

export function assertPackedBundledClaudeMaterialization({ envelope }) {
  const materialization = envelope?.data?.result;
  if (
    envelope?.ok !== true
    || materialization?.binding?.purpose !== 'packed-claude-account'
    || materialization.binding.service?.pluginId !== 'happier.agent.claude'
    || materialization.binding.service?.localId !== 'claude-subscription'
    || materialization.binding.target?.kind !== 'account'
    || typeof materialization.binding.target?.displayName !== 'string'
    || materialization.binding.target.displayName.length === 0
    || materialization?.materializationKind !== 'environment'
    || materialization?.credentialVerified !== true
  ) {
    fail(`Packed bundled Claude setup-token materialization did not reach the public host service: ${JSON.stringify(envelope)}`);
  }
  return materialization;
}

export function assertPackedConnectedAccountWatchRematerialization({
  selectionEnvelope,
  watchEnvelope,
  mutation,
}) {
  const selection = selectionEnvelope?.data?.result;
  const watch = watchEnvelope?.data?.result;
  const observations = Array.isArray(watch?.observations)
    ? watch.observations
    : [];
  const observationsAreBoundedRematerializations = observations.every(
    (observation) => (
      observation?.purpose === 'packed-novel-account'
      && observation?.targetKind === 'group'
      && (
        observation?.accountId === 'account-a'
        || observation?.accountId === 'account-b'
      )
      && observation?.materializationKind === 'environment'
    ),
  );
  if (
    selectionEnvelope?.ok !== true
    || selection?.status !== 'unavailable'
    || selection.code !== 'plugin_ui_unavailable'
  ) {
    fail('Packed public Connected Account selection did not fail closed without an invocation UI');
  }
  if (
    watchEnvelope?.ok !== true
    || !Number.isInteger(watch?.resyncCount)
    || watch.resyncCount !== observations.length
    || observations.length < 2
    || !observationsAreBoundedRematerializations
    || observations[0]?.accountId !== 'account-b'
    || observations.at(-1)?.accountId !== 'account-a'
    || mutation?.group?.ref?.groupId !== 'packed-fallback'
    || mutation.group.activeConnectedAccountId !== 'account-a'
  ) {
    fail(`Packed public Connected Account watch did not prove level-triggered rematerialization: ${JSON.stringify({
      resyncCount: watch?.resyncCount ?? null,
      observations: observations.map((observation) => ({
        purpose: observation?.purpose ?? null,
        targetKind: observation?.targetKind ?? null,
        accountId: observation?.accountId ?? null,
        materializationKind: observation?.materializationKind ?? null,
      })),
      mutation: {
        groupId: mutation?.group?.ref?.groupId ?? null,
        activeConnectedAccountId:
          mutation?.group?.activeConnectedAccountId ?? null,
      },
    })}`);
  }
  return Object.freeze({
    selection: selection.code,
    resyncCount: watch.resyncCount,
    rematerializedAccountIds: Object.freeze(
      observations.map(({ accountId }) => accountId),
    ),
  });
}

function packedConnectedAccountDurableShape(probe) {
  return {
    binding: probe?.binding ?? null,
    group: probe?.group ?? null,
    account: probe?.account ?? null,
  };
}

export function assertPackedConnectedAccountDormancy({
  baseline,
  dormant,
  reenabled,
  materializationEnvelope,
}) {
  const baselineShape = packedConnectedAccountDurableShape(baseline);
  const dormantShape = packedConnectedAccountDurableShape(dormant);
  const reenabledShape = packedConnectedAccountDurableShape(reenabled);
  const materialization = materializationEnvelope?.data?.result;
  if (
    dormant?.runtime?.status !== 'unavailable'
    || dormant.runtime.code !== 'connected_account_daemon_runtime_unavailable'
    || JSON.stringify(dormantShape) !== JSON.stringify(baselineShape)
    || JSON.stringify(reenabledShape) !== JSON.stringify(baselineShape)
  ) {
    fail('Packed durable Connected Account state changed while its plugin generation was dormant');
  }
  if (
    baselineShape.binding?.purpose !== 'packed-novel-account'
    || baselineShape.binding.target?.kind !== 'group'
    || baselineShape.binding.target.groupId !== 'packed-fallback'
    || baselineShape.group?.ref?.groupId !== 'packed-fallback'
    || baselineShape.group.activeConnectedAccountId !== 'device-account'
    || baselineShape.group.members?.length !== 1
    || baselineShape.group.members[0]?.connectedAccountId !== 'device-account'
    || baselineShape.account?.accountId !== 'device-account'
    || baselineShape.account.status !== 'connected'
    || baselineShape.account.credentialPresent !== true
    || baselineShape.account.configurationPresent !== true
  ) {
    fail('Packed dormancy baseline did not contain the expected durable Connected Account state');
  }
  if (
    materializationEnvelope?.ok !== true
    || materialization?.binding?.purpose !== 'packed-novel-account'
    || materialization.binding.service?.pluginId !== 'acme.vertical-a'
    || materialization.binding.service?.localId !== 'novel-cloud'
    || materialization.binding.target?.kind !== 'group'
    || materialization?.materializationKind !== 'environment'
    || materialization?.accountId !== 'device-account'
    || materialization?.credentialVerified !== true
  ) {
    fail('Packed re-enabled Connected Account consumer did not receive fresh HostAccess materialization');
  }
  return Object.freeze({
    dormantRuntime: dormant.runtime.code,
    preservedAccountId: baselineShape.account.accountId,
    preservedGroupId: baselineShape.group.ref.groupId,
    rematerializedAccountId: materialization.accountId,
  });
}

export async function configureVerticalAPlugin(params) {
  const manifestPath = join(params.pluginRoot, '.happier-plugin', 'plugin.json');
  const packagePath = join(params.pluginRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const unknownScmRepositoryAuth = resolvePackedScmRepositoryAuth(undefined);
  await writeFile(manifestPath, `${JSON.stringify(configureVerticalAManifest({
    manifest,
    version: params.version,
    pluginId: params.pluginId,
    fetchOrigin: params.fetchOrigin,
    connectedAccountOrigin: params.connectedAccountOrigin,
  }), null, 2)}\n`, 'utf8');
  await writeFile(packagePath, `${JSON.stringify({
    ...packageJson,
    ...(params.packageName ? { name: params.packageName } : {}),
    version: params.version,
    ...(params.pluginId === 'acme.vertical-a' ? {
      scripts: {
        ...(packageJson.scripts ?? {}),
        'build:ui': 'happier-plugin-build-ui --project-root .',
      },
      dependencies: {
        ...(packageJson.dependencies ?? {}),
        react: '19.2.0',
      },
      devDependencies: {
        ...(packageJson.devDependencies ?? {}),
        vite: '^7.0.0',
      },
    } : {}),
    files: [...new Set([
      ...(Array.isArray(packageJson.files) ? packageJson.files : []),
      'resources',
    ])],
  }, null, 2)}\n`, 'utf8');
  const resourceRoot = join(params.pluginRoot, 'resources');
  const resourcePayloads = verticalAResourcePayloads(params.version);
  await mkdir(resourceRoot, { recursive: true });
  await Promise.all([
    writeFile(join(resourceRoot, 'prompt.md'), resourcePayloads.prompt, 'utf8'),
    writeFile(join(resourceRoot, 'skill.md'), resourcePayloads.skill, 'utf8'),
    writeFile(join(resourceRoot, 'template.txt'), resourcePayloads.template, 'utf8'),
    writeFile(join(resourceRoot, 'asset.json'), resourcePayloads.asset, 'utf8'),
    writeFile(join(resourceRoot, 'config.json'), resourcePayloads.config, 'utf8'),
  ]);
  if (params.pluginId === 'acme.vertical-a') {
    const uiRoot = join(params.pluginRoot, 'src', 'ui');
    await mkdir(uiRoot, { recursive: true });
    await Promise.all([
      writeFile(join(params.pluginRoot, 'pluginUiBuild.mjs'), [
        "import { definePluginUiBuildConfig } from '@happier-dev/plugin-sdk/ui/build';",
        '',
        'export default definePluginUiBuildConfig({',
        '  targets: [{',
        "    rendererId: 'main-web',",
        "    entry: 'src/ui/index.html',",
        "    kind: 'hostedWeb',",
        "    platforms: ['web'],",
        '  }],',
        '});',
        '',
      ].join('\n'), 'utf8'),
      writeFile(join(params.pluginRoot, 'vite.config.mjs'), [
        "import { resolve } from 'node:path';",
        "import { defineConfig } from 'vite';",
        '',
        'export default defineConfig({',
        "  root: 'src/ui',",
        "  base: './',",
        '  build: {',
        "    outDir: resolve(process.cwd(), 'dist/ui/hosted-web/main-web'),",
        '    emptyOutDir: true,',
        '    sourcemap: false,',
        '  },',
        '});',
        '',
      ].join('\n'), 'utf8'),
      writeFile(join(uiRoot, 'index.html'), [
        '<!doctype html>',
        '<html lang="en">',
        '  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
        '  <body>',
        '    <main>',
        '      <h1>Vertical A packed hosted web surface</h1>',
        '      <p data-testid="packed-hosted-web-status">Installed artifact mounted.</p>',
        '    </main>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'), 'utf8'),
    ]);
  }
  await writeFile(join(params.pluginRoot, 'src', 'index.ts'), [
    "import { randomUUID } from 'node:crypto';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { readCurrentScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';",
    "import type { ScmHostingProviderRuntimeAdapter } from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';",
    "import type { JsonValue, PluginApi } from '@happier-dev/plugin-sdk';",
    "import type { ActionHandler, PluginConnectedAccountAuthenticationContext, PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/runtime';",
    "import type { AgentExternalSessionHooksContribution, AgentExternalSessionObservationContribution, AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/experimental/sessions';",
    '',
    `const pluginVersion = ${JSON.stringify(params.version)};`,
    ...(params.pluginId === 'acme.vertical-a' ? [
      `const fetchOrigin = ${JSON.stringify(params.fetchOrigin)};`,
    ] : []),
    'let activationInstanceId = randomUUID();',
    'let activationInvocationCount = 0;',
    "const markerPath = process.env.HAPPIER_VERTICAL_A_MARKER;",
    'const appendMarker = (kind: string): void => {',
    '  if (!markerPath) return;',
    "  appendFileSync(markerPath, `${kind}:${pluginVersion}:${activationInstanceId}:${process.pid}\\n`, 'utf8');",
    '};',
    'const shouldFailPostCommit = (): boolean => {',
    '  if (!markerPath) return false;',
    '  try {',
    "    return readFileSync(`${markerPath}.fatal`, 'utf8').trim() === pluginVersion;",
    '  } catch (error) {',
    "    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;",
    '    throw error;',
    '  }',
    '};',
    'const shouldFailCleanup = (): boolean => {',
    '  if (!markerPath) return false;',
    '  try {',
    "    return readFileSync(`${markerPath}.cleanup-fatal`, 'utf8').trim() === pluginVersion;",
    '  } catch (error) {',
    "    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;",
    '    throw error;',
    '  }',
    '};',
    "appendMarker('module');",
    '',
    'const roundtrip: ActionHandler = async (input, context): Promise<JsonValue> => {',
    "  const operation = typeof input === 'object' && input !== null && 'operation' in input ? input.operation : undefined;",
    ...(params.pluginId === 'acme.vertical-a' ? [
      "  if (operation === 'interceptor-fetch') {",
      '    const response = await context.services.fetch.request({',
      "      url: `${fetchOrigin}/@happier-dev%2fplugin-sdk`,",
      "      method: 'GET',",
      "      redirect: 'error',",
      '    });',
      '    return {',
      '      fetch: {',
      '        status: response.status,',
      '        finalUrl: response.finalUrl,',
      '        body: new TextDecoder().decode(response.body),',
      '      },',
      '    };',
      '  }',
      "  if (operation === 'connected-account-materialize') {",
      "    const binding = await context.services.connectedAccounts.getBinding('packed-novel-account');",
      "    const materialization = await context.services.connectedAccounts.materialize('packed-novel-account', {",
      "      kind: 'environment',",
      "      keys: ['NOVEL_CLOUD_TOKEN'],",
      '    });',
      '    return {',
      '      binding,',
      '      materializationKind: materialization.kind,',
      "      credentialVerified: materialization.kind === 'environment'",
      "        && materialization.env.NOVEL_CLOUD_TOKEN === 'token-b',",
      '    };',
      '  }',
      "  if (operation === 'connected-account-request-selection') {",
      '    try {',
      '      return {',
      "        status: 'selected',",
      "        binding: await context.services.connectedAccounts.requestSelection({",
      "          purpose: 'packed-novel-account',",
      "          reason: 'Select the packed Novel Cloud account',",
      '        }),',
      '      };',
      '    } catch (error) {',
      "      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'",
      '        ? error.code',
      "        : 'unknown';",
      "      return { status: 'unavailable', code };",
      '    }',
      '  }',
      "  if (operation === 'connected-account-watch-rematerialize') {",
      "    const observations: Array<{ purpose: string; targetKind: 'account' | 'group'; accountId: string | null; materializationKind: string }> = [];",
      '    let resolveSecondResync!: () => void;',
      '    let rejectSecondResync!: (error: unknown) => void;',
      '    const secondResync = new Promise<void>((resolve, reject) => {',
      '      resolveSecondResync = resolve;',
      '      rejectSecondResync = reject;',
      '    });',
      '    let materializationQueue = Promise.resolve();',
      "    const subscription = context.services.connectedAccounts.watch('packed-novel-account', (event) => {",
      "      if (event.kind !== 'resync') {",
      "        rejectSecondResync(new Error('Packed Connected Account watch emitted an invalid event'));",
      '        return;',
      '      }',
      '      materializationQueue = materializationQueue.then(async () => {',
      "        const binding = await context.services.connectedAccounts.getBinding('packed-novel-account');",
      "        const materialization = await context.services.connectedAccounts.materialize('packed-novel-account', {",
      "          kind: 'environment',",
      "          keys: ['NOVEL_CLOUD_TOKEN'],",
      '        });',
      "        const token = materialization.kind === 'environment'",
      '          ? materialization.env.NOVEL_CLOUD_TOKEN',
      '          : undefined;',
      "        const accountId = token === 'token-b'",
      "          ? 'account-b'",
      "          : token === 'token-a-reconnected'",
      "            ? 'account-a'",
      '            : null;',
      '        observations.push({',
      "          purpose: binding?.purpose ?? 'missing',",
      "          targetKind: binding?.target.kind ?? 'account',",
      '          accountId,',
      '          materializationKind: materialization.kind,',
      '        });',
      '        if (observations.length === 1) {',
      "          appendMarker('connected-account-watch-ready');",
      '        }',
      "        if (observations.length >= 2 && accountId === 'account-a') resolveSecondResync();",
      '      }).catch(rejectSecondResync);',
      '    });',
      '    const timeout = setTimeout(() => {',
      "      rejectSecondResync(new Error('Timed out waiting for packed Connected Account rematerialization'));",
      '    }, 15_000);',
      '    try {',
      '      await secondResync;',
      '      await materializationQueue;',
      '    } finally {',
      '      clearTimeout(timeout);',
      '      subscription.dispose();',
      '    }',
      '    return { resyncCount: observations.length, observations };',
      '  }',
      "  if (operation === 'connected-account-dormancy-materialize') {",
      "    const binding = await context.services.connectedAccounts.getBinding('packed-novel-account');",
      "    const materialization = await context.services.connectedAccounts.materialize('packed-novel-account', {",
      "      kind: 'environment',",
      "      keys: ['NOVEL_CLOUD_TOKEN'],",
      '    });',
      "    const token = materialization.kind === 'environment'",
      '      ? materialization.env.NOVEL_CLOUD_TOKEN',
      '      : undefined;',
      "    const accountId = typeof token === 'string' && token.startsWith('device:device-account')",
      "      ? 'device-account'",
      '      : null;',
      '    return {',
      '      binding,',
      '      materializationKind: materialization.kind,',
      '      accountId,',
      "      credentialVerified: accountId === 'device-account',",
      '    };',
      '  }',
      "  if (operation === 'builtin-claude-materialize') {",
      "    const binding = await context.services.connectedAccounts.getBinding('packed-claude-account');",
      "    const materialization = await context.services.connectedAccounts.materialize('packed-claude-account', {",
      "      kind: 'environment',",
      "      keys: ['CLAUDE_CODE_OAUTH_TOKEN'],",
      '    });',
      '    return {',
      '      binding,',
      '      materializationKind: materialization.kind,',
      "      credentialVerified: materialization.kind === 'environment'",
      "        && materialization.env.CLAUDE_CODE_OAUTH_TOKEN === 'packed-claude-setup-token-reconnected',",
      '    };',
      '  }',
    ] : []),
    "  if (operation === 'notification-preferences') {",
    "    return { notification: await context.services.notifications.preferences('packed-ready') };",
    '  }',
    "  if (operation === 'notification-send') {",
    "    const clientRequestId = typeof input === 'object' && input !== null && 'clientRequestId' in input ? input.clientRequestId : undefined;",
    "    if (typeof clientRequestId !== 'string') throw new Error('Packed notification request id is required');",
    "    await context.services.events.emit('notification-ready', { clientRequestId });",
    '    return {',
    '      notification: await context.services.notifications.send({',
    '        clientRequestId,',
    "        categoryId: 'packed-ready',",
    "        title: 'Packed notification ready',",
    '      }),',
    '    };',
    '  }',
    "  const value = typeof input === 'object' && input !== null && 'value' in input ? input.value : undefined;",
    "  if (typeof value === 'string') await context.services.storage.local.set('verticalAValue', value);",
    '  const decoder = new TextDecoder();',
    '  const resources = {',
    "    prompt: decoder.decode((await context.services.resources.read('prompt')).bytes),",
    "    skill: decoder.decode((await context.services.resources.read('skill')).bytes),",
    "    template: decoder.decode((await context.services.resources.read('template')).bytes),",
    "    asset: decoder.decode((await context.services.resources.read('asset')).bytes),",
    "    config: decoder.decode((await context.services.resources.read('config')).bytes),",
    '  };',
    "  appendMarker('invoke');",
    "  return { pluginId: " + JSON.stringify(params.pluginId) + ", version: " + JSON.stringify(params.version) + ", value: await context.services.storage.local.get('verticalAValue'), resources, activationInstanceId, pid: process.pid, runtime: { execPath: process.execPath, argv: process.argv.slice(0, 3) } };",
    '};',
    '',
    'const packedForgeConnectedAccountRuntime = {',
    '  authentication: {',
    '    modes: {',
    '      manual: {',
    "        kind: 'manual',",
    '        complete: async (input, context) => {',
    '          const token = input.fields.token?.trim();',
    '          if (!token) {',
    "            return { status: 'rejected' as const, diagnostic: { code: 'packed_forge_token_missing', severity: 'error' as const, message: 'Packed Forge token is required.' } };",
    '          }',
    "          await context.attemptCredentials.set('token', token);",
    "          return { status: 'connected' as const, accountId: 'packed-forge', displayName: 'Packed Forge', scopes: [] };",
    '        },',
    '      },',
    '    },',
    '  },',
    '  refresh: async (context) => (await context.credentials.get(\'token\'))',
    "    ? { status: 'connected' as const, displayName: 'Packed Forge', scopes: [] }",
    "    : { status: 'unavailable' as const },",
    "  revoke: async () => ({ status: 'remoteUnsupported' as const }),",
    '  status: async (context) => (await context.credentials.get(\'token\'))',
    "    ? { status: 'connected' as const, displayName: 'Packed Forge', scopes: [] }",
    "    : { status: 'unavailable' as const },",
    '  materialize: async (request, context) => {',
    "    const token = await context.credentials.get('token');",
    "    if (!token) throw new Error('Packed Forge credentials are unavailable');",
    "    if (request.kind === 'httpHeaders') return { kind: 'httpHeaders' as const, headers: { Authorization: `Bearer ${token}` } };",
    "    if (request.kind === 'environment') return { kind: 'environment' as const, env: {} };",
    "    return { kind: 'files' as const, files: {} };",
    '  },',
    '} satisfies PluginConnectedAccountRuntime;',
    '',
    'const novelAccountId = (context: PluginConnectedAccountAuthenticationContext, fallback: string): string => context.attempt.kind === \'reconnect\'',
    '  ? context.attempt.account.accountId',
    '  : fallback;',
    'const readNovelConfiguration = async (context: PluginConnectedAccountAuthenticationContext, secretFieldId: string) => {',
    '  const secret = await context.configuration.getSecret(secretFieldId);',
    '  if (!secret) {',
    "    return { ok: false as const, diagnostic: { code: 'novel_configuration_secret_missing', severity: 'error' as const, message: 'Novel Cloud configuration secret is required.' } };",
    '  }',
    "  appendMarker('connected-account-configuration');",
    '  return { ok: true as const, secret };',
    '};',
    'const fetchNovelProvider = async (context: PluginConnectedAccountAuthenticationContext): Promise<void> => {',
    "  const configuredOrigin = context.configuration.values['api-origin'];",
    "  if (typeof configuredOrigin !== 'string') throw new Error('Novel Cloud configured origin is unavailable');",
    '  const response = await context.services.fetch.request({',
    '    url: `${configuredOrigin}/@happier-dev%2fplugin-sdk`,',
    "    method: 'GET',",
    "    redirect: 'error',",
    '  });',
    "  if (response.status !== 200) throw new Error('Novel Cloud provider probe failed');",
    "  appendMarker('connected-account-final-fetch');",
    '};',
    'const packedNovelCloudConnectedAccountRuntime = {',
    '  authentication: {',
    '    modes: {',
    '      manual: {',
    "        kind: 'manual',",
    '        complete: async (input, context) => {',
    "          appendMarker('connected-account-manual');",
    '          const token = input.fields.token?.trim();',
    '          if (!token) {',
    "            return { status: 'rejected' as const, diagnostic: { code: 'novel_token_missing', severity: 'error' as const, message: 'Novel Cloud token is required.' } };",
    '          }',
    "          if (token === 'outcome-unknown') {",
    "            return { status: 'outcomeUnknown' as const, diagnostic: { code: 'novel_manual_outcome_unknown', severity: 'warning' as const, message: 'Novel Cloud could not determine the remote outcome.' } };",
    '          }',
    "          if (token === 'slow-token') {",
    '            await new Promise((resolveSlow) => setTimeout(resolveSlow, 300));',
    '          }',
    '          await fetchNovelProvider(context);',
    "          await context.attemptCredentials.set('token', token);",
    "          const proposedAccountId = token === 'token-b' ? 'account-b' : 'account-a';",
    '          const accountId = novelAccountId(context, proposedAccountId);',
    "          return { status: 'connected' as const, accountId, providerIdentity: { accountId: `provider-${accountId}` }, displayName: `Novel ${accountId}`, scopes: ['novel.read'] };",
    '        },',
    '      },',
    '      oauth: {',
    "        kind: 'oauthAuthorizationCode',",
    '        begin: async (input, context) => {',
    "          appendMarker('connected-account-oauth-begin');",
    "          const configured = await readNovelConfiguration(context, 'client-secret');",
    '          if (!configured.ok) return { status: \'rejected\' as const, diagnostic: configured.diagnostic };',
    "          const authorizationOrigin = context.configuration.values['authorization-origin'];",
    "          if (typeof authorizationOrigin !== 'string') throw new Error('Novel Cloud authorization origin is unavailable');",
    '          const parsedAuthorizationOrigin = new URL(authorizationOrigin);',
    "          if (parsedAuthorizationOrigin.protocol !== 'https:' || parsedAuthorizationOrigin.username || parsedAuthorizationOrigin.password || parsedAuthorizationOrigin.origin !== authorizationOrigin) throw new Error('Novel Cloud authorization origin must be an exact HTTPS origin');",
    "          const authorizationUrl = new URL('/authorize', parsedAuthorizationOrigin.origin);",
    "          authorizationUrl.searchParams.set('response_type', 'code');",
    "          authorizationUrl.searchParams.set('state', input.state);",
    "          authorizationUrl.searchParams.set('redirect_uri', input.callbackUrl);",
    '          await fetchNovelProvider(context);',
    "          await context.attemptCredentials.set('oauth-state', input.state);",
    "          return { status: 'awaitingOAuthRedirect' as const, authorizationUrl: authorizationUrl.href, expiresAtMs: Date.now() + 300_000 };",
    '        },',
    '        complete: async (input, context) => {',
    "          appendMarker('connected-account-oauth-complete');",
    "          if (input.code === 'outcome-unknown') {",
    '            await fetchNovelProvider(context);',
    "            await context.attemptCredentials.set('token', 'oauth:outcome-unknown');",
    "            await context.attemptCredentials.set('oauth-settled', 'true');",
    "            await context.attemptCredentials.set('oauth-account-id', 'oauth-account');",
    "            return { status: 'outcomeUnknown' as const, diagnostic: { code: 'novel_oauth_outcome_unknown', severity: 'warning' as const, message: 'Novel Cloud OAuth completion is uncertain.' } };",
    '          }',
    '          await fetchNovelProvider(context);',
    "          await context.attemptCredentials.set('token', `oauth:${input.code}`);",
    "          await context.attemptCredentials.set('oauth-settled', 'true');",
    "          const accountId = novelAccountId(context, input.code === 'oauth-account' ? 'oauth-account' : input.code === 'account-b' ? 'account-b' : 'account-a');",
    "          return { status: 'connected' as const, accountId, providerIdentity: { email: `${accountId}@novel.example` }, displayName: `Novel ${accountId}`, scopes: ['novel.read', 'novel.write'] };",
    '        },',
    '        cancel: async () => {',
    "          appendMarker('connected-account-cancel');",
    '        },',
    '        reconcile: async (context) => {',
    "          appendMarker('connected-account-reconcile');",
    "          if (await context.attemptCredentials.get('oauth-settled') !== 'true') return { status: 'pending' as const, retryAfterMs: 1_000 };",
    "          const accountId = novelAccountId(context, (await context.attemptCredentials.get('oauth-account-id')) ?? 'account-a');",
    "          return { status: 'connected' as const, accountId, displayName: `Novel ${accountId}`, scopes: ['novel.read', 'novel.write'] };",
    '        },',
    '      },',
    '      device: {',
    "        kind: 'oauthDeviceCode',",
    '        begin: async (context) => {',
    "          appendMarker('connected-account-device-begin');",
    "          const configured = await readNovelConfiguration(context, 'account-secret');",
    '          if (!configured.ok) return { status: \'rejected\' as const, diagnostic: configured.diagnostic };',
    '          await fetchNovelProvider(context);',
    "          await context.attemptCredentials.set('device-polls', '0');",
    "          return { status: 'awaitingDeviceAuthorization' as const, verificationUri: 'https://auth.novel.example/device', verificationUriComplete: 'https://auth.novel.example/device?code=NOVEL-123', userCode: 'NOVEL-123', expiresAtMs: Date.now() + 300_000, pollIntervalMs: 1_000 };",
    '        },',
    '        poll: async (context) => {',
    "          appendMarker('connected-account-device-poll');",
    "          const pollCount = Number.parseInt((await context.attemptCredentials.get('device-polls')) ?? '0', 10);",
    '          if (pollCount < 1) {',
    "            await context.attemptCredentials.set('device-polls', String(pollCount + 1));",
    "            return { status: 'pending' as const, retryAfterMs: 1_000 };",
    '          }',
    '          await fetchNovelProvider(context);',
    "          await context.attemptCredentials.set('token', 'device:device-account');",
    "          const accountId = novelAccountId(context, 'device-account');",
    "          return { status: 'connected' as const, accountId, displayName: `Novel ${accountId}`, scopes: ['novel.read'] };",
    '        },',
    '        cancel: async () => {',
    "          appendMarker('connected-account-cancel');",
    '        },',
    '      },',
    '    },',
    '  },',
    '  refresh: async (context) => {',
    "    const accountSecret = await context.configuration.getSecret('account-secret');",
    "    const token = await context.credentials.get('token');",
    "    if (!token || accountSecret !== 'packed-device-account-secret') return { status: 'unavailable' as const };",
    "    await context.stagedCredentials.set('token', `${token}:refreshed`);",
    "    appendMarker('connected-account-refresh');",
    "    return { status: 'connected' as const, displayName: `Novel ${context.account.accountId}`, scopes: ['novel.read'] };",
    '  },',
    '  revoke: async () => {',
    "    appendMarker('connected-account-revoke');",
    "    return { status: 'remoteRevoked' as const };",
    '  },',
    '  status: async (context) => {',
    "    appendMarker('connected-account-status');",
    "    return (await context.credentials.get('token'))",
    "      ? { status: 'connected' as const, displayName: `Novel ${context.account.accountId}`, scopes: ['novel.read'] }",
    "      : { status: 'unavailable' as const };",
    '  },',
    '  quota: async () => {',
    "    appendMarker('connected-account-quota');",
    "    return { observedAtMs: Date.now(), limits: [{ id: 'requests', remaining: 42 }] };",
    '  },',
    '  materialize: async (request, context) => {',
    "    appendMarker('connected-account-materialize');",
    "    const token = await context.credentials.get('token');",
    "    if (!token) throw new Error('Novel Cloud credentials are unavailable');",
    "    if (request.kind === 'httpHeaders') return { kind: 'httpHeaders' as const, headers: { Authorization: `Bearer ${token}`, 'X-Novel-Account': context.account.accountId } };",
    "    if (request.kind === 'environment') return { kind: 'environment' as const, env: { NOVEL_CLOUD_TOKEN: token } };",
    "    return { kind: 'files' as const, files: { 'novel-token.txt': new TextEncoder().encode(token) } };",
    '  },',
    '} satisfies PluginConnectedAccountRuntime;',
    '',
    "const packedNotificationSender: Parameters<PluginApi['notifications']['registerChannel']>[1] = async (request, context) => {",
    "  appendMarker('notification-send');",
    "  const endpoint = await context.services.settings.get('webhook.endpoint');",
    '  try {',
    "    const token = await context.services.secrets.get('webhook.token', { reason: 'Authenticate packed notification delivery' });",
    "    if (endpoint !== 'https://notifications.example.test/deliver') {",
    "      return { deliveryId: request.deliveryId, channelId: request.channelId, status: 'failed' as const, code: 'endpoint_invalid', retryable: false };",
    '    }',
    "    return token === 'configured-notification-token'",
    "      ? { deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted' as const, evidence: 'provider' as const }",
    "      : { deliveryId: request.deliveryId, channelId: request.channelId, status: 'failed' as const, code: 'credential_invalid', retryable: false };",
    '  } catch (error) {',
    "    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'",
    '      ? error.code',
    "      : 'credential_unavailable';",
    "    return { deliveryId: request.deliveryId, channelId: request.channelId, status: 'failed' as const, code, retryable: false };",
    '  }',
    '};',
    '',
    'const packedForgeAdapter = {',
    '  detectRemote: ({ remoteName, remoteUrl }) => {',
    "    if (!remoteUrl.startsWith('https://forge.example/')) return null;",
    "    appendMarker('scm-provider-detect');",
    '    return {',
    "      id: 'forge',",
    "      kind: 'packed-forge',",
    "      displayName: 'Packed Forge',",
    "      baseUrl: 'https://forge.example',",
    "      repositoryWebUrl: 'https://forge.example/packed/repository',",
    "      nameWithOwner: 'packed/repository',",
    '      remoteName,',
    '    };',
    '  },',
    '  describePublishTargets: async ({ provider, runtimeServices }) => {',
    "    appendMarker('scm-auth');",
    '    const materialized = await runtimeServices?.resolveScmHostingTokenMaterialization?.({',
    "      kind: 'scm_hosting_token',",
    '      providerId: provider.id,',
    "      host: 'forge.example',",
    '      provider,',
    '    });',
    "    if (materialized?.kind === 'available' && materialized.token === 'token-b') {",
    "      appendMarker('scm-auth-account-b');",
    '    } else {',
    "      appendMarker('scm-auth-wrong-account');",
    '    }',
    "    const auth = materialized?.kind === 'available'",
    "      ? { state: 'authenticated' as const, profileKind: 'connected_account' as const, ...(materialized.profileKey ? { profileKey: materialized.profileKey } : {}) }",
    "      : { state: 'authentication_required' as const, profileKind: 'connected_account' as const, remediation: { kind: 'auth_required' as const } };",
    '    return {',
    '      auth,',
    '      targets: [{',
    '        provider,',
    "        owner: 'packed-owner',",
    "        ownerKind: 'user',",
    "        label: 'packed-owner',",
    '        isDefault: true,',
    "        supportedVisibilities: ['private'],",
    "        supportedRemoteUrlKinds: ['https'],",
    '        auth,',
    '      }],',
    '    };',
    '  },',
    '} satisfies ScmHostingProviderRuntimeAdapter;',
    '',
    'const packedExternalSessions = {',
    '  resolveSource: async (request) => {',
    "    appendMarker('external-resolve-source');",
    "    return { ok: true as const, value: { source: { kind: 'packedExternal', scope: request.source.scope } } };",
    '  },',
    '  listCandidates: async (request) => {',
    "    appendMarker('external-list');",
    "    const offset = request.cursor === undefined ? 0 : Number.parseInt(request.cursor.replace('packed-candidate-', ''), 10);",
    "    if (!Number.isSafeInteger(offset) || offset < 0 || request.maxItems > 50) throw new Error('packed_external_cursor_invalid');",
    "    const remoteSessionId = `packed-session-${offset}`;",
    '    return {',
    '      ok: true as const,',
    '      value: {',
    "        candidates: [{ remoteSessionId, title: `Packed session ${offset}`, createdAtMs: 1, updatedAtMs: 10 - offset, linkData: { scope: 'default', offset } }],",
    "        nextCursor: offset < 2 ? `packed-candidate-${offset + 1}` : null,",
    '      },',
    '    };',
    '  },',
    '  resolveLinkIdentity: async (request) => {',
    "    appendMarker('external-link');",
    "    return { ok: true as const, value: { source: { kind: 'packedExternal', scope: request.source.scope }, remoteSessionId: request.remoteSessionId, linkData: { scope: request.source.scope } } };",
    '  },',
    '  resolveLinkedIdentity: async (request) => {',
    "    appendMarker('external-resolve-linked');",
    "    return { ok: true as const, value: { source: { kind: 'packedExternal', scope: request.source.scope }, remoteSessionId: request.remoteSessionId, linkData: request.linkData } };",
    '  },',
    '  pageTranscript: async () => {',
    "    appendMarker('external-page');",
    '    return {',
    '      ok: true as const,',
    '      value: {',
    "        items: [{ id: `packed-page-${pluginVersion}`, createdAtMs: 1, messageRole: 'agent' as const, raw: { role: 'agent', text: `packed-page-${pluginVersion}` } }],",
    '        nextCursor: null,',
    "        tailCursor: `packed-tail-${pluginVersion}`,",
    '        hasMore: false,',
    '      },',
    '    };',
    '  },',
    '  readAfterTranscript: async () => {',
    "    appendMarker('external-read-after');",
    '    return {',
    '      ok: true as const,',
    '      value: {',
    "        outcome: 'advanced' as const,",
    "        items: [{ id: `packed-read-after-${pluginVersion}`, createdAtMs: 2, messageRole: 'agent' as const, raw: { role: 'agent', text: `packed-read-after-${pluginVersion}` } }],",
    "        nextCursor: `packed-tail-next-${pluginVersion}`,",
    "        boundary: `packed-tail-next-${pluginVersion}`,",
    '      },',
    '    };',
    '  },',
    '} satisfies AgentExternalSessionsContribution;',
    '',
    'const groupPackedExternalSessionResource = (request: Parameters<AgentExternalSessionObservationContribution[\'describeResource\']>[0]) => ({',
    "  resourceKey: `packed-resource-${request.source.scope}`,",
    '  linkKey: request.remoteSessionId,',
    '});',
    '',
    'const describePackedExternalSessionResource = (request: Parameters<AgentExternalSessionObservationContribution[\'describeResource\']>[0]) => ({',
    '  ...groupPackedExternalSessionResource(request),',
    "  changeObservation: 'reconcile_only' as const,",
    '});',
    '',
    'const packedExternalSessionObservation = {',
    '  describeResource: groupPackedExternalSessionResource,',
    '  observeResource: async () => ({ dispose() {} }),',
    '  reconcileResource: async (request) => request.purpose === \'resource_descriptors\'',
    '    ? ({',
    "        purpose: 'resource_descriptors' as const,",
    '        outcomes: request.links.map((link) => ({',
    "          kind: 'described' as const,",
    '          descriptor: describePackedExternalSessionResource(link.linkedSource),',
    '        })),',
    '      })',
    '    : ({',
    "        purpose: 'observation_evidence' as const,",
    '        outcomes: request.links.map((link) => ({',
    '          linkKey: link.linkKey,',
    '          facts: [{',
    "            kind: 'successful_empty' as const,",
    "            emptyTurnPhase: 'idle' as const,",
    "            evidenceClass: 'reconciliation' as const,",
    '            observedAtMs: Date.now(),',
    '            expiresAtMs: Date.now() + 30_000,',
    '          }],',
    '        })),',
    '      }),',
    '} satisfies AgentExternalSessionObservationContribution;',
    '',
    'const packedExternalSessionHooks = {',
    '  installationVariants: [{',
    "    variantId: 'packed-hook-v1',",
    '    targets: [{',
    "      targetId: 'settings',",
    "      format: 'hook_event_json_arrays_v1',",
    "      collectionId: 'hooks',",
    '    }],',
    '    events: [{',
    "      eventId: 'session-start',",
    "      targetId: 'settings',",
    "      nativeEventName: 'SessionStart',",
    '      command: {',
    "        kind: 'happier_observation_v1',",
    "        shellDialect: process.platform === 'win32' ? 'windows_cmd' : 'posix',",
    '      },',
    '    }],',
    '  }],',
    '  resolveInstallation: async () => {',
    "    appendMarker('external-hook-resolve');",
    '    const happyHomeDir = process.env.HAPPIER_HOME_DIR;',
    "    if (!happyHomeDir) throw new Error('Packed hook fixture requires HAPPIER_HOME_DIR');",
    '    return {',
    '      ok: true as const,',
    '      value: {',
    "        kind: 'supported' as const,",
    "        variantId: 'packed-hook-v1',",
    '        targets: [{',
    "          targetId: 'settings',",
    "          absolutePath: join(happyHomeDir, 'packed-external-agent', 'settings.json'),",
    '        }],',
    "        readiness: { kind: 'ready' as const },",
    '      },',
    '    };',
    '  },',
    '  mapHookEvent: async () => {',
    "    appendMarker('external-hook-map');",
    "    return { ok: true as const, value: { kind: 'ignored' as const } };",
    '  },',
    '} satisfies AgentExternalSessionHooksContribution;',
    '',
    'export function activate(api: PluginApi): () => void {',
    '  if (activationInvocationCount > 0) activationInstanceId = randomUUID();',
    '  activationInvocationCount += 1;',
    "  appendMarker('activate');",
    ...(params.failActivation ? [
      "  throw new Error('vertical-a-rejected-update');",
    ] : []),
    "  if (shouldFailPostCommit()) throw new Error('vertical-a-post-commit-fatal');",
    "  api.actions.register('roundtrip', roundtrip);",
    "  api.events.register('observe-notification-ready', (payload) => {",
    "    if (!payload || typeof payload !== 'object' || !('clientRequestId' in payload) || typeof payload.clientRequestId !== 'string') {",
    "      throw new Error('Packed notification event payload is invalid');",
    '    }',
    "    appendMarker('event-subscription');",
    '  });',
    ...(params.pluginId === 'acme.vertical-a' ? [
      "  api.interceptors.register('observe-api', (request) => {",
      "    appendMarker('request-interceptor');",
      '    return {',
      "      decision: 'continue',",
      '      request: {',
      '        ...request,',
      "        headers: { ...request.headers, 'x-packed-interceptor': 'acme.vertical-a/observe-api' },",
      '      },',
      '    };',
      '  });',
    ] : []),
    "  api.notifications.registerChannel('webhook', packedNotificationSender);",
    "  api.connectedAccounts.register('github', packedForgeConnectedAccountRuntime);",
    ...(params.pluginId === 'acme.vertical-a' ? [
      "  api.connectedAccounts.register('novel-cloud', packedNovelCloudConnectedAccountRuntime);",
    ] : []),
    "  api.scm.registerHostingProvider('forge', { adapter: packedForgeAdapter });",
    "  api.scm.registerBackend('stacked', {",
    '    runtime: {',
    "      repoModes: ['.git'],",
    '      capabilities: {',
    "        detection: { repository: { support: 'supported' } },",
    "        read: { status: { support: 'supported' } },",
    "        changeSet: { model: 'working-copy', diffAreas: ['pending'] },",
    '        commit: {}, remote: {}, branch: {}, worktree: {}, lifecycle: {},',
    "        hosting: { providerDetection: { support: 'supported' }, repositoryPublishTargets: { support: 'supported' } },",
    '        checkpoints: {}, workspaceIntegration: {}, tooling: {}, freshness: {},',
    '      },',
    '      commands: [],',
    '    },',
    '    handlers: {',
    '      detection: {',
    '        detectRepo: ({ cwd }) => {',
    "          appendMarker('scm-detect');",
    "          return { isRepo: true, rootPath: cwd, mode: '.git' };",
    '        },',
    '      },',
    '      read: {',
    '        statusSnapshot: async () => {',
    "          appendMarker('scm-status');",
    '          const detected = packedForgeAdapter.detectRemote?.({',
    "            remoteName: 'origin',",
    "            remoteUrl: 'https://forge.example/packed/repository',",
    '          });',
    `          const providerId = detected ? ${JSON.stringify(`${params.pluginId}/forge`)} : 'unresolved';`,
    '          return {',
    '            success: false,',
    "            errorCode: 'COMMAND_FAILED',",
    '            error: `Packed SCM status reached ${providerId}`,',
    '          };',
    '        },',
    '      },',
    '      hosting: {',
    '        repositoryDescribePublishTargets: async () => {',
    "          appendMarker('scm-repository');",
    '          const services = readCurrentScmHostingProviderRuntimeServices();',
    '          const registry = await services?.resolveScmHostingProviderRegistry?.();',
    `          const adapter = registry?.getAdapter(${JSON.stringify(`${params.pluginId}/forge`)});`,
    '          const result = await adapter?.describePublishTargets?.({',
    '            provider: {',
    `              id: ${JSON.stringify(`${params.pluginId}/forge`)},`,
    "              kind: 'unknown',",
    "              providerKind: 'custom',",
    "              displayName: 'Packed Forge',",
    "              baseUrl: 'https://forge.example',",
    "              repositoryWebUrl: 'https://forge.example/packed/repository',",
    "              nameWithOwner: 'packed/repository',",
    "              remoteName: 'origin',",
    "              urlSafety: { allowedSchemes: ['https:'], allowedBaseUrls: ['https://forge.example'], allowedOrigins: ['https://forge.example'] },",
    '            },',
    "            defaultRepositoryName: 'packed-repository',",
    '            ...(services ? { runtimeServices: services } : {}),',
    '          });',
    "          if (!result) return { success: false, error: 'Packed Forge publish targets are unavailable.', errorCode: 'FEATURE_UNSUPPORTED' };",
    '          return {',
    '            success: true,',
    `            auth: result.auth ?? (${JSON.stringify(unknownScmRepositoryAuth)} as const),`,
    "            defaultRepositoryName: 'packed-repository',",
    '            targets: [...result.targets],',
    '          };',
    '        },',
    '      },',
    '    },',
    '  });',
    ...(params.pluginId === 'acme.vertical-a' ? [
      "  api.agents.registerExternalSessions('packed-external-agent', packedExternalSessions);",
      "  api.agents.registerExternalSessionObservation('packed-external-agent', packedExternalSessionObservation);",
      "  api.agents.registerExternalSessionHooks('packed-external-agent', packedExternalSessionHooks);",
    ] : []),
    "  appendMarker('registered');",
    '  return () => {',
    '    if (shouldFailCleanup()) {',
    "      appendMarker('cleanup-failure');",
    "      throw new Error('vertical-a-activation-cleanup-failure');",
    '    }',
    "    appendMarker('cleanup');",
    '  };',
    '}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(params.pluginRoot, 'test', 'index.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "import test from 'node:test';",
    '',
    "import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';",
    '',
    "const manifest = JSON.parse(await readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'));",
    "const module = await import('../dist/index.js');",
    '',
    "test('roundtrip action is registered by the configured vertical-a fixture', async (t) => {",
    '  const plugin = await createPluginTestkit({ manifest, module });',
    '  t.after(async () => plugin.dispose());',
    '',
    "  const registration = plugin.registrations().find(({ family, localId }) => family === 'actions' && localId === 'roundtrip');",
    "  assert.ok(registration, 'configured fixture must register its declared roundtrip action');",
    ...(params.pluginId === 'acme.vertical-a' ? [
      "  const interceptor = plugin.registrations().find(({ family, localId }) => family === 'requestInterceptors' && localId === 'observe-api');",
      "  assert.ok(interceptor, 'configured fixture must register its declared request interceptor');",
      "  const externalSessions = plugin.registrations().find(({ family, localId }) => family === 'agents' && localId === 'packed-external-agent');",
      "  assert.ok(externalSessions, 'configured fixture must register its declared External Sessions auxiliary');",
      "  const connectedAccount = plugin.registrations().find(({ family, localId }) => family === 'connectedAccountDescriptors' && localId === 'novel-cloud');",
      "  assert.ok(connectedAccount, 'configured fixture must register its declared novel Connected Account runtime');",
    ] : []),
    '});',
    '',
  ].join('\n'), 'utf8');
}

export async function readVerticalAMarkerEvents(markerPath) {
  const raw = await readFile(markerPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  return raw.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const [kind, version, activationInstanceId, rawPid, ...unexpected] = line.split(':');
    const pid = Number(rawPid);
    if (
      unexpected.length > 0
      || ![
        'module', 'activate', 'registered', 'invoke', 'cleanup', 'cleanup-failure',
        'notification-send', 'event-subscription', 'request-interceptor',
        'scm-detect', 'scm-status', 'scm-repository', 'scm-provider-detect',
        'scm-auth', 'scm-auth-account-b', 'scm-auth-wrong-account',
        'connected-account-configuration', 'connected-account-final-fetch',
        'connected-account-manual', 'connected-account-oauth-begin',
        'connected-account-oauth-complete', 'connected-account-device-begin',
        'connected-account-device-poll', 'connected-account-cancel',
        'connected-account-reconcile', 'connected-account-refresh',
        'connected-account-revoke', 'connected-account-status',
        'connected-account-quota', 'connected-account-materialize',
        'connected-account-watch-ready',
        'external-resolve-source', 'external-list', 'external-link',
        'external-resolve-linked', 'external-page', 'external-read-after',
        'external-hook-resolve', 'external-hook-map',
      ].includes(kind)
      || !version
      || !/^[0-9a-f-]{36}$/u.test(activationInstanceId ?? '')
      || !Number.isInteger(pid)
      || pid <= 0
    ) {
      fail(`Invalid Vertical-A lifecycle marker: ${line}`);
    }
    return { kind, version, activationInstanceId, pid };
  });
}

export function findLatestMarkerEvent(events, kind, version) {
  return events.findLast((event) => event.kind === kind && event.version === version) ?? null;
}

export async function waitForActivationCleanup({ markerPath, version, activationInstanceId, timeoutMs = 15_000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await readVerticalAMarkerEvents(markerPath);
    const cleanupEvent = events.find((event) => (
      event.kind === 'cleanup'
      && event.version === version
      && event.activationInstanceId === activationInstanceId
    ));
    if (cleanupEvent) return cleanupEvent;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  fail(`Timed out waiting for ${version} activation ${activationInstanceId} cleanup after uninstall`);
}

export async function waitForActivationCleanupFailure({
  markerPath,
  version,
  activationInstanceId,
  timeoutMs = 15_000,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await readVerticalAMarkerEvents(markerPath);
    const cleanupFailure = events.find((event) => (
      event.kind === 'cleanup-failure'
      && event.version === version
      && event.activationInstanceId === activationInstanceId
    ));
    if (cleanupFailure) return cleanupFailure;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  fail(`Timed out waiting for ${version} activation ${activationInstanceId} cleanup failure`);
}

function assertRoundtrip(envelope, expected) {
  const result = envelope.data?.result;
  const expectedResources = verticalAResourcePayloads(expected.version);
  if (
    result?.pluginId !== expected.pluginId
    || result?.version !== expected.version
    || result?.value !== expected.value
    || JSON.stringify(result?.resources) !== JSON.stringify(expectedResources)
    || (expected.activationInstanceId !== undefined && result?.activationInstanceId !== expected.activationInstanceId)
  ) {
    fail(`Unexpected ${expected.pluginId} roundtrip result: ${JSON.stringify(result)}`);
  }
}

function readPackedNotificationResult(envelope, label) {
  const notification = envelope?.data?.result?.notification;
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    fail(`Packed notification ${label} did not return a visible result: ${JSON.stringify(envelope)}`);
  }
  return notification;
}

export function assertVerticalANotificationLifecycleEvidence({
  pluginId,
  configuration,
  success,
  failure,
  replay,
  recovery,
  suppressedPreferences,
  suppressed,
  restoredPreferences,
  eventSubscriptionDeliveries,
  retiredInvocation,
}) {
  const channelId = `${pluginId}/webhook`;
  const serializedEvidence = JSON.stringify({
    configuration,
    success,
    failure,
    replay,
    recovery,
    suppressedPreferences,
    suppressed,
    restoredPreferences,
  });
  if (
    serializedEvidence.includes('configured-notification-token')
    || serializedEvidence.includes('invalid-notification-token')
  ) {
    fail('Packed notification evidence exposed credential material');
  }
  if (
    configuration?.storageScope !== 'synced'
    || configuration?.values?.['webhook.endpoint'] !== 'https://notifications.example.test/deliver'
    || configuration?.values?.['webhook.token'] !== undefined
    || JSON.stringify(configuration?.redactedKeys) !== JSON.stringify(['webhook.token'])
  ) {
    fail(`Packed notification configuration did not route through canonical settings/secrets owners: ${JSON.stringify(configuration)}`);
  }
  const assertDelivery = (envelope, label, expected) => {
    const notification = readPackedNotificationResult(envelope, label);
    const delivery = notification.deliveries?.[0];
    if (
      notification.replayed !== expected.replayed
      || !Array.isArray(notification.deliveries)
      || notification.deliveries.length !== 1
      || delivery?.channelId !== channelId
      || delivery?.status !== expected.status
      || (expected.evidence !== undefined && delivery?.evidence !== expected.evidence)
      || (expected.code !== undefined && delivery?.code !== expected.code)
    ) {
      fail(`Packed notification ${label} returned unexpected delivery evidence: ${JSON.stringify(notification)}`);
    }
    return delivery;
  };
  const accepted = assertDelivery(success, 'success', {
    replayed: false,
    status: 'accepted',
    evidence: 'provider',
  });
  const failedDelivery = assertDelivery(failure, 'provider failure', {
    replayed: false,
    status: 'failed',
    code: 'credential_invalid',
  });
  const replayedFailure = assertDelivery(replay, 'failed-result replay', {
    replayed: true,
    status: 'failed',
    code: 'credential_invalid',
  });
  if (replayedFailure.deliveryId !== failedDelivery.deliveryId) {
    fail('Packed notification failed-result replay changed the canonical delivery identity');
  }
  assertDelivery(recovery, 'new-request recovery', {
    replayed: false,
    status: 'accepted',
    evidence: 'provider',
  });
  const disabledPreferences = readPackedNotificationResult(suppressedPreferences, 'suppressed preferences');
  if (
    disabledPreferences.categoryId !== 'packed-ready'
    || disabledPreferences.enabled !== false
    || !Array.isArray(disabledPreferences.channelIds)
    || disabledPreferences.channelIds.length !== 0
  ) {
    fail(`Packed notification policy did not publish disabled preferences: ${JSON.stringify(disabledPreferences)}`);
  }
  assertDelivery(suppressed, 'policy suppression', {
    replayed: false,
    status: 'suppressed',
    code: 'plugin_notification_channel_disabled',
  });
  const enabledPreferences = readPackedNotificationResult(restoredPreferences, 'restored preferences');
  if (
    enabledPreferences.categoryId !== 'packed-ready'
    || enabledPreferences.enabled !== true
    || JSON.stringify(enabledPreferences.channelIds) !== JSON.stringify([channelId])
  ) {
    fail(`Packed notification policy did not restore the configured channel: ${JSON.stringify(enabledPreferences)}`);
  }
  if (retiredInvocation?.code === 0 && retiredInvocation?.signal === null) {
    fail('Retired packed notification invocation unexpectedly remained executable');
  }
  if (eventSubscriptionDeliveries !== 5) {
    fail(`Packed event subscription did not receive each notification request: ${String(eventSubscriptionDeliveries)}`);
  }
  return {
    pluginId,
    channelId,
    configuredEndpoint: configuration.values['webhook.endpoint'],
    secretState: 'redacted-reference',
    acceptedDeliveryId: accepted.deliveryId,
    replayedFailureDeliveryId: replayedFailure.deliveryId,
    providerFailure: 'credential_invalid',
    replayedFailure: true,
    policySuppression: 'plugin_notification_channel_disabled',
    eventSubscriptionDeliveries,
    retirement: 'invocation-rejected',
    credentialMaterialExposed: false,
  };
}

export function assertPluginCommandAbsentFromRootHelp({ stdout, commandRoot }) {
  const commandPrefix = `happier ${commandRoot}`;
  const advertised = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line === commandPrefix || line.startsWith(`${commandPrefix} `));
  if (advertised) {
    fail(`Uninstalled plugin command remained visible in root help: ${commandRoot}`);
  }
}

function readVerticalAProjectionV2(probe, phase) {
  const projection = probe?.projection?.projection;
  if (projection?.v !== 2 || !projection.familiesById || typeof projection.familiesById !== 'object') {
    fail(`Packed SCM ${phase} probe did not return a daemon PluginProjectionV2: ${JSON.stringify(probe)}`);
  }
  return projection;
}

export function assertVerticalAScmInstalledProbe({ probe, backendId, hostingProviderId }) {
  const projection = readVerticalAProjectionV2(probe, 'installed');
  const backend = projection.familiesById.scmBackends?.entriesById?.[backendId];
  const provider = projection.familiesById.scmHostingProviders?.entriesById?.[hostingProviderId];
  const browserTargetId = 'browserTarget:acme.vertical-a:preview';
  const browserActionIds = [
    'browserAction:acme.vertical-a:preview-roundtrip',
    'browserAction:acme.vertical-a:preview-details',
    'browserAction:acme.vertical-a:preview-context',
  ];
  const expectedBrowserActionPlacements = ['toolbar', 'detailsPanel', 'contextMenu'];
  const browserTarget = projection.familiesById.pluginBrowser?.entriesById?.[browserTargetId];
  const browserActions = browserActionIds.map(
    (browserActionId) => projection.familiesById.pluginBrowser?.entriesById?.[browserActionId],
  );
  if (
    backend?.id !== backendId
    || backend?.localId !== 'stacked'
    || backend?.pluginId !== 'acme.vertical-a'
    || provider?.id !== hostingProviderId
    || provider?.localId !== 'forge'
    || provider?.pluginId !== 'acme.vertical-a'
    || provider?.authService?.pluginId !== 'acme.vertical-a'
    || provider?.authService?.localId !== 'novel-cloud'
  ) {
    fail(`Packed SCM daemon projection did not expose qualified backend/provider/auth identities: ${JSON.stringify({ backend, provider })}`);
  }
  if (
    browserTarget?.pluginId !== 'acme.vertical-a'
    || browserTarget?.contributionKind !== 'browserTarget'
    || browserTarget?.currentUrl !== 'https://preview.example.test/'
    || browserTarget?.launchMode !== 'currentView'
    || browserActions.some((browserAction, index) => (
      browserAction?.pluginId !== 'acme.vertical-a'
      || browserAction?.contributionKind !== 'browserAction'
      || browserAction?.qualifiedActionId !== 'acme.vertical-a/roundtrip'
      || browserAction?.targetId !== browserTargetId
      || browserAction?.placement !== expectedBrowserActionPlacements[index]
    ))
  ) {
    fail(`Packed browser projection did not expose a safe target and all qualified F03 action placements: ${JSON.stringify({ browserTarget, browserActions })}`);
  }
  if (
    probe?.status?.success !== false
    || probe?.status?.errorCode !== 'COMMAND_FAILED'
    || probe?.status?.error !== `Packed SCM status reached ${hostingProviderId}`
  ) {
    fail(`Packed SCM preferred backend status operation did not reach the external runtime: ${JSON.stringify(probe?.status)}`);
  }
  const target = probe?.repository?.targets?.[0];
  if (
    probe?.repository?.success !== true
    || probe.repository.defaultRepositoryName !== 'packed-repository'
    || probe.repository.auth?.state !== 'authenticated'
    || probe.repository.auth?.profileKind !== 'connected_account'
    || probe.repository.auth?.profileKey !== undefined
    || target?.provider?.id !== hostingProviderId
    || target?.owner !== 'packed-owner'
  ) {
    fail(`Packed SCM repository/auth operation did not traverse the hosting runtime: ${JSON.stringify(probe?.repository)}`);
  }
  return {
    generation: projection.generation,
    backendId,
    hostingProviderId,
    authService: provider.authService,
    clientPreference: { kind: 'prefer', backendId },
    statusErrorCode: probe.status.errorCode,
    repositoryAuth: probe.repository.auth,
    browserTargetId,
    browserActionIds,
  };
}

export function assertVerticalAScmUninstalledProbe({ probe, backendId, hostingProviderId }) {
  const projection = readVerticalAProjectionV2(probe, 'uninstalled');
  const backendFamily = projection.familiesById.scmBackends;
  const providerFamily = projection.familiesById.scmHostingProviders;
  const browserFamily = projection.familiesById.pluginBrowser;
  if (
    !backendFamily
    || !providerFamily
    || !browserFamily
    || backendFamily.entriesById?.[backendId] !== undefined
    || providerFamily.entriesById?.[hostingProviderId] !== undefined
    || Object.values(browserFamily.entriesById ?? {}).some((entry) => entry?.pluginId === 'acme.vertical-a')
  ) {
    fail(`Packed uninstall left a stale SCM/browser projection: ${JSON.stringify({ backendFamily, providerFamily, browserFamily })}`);
  }
  return {
    generation: projection.generation,
    backendId,
    hostingProviderId,
    backend: 'absent',
    hostingProvider: 'absent',
    authoritativeFamiliesPresent: true,
  };
}

async function runPackedPluginRoundtrip({ cliEntrypoint, cwd, env, pluginId, input }) {
  return await runPackedCliJson({
    cliEntrypoint,
    cwd,
    env,
    args: [
      'vertical-a',
      pluginId.split('.').at(-1),
      ...(input === undefined ? [] : ['--input', JSON.stringify(input)]),
      '--json',
    ],
  }, 'plugin_command');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readPackedAuthorLogEvidence(root) {
  const logs = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.log')) {
        logs.push(await readFile(path, 'utf8'));
      }
    }
  };
  await visit(root);
  return logs;
}

export function buildVerticalAResult({
  candidate,
  stages,
  loadedIdentities,
  executionFailure = null,
}) {
  const {
    missingStageIds,
    failedStageIds,
    duplicateStageIds,
    unexpectedStageIds,
  } = analyzeVerticalAStageCoverage(stages);
  const incomplete =
    executionFailure !== null
    ||
    missingStageIds.length > 0
    || failedStageIds.length > 0
    || duplicateStageIds.length > 0
    || unexpectedStageIds.length > 0;
  return {
    ok: !incomplete,
    scenario: 'vertical-a',
    candidate: {
      runId: candidate.runId,
      sdk: { packageName: candidate.sdk.packageName, version: candidate.sdk.version, integrity: candidate.sdk.integrity },
      cli: { packageName: candidate.cli.packageName, version: candidate.cli.version, integrity: candidate.cli.integrity },
    },
    stages,
    evidenceLayers: {
      ownerFault: buildVerticalAEvidenceLayerResult('ownerFault', stages),
      packedExternalBlackBox: buildVerticalAEvidenceLayerResult(
        'packedExternalBlackBox',
        stages,
      ),
      authenticatedDaemon: buildVerticalAEvidenceLayerResult(
        'authenticatedDaemon',
        stages,
      ),
    },
    loadedIdentities,
    ...(incomplete ? {
      error: {
        code: 'vertical_a_incomplete',
        missingStageIds,
        failedStageIds,
        duplicateStageIds,
        unexpectedStageIds,
        ...(executionFailure === null ? {} : { executionFailure }),
      },
    } : {}),
    cleanup: { disposition: 'removed' },
  };
}

export async function prepareVerticalAChildEnvironment({
  happyHomeDir,
  markerPath,
  baseEnv = process.env,
  prepareHome,
}) {
  if (typeof prepareHome !== 'function') {
    fail('Vertical-A requires authenticated isolated-home preparation; run the test:plugin-platform:packed-author package script');
  }
  const inheritedDaemonAuthorityKeys = Object.keys(baseEnv).filter((key) => (
    key.startsWith('HAPPIER_STACK_')
    || key.startsWith('HAPPY_STACK_')
    || [
      'TMUX',
      'TMUX_PANE',
      'TMUX_TMPDIR',
      'HAPPIER_SESSION_ATTACH_FILE',
      'HAPPY_SESSION_ATTACH_FILE',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
      'HAPPIER_DAEMON_SERVICE_SERVER_URL',
    ].includes(key)
  ));
  if (inheritedDaemonAuthorityKeys.length > 0) {
    fail(`Vertical-A requires canonical daemon environment sanitization before composing the isolated runtime: ${inheritedDaemonAuthorityKeys.sort().join(', ')}`);
  }
  await mkdir(happyHomeDir, { recursive: true });
  const preparedEnv = await prepareHome({ happyHomeDir });
  if (!preparedEnv || typeof preparedEnv !== 'object' || Array.isArray(preparedEnv)) {
    fail('Vertical-A home preparation must return an environment object');
  }
  const lifecycleScopeId = typeof preparedEnv.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID === 'string'
    ? preparedEnv.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID.trim()
    : '';
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(lifecycleScopeId)) {
    fail('Vertical-A requires an isolated daemon lifecycle scope before starting the composed runtime');
  }
  const requestedPathEntries = typeof preparedEnv.PATH === 'string'
    ? preparedEnv.PATH.split(delimiter).filter((entry) => entry.length > 0)
    : [];
  const physicalHappyHomeDir = await realpath(happyHomeDir);
  const ownedPathEntries = [];
  for (const entry of requestedPathEntries) {
    if (!isAbsolute(entry)) {
      fail('Vertical-A prepared PATH entries must be absolute isolated-home directories');
    }
    let physicalEntry;
    try {
      physicalEntry = await realpath(entry);
    } catch {
      fail('Vertical-A prepared PATH entries must resolve to existing isolated-home directories');
    }
    if (!isPathInsideRoot(physicalHappyHomeDir, physicalEntry)) {
      fail('Vertical-A prepared PATH entries must remain inside the isolated home');
    }
    ownedPathEntries.push(physicalEntry);
  }
  return sanitizePackedAuthorArtifactEnv({
    ...baseEnv,
    ...preparedEnv,
    HAPPIER_HOME_DIR: happyHomeDir,
    HAPPIER_VERTICAL_A_MARKER: markerPath,
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: lifecycleScopeId,
    PATH: ownedPathEntries.join(delimiter),
  });
}

export function buildVerticalADaemonRestartArgs() {
  return ['daemon', 'restart', '--json'];
}

export async function restartPackedDaemonForUpdatedTrustStore({
  cliEntrypoint,
  cwd,
  env,
  runCli = runPackedCli,
}) {
  const extraCaBundlePath = typeof env?.NODE_EXTRA_CA_CERTS === 'string'
    ? env.NODE_EXTRA_CA_CERTS.trim()
    : '';
  if (!extraCaBundlePath) {
    fail('Packed daemon trust-store reload requires the updated extra CA bundle');
  }
  const result = await runCli({
    cliEntrypoint,
    cwd,
    env,
    args: buildVerticalADaemonRestartArgs(),
  });
  assertCommandSucceeded(result, 'Packed daemon restart after extra CA bundle update');
  return result;
}

export async function cleanupPrivateRegistryFixture({
  pluginId,
  markerPath,
  activationInstances,
  uninstallPlugin,
  waitForCleanup = waitForActivationCleanup,
  clearMarker = async (path) => await rm(path, { force: true }),
}) {
  const uninstall = await uninstallPlugin();
  if (uninstall.data?.desiredGeneration !== null || uninstall.data?.appliedGeneration !== null) {
    fail(`Private registry fixture uninstall did not clear desired/applied state: ${JSON.stringify(uninstall)}`);
  }
  await Promise.all(activationInstances.map(({ version, activationInstanceId }) => (
    waitForCleanup({
      markerPath,
      version,
      activationInstanceId,
    })
  )));
  await clearMarker(markerPath);
  return {
    desiredGeneration: uninstall.data.desiredGeneration,
    appliedGeneration: uninstall.data.appliedGeneration,
  };
}

export async function installVerticalAHealthyControlFixture({
  plugin,
  sdkRegistryOrigin,
  installPlugin,
}) {
  const install = await installPlugin([
    'plugins', 'install', plugin.root,
    '--dev',
    '--sdk-registry', sdkRegistryOrigin,
    '--json',
  ]);
  const desiredGeneration = install.change?.desiredGeneration;
  if (
    install.change?.kind !== 'committed'
    || install.change.pluginId !== plugin.pluginId
    || typeof desiredGeneration !== 'string'
    || install.change.appliedGeneration !== desiredGeneration
  ) {
    fail(`Healthy control plugin did not commit its exact generation: ${JSON.stringify(install)}`);
  }
  return {
    pluginId: plugin.pluginId,
    desiredGeneration,
    appliedGeneration: install.change.appliedGeneration,
  };
}

async function runVerticalAWithCapturedOutputs(candidate, options = {}) {
  if (typeof options.prepareHome !== 'function') {
    fail('Vertical-A requires authenticated isolated-home preparation; run the test:plugin-platform:packed-author package script');
  }
  if (typeof options.probeScm !== 'function') {
    fail('Vertical-A requires the composed SCM machine-RPC probe; run the test:plugin-platform:packed-author package script');
  }
  if (typeof options.probeNotifications !== 'function') {
    fail('Vertical-A requires the composed notification settings/policy probe; run the test:plugin-platform:packed-author package script');
  }
  if (typeof options.probeExternalSessions !== 'function') {
    fail('Vertical-A requires the composed External Sessions machine-RPC probe; run the test:plugin-platform:packed-author package script');
  }
  if (typeof options.probeRetainedCapabilities !== 'function') {
    fail('Vertical-A requires the composed retained-capability machine-RPC probe; run the test:plugin-platform:packed-author package script');
  }
  if (typeof options.probeConnectedAccounts !== 'function') {
    fail('Vertical-A requires the composed Connected Accounts machine-RPC probe; run the test:plugin-platform:packed-author package script');
  }
  if (typeof options.decideInstallReview !== 'function') {
    fail('Vertical-A requires the authenticated private plugin review decision boundary');
  }
  const packedArtifactBaseEnv = sanitizePackedAuthorArtifactEnv(options.baseEnv ?? process.env);
  const tempRoot = await mkdtemp(join(tmpdir(), `happier-packed-author-${candidate.runId}-`));
  const stages = [];
  let registry = null;
  let publicRegistry = null;
  let privateRegistry = null;
  let connectedAccountProvider = null;
  let staleConnectedAccountProvider = null;
  let daemonCleanup = null;
  let daemonStopped = false;
  let succeeded = false;
  let observedDaemonRuntimeIdentity = null;
  try {
    const [sdkBytes, cliBytes] = await Promise.all([
      verifyArtifactIntegrity(candidate.sdk, 'SDK tarball'),
      verifyArtifactIntegrity(candidate.cli, 'CLI tarball'),
    ]);
    const verifiedSdkTarballPath = join(tempRoot, 'verified-sdk.tgz');
    const verifiedCliTarballPath = join(tempRoot, 'verified-cli.tgz');
    await Promise.all([
      writeFile(verifiedSdkTarballPath, sdkBytes, { flag: 'wx' }),
      writeFile(verifiedCliTarballPath, cliBytes, { flag: 'wx' }),
    ]);
    const archiveCensus = await assertPackedAuthorCandidateArchivesSafe({
      sdkTarballPath: verifiedSdkTarballPath,
      cliTarballPath: verifiedCliTarballPath,
    });
    stages.push({
      id: 'artifact-integrity',
      ok: true,
      sdkEntries: archiveCensus.sdk.entryCount,
      cliEntries: archiveCensus.cli.entryCount,
    });

    const sdkExtractRoot = join(tempRoot, 'sdk-artifact');
    const sdkPackageJson = await readPackedPackageManifest(verifiedSdkTarballPath, sdkExtractRoot);
    assertPackedPackageIdentity(sdkPackageJson, candidate.sdk, 'Packed SDK');
    stages.push({ id: 'sdk-identity', ok: true, packageName: sdkPackageJson.name, version: sdkPackageJson.version });

    registry = await startCandidateRegistry({
      sdk: candidate.sdk,
      sdkBytes,
      packageManifest: sdkPackageJson,
    });
    stages.push({ id: 'candidate-registry', ok: true, origin: registry.origin });

    const cliInstallRoot = join(tempRoot, 'cli-install');
    const cliEntrypoint = await materializePackedCli({
      cliArtifact: { ...candidate.cli, tarballPath: verifiedCliTarballPath },
      installRoot: cliInstallRoot,
      env: packedArtifactBaseEnv,
    });
    stages.push({
      id: 'cli-identity',
      ok: true,
      packageName: candidate.cli.packageName,
      version: candidate.cli.version,
      materialization: 'installed-from-exact-tarball',
    });
    const installedCliPackageRoot = await realpath(join(
      cliInstallRoot,
      'node_modules',
      ...candidate.cli.packageName.split('/'),
    ));
    const fixtureRoot = join(tempRoot, 'external-author');
    const pluginSpecs = [
      { pluginId: 'acme.vertical-a', name: 'vertical-a-plugin', root: join(fixtureRoot, 'vertical-a-plugin'), value: 'packed-v1' },
      {
        pluginId: 'acme.private-registry',
        packageName: '@acme/private-registry-plugin',
        name: 'private-registry-plugin',
        root: join(fixtureRoot, 'private-registry-plugin'),
        value: 'private-registry',
      },
      {
        pluginId: 'acme.public-registry',
        packageName: 'acme-public-registry-plugin',
        name: 'public-registry-plugin',
        root: join(fixtureRoot, 'public-registry-plugin'),
        value: 'public-registry',
      },
      {
        pluginId: 'acme.descriptor-only',
        name: 'descriptor-only-plugin',
        root: join(fixtureRoot, 'descriptor-only-plugin'),
        descriptorOnly: true,
      },
    ];
    await mkdir(fixtureRoot, { recursive: true });
    const childEnv = await prepareVerticalAChildEnvironment({
      happyHomeDir: join(tempRoot, 'happier-home'),
      markerPath: join(tempRoot, 'activation.log'),
      baseEnv: packedArtifactBaseEnv,
      prepareHome: options.prepareHome,
    });
    connectedAccountProvider = await startPrivatePluginRegistry({
      packageName: SDK_PACKAGE_NAME,
      artifacts: [{ version: candidate.sdk.version, bytes: sdkBytes }],
      acceptedToken: null,
    });
    staleConnectedAccountProvider = await startPrivatePluginRegistry({
      packageName: SDK_PACKAGE_NAME,
      artifacts: [{ version: candidate.sdk.version, bytes: sdkBytes }],
      acceptedToken: null,
    });
    const extraCaBundlePath = join(tempRoot, 'packed-author-extra-ca.pem');
    const refreshExtraCaBundle = createExtraCaBundleRefresher({
      bundlePath: extraCaBundlePath,
    });
    await refreshExtraCaBundle(connectedAccountProvider.caCertificatePath);
    await refreshExtraCaBundle(staleConnectedAccountProvider.caCertificatePath);
    childEnv.NODE_EXTRA_CA_CERTS = extraCaBundlePath;
    const authorEnv = { ...childEnv };
    delete authorEnv.HAPPIER_VERTICAL_A_MARKER;
    daemonCleanup = { cliEntrypoint, cwd: fixtureRoot, env: childEnv };
    const carrierFailClosedEnv = { ...childEnv };
    delete carrierFailClosedEnv.HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE;
    const carrierFailClosed = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: carrierFailClosedEnv,
      args: ['auggie', '--happy-starting-mode', 'remote', '--started-by', 'daemon'],
    });
    stages.push({
      id: 'daemon-agent-carrier-fail-closed',
      ok: true,
      ...assertDaemonAgentCarrierFailClosed(carrierFailClosed),
    });
    const runReviewedInstall = async (args) => await runPackedReviewedPluginInstall({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args,
      decideInstallReview: options.decideInstallReview,
    });
    const readInstalledPlugin = async (pluginId) => {
      const shown = await runPackedCliJson({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        args: ['plugins', 'show', pluginId, '--json'],
      }, 'plugins_show');
      return shown.data?.plugin ?? null;
    };
    for (const plugin of pluginSpecs) {
      const isRetainedCapabilityFixture = plugin.pluginId === 'acme.vertical-a';
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: isRetainedCapabilityFixture
          ? [
              'plugins', 'scaffold', plugin.root,
              '--id', plugin.pluginId,
              '--name', 'Vertical A',
              '--sdk-version', candidate.sdk.version,
              '--ui', 'hostedWeb',
              '--json',
            ]
          : ['plugins', 'create', plugin.root, '--id', plugin.pluginId, '--sdk-version', candidate.sdk.version, '--json'],
      }, isRetainedCapabilityFixture ? 'plugins_scaffold' : 'plugins_create');
    }
    stages.push({ id: 'create', ok: true, pluginIds: pluginSpecs.map((plugin) => plugin.pluginId) });

    for (const plugin of pluginSpecs) {
      const generatedPackageJson = JSON.parse(await readFile(join(plugin.root, 'package.json'), 'utf8'));
      const packageFailures = inspectGeneratedScaffoldPackage(generatedPackageJson, candidate.sdk.version);
      if (packageFailures.length > 0) fail(packageFailures.join('\n'));
      const source = await readFile(join(plugin.root, 'src', 'index.ts'), 'utf8');
      if (/from\s+['"]@\/|packages\/plugin-sdk|node_modules\/@happier-dev\/plugin-sdk/u.test(source)) {
        fail('generated source contains a monorepo alias or repository path');
      }
      if (plugin.descriptorOnly) {
        await configureDescriptorOnlyPlugin({
          pluginRoot: plugin.root,
          version: '1.0.0',
        });
      } else {
        await configureVerticalAPlugin({
          pluginRoot: plugin.root,
          pluginId: plugin.pluginId,
          version: '1.0.0',
          fetchOrigin: registry.origin,
          ...(plugin.pluginId === 'acme.vertical-a'
            ? { connectedAccountOrigin: connectedAccountProvider.origin }
            : {}),
          ...(plugin.packageName ? { packageName: plugin.packageName } : {}),
        });
      }
    }
    stages.push({ id: 'create-contract', ok: true });

    for (const plugin of pluginSpecs) {
      const envelope = await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', 'install', plugin.root, '--sdk-registry', registry.origin, '--json'],
      }, 'plugins_author_install');
      if (envelope.data?.operation !== 'install' || envelope.data?.projectRoot !== plugin.root) {
        fail(`packed CLI author install reported the wrong project for ${plugin.pluginId}`);
      }
    }
    stages.push({ id: 'author-install', ok: true });

    for (const operation of ['typecheck', 'build', 'test']) {
      for (const plugin of pluginSpecs) {
        if (plugin.descriptorOnly && operation !== 'typecheck') continue;
        const envelope = await runPackedCliJson({
          cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
          args: ['plugins', 'author', operation, plugin.root, '--json'],
        }, `plugins_author_${operation}`);
        if (envelope.data?.operation !== operation || envelope.data?.projectRoot !== plugin.root) {
          fail(`packed CLI author ${operation} reported the wrong project for ${plugin.pluginId}`);
        }
      }
      stages.push({ id: `author-${operation}`, ok: true });
    }
    const installedSdkRoot = join(
      pluginSpecs[0].root,
      'node_modules',
      ...SDK_PACKAGE_NAME.split('/'),
    );
    const installedSdkPhysicalRoot = await realpath(installedSdkRoot);
    const installedSdkManifest = JSON.parse(await readFile(
      join(installedSdkPhysicalRoot, 'package.json'),
      'utf8',
    ));
    const retainedUiBuildRelativePath =
      installedSdkManifest.bin?.['happier-plugin-build-ui'];
    if (
      typeof retainedUiBuildRelativePath !== 'string'
      || isAbsolute(retainedUiBuildRelativePath)
    ) {
      fail('Packed SDK did not expose a relative happier-plugin-build-ui entrypoint');
    }
    const retainedUiBuildBin = await realpath(resolve(
      installedSdkPhysicalRoot,
      retainedUiBuildRelativePath,
    ));
    const retainedUiBuildBinRelativePath = relative(
      installedSdkPhysicalRoot,
      retainedUiBuildBin,
    );
    if (
      retainedUiBuildBinRelativePath === '..'
      || retainedUiBuildBinRelativePath.startsWith(`..${sep}`)
      || isAbsolute(retainedUiBuildBinRelativePath)
    ) {
      fail('Packed SDK happier-plugin-build-ui entrypoint escaped the installed package');
    }
    const retainedUiBuild = await run(process.execPath, [
      retainedUiBuildBin,
      '--project-root',
      pluginSpecs[0].root,
    ], {
      cwd: pluginSpecs[0].root,
      env: authorEnv,
    });
    assertCommandSucceeded(retainedUiBuild, 'packed retained-capability hostedWeb UI build');
    const retainedUiArtifacts = JSON.parse(await readFile(
      join(pluginSpecs[0].root, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
      'utf8',
    ));
    const retainedHostedWebArtifact = retainedUiArtifacts.entries?.find((entry) => (
      entry.contributionId === 'main-web'
      && entry.tier === 'hostedWeb'
      && entry.platform === 'web'
    ));
    if (
      !retainedHostedWebArtifact
      || typeof retainedHostedWebArtifact.digest !== 'string'
      || !retainedHostedWebArtifact.files?.some((file) => file.relativePath === retainedHostedWebArtifact.entry)
    ) {
      fail(`Packed retained-capability UI build did not emit its hostedWeb artifact graph: ${JSON.stringify(retainedUiArtifacts)}`);
    }

    const plugin = pluginSpecs[0];
    const archivePath = join(tempRoot, `${plugin.pluginId}.happier-plugin.tgz`);
    const archiveAttestations = [];
    const packCurrentPlugin = async (label) => {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'pack', plugin.root, '--out', archivePath, '--json'],
      }, 'plugins_pack');
      const bytes = await readFile(archivePath);
      const attestation = {
        label,
        pluginId: plugin.pluginId,
        version: JSON.parse(await readFile(join(plugin.root, 'package.json'), 'utf8')).version,
        integrity: sha512Sri(bytes),
        size: bytes.byteLength,
      };
      archiveAttestations.push(attestation);
      return attestation;
    };
    const replacePackedArchive = async (label) => {
      await Promise.all([
        rm(archivePath, { force: true }),
        rm(`${archivePath}.sha256`, { force: true }),
      ]);
      return await packCurrentPlugin(label);
    };
    const readCurrentCommit = async () => {
      const stateRoot = join(childEnv.HAPPIER_HOME_DIR, 'plugins', 'plugins', 'state');
      return JSON.parse(await readFile(join(stateRoot, 'plugin-registry-current.v1.json'), 'utf8'));
    };
    const readCurrentInstallationState = async () => {
      const commit = await readCurrentCommit();
      const revisionPath = join(
        childEnv.HAPPIER_HOME_DIR,
        'plugins',
        'plugins',
        'state-revisions',
        commit.installationState.revisionId,
        'plugin-installations.v1.json',
      );
      return { commit, revision: JSON.parse(await readFile(revisionPath, 'utf8')) };
    };
    const waitForGenerationHealth = async ({ generationId, state, timeoutMs }) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const current = await readCurrentInstallationState();
        if (current.revision.health?.[generationId]?.state === state) return current;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      fail(`Timed out waiting for generation ${generationId} to become ${state}`);
    };
    const initialArtifact = await packCurrentPlugin('initial-v1');
    const initialPackedNovelArchiveBytes = await readFile(archivePath);
    if (
      initialArtifact.integrity !== sha512Sri(initialPackedNovelArchiveBytes)
      || initialArtifact.size !== initialPackedNovelArchiveBytes.byteLength
    ) {
      fail('Initial packed novel archive changed before handoff custody');
    }
    stages.push({ id: 'plugin-pack', ok: true, plugins: [initialArtifact] });

    const descriptorPlugin = pluginSpecs.find((candidatePlugin) => candidatePlugin.descriptorOnly === true);
    if (!descriptorPlugin) fail('Vertical-A descriptor-only fixture was not created');
    const descriptorArchivePath = join(tempRoot, `${descriptorPlugin.pluginId}.happier-plugin.tgz`);
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
      args: ['plugins', 'pack', descriptorPlugin.root, '--out', descriptorArchivePath, '--json'],
    }, 'plugins_pack');
    const descriptorInstall = await runReviewedInstall([
      'plugins', 'install', descriptorArchivePath, '--json',
    ]);
    const descriptorGeneration = descriptorInstall.change?.desiredGeneration;
    const descriptorInstalled = descriptorInstall.change?.kind === 'committed'
      ? await readInstalledPlugin(descriptorPlugin.pluginId)
      : null;
    if (
      descriptorInstall.change?.kind !== 'committed'
      || descriptorInstall.change.pluginId !== descriptorPlugin.pluginId
      || typeof descriptorGeneration !== 'string'
      || descriptorInstall.change.appliedGeneration !== descriptorGeneration
      || descriptorInstalled?.enabled !== true
      || descriptorInstalled.desiredGeneration !== descriptorGeneration
      || descriptorInstalled.appliedGeneration !== descriptorGeneration
    ) {
      fail(`Descriptor-only install did not commit one desired/applied generation: ${JSON.stringify({
        descriptorInstall,
        descriptorInstalled,
      })}`);
    }
    const descriptorManifest = JSON.parse(await readFile(join(
      childEnv.HAPPIER_HOME_DIR,
      'plugins',
      'plugins',
      'generations',
      descriptorGeneration,
      '.happier-plugin',
      'plugin.json',
    ), 'utf8'));
    const descriptorContributionRecords = descriptorInstalled.contributions?.contributions ?? [];
    const descriptorContributionFamilies = [
      ...new Set(descriptorContributionRecords.map((record) => record?.contribution?.family)),
    ].filter((family) => typeof family === 'string').sort();
    if (
      descriptorManifest.entrypoints !== undefined
      || descriptorManifest.activation !== undefined
      || descriptorManifest.contributes?.settings?.length !== 1
      || descriptorManifest.contributes?.ui?.renderers?.[0]?.kind !== 'declarative'
      || !descriptorContributionFamilies.includes('settings')
      || !descriptorContributionFamilies.includes('ui.views')
      || !descriptorContributionFamilies.includes('ui.renderers')
      || descriptorContributionRecords.some((record) => (
        record?.registration?.requirement !== 'notRequired'
        || record?.activation?.state !== 'notRequired'
      ))
      || (descriptorInstalled.contributions?.diagnostics?.length ?? 0) !== 0
      || await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER)
    ) {
      fail(`Descriptor-only install gained executable ownership or lost static contributions: ${JSON.stringify({
        manifest: descriptorManifest,
        contributionFamilies: descriptorContributionFamilies,
        contributionRecords: descriptorContributionRecords,
        executableMarkerExists: await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER),
      })}`);
    }
    const descriptorDaemonBeforeRestart = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    const descriptorRestart = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: buildVerticalADaemonRestartArgs(),
    });
    assertCommandSucceeded(descriptorRestart, 'Packed descriptor-only daemon restart');
    const descriptorAfterRestart = await readInstalledPlugin(descriptorPlugin.pluginId);
    const descriptorDaemonAfterRestart = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    if (
      descriptorDaemonAfterRestart.pid === descriptorDaemonBeforeRestart.pid
      || descriptorAfterRestart?.enabled !== true
      || descriptorAfterRestart.desiredGeneration !== descriptorGeneration
      || descriptorAfterRestart.appliedGeneration !== descriptorGeneration
      || await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER)
    ) {
      fail(`Descriptor-only restart did not preserve static currentness without activation: ${JSON.stringify({
        beforePid: descriptorDaemonBeforeRestart.pid,
        afterPid: descriptorDaemonAfterRestart.pid,
        descriptorAfterRestart,
        executableMarkerExists: await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER),
      })}`);
    }
    const descriptorUninstall = await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'uninstall', descriptorPlugin.pluginId, '--json'],
    }, 'plugins_uninstall');
    const afterDescriptorUninstall = await readCurrentInstallationState();
    if (
      descriptorUninstall.data?.desiredGeneration !== null
      || descriptorUninstall.data?.appliedGeneration !== null
      || afterDescriptorUninstall.revision.plugins?.[descriptorPlugin.pluginId] !== undefined
      || afterDescriptorUninstall.revision.runtimeCatalog?.plugins?.[descriptorPlugin.pluginId] !== undefined
      || await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER)
    ) {
      fail(`Descriptor-only uninstall left current state or executable evidence: ${JSON.stringify({
        descriptorUninstall,
        installation: afterDescriptorUninstall.revision.plugins?.[descriptorPlugin.pluginId],
        runtimeCatalog: afterDescriptorUninstall.revision.runtimeCatalog?.plugins?.[descriptorPlugin.pluginId],
        executableMarkerExists: await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER),
      })}`);
    }
    stages.push({
      id: 'descriptor-only-static-lifecycle',
      ok: true,
      pluginId: descriptorPlugin.pluginId,
      desiredGeneration: descriptorGeneration,
      appliedGeneration: descriptorGeneration,
      contributionFamilies: descriptorContributionFamilies,
      executableEntrypoints: 0,
      daemonRestart: {
        previousPid: descriptorDaemonBeforeRestart.pid,
        pid: descriptorDaemonAfterRestart.pid,
        currentGeneration: descriptorGeneration,
      },
      uninstall: { desiredGeneration: null, appliedGeneration: null },
    });

    const publicPlugin = pluginSpecs.find((candidatePlugin) => (
      candidatePlugin.pluginId === 'acme.public-registry'
    ));
    if (!publicPlugin?.packageName) fail('Vertical-A public registry fixture was not created');
    const publicArchivePath = join(tempRoot, `${publicPlugin.name}-1.0.0.tgz`);
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
      args: ['plugins', 'pack', publicPlugin.root, '--out', publicArchivePath, '--json'],
    }, 'plugins_pack');
    const publicArtifactBytes = await readFile(publicArchivePath);
    const publicArtifactIntegrity = sha512Sri(publicArtifactBytes);
    const publicArtifactExtractRoot = join(tempRoot, 'public-registry-artifact');
    await extractTarball(publicArchivePath, publicArtifactExtractRoot);
    const publicArtifactRootEntries = await readdir(publicArtifactExtractRoot, { withFileTypes: true });
    const publicArtifactRoot = publicArtifactRootEntries.find((entry) => entry.isDirectory());
    if (!publicArtifactRoot) fail('Packed public registry artifact did not contain a package root');
    const publicManifestBytes = await readFile(join(
      publicArtifactExtractRoot,
      publicArtifactRoot.name,
      '.happier-plugin',
      'plugin.json',
    ));
    const publicManifestDigest = `sha256:${createHash('sha256').update(publicManifestBytes).digest('hex')}`;
    publicRegistry = await startPrivatePluginRegistry({
      packageName: publicPlugin.packageName,
      artifacts: [{ version: '1.0.0', bytes: publicArtifactBytes }],
      acceptedToken: null,
    });
    await refreshExtraCaBundle(publicRegistry.caCertificatePath);
    await restartPackedDaemonForUpdatedTrustStore({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
    });
    const publicRegistryProfileId = 'registry_public_vertical_a';
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: [
        'plugins', 'registry', 'add', publicRegistry.origin,
        '--id', publicRegistryProfileId,
        '--name', 'Vertical A public registry',
        '--default',
        '--allow-private-network',
        '--json',
      ],
    }, 'plugins_registry');
    const publicRegistryTest = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'test', publicRegistryProfileId, '--json'],
    }, 'plugins_registry');
    const publicProfile = publicRegistryTest.data?.snapshot?.profiles?.find((profile) => (
      profile.profileId === publicRegistryProfileId
    ));
    if (
      publicProfile?.availability !== 'available'
      || publicProfile.hasCredentials !== false
      || publicProfile.authenticationState !== 'missing'
    ) {
      fail(`Public registry test did not observe unauthenticated availability: ${JSON.stringify(publicRegistryTest)}`);
    }
    const persistedPublicProfileFile = JSON.parse(await readFile(join(
      childEnv.HAPPIER_HOME_DIR,
      'plugins',
      'plugins',
      'state',
      'npm-registry-profiles.v1.json',
    ), 'utf8'));
    const persistedPublicProfile = persistedPublicProfileFile.profiles?.find((profile) => (
      profile.profileId === publicRegistryProfileId
    ));
    if (persistedPublicProfile?.credentialSecretRef !== null) {
      fail(`Public registry profile unexpectedly persisted a credential reference: ${JSON.stringify(persistedPublicProfile)}`);
    }
    const publicInstall = await runReviewedInstall([
      'plugins', 'install', publicPlugin.packageName,
      '--kind', 'npm',
      '--selector', '1.0.0',
      '--json',
    ]);
    const publicGeneration = publicInstall.change?.desiredGeneration;
    if (
      publicInstall.change?.kind !== 'committed'
      || publicInstall.change.pluginId !== publicPlugin.pluginId
      || typeof publicGeneration !== 'string'
      || publicInstall.change.appliedGeneration !== publicGeneration
    ) {
      fail(`Public npm install did not commit one desired/applied generation: ${JSON.stringify(publicInstall)}`);
    }
    const publicAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      pluginId: publicPlugin.pluginId,
      input: { value: publicPlugin.value },
    });
    assertRoundtrip(publicAction, {
      pluginId: publicPlugin.pluginId,
      version: '1.0.0',
      value: publicPlugin.value,
    });
    const publicActivationInstanceId = publicAction.data.result.activationInstanceId;
    if (publicRegistry.getRequests().some((request) => request.authorization !== null)) {
      fail(`Public npm profile sent unexpected authorization material: ${JSON.stringify(publicRegistry.getRequests())}`);
    }
    const publicDaemonState = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    const discardedDisableResponse = await postPackedDaemonControlDiscardingResponse(
      publicDaemonState,
      '/plugins/change/request',
      { kind: 'disable', pluginId: publicPlugin.pluginId },
    );
    const publicAfterUnknownDisable = await readInstalledPlugin(publicPlugin.pluginId);
    const stateAfterUnknownDisable = await readCurrentInstallationState();
    assertDiscardedDisableCurrentness({
      discardedDisableResponse,
      installedPlugin: publicAfterUnknownDisable,
      installation: stateAfterUnknownDisable.revision.plugins?.[publicPlugin.pluginId],
      runtimeCatalog: stateAfterUnknownDisable.revision.runtimeCatalog?.plugins?.[publicPlugin.pluginId],
      expectedGeneration: publicGeneration,
    });
    const disabledAction = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['vertical-a', publicPlugin.pluginId.split('.').at(-1), '--json'],
    });
    if (disabledAction.code === 0 && disabledAction.signal === null) {
      fail('Disabled public plugin remained callable after the discarded daemon response');
    }
    const publicDisabledCleanup = await waitForActivationCleanup({
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      version: '1.0.0',
      activationInstanceId: publicActivationInstanceId,
    });
    stages.push({
      id: 'response-loss-currentness-query',
      ok: true,
      pluginId: publicPlugin.pluginId,
      response: 'body-discarded-before-client-result-parse',
      query: 'plugins-show',
      enabled: publicAfterUnknownDisable.enabled,
      desiredGeneration: publicAfterUnknownDisable.desiredGeneration,
      appliedGeneration: publicAfterUnknownDisable.appliedGeneration,
    });
    const publicEnable = await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'enable', publicPlugin.pluginId, '--json'],
    }, 'plugins_enable');
    const publicReenabled = await readInstalledPlugin(publicPlugin.pluginId);
    const reenabledAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      pluginId: publicPlugin.pluginId,
      input: { value: publicPlugin.value },
    });
    assertRoundtrip(reenabledAction, {
      pluginId: publicPlugin.pluginId,
      version: '1.0.0',
      value: publicPlugin.value,
    });
    if (
      publicEnable.data?.enabled !== true
      || publicEnable.data?.desiredGeneration !== publicGeneration
      || publicEnable.data?.appliedGeneration !== publicGeneration
      || publicReenabled?.enabled !== true
      || publicReenabled.desiredGeneration !== publicGeneration
      || publicReenabled.appliedGeneration !== publicGeneration
      || reenabledAction.data.result.activationInstanceId === publicActivationInstanceId
      || reenabledAction.data.result.pid !== publicDaemonState.pid
    ) {
      fail(`Ordinary re-enable did not restore the same trusted generation in the daemon owner: ${JSON.stringify({
        publicEnable,
        publicReenabled,
        initialActivationInstanceId: publicActivationInstanceId,
        reenabledAction: reenabledAction.data?.result,
      })}`);
    }
    stages.push({
      id: 'ordinary-disable-enable',
      ok: true,
      pluginId: publicPlugin.pluginId,
      desiredGeneration: publicGeneration,
      disabled: {
        enabled: false,
        appliedGeneration: publicAfterUnknownDisable.appliedGeneration,
        action: 'unavailable',
        cleanup: publicDisabledCleanup,
      },
      reenabled: {
        enabled: true,
        appliedGeneration: publicReenabled.appliedGeneration,
        activationInstanceId: reenabledAction.data.result.activationInstanceId,
        daemonPid: reenabledAction.data.result.pid,
      },
    });
    const publicUninstall = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'uninstall', publicPlugin.pluginId, '--json'],
    }, 'plugins_uninstall');
    if (publicUninstall.data?.desiredGeneration !== null || publicUninstall.data?.appliedGeneration !== null) {
      fail(`Public registry fixture uninstall did not clear desired/applied state: ${JSON.stringify(publicUninstall)}`);
    }
    await waitForActivationCleanup({
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      version: '1.0.0',
      activationInstanceId: reenabledAction.data.result.activationInstanceId,
    });
    childEnv.HAPPIER_MARKETPLACE_CURATED_SOURCE_URL = 'https://marketplace.happier.dev/catalog.json';
    const marketplaceSourceEnvelope = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: [
        'plugins', 'marketplace', 'sources', 'add',
        'https://marketplace.happier.dev/catalog.json',
        '--title', 'Vertical A curated marketplace',
        '--registry-profile', publicRegistryProfileId,
        '--json',
      ],
    }, 'plugins_marketplace_sources_add');
    const marketplaceSource = marketplaceSourceEnvelope.data?.source;
    if (
      typeof marketplaceSource?.id !== 'string'
      || marketplaceSource.origin !== 'curated'
      || marketplaceSource.registryProfileId !== publicRegistryProfileId
    ) {
      fail(`Curated marketplace source did not preserve the exact registry profile binding: ${JSON.stringify(marketplaceSourceEnvelope)}`);
    }
    const marketplaceInstall = await postPackedDaemonControl(
      await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR),
      '/plugins/change/request',
      {
        kind: 'installNpm',
        packageName: publicPlugin.packageName,
        selector: '1.0.0',
        registryOrigin: publicRegistry.origin,
        registryProfileId: publicRegistryProfileId,
        expectedMarketplaceListing: {
          source: {
            id: marketplaceSource.id,
            kind: 'curated',
            sourceUrl: marketplaceSource.sourceUrl,
          },
          pluginId: publicPlugin.pluginId,
          publisher: { id: 'acme', displayName: 'Acme' },
          packageName: publicPlugin.packageName,
          registryOrigin: publicRegistry.origin,
          registryProfileId: publicRegistryProfileId,
          version: '1.0.0',
          integrity: publicArtifactIntegrity,
          manifestDigest: publicManifestDigest,
          review: {
            status: 'approved',
            reviewedAt: '2026-07-23T00:00:00.000Z',
          },
          updatePolicy: 'automatic',
        },
      },
    );
    if (
      marketplaceInstall?.kind !== 'reviewRequired'
      || typeof marketplaceInstall.pendingChangeId !== 'string'
      || marketplaceInstall.review?.pluginId !== publicPlugin.pluginId
    ) {
      fail(`Exact marketplace install did not stage the reviewed candidate: ${JSON.stringify(marketplaceInstall)}`);
    }
    const marketplaceDecision = await options.decideInstallReview({
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pendingChangeId: marketplaceInstall.pendingChangeId,
      review: marketplaceInstall.review,
    });
    const marketplaceGeneration = marketplaceDecision?.desiredGeneration;
    if (
      marketplaceDecision?.kind !== 'committed'
      || marketplaceDecision.pluginId !== publicPlugin.pluginId
      || typeof marketplaceGeneration !== 'string'
      || marketplaceDecision.appliedGeneration !== marketplaceGeneration
    ) {
      fail(`Exact marketplace install did not commit one desired/applied generation: ${JSON.stringify(marketplaceDecision)}`);
    }
    const marketplaceState = await readCurrentInstallationState();
    const marketplaceGenerationRecord = JSON.parse(await readFile(join(
      childEnv.HAPPIER_HOME_DIR,
      'plugins',
      'plugins',
      'generations',
      marketplaceGeneration,
      'plugin-generation.v1.json',
    ), 'utf8'));
    const marketplaceInstalledPlugin = marketplaceState.revision.plugins?.[publicPlugin.pluginId];
    assertExactMarketplaceInstallationState({
      generation: marketplaceGenerationRecord,
      installation: marketplaceInstalledPlugin,
      runtimeCatalog: marketplaceState.revision.runtimeCatalog?.plugins?.[publicPlugin.pluginId],
      expected: {
        pluginId: publicPlugin.pluginId,
        version: '1.0.0',
        marketplaceIntegrity: publicArtifactIntegrity,
        manifestDigest: publicManifestDigest,
        distribution: {
          kind: 'npm',
          registryOrigin: publicRegistry.origin,
          packageName: publicPlugin.packageName,
        },
        updatePolicy: 'automatic',
      },
    });
    const marketplaceAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      pluginId: publicPlugin.pluginId,
      input: { value: 'marketplace-exact' },
    });
    assertRoundtrip(marketplaceAction, {
      pluginId: publicPlugin.pluginId,
      version: '1.0.0',
      value: 'marketplace-exact',
    });
    const marketplaceUninstall = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'uninstall', publicPlugin.pluginId, '--json'],
    }, 'plugins_uninstall');
    if (marketplaceUninstall.data?.desiredGeneration !== null || marketplaceUninstall.data?.appliedGeneration !== null) {
      fail(`Marketplace registry fixture uninstall did not clear desired/applied state: ${JSON.stringify(marketplaceUninstall)}`);
    }
    await waitForActivationCleanup({
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      version: '1.0.0',
      activationInstanceId: marketplaceAction.data.result.activationInstanceId,
    });
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'marketplace', 'sources', 'remove', marketplaceSource.id, '--json'],
    }, 'plugins_marketplace_sources_remove');
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'remove', publicRegistryProfileId, '--json'],
    }, 'plugins_registry');
    stages.push({
      id: 'marketplace-exact-daemon-lifecycle',
      ok: true,
      sourceId: marketplaceSource.id,
      sourceUrl: marketplaceSource.sourceUrl,
      registryProfileId: publicRegistryProfileId,
      packageName: publicPlugin.packageName,
      exactArtifact: {
        version: '1.0.0',
        integrity: publicArtifactIntegrity,
        manifestDigest: publicManifestDigest,
      },
      durableDistributionIdentity: {
        registryOrigin: publicRegistry.origin,
        packageName: publicPlugin.packageName,
      },
      install: { desiredGeneration: marketplaceGeneration, appliedGeneration: marketplaceGeneration },
      cleanup: { desiredGeneration: null, appliedGeneration: null, sourceRemoved: true },
    });
    stages.push({
      id: 'public-registry-profile-lifecycle',
      ok: true,
      registryOrigin: publicRegistry.origin,
      packageName: publicPlugin.packageName,
      profileId: publicRegistryProfileId,
      credentialState: 'not-configured',
      test: 'real-unauthenticated-https-ping',
      install: { version: '1.0.0', desiredGeneration: publicGeneration, appliedGeneration: publicGeneration },
      registryAuthorizationHeaders: 'absent',
      cleanup: { desiredGeneration: null, appliedGeneration: null, profileRemoved: true },
    });
    const publicRegistryDaemonStop = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['daemon', 'stop', '--json'],
    });
    assertCommandSucceeded(publicRegistryDaemonStop, 'Packed daemon stop before private registry CA transition');
    await publicRegistry.close();
    publicRegistry = null;

    const privatePlugin = pluginSpecs.find((candidatePlugin) => (
      candidatePlugin.pluginId === 'acme.private-registry'
    ));
    if (!privatePlugin) fail('Vertical-A private registry fixture was not created');
    const privateArtifacts = [];
    for (const version of ['10.0.0', '11.0.0']) {
      await configureVerticalAPlugin({
        pluginRoot: privatePlugin.root,
        pluginId: privatePlugin.pluginId,
        packageName: privatePlugin.packageName,
        version,
        fetchOrigin: registry.origin,
      });
      for (const operation of ['typecheck', 'build']) {
        await runPackedCliJson({
          cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
          args: ['plugins', 'author', operation, privatePlugin.root, '--json'],
        }, `plugins_author_${operation}`);
      }
      const privateArchivePath = join(tempRoot, `${privatePlugin.name}-${version}.tgz`);
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'pack', privatePlugin.root, '--out', privateArchivePath, '--json'],
      }, 'plugins_pack');
      privateArtifacts.push({ version, bytes: await readFile(privateArchivePath) });
    }

    privateRegistry = await startPrivatePluginRegistry({
      packageName: privatePlugin.packageName,
      artifacts: privateArtifacts,
      acceptedToken: 'synthetic-private-token-v1',
    });
    await refreshExtraCaBundle(privateRegistry.caCertificatePath);
    const registryProfileId = 'registry_private_vertical_a';
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: [
        'plugins', 'registry', 'add', privateRegistry.origin,
        '--id', registryProfileId,
        '--name', 'Vertical A private registry',
        '--scope', '@acme',
        '--allow-private-network',
        '--json',
      ],
    }, 'plugins_registry');
    const initialRegistryLogin = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      input: 'synthetic-private-token-v1\n',
      args: ['plugins', 'registry', 'login', registryProfileId, '--json'],
    }, 'plugins_registry');
    if (JSON.stringify(initialRegistryLogin).includes('synthetic-private-token-v1')) {
      fail('Private registry login emitted credential material');
    }
    const initialRegistryTest = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'test', registryProfileId, '--json'],
    }, 'plugins_registry');
    const initialProfile = initialRegistryTest.data?.snapshot?.profiles?.find((profile) => (
      profile.profileId === registryProfileId
    ));
    if (initialProfile?.availability !== 'available' || initialProfile.hasCredentials !== true) {
      fail(`Private registry test did not observe authenticated availability: ${JSON.stringify(initialRegistryTest)}`);
    }

    const installPrivateVersion = async (version) => await runReviewedInstall([
        'plugins', 'install', privatePlugin.packageName,
        '--kind', 'npm',
        '--selector', version,
        '--json',
      ]);
    const privateV1Install = await installPrivateVersion('10.0.0');
    const privateV1Generation = privateV1Install.change?.desiredGeneration;
    if (
      privateV1Install.change?.kind !== 'committed'
      || privateV1Install.change.pluginId !== privatePlugin.pluginId
      || typeof privateV1Generation !== 'string'
      || privateV1Install.change.appliedGeneration !== privateV1Generation
    ) {
      fail(`Private npm install did not commit one desired/applied generation: ${JSON.stringify(privateV1Install)}`);
    }
    const privateV1Action = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      pluginId: privatePlugin.pluginId,
      input: { value: privatePlugin.value },
    });
    assertRoundtrip(privateV1Action, {
      pluginId: privatePlugin.pluginId,
      version: '10.0.0',
      value: privatePlugin.value,
    });
    const privateV1ActivationInstanceId = privateV1Action.data.result.activationInstanceId;

    privateRegistry.setAcceptedToken('synthetic-private-token-v2');
    const commitBeforeExpiredUpdate = await readCurrentCommit();
    const expiredUpdate = await runPackedCli({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: [
        'plugins', 'install', privatePlugin.packageName,
        '--kind', 'npm',
        '--selector', '11.0.0',
        '--json',
      ],
    });
    if (expiredUpdate.code === 0 || expiredUpdate.signal !== null) {
      fail(`Expired private registry credential did not fail the update: ${expiredUpdate.stdout}${expiredUpdate.stderr}`);
    }
    const commitAfterExpiredUpdate = await readCurrentCommit();
    if (
      commitAfterExpiredUpdate.pluginGenerations?.[privatePlugin.pluginId]?.immutableGenerationId !== privateV1Generation
      || commitAfterExpiredUpdate.revision !== commitBeforeExpiredUpdate.revision
    ) {
      fail('Expired private registry credential changed canonical desired currentness');
    }
    const expiredProfileList = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'list', '--json'],
    }, 'plugins_registry');
    const expiredProfile = expiredProfileList.data?.snapshot?.profiles?.find((profile) => (
      profile.profileId === registryProfileId
    ));
    if (
      expiredProfile?.availability !== 'sign_in_required'
      || !expiredProfileList.data?.snapshot?.pausedSources?.some((source) => (
        source.origin === privateRegistry.origin && source.reason === 'authentication_failed'
      ))
    ) {
      fail(`Expired credential did not pause only the private source: ${JSON.stringify(expiredProfileList)}`);
    }
    const privateV1AfterExpiry = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      pluginId: privatePlugin.pluginId,
    });
    assertRoundtrip(privateV1AfterExpiry, {
      pluginId: privatePlugin.pluginId,
      version: '10.0.0',
      value: privatePlugin.value,
    });

    const rotatedRegistryLogin = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      input: 'synthetic-private-token-v2\n',
      args: ['plugins', 'registry', 'login', registryProfileId, '--json'],
    }, 'plugins_registry');
    if (JSON.stringify(rotatedRegistryLogin).includes('synthetic-private-token-v2')) {
      fail('Private registry credential rotation emitted credential material');
    }
    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'test', registryProfileId, '--json'],
    }, 'plugins_registry');
    const privateV2Install = await installPrivateVersion('11.0.0');
    const privateV2Generation = privateV2Install.change?.desiredGeneration;
    if (
      privateV2Install.change?.kind !== 'committed'
      || privateV2Install.change.pluginId !== privatePlugin.pluginId
      || typeof privateV2Generation !== 'string'
      || privateV2Generation === privateV1Generation
      || privateV2Install.change.appliedGeneration !== privateV2Generation
    ) {
      fail(`Private npm update did not replace desired/applied currentness: ${JSON.stringify(privateV2Install)}`);
    }
    const privateV2Action = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      pluginId: privatePlugin.pluginId,
    });
    assertRoundtrip(privateV2Action, {
      pluginId: privatePlugin.pluginId,
      version: '11.0.0',
      value: privatePlugin.value,
    });
    const privateV2ActivationInstanceId = privateV2Action.data.result.activationInstanceId;

    await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'logout', registryProfileId, '--json'],
    }, 'plugins_registry');
    const requestsBeforeLoggedOutAttempt = privateRegistry.getRequests().length;
    const loggedOutUpdate = await runPackedCli({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: [
        'plugins', 'install', privatePlugin.packageName,
        '--kind', 'npm',
        '--selector', '11.0.0',
        '--json',
      ],
    });
    const requestsAfterLoggedOutAttempt = privateRegistry.getRequests();
    const loggedOutAttemptRequests = requestsAfterLoggedOutAttempt.slice(requestsBeforeLoggedOutAttempt);
    const loggedOutProhibitedRequests = loggedOutAttemptRequests.filter(
      (request) => request.classification !== 'ambient-availability-probe',
    );
    if (loggedOutUpdate.code === 0 || loggedOutProhibitedRequests.length !== 0) {
      fail(`Logged-out private profile did not fail closed before registry access: ${JSON.stringify({
        command: {
          code: loggedOutUpdate.code,
          signal: loggedOutUpdate.signal,
          envelope: parseJsonEnvelope(loggedOutUpdate.stdout, 'plugins_install_logged_out'),
          stderr: loggedOutUpdate.stderr,
        },
        requestCountBefore: requestsBeforeLoggedOutAttempt,
        attemptRequests: loggedOutAttemptRequests,
        prohibitedRequests: loggedOutProhibitedRequests,
      })}`);
    }
    const commitAfterLogout = await readCurrentCommit();
    if (commitAfterLogout.pluginGenerations?.[privatePlugin.pluginId]?.immutableGenerationId !== privateV2Generation) {
      fail('Private registry logout changed the installed desired generation');
    }

    const removedProfile = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'registry', 'remove', registryProfileId, '--json'],
    }, 'plugins_registry');
    if (
      removedProfile.data?.snapshot?.profiles?.some((profile) => profile.profileId === registryProfileId)
      || !removedProfile.data?.snapshot?.pausedSources?.some((source) => (
        source.origin === privateRegistry.origin && source.reason === 'profile_removed'
      ))
    ) {
      fail(`Private registry profile removal did not preserve truthful source pause state: ${JSON.stringify(removedProfile)}`);
    }
    const requestsBeforeRemovedAttempt = privateRegistry.getRequests().length;
    const daemonStateForRemovedProfile = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    const removedProfileRequest = await postPackedDaemonControl(
      daemonStateForRemovedProfile,
      '/plugins/change/request',
      {
        kind: 'installNpm',
        packageName: privatePlugin.packageName,
        selector: '11.0.0',
        registryOrigin: privateRegistry.origin,
        registryProfileId,
      },
    );
    const requestsAfterRemovedAttempt = privateRegistry.getRequests();
    const removedAttemptRequests = requestsAfterRemovedAttempt.slice(requestsBeforeRemovedAttempt);
    const removedProhibitedRequests = removedAttemptRequests.filter(
      (request) => request.classification !== 'ambient-availability-probe',
    );
    if (
      removedProfileRequest?.kind !== 'failed'
      || removedProhibitedRequests.length !== 0
    ) {
      fail(`Removed private profile did not fail closed before registry access: ${JSON.stringify({
        response: removedProfileRequest,
        attemptRequests: removedAttemptRequests,
        prohibitedRequests: removedProhibitedRequests,
      })}`);
    }
    const commitAfterRemoval = await readCurrentCommit();
    if (commitAfterRemoval.pluginGenerations?.[privatePlugin.pluginId]?.immutableGenerationId !== privateV2Generation) {
      fail('Private registry profile removal changed the installed desired generation');
    }
    const persistedPrivateProfileBytes = await readFile(join(
      childEnv.HAPPIER_HOME_DIR,
      'plugins',
      'plugins',
      'state',
      'npm-registry-profiles.v1.json',
    ), 'utf8');
    if (
      persistedPrivateProfileBytes.includes('synthetic-private-token-v1')
      || persistedPrivateProfileBytes.includes('synthetic-private-token-v2')
    ) {
      fail('Private registry profile state persisted credential material');
    }

    const privateFixtureCleanup = await cleanupPrivateRegistryFixture({
      pluginId: privatePlugin.pluginId,
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      activationInstances: [
        { version: '10.0.0', activationInstanceId: privateV1ActivationInstanceId },
        { version: '11.0.0', activationInstanceId: privateV2ActivationInstanceId },
      ],
      uninstallPlugin: async () => await runPackedCliJson({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        args: ['plugins', 'uninstall', privatePlugin.pluginId, '--json'],
      }, 'plugins_uninstall'),
    });
    stages.push({
      id: 'private-registry-profile-lifecycle',
      ok: true,
      registryOrigin: privateRegistry.origin,
      packageName: privatePlugin.packageName,
      profileId: registryProfileId,
      login: 'configured-secret-reference',
      secretMaterialEmitted: false,
      secretMaterialPersistedInProfileState: false,
      test: 'real-authenticated-https-ping',
      install: { version: '10.0.0', desiredGeneration: privateV1Generation, appliedGeneration: privateV1Generation },
      expiry: { status: 'sign_in_required', retainedGeneration: privateV1Generation },
      update: { version: '11.0.0', desiredGeneration: privateV2Generation, appliedGeneration: privateV2Generation },
      logout: {
        prohibitedRegistryRequestsAfterLogout: 0,
        ambientAvailabilityProbes: loggedOutAttemptRequests.length,
        retainedGeneration: privateV2Generation,
      },
      remove: {
        prohibitedRegistryRequestsAfterRemoval: 0,
        ambientAvailabilityProbes: removedAttemptRequests.length,
        retainedGeneration: privateV2Generation,
      },
      cleanup: privateFixtureCleanup,
    });

    if (await pathExists(childEnv.HAPPIER_VERTICAL_A_MARKER)) {
      fail('Plugin executable code ran before daemon-owned review and approval');
    }
    const installEnvelope = await runReviewedInstall([
      'plugins', 'install', archivePath, '--json',
    ]);
    const installedPlugin = installEnvelope.change?.kind === 'committed'
      ? await readInstalledPlugin(installEnvelope.change.pluginId)
      : null;
    const desiredGeneration = installEnvelope.change?.desiredGeneration;
    const appliedGeneration = installEnvelope.change?.appliedGeneration;
    const pendingSurfaces = installEnvelope.change?.pendingSurfaces;
    if (
      installEnvelope.change?.kind !== 'committed'
      || installEnvelope.change.pluginId !== plugin.pluginId
      || installedPlugin?.install?.trust?.state !== 'trusted'
      || typeof desiredGeneration !== 'string'
      || appliedGeneration !== desiredGeneration
      || !Array.isArray(pendingSurfaces)
      || pendingSurfaces.length !== 0
    ) {
      fail(`Install did not synchronously commit one desired/applied generation: ${JSON.stringify(installEnvelope)}`);
    }
    stages.push({
      id: 'daemon-review-and-commit',
      ok: true,
      pluginId: installEnvelope.change?.pluginId,
      trustState: installedPlugin?.install?.trust?.state,
      desiredGeneration,
      appliedGeneration,
      approvalEvidence: {
        actor: 'authenticated-test-user',
        interaction: 'simulated-interactive-confirmation',
        physicalHuman: false,
      },
    });

    const initialMarkerEvents = await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER);
    const expectedActivationEvents = ['module', 'activate', 'registered'];
    const activationEvents = initialMarkerEvents.map((event) => event.kind);
    const activationPids = [...new Set(initialMarkerEvents.map((event) => event.pid))];
    const activationInstanceIds = [...new Set(initialMarkerEvents.map((event) => event.activationInstanceId))];
    if (
      JSON.stringify(activationEvents) !== JSON.stringify(expectedActivationEvents)
      || activationPids.length !== 1
      || activationInstanceIds.length !== 1
      || initialMarkerEvents.some((event) => event.version !== '1.0.0')
    ) {
      fail(`Prepared activation/registration did not occur exactly once in one daemon: ${JSON.stringify(initialMarkerEvents)}`);
    }
    const initialDaemonPid = activationPids[0];
    const initialActivationInstanceId = activationInstanceIds[0];
    stages.push({
      id: 'prepared-activation-registration',
      ok: true,
      daemonPid: initialDaemonPid,
      activationInstanceId: initialActivationInstanceId,
      events: activationEvents,
    });

    const actionEnvelope = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId, input: { value: plugin.value },
    });
    assertRoundtrip(actionEnvelope, {
      pluginId: plugin.pluginId,
      version: '1.0.0',
      value: plugin.value,
      activationInstanceId: initialActivationInstanceId,
    });
    if (actionEnvelope.data?.result?.pid !== initialDaemonPid) {
      fail('Declared action was not invoked by the daemon that owns the applied runtime registry');
    }
    observedDaemonRuntimeIdentity = await assertPackedDaemonRuntimeIdentity({
      installedCliPackageRoot,
      candidateVersion: candidate.cli.version,
      daemonState: await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR),
      expectedDaemonPid: initialDaemonPid,
      runtime: actionEnvelope.data?.result?.runtime,
    });
    const interceptorFetchEnvelope = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'interceptor-fetch' },
    });
    const interceptorFetch = interceptorFetchEnvelope.data?.result?.fetch;
    let interceptorFetchBody;
    try {
      interceptorFetchBody = JSON.parse(interceptorFetch?.body);
    } catch {
      fail(`Packed interceptor fetch returned a non-JSON response: ${JSON.stringify(interceptorFetch)}`);
    }
    let interceptorFetchFinalOrigin = null;
    try {
      interceptorFetchFinalOrigin = new URL(interceptorFetch?.finalUrl).origin;
    } catch {
      fail(`Packed interceptor fetch returned an invalid final URL: ${JSON.stringify(interceptorFetch)}`);
    }
    const interceptorMarkers = (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
      .filter((event) => (
        event.kind === 'request-interceptor'
        && event.version === '1.0.0'
        && event.activationInstanceId === initialActivationInstanceId
      ));
    if (
      interceptorFetch?.status !== 200
      || interceptorFetchFinalOrigin !== registry.origin
      || interceptorFetchBody?.name !== SDK_PACKAGE_NAME
      || interceptorFetchBody?.versions?.[candidate.sdk.version]?.version !== candidate.sdk.version
      || interceptorMarkers.length !== 1
      || interceptorMarkers[0]?.pid !== initialDaemonPid
    ) {
      fail(`Packed fetch/interceptor service did not settle through the applied daemon generation: ${JSON.stringify({
        interceptorFetch,
        interceptorFetchBody,
        interceptorMarkers,
      })}`);
    }
    stages.push({
      id: 'declared-action-invocation',
      ok: true,
      actionId: `${plugin.pluginId}/roundtrip`,
      daemonPid: actionEnvelope.data.result.pid,
      resourceKinds: ['prompt', 'skill', 'template', 'asset', 'config'],
      requestInterceptor: {
        id: `${plugin.pluginId}/observe-api`,
        status: interceptorFetch.status,
        origin: registry.origin,
        activationInstanceId: initialActivationInstanceId,
        deliveries: interceptorMarkers.length,
      },
    });
    const installedRetainedCapabilities = await options.probeRetainedCapabilities({
      phase: 'installed',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const installedRetainedProjection = installedRetainedCapabilities?.projection?.projection;
    const installedPluginUiEntries = installedRetainedProjection?.familiesById?.pluginUi?.entriesById ?? {};
    const installedTool = installedRetainedProjection?.toolsById?.[`${plugin.pluginId}/roundtrip-tool`];
    const installedStructuredMessage = installedPluginUiEntries[`structuredMessage:${plugin.pluginId}:roundtrip-result`];
    const installedHeaderAction = installedPluginUiEntries[`sessionHeaderAction:${plugin.pluginId}:roundtrip-header`];
    const installedHostedWeb = installedPluginUiEntries[`hostedWeb:${plugin.pluginId}:main-web`];
    const installedPublicGeneration = String(installedRetainedProjection?.generation);
    if (
      installedTool?.id !== 'roundtrip-tool'
      || installedTool.exposesToAgent !== true
      || installedStructuredMessage?.kind !== 'acme.vertical-a/roundtrip-result.v1'
      || installedHeaderAction?.action !== 'roundtrip'
      || installedHostedWeb?.runtime?.state !== 'available'
      || installedHostedWeb?.runtimeMode?.kind !== 'installedStaticAssets'
      || installedHostedWeb?.artifactGraph?.tier !== 'hostedWeb'
      || installedRetainedCapabilities?.structuredResolution?.ok !== true
      || installedRetainedCapabilities.structuredResolution.model?.identity?.generation !== installedPublicGeneration
      || installedRetainedCapabilities.structuredResolution.model?.renderer?.generation !== installedPublicGeneration
      || installedRetainedCapabilities?.structuredResolution?.model?.actions?.[0]?.qualifiedId !== `${plugin.pluginId}/roundtrip`
      || installedRetainedCapabilities.structuredResolution.model.actions[0]?.generation !== installedPublicGeneration
      || installedRetainedCapabilities.structuredResolution.renderer?.identity?.generation !== installedPublicGeneration
      || installedRetainedCapabilities?.structuredAction?.ok !== true
    ) {
      fail(`Packed retained capabilities did not reach their real installed consumers: ${JSON.stringify(installedRetainedCapabilities)}`);
    }
    const installedConnectedAccount = await options.probeConnectedAccounts({
      phase: 'installed',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
      service: Object.freeze({
        pluginId: plugin.pluginId,
        localId: 'novel-cloud',
      }),
      configuredOrigin: connectedAccountProvider.origin,
      staleConfiguredOrigin: staleConnectedAccountProvider.origin,
    });
    if (
      installedConnectedAccount?.initialConfigurationAdmission?.status
        !== 'configurationRequired'
      || installedConnectedAccount.initialConfigurationAdmission.attemptId !== undefined
      || installedConnectedAccount.initialConfigurationAdmission.target?.kind !== 'service'
      || installedConnectedAccount.initialConfigurationAdmission.target?.modeId !== 'manual'
      || installedConnectedAccount.initialConfigurationAdmission.target?.service?.pluginId
        !== plugin.pluginId
      || installedConnectedAccount.initialConfigurationAdmission.target?.service?.localId
        !== 'novel-cloud'
      || JSON.stringify(
        [...(installedConnectedAccount.initialConfigurationAdmission.missingFieldIds ?? [])].sort(),
      ) !== JSON.stringify(['api-origin'])
      || installedConnectedAccount?.configurationCommitted?.status
        !== 'configurationCommitted'
      || typeof installedConnectedAccount.configurationCommitted.configuration?.revision
        !== 'string'
      || installedConnectedAccount.configurationCommitted.configuration.values?.['api-origin']
        !== connectedAccountProvider.origin
      || installedConnectedAccount?.beginStaleConfiguration?.status !== 'awaitingManual'
      || installedConnectedAccount?.staleConfigurationCommitted?.status
        !== 'configurationCommitted'
      || installedConnectedAccount.staleConfigurationCommitted.configuration?.values?.['api-origin']
        !== staleConnectedAccountProvider.origin
      || installedConnectedAccount?.staleConfigurationSubmit?.status !== 'conflict'
      || installedConnectedAccount?.configurationRestored?.status
        !== 'configurationCommitted'
      || installedConnectedAccount.configurationRestored.configuration?.values?.['api-origin']
        !== connectedAccountProvider.origin
      || installedConnectedAccount?.begin?.status !== 'awaitingManual'
      || installedConnectedAccount?.qualifiedAccountsCapability?.protocolVersion !== 4
      || typeof installedConnectedAccount.begin.attemptId !== 'string'
      || installedConnectedAccount?.submit?.status !== 'connected'
      || installedConnectedAccount.submit.account?.service?.pluginId !== plugin.pluginId
      || installedConnectedAccount.submit.account?.service?.localId !== 'novel-cloud'
      || installedConnectedAccount.submit.account?.accountId !== 'account-a'
      || installedConnectedAccount?.beginAccountB?.status !== 'awaitingManual'
      || installedConnectedAccount?.submitAccountB?.status !== 'connected'
      || installedConnectedAccount.submitAccountB.account?.accountId !== 'account-b'
      || installedConnectedAccount?.beginReconnectAccountA?.status !== 'awaitingManual'
      || installedConnectedAccount?.submitReconnectAccountA?.status !== 'connected'
      || installedConnectedAccount.submitReconnectAccountA.account?.accountId !== 'account-a'
      || installedConnectedAccount?.qualifiedGroup?.ref?.service?.pluginId
        !== plugin.pluginId
      || installedConnectedAccount.qualifiedGroup.ref.service.localId
        !== 'novel-cloud'
      || installedConnectedAccount.qualifiedGroup.ref.groupId
        !== 'packed-fallback'
      || installedConnectedAccount.qualifiedGroup.activeConnectedAccountId
        !== 'account-b'
      || installedConnectedAccount.qualifiedGroup.members?.length !== 2
      || installedConnectedAccount?.qualifiedGroupAfterReconnect?.activeConnectedAccountId
        !== 'account-b'
      || installedConnectedAccount.qualifiedGroupAfterReconnect.generation
        !== installedConnectedAccount.qualifiedGroup.generation
      || installedConnectedAccount.qualifiedGroupAfterReconnect.runtimeStateRevision
        !== installedConnectedAccount.qualifiedGroup.runtimeStateRevision
      || installedConnectedAccount?.beginOutcomeUnknown?.status !== 'awaitingManual'
      || installedConnectedAccount?.submitOutcomeUnknown?.status !== 'reconnectRequired'
      || installedConnectedAccount.submitOutcomeUnknown.code
        !== 'connected_account_authentication_outcome_unknown'
      || installedConnectedAccount?.beginCancellation?.status !== 'awaitingManual'
      || installedConnectedAccount?.cancellation?.status !== 'cancelled'
      || installedConnectedAccount?.beginLateResult?.status !== 'awaitingManual'
      || installedConnectedAccount?.cancelLateResult?.status !== 'cancelled'
      || installedConnectedAccount?.lateResult?.status !== 'conflict'
      || installedConnectedAccount.lateResult.code
        !== 'connected_account_attempt_cancelled'
      || installedConnectedAccount?.beginOAuthConfiguration?.status
        !== 'configurationRequired'
      || installedConnectedAccount.beginOAuthConfiguration.attemptId !== undefined
      || installedConnectedAccount.beginOAuthConfiguration.target?.kind !== 'service'
      || installedConnectedAccount.beginOAuthConfiguration.target?.modeId !== 'oauth'
      || installedConnectedAccount.beginOAuthConfiguration.target?.service?.pluginId
        !== plugin.pluginId
      || installedConnectedAccount.beginOAuthConfiguration.target?.service?.localId
        !== 'novel-cloud'
      || JSON.stringify(
        [...(installedConnectedAccount.beginOAuthConfiguration.missingFieldIds ?? [])].sort(),
      ) !== JSON.stringify([
        'api-origin',
        'authorization-origin',
        'client-secret',
        'tenant',
      ])
      || installedConnectedAccount?.oauthConfigurationCommitted?.status
        !== 'configurationCommitted'
      || typeof installedConnectedAccount.oauthConfigurationCommitted.configuration?.revision
        !== 'string'
      || installedConnectedAccount.oauthConfigurationCommitted.configuration.values?.['api-origin']
        !== connectedAccountProvider.origin
      || installedConnectedAccount.oauthConfigurationCommitted.configuration.values?.['authorization-origin']
        !== 'https://auth.novel.example'
      || installedConnectedAccount.oauthConfigurationCommitted.configuration.values?.tenant
        !== 'packed-tenant'
      || installedConnectedAccount?.beginOAuthStart?.status !== 'starting'
      || installedConnectedAccount?.beginOAuth?.status !== 'awaitingOAuth'
      || typeof installedConnectedAccount.beginOAuth.attemptId !== 'string'
      || typeof installedConnectedAccount.beginOAuth.authorizationUrl !== 'string'
      || typeof installedConnectedAccount.beginOAuth.callbackUrl !== 'string'
      || installedConnectedAccount.oauthAuthorization?.origin
        !== 'https://auth.novel.example'
      || installedConnectedAccount.oauthAuthorization?.pathname !== '/authorize'
      || installedConnectedAccount.oauthAuthorization?.responseType !== 'code'
      || typeof installedConnectedAccount.oauthAuthorization?.state !== 'string'
      || installedConnectedAccount.oauthAuthorization.state.length === 0
      || installedConnectedAccount.oauthAuthorization?.redirectUri
        !== installedConnectedAccount.beginOAuth.callbackUrl
      || installedConnectedAccount?.beginProviderCancellation?.status
        !== 'awaitingOAuth'
      || installedConnectedAccount?.providerCancellation?.status
        !== 'cancelled'
      || installedConnectedAccount?.beginDeviceConfiguration?.status
        !== 'configurationRequired'
      || typeof installedConnectedAccount.beginDeviceConfiguration.attemptId !== 'string'
      || installedConnectedAccount.beginDeviceConfiguration.target?.kind !== 'attempt'
      || installedConnectedAccount.beginDeviceConfiguration.target?.attemptId
        !== installedConnectedAccount.beginDeviceConfiguration.attemptId
      || installedConnectedAccount.beginDeviceConfiguration.target?.modeId !== 'device'
      || installedConnectedAccount.beginDeviceConfiguration.target?.service?.pluginId
        !== plugin.pluginId
      || installedConnectedAccount.beginDeviceConfiguration.target?.service?.localId
        !== 'novel-cloud'
      || JSON.stringify(
        [...(installedConnectedAccount.beginDeviceConfiguration.missingFieldIds ?? [])].sort(),
      ) !== JSON.stringify(['account-secret', 'api-origin', 'workspace'])
      || installedConnectedAccount?.deviceConfigurationCommitted?.status
        !== 'configurationCommitted'
      || typeof installedConnectedAccount.deviceConfigurationCommitted.configuration?.revision
        !== 'string'
      || installedConnectedAccount.deviceConfigurationCommitted.configuration.values?.['api-origin']
        !== connectedAccountProvider.origin
      || installedConnectedAccount.deviceConfigurationCommitted.configuration.values?.workspace
        !== 'packed-workspace'
      || installedConnectedAccount?.continueDeviceStart?.status !== 'starting'
      || installedConnectedAccount?.continueDevice?.status
        !== 'awaitingDeviceAuthorization'
      || installedConnectedAccount.continueDevice.attemptId
        !== installedConnectedAccount.beginDeviceConfiguration.attemptId
    ) {
      fail(`Packed novel Connected Account did not traverse daemon command admission and V4 settlement: ${JSON.stringify(
        installedConnectedAccount,
        (key, value) => (
          /(?:authorizationUrl|callbackUrl|oauthState|secret|token)/iu.test(key)
            ? value === null || value === undefined
              ? value
              : `<redacted:${typeof value}>`
            : value
        ),
      )}`);
    }
    const connectedAccountProviderRequests = connectedAccountProvider.getRequests()
      .filter((request) => (
        decodeURIComponent(request.pathname) === `/${SDK_PACKAGE_NAME}`
      ));
    const staleConnectedAccountProviderRequests =
      staleConnectedAccountProvider.getRequests()
        .filter((request) => (
          decodeURIComponent(request.pathname) === `/${SDK_PACKAGE_NAME}`
        ));
    let providerCancellationMarkers = [];
    const providerCancellationMarkerStartedAt = Date.now();
    while (
      providerCancellationMarkers.length !== 1
      && Date.now() - providerCancellationMarkerStartedAt < 5_000
    ) {
      providerCancellationMarkers =
        (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
          .filter((event) => (
            event.kind === 'connected-account-cancel'
            && event.version === '1.0.0'
            && event.activationInstanceId === initialActivationInstanceId
            && event.pid === initialDaemonPid
          ));
      if (providerCancellationMarkers.length !== 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    if (
      connectedAccountProviderRequests.length !== 7
      || connectedAccountProviderRequests.some((request) => request.authorization !== null)
      || staleConnectedAccountProviderRequests.length !== 0
      || providerCancellationMarkers.length !== 1
    ) {
      fail(`Packed novel Connected Account did not enforce its persisted configured-origin binding: ${JSON.stringify({
        configured: connectedAccountProviderRequests,
        stale: staleConnectedAccountProviderRequests,
        providerCancellationMarkers,
      })}`);
    }
    const connectedAccountConsumerEnvelope = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'connected-account-materialize' },
    });
    const connectedAccountConsumer =
      connectedAccountConsumerEnvelope.data?.result;
    const connectedAccountMaterializationMarkers =
      (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
        .filter((event) => (
          event.kind === 'connected-account-materialize'
          && event.version === '1.0.0'
          && event.activationInstanceId === initialActivationInstanceId
        ));
    if (
      connectedAccountConsumerEnvelope.ok !== true
      || connectedAccountConsumer?.binding?.purpose !== 'packed-novel-account'
      || connectedAccountConsumer.binding.service?.pluginId !== plugin.pluginId
      || connectedAccountConsumer.binding.service?.localId !== 'novel-cloud'
      || connectedAccountConsumer.binding.target?.kind !== 'group'
      || connectedAccountConsumer?.materializationKind !== 'environment'
      || connectedAccountConsumer?.credentialVerified !== true
      || connectedAccountMaterializationMarkers.length !== 1
      || connectedAccountMaterializationMarkers[0]?.pid !== initialDaemonPid
    ) {
      fail(`Packed novel Connected Account did not reach the public action consumer and established materializer: ${JSON.stringify({
        connectedAccountConsumerEnvelope,
        connectedAccountMaterializationMarkers,
      })}`);
    }
    const connectedAccountSelectionEnvelope = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'connected-account-request-selection' },
    });
    const connectedAccountWatchPromise = runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'connected-account-watch-rematerialize' },
    });
    let connectedAccountWatchMutation;
    try {
      const watchReadyStartedAt = Date.now();
      let watchReady = false;
      while (!watchReady && Date.now() - watchReadyStartedAt < 15_000) {
        watchReady = (
          await readVerticalAMarkerEvents(
            childEnv.HAPPIER_VERTICAL_A_MARKER,
          )
        ).some((event) => (
          event.kind === 'connected-account-watch-ready'
          && event.version === '1.0.0'
          && event.activationInstanceId === initialActivationInstanceId
          && event.pid === initialDaemonPid
        ));
        if (!watchReady) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
      }
      if (!watchReady) {
        fail('Timed out waiting for the packed Connected Account watch initial resync');
      }
      connectedAccountWatchMutation =
        await options.probeConnectedAccounts({
          phase: 'watchRematerialize',
          happyHomeDir: childEnv.HAPPIER_HOME_DIR,
          pluginId: plugin.pluginId,
          service: Object.freeze({
            pluginId: plugin.pluginId,
            localId: 'novel-cloud',
          }),
          configuredOrigin: connectedAccountProvider.origin,
          staleConfiguredOrigin: staleConnectedAccountProvider.origin,
        });
    } catch (error) {
      await connectedAccountWatchPromise.catch(() => undefined);
      throw error;
    }
    const connectedAccountWatchEnvelope =
      await connectedAccountWatchPromise;
    const connectedAccountPublicConsumer =
      assertPackedConnectedAccountWatchRematerialization({
        selectionEnvelope: connectedAccountSelectionEnvelope,
        watchEnvelope: connectedAccountWatchEnvelope,
        mutation: connectedAccountWatchMutation,
      });
    const connectedAccountWatchRestore =
      await options.probeConnectedAccounts({
        phase: 'watchRestore',
        happyHomeDir: childEnv.HAPPIER_HOME_DIR,
        pluginId: plugin.pluginId,
        service: Object.freeze({
          pluginId: plugin.pluginId,
          localId: 'novel-cloud',
        }),
        configuredOrigin: connectedAccountProvider.origin,
        staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      });
    if (
      connectedAccountWatchRestore?.group?.activeConnectedAccountId
        !== 'account-b'
    ) {
      fail('Packed Connected Account watch fixture did not restore its established group currentness');
    }
    stages.push({
      id: 'packed-connected-account-producer',
      ok: true,
      pluginId: plugin.pluginId,
      qualifiedProtocolVersion:
        installedConnectedAccount.qualifiedAccountsCapability.protocolVersion,
      service: installedConnectedAccount.submit.account.service,
      accountId: installedConnectedAccount.submit.account.accountId,
      secondAccountId: installedConnectedAccount.submitAccountB.account.accountId,
      reconnectedAccountId:
        installedConnectedAccount.submitReconnectAccountA.account.accountId,
      group: {
        id: installedConnectedAccount.qualifiedGroup.ref.groupId,
        activeAccountId:
          installedConnectedAccount.qualifiedGroupAfterReconnect
            .activeConnectedAccountId,
        memberAccountIds:
          installedConnectedAccount.qualifiedGroupAfterReconnect.members
            .map((member) => member.connectedAccountId),
        generation:
          installedConnectedAccount.qualifiedGroupAfterReconnect.generation,
        runtimeStateRevision:
          installedConnectedAccount.qualifiedGroupAfterReconnect
            .runtimeStateRevision,
      },
      outcomeUnknown: installedConnectedAccount.submitOutcomeUnknown.status,
      cancellation: installedConnectedAccount.cancellation.status,
      lateResult: {
        cancellation: installedConnectedAccount.cancelLateResult.status,
        providerCompletion: installedConnectedAccount.lateResult.code,
      },
      configurationAdmission: {
        initial: installedConnectedAccount.initialConfigurationAdmission.status,
        committedRevision:
          installedConnectedAccount.configurationCommitted.configuration.revision,
        staleAttempt: installedConnectedAccount.staleConfigurationSubmit.status,
        restoredRevision:
          installedConnectedAccount.configurationRestored.configuration.revision,
        service: installedConnectedAccount.beginOAuthConfiguration.status,
        serviceCommittedRevision:
          installedConnectedAccount.oauthConfigurationCommitted.configuration.revision,
        account: installedConnectedAccount.beginDeviceConfiguration.status,
        accountCommittedRevision:
          installedConnectedAccount.deviceConfigurationCommitted.configuration.revision,
      },
      modeId: 'manual',
      durableAttempts: {
        oauth: installedConnectedAccount.beginOAuth.status,
        device: installedConnectedAccount.continueDevice.status,
      },
      providerCancellation: {
        begin: installedConnectedAccount.beginProviderCancellation.status,
        status: installedConnectedAccount.providerCancellation.status,
        deliveries: providerCancellationMarkers.length,
      },
      providerFetches: connectedAccountProviderRequests.length,
      providerOrigin: connectedAccountProvider.origin,
      staleProviderFetches: staleConnectedAccountProviderRequests.length,
      staleProviderOrigin: staleConnectedAccountProvider.origin,
      consumer: {
        purpose: connectedAccountConsumer.binding.purpose,
        target: connectedAccountConsumer.binding.target.kind,
        materialization: connectedAccountConsumer.materializationKind,
        credentialVerified: connectedAccountConsumer.credentialVerified,
      },
      publicConsumer: {
        ...connectedAccountPublicConsumer,
        restoredAccountId:
          connectedAccountWatchRestore.group.activeConnectedAccountId,
      },
      daemonPid: initialDaemonPid,
      activationInstanceId: initialActivationInstanceId,
    });
    const bundledMultimodeAccount = await options.probeConnectedAccounts({
      phase: 'builtinMultimode',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
      service: Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }),
      configuredOrigin: connectedAccountProvider.origin,
      staleConfiguredOrigin: staleConnectedAccountProvider.origin,
    });
    const bundledModes =
      bundledMultimodeAccount?.descriptorBefore?.descriptor
        ?.authentication?.modes ?? [];
    const bundledSetupTokenMode = bundledModes.find(
      ({ id }) => id === 'setup-token',
    );
    const bundledOAuthMode = bundledModes.find(({ id }) => id === 'oauth');
    const bundledOAuthAuthorizationUrl =
      typeof bundledMultimodeAccount?.beginOAuth?.authorizationUrl === 'string'
        ? new URL(bundledMultimodeAccount.beginOAuth.authorizationUrl)
        : null;
    const bundledAccount =
      bundledMultimodeAccount?.connected?.status === 'connected'
        ? bundledMultimodeAccount.connected.account
        : null;
    if (
      bundledMultimodeAccount?.descriptorBefore?.status !== 'described'
      || bundledMultimodeAccount.descriptorBefore.service?.pluginId
        !== 'happier.agent.claude'
      || bundledMultimodeAccount.descriptorBefore.service?.localId
        !== 'claude-subscription'
      || bundledMultimodeAccount.descriptorBefore.descriptor?.id
        !== 'claude-subscription'
      || bundledMultimodeAccount.descriptorBefore.descriptor?.authentication
        ?.defaultModeId !== 'setup-token'
      || bundledModes.length !== 2
      || bundledSetupTokenMode?.kind !== 'manual'
      || bundledSetupTokenMode.outcomeReconciliation !== 'none'
      || bundledSetupTokenMode.fields?.length !== 1
      || bundledSetupTokenMode.fields[0]?.id !== 'token'
      || bundledSetupTokenMode.fields[0]?.secret !== true
      || bundledOAuthMode?.kind !== 'oauthAuthorizationCode'
      || bundledOAuthMode.pkce !== 'required'
      || bundledOAuthMode.outcomeReconciliation !== 'none'
      || bundledMultimodeAccount?.beginSetupToken?.status !== 'awaitingManual'
      || bundledMultimodeAccount?.connected?.status !== 'connected'
      || bundledAccount?.service?.pluginId !== 'happier.agent.claude'
      || bundledAccount.service?.localId !== 'claude-subscription'
      || bundledMultimodeAccount?.credentialAfterConnect
        ?.authenticationModeId !== 'setup-token'
      || bundledMultimodeAccount.credentialAfterConnect.content?.t
        !== 'encrypted'
      || bundledMultimodeAccount.credentialAfterConnect.metadata
        ?.displayName !== 'Claude setup token'
      || bundledMultimodeAccount?.profileAfterConnect?.status !== 'connected'
      || bundledMultimodeAccount.profileAfterConnect.authenticationModeId
        !== 'setup-token'
      || bundledMultimodeAccount.profileAfterConnect.credentialRevision
        !== bundledMultimodeAccount.credentialAfterConnect.credentialRevision
      || bundledMultimodeAccount?.beginReconnect?.status !== 'awaitingManual'
      || bundledMultimodeAccount?.reconnected?.status !== 'connected'
      || bundledMultimodeAccount.reconnected.account?.accountId
        !== bundledAccount.accountId
      || bundledMultimodeAccount?.credentialAfterReconnect
        ?.authenticationModeId !== 'setup-token'
      || bundledMultimodeAccount.credentialAfterReconnect.content?.t
        !== 'encrypted'
      || bundledMultimodeAccount.credentialAfterReconnect.credentialRevision
        === bundledMultimodeAccount.credentialAfterConnect.credentialRevision
      || bundledMultimodeAccount.credentialAfterReconnect.configurationRevision
        !== bundledMultimodeAccount.credentialAfterConnect.configurationRevision
      || bundledMultimodeAccount?.profileAfterReconnect?.status !== 'connected'
      || bundledMultimodeAccount.profileAfterReconnect.credentialRevision
        !== bundledMultimodeAccount.credentialAfterReconnect.credentialRevision
      || bundledMultimodeAccount?.descriptorAfterReconnect?.status
        !== 'described'
      || bundledMultimodeAccount.descriptorAfterReconnect.generation
        !== bundledMultimodeAccount.descriptorBefore.generation
      || bundledMultimodeAccount.descriptorAfterReconnect
        .immutableGenerationId
        !== bundledMultimodeAccount.descriptorBefore.immutableGenerationId
      || bundledMultimodeAccount.descriptorAfterReconnect.accounts
        ?.find(({ ref }) => ref.accountId === bundledAccount.accountId)
        ?.credentialRevision
        !== bundledMultimodeAccount.credentialAfterReconnect.credentialRevision
      || bundledMultimodeAccount?.beginOAuth?.status !== 'awaitingOAuth'
      || bundledOAuthAuthorizationUrl?.origin !== 'https://platform.claude.com'
      || bundledOAuthAuthorizationUrl.pathname !== '/oauth/authorize'
      || bundledOAuthAuthorizationUrl.searchParams.get('response_type')
        !== 'code'
      || !bundledOAuthAuthorizationUrl.searchParams.get('client_id')
      || !bundledOAuthAuthorizationUrl.searchParams.get('code_challenge')
      || bundledOAuthAuthorizationUrl.searchParams.get('code_challenge_method')
        !== 'S256'
      || !bundledOAuthAuthorizationUrl.searchParams.get('state')
      || bundledMultimodeAccount?.cancelOAuth?.status !== 'cancelled'
    ) {
      fail('Packed bundled Claude multi-mode lifecycle did not reach current daemon and durable V4 owners');
    }
    const bundledMaterializationEnvelope = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'builtin-claude-materialize' },
    });
    const bundledMaterialization =
      assertPackedBundledClaudeMaterialization({
        envelope: bundledMaterializationEnvelope,
      });
    const bundledCleanup = await options.probeConnectedAccounts({
      phase: 'builtinMultimodeCleanup',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
      service: Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }),
      builtinAccountId: bundledAccount.accountId,
      configuredOrigin: connectedAccountProvider.origin,
      staleConfiguredOrigin: staleConnectedAccountProvider.origin,
    });
    if (
      bundledCleanup?.credentialBeforeRevoke?.credentialRevision
        !== bundledMultimodeAccount.credentialAfterReconnect.credentialRevision
      || bundledCleanup?.revoked?.status !== 'revoked'
      || bundledCleanup.revoked.remoteStatus !== 'remoteUnsupported'
      || bundledCleanup?.credentialAfterRevoke !== null
      || bundledCleanup?.accountAfterRevoke !== null
    ) {
      const cleanupSummary = summarizeBundledClaudeCleanupFailure({
        expectedCredentialRevision:
          bundledMultimodeAccount.credentialAfterReconnect.credentialRevision,
        cleanup: bundledCleanup,
      });
      fail(
        'Packed bundled Claude local revoke did not retire durable account state: '
        + JSON.stringify(cleanupSummary),
      );
    }
    stages.push({
      id: 'packed-builtin-multimode-connected-account',
      ok: true,
      service: bundledMultimodeAccount.descriptorBefore.service,
      generation: bundledMultimodeAccount.descriptorBefore.generation,
      immutableGenerationId:
        bundledMultimodeAccount.descriptorBefore.immutableGenerationId,
      modes: bundledModes.map(({ id, kind }) => ({ id, kind })),
      accountId: bundledAccount.accountId,
      credentialRevision: {
        connected:
          bundledMultimodeAccount.credentialAfterConnect.credentialRevision,
        reconnected:
          bundledMultimodeAccount.credentialAfterReconnect.credentialRevision,
      },
      configurationRevision:
        bundledMultimodeAccount.credentialAfterReconnect.configurationRevision,
      status: bundledMultimodeAccount.profileAfterReconnect.status,
      oauth: {
        status: bundledMultimodeAccount.beginOAuth.status,
        origin: bundledOAuthAuthorizationUrl.origin,
        pkceMethod:
          bundledOAuthAuthorizationUrl.searchParams
            .get('code_challenge_method'),
        cancellation: bundledMultimodeAccount.cancelOAuth.status,
      },
      materialization: {
        kind: bundledMaterialization.materializationKind,
        credentialVerified: bundledMaterialization.credentialVerified,
      },
      cleanup: {
        status: bundledCleanup.revoked.status,
        remoteStatus: bundledCleanup.revoked.remoteStatus,
        durableCredentialPresent: false,
        durableProfilePresent: false,
      },
      daemonPid: initialDaemonPid,
    });

    const notificationConfiguration = await options.probeNotifications({
      phase: 'configure',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const notificationSuccess = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'notification-send', clientRequestId: 'packed-notification-success' },
    });
    await options.probeNotifications({
      phase: 'credential-invalid',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const notificationFailure = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'notification-send', clientRequestId: 'packed-notification-failure' },
    });
    await options.probeNotifications({
      phase: 'credential-valid',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const notificationReplay = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'notification-send', clientRequestId: 'packed-notification-failure' },
    });
    const notificationRecovery = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'notification-send', clientRequestId: 'packed-notification-recovery' },
    });
    const waitForNotificationPreferences = async (enabled) => {
      const startedAt = Date.now();
      let latest = null;
      while (Date.now() - startedAt < 20_000) {
        latest = await runPackedPluginRoundtrip({
          cliEntrypoint,
          cwd: fixtureRoot,
          env: childEnv,
          pluginId: plugin.pluginId,
          input: { operation: 'notification-preferences' },
        });
        if (latest.data?.result?.notification?.enabled === enabled) return latest;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      fail(`Timed out waiting for packed notification preferences enabled=${String(enabled)}: ${JSON.stringify(latest)}`);
    };
    await options.probeNotifications({
      phase: 'policy-disabled',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const notificationSuppressedPreferences = await waitForNotificationPreferences(false);
    const notificationSuppressed = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
      input: { operation: 'notification-send', clientRequestId: 'packed-notification-suppressed' },
    });
    await options.probeNotifications({
      phase: 'policy-enabled',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const notificationRestoredPreferences = await waitForNotificationPreferences(true);
    const waitForNotificationEventDeliveries = async () => {
      const startedAt = Date.now();
      let latest = [];
      while (Date.now() - startedAt < 20_000) {
        latest = (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER)).filter((event) => (
          event.kind === 'event-subscription'
          && event.version === '1.0.0'
          && event.activationInstanceId === initialActivationInstanceId
        ));
        if (latest.length === 5) return latest.length;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      fail(`Timed out waiting for packed event subscription deliveries: ${String(latest.length)}`);
    };
    const eventSubscriptionDeliveries = await waitForNotificationEventDeliveries();
    const pendingNotificationEvidence = {
      pluginId: plugin.pluginId,
      configuration: notificationConfiguration,
      success: notificationSuccess,
      failure: notificationFailure,
      replay: notificationReplay,
      recovery: notificationRecovery,
      suppressedPreferences: notificationSuppressedPreferences,
      suppressed: notificationSuppressed,
      restoredPreferences: notificationRestoredPreferences,
      eventSubscriptionDeliveries,
    };

    const packedScmBackendId = `${plugin.pluginId}/stacked`;
    const packedScmHostingProviderId = `${plugin.pluginId}/forge`;
    const installedScmProbe = await options.probeScm({
      phase: 'installed',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      cwd: fixtureRoot,
      pluginId: plugin.pluginId,
      backendId: packedScmBackendId,
      hostingProviderId: packedScmHostingProviderId,
    });
    const installedScmEvidence = assertVerticalAScmInstalledProbe({
      probe: installedScmProbe,
      backendId: packedScmBackendId,
      hostingProviderId: packedScmHostingProviderId,
    });
    const scmMarkerKinds = new Set(
      (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
        .filter((event) => (
          event.version === '1.0.0'
          && event.activationInstanceId === initialActivationInstanceId
        ))
        .map((event) => event.kind),
    );
    const missingScmMarkerKinds = [
      'scm-detect',
      'scm-status',
      'scm-repository',
      'scm-provider-detect',
      'scm-auth',
      'scm-auth-account-b',
    ].filter((kind) => !scmMarkerKinds.has(kind));
    if (missingScmMarkerKinds.length > 0) {
      fail(`Packed SCM runtime probe missed plugin-owned operations: ${missingScmMarkerKinds.join(', ')}`);
    }
    if (scmMarkerKinds.has('scm-auth-wrong-account')) {
      fail('Packed no-profile SCM authentication did not materialize the durable group current member');
    }
    stages.push({
      id: 'packed-scm-runtime-auth-projection',
      ok: true,
      ...installedScmEvidence,
      daemonPid: initialDaemonPid,
      activationInstanceId: initialActivationInstanceId,
      pluginRuntimeMarkers: [...scmMarkerKinds].filter((kind) => kind.startsWith('scm-')).sort(),
      durablePurposeMaterialization: {
        consumer: { pluginId: plugin.pluginId, localId: 'forge' },
        purpose: 'authentication',
        target: { kind: 'group', groupId: 'packed-fallback' },
        currentAccountId: 'account-b',
        reconnectedNonCurrentAccountId: 'account-a',
        explicitProfile: false,
      },
    });
    const packedExternalAgentId = 'packed-external-agent';
    const packedExternalSource = Object.freeze({ kind: 'packedExternal', scope: 'default' });
    const installedExternalSessions = await options.probeExternalSessions({
      phase: 'installed',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      agentId: packedExternalAgentId,
      source: packedExternalSource,
    });
    if (
      installedExternalSessions?.candidates?.ok !== true
      || installedExternalSessions.candidates.candidates?.[0]?.remoteSessionId !== 'packed-session-0'
      || typeof installedExternalSessions.candidates.nextCursor !== 'string'
      || installedExternalSessions?.link?.ok !== true
      || typeof installedExternalSessions.link.sessionId !== 'string'
      || installedExternalSessions?.status?.ok !== true
      || installedExternalSessions.status.externalAgent?.status !== 'idle'
      || installedExternalSessions?.page?.ok !== true
      || installedExternalSessions.page.items?.[0]?.id !== 'packed-page-1.0.0'
      || typeof installedExternalSessions.page.tailCursor !== 'string'
      || installedExternalSessions?.readAfter?.ok !== true
      || installedExternalSessions.readAfter.items?.[0]?.id !== 'packed-read-after-1.0.0'
      || installedExternalSessions?.hookPreview?.ok !== true
      || installedExternalSessions.hookPreview.rows?.[0]?.status?.state !== 'not_installed'
      || installedExternalSessions?.hookInstall?.ok !== true
      || installedExternalSessions.hookInstall.status?.state !== 'installed_enabled'
      || typeof installedExternalSessions.hookInstall.status.installationId !== 'string'
      || installedExternalSessions?.hooksAfterInstall?.ok !== true
      || installedExternalSessions.hooksAfterInstall.rows?.[0]?.status?.state !== 'installed_enabled'
      || installedExternalSessions.hooksAfterInstall.rows[0].status.installationId
        !== installedExternalSessions.hookInstall.status.installationId
      || !Array.isArray(installedExternalSessions?.hookConfig?.hooks?.SessionStart)
      || installedExternalSessions.hookConfig.hooks.SessionStart.length !== 1
    ) {
      fail(`Packed External Sessions and hook-installation routes did not traverse their canonical owners: ${JSON.stringify(installedExternalSessions)}`);
    }
    const initialPackedCandidateCursor = installedExternalSessions.candidates.nextCursor;
    const initialPackedTailCursor = installedExternalSessions.page.tailCursor;
    const initialPackedSessionId = installedExternalSessions.link.sessionId;
    const initialPackedHookInstallationId =
      installedExternalSessions.hookInstall.status.installationId;
    const packedExternalSessionMarkerKinds = new Set(
      (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
        .filter((event) => (
          event.version === '1.0.0'
          && event.activationInstanceId === initialActivationInstanceId
        ))
        .map((event) => event.kind),
    );
    const missingPackedExternalSessionMarkerKinds = [
      'external-resolve-source',
      'external-list',
      'external-link',
      'external-resolve-linked',
      'external-page',
      'external-read-after',
      'external-hook-resolve',
    ].filter((kind) => !packedExternalSessionMarkerKinds.has(kind));
    if (missingPackedExternalSessionMarkerKinds.length > 0) {
      fail(`Packed External Sessions route missed plugin-owned methods: ${missingPackedExternalSessionMarkerKinds.join(', ')}`);
    }
    if (packedExternalSessionMarkerKinds.has('external-hook-map')) {
      fail('Passive packed hook installation invoked mapHookEvent without an ingress event');
    }

    const healthyControlFixture = await installVerticalAHealthyControlFixture({
      plugin: privatePlugin,
      sdkRegistryOrigin: registry.origin,
      installPlugin: runReviewedInstall,
    });
    const initialHealthyControlGeneration = healthyControlFixture.desiredGeneration;
    const initialCommit = await readCurrentCommit();
    if (
      initialCommit.t !== 'happier_plugin_registry_commit_v1'
      || !Number.isInteger(initialCommit.revision)
      || initialCommit.pluginGenerations?.[plugin.pluginId]?.immutableGenerationId !== desiredGeneration
    ) {
      fail(`Initial current commit does not name the applied generation: ${JSON.stringify(initialCommit)}`);
    }

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '1.1.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const takeoverCandidateArtifact = await replacePackedArchive('takeover-pending-v1.1');
    const oldDaemonState = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    if (oldDaemonState.pid !== initialDaemonPid) {
      fail(`Daemon state PID did not match the applied plugin runtime owner before takeover: ${JSON.stringify({
        statePid: oldDaemonState.pid,
        runtimePid: initialDaemonPid,
      })}`);
    }
    const pendingTakeoverChange = await postPackedDaemonControl(
      oldDaemonState,
      '/plugins/change/request',
      { kind: 'installArchive', locator: archivePath },
    );
    if (
      pendingTakeoverChange?.kind !== 'reviewRequired'
      || typeof pendingTakeoverChange.pendingChangeId !== 'string'
      || pendingTakeoverChange.review?.pluginId !== plugin.pluginId
      || pendingTakeoverChange.review?.version !== '1.1.0'
    ) {
      fail(`Old daemon did not own the reviewed takeover candidate: ${JSON.stringify(pendingTakeoverChange)}`);
    }
    const commitWithPendingChange = await readCurrentCommit();
    const installedWithPendingChange = await readInstalledPlugin(plugin.pluginId);
    assertReviewedCandidatePreservedCurrentness({
      initialCommit,
      currentCommit: commitWithPendingChange,
      pluginId: plugin.pluginId,
      desiredGeneration,
      installedPlugin: installedWithPendingChange,
    });
    const pendingVersionEvents = (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
      .filter((event) => event.version === '1.1.0');
    if (pendingVersionEvents.length !== 0) {
      fail(`Reviewed takeover candidate executed before approval: ${JSON.stringify(pendingVersionEvents)}`);
    }

    const restartResult = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: buildVerticalADaemonRestartArgs(),
    });
    assertCommandSucceeded(restartResult, 'Packed daemon restart');
    const restartEnvelope = parseJsonEnvelope(restartResult.stdout, 'daemon_restart');
    if (restartEnvelope?.ok !== true || restartEnvelope?.status !== 'restarted') {
      fail(`Packed daemon restart did not report a stable replacement: ${JSON.stringify(restartEnvelope)}`);
    }
    const restartAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(restartAction, { pluginId: plugin.pluginId, version: '1.0.0', value: plugin.value });
    const restartMarkerEvents = await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER);
    const restartedRegistration = findLatestMarkerEvent(restartMarkerEvents, 'registered', '1.0.0');
    if (
      !restartedRegistration
      || restartedRegistration.pid === initialDaemonPid
      || restartAction.data?.result?.pid !== restartedRegistration.pid
      || restartAction.data?.result?.activationInstanceId !== restartedRegistration.activationInstanceId
    ) {
      fail(`Restart did not reactivate and serve the applied generation from a new daemon: ${JSON.stringify(restartMarkerEvents)}`);
    }
    const restartedHealthyPeerRegistration = findLatestMarkerEvent(
      restartMarkerEvents,
      'registered',
      '11.0.0',
    );
    const restartedHealthyPeerRegistrationCount = restartMarkerEvents.filter((event) => (
      event.kind === 'registered' && event.version === '11.0.0'
    )).length;
    const restartedHealthyPeerAction = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: privatePlugin.pluginId,
    });
    assertRoundtrip(restartedHealthyPeerAction, {
      pluginId: privatePlugin.pluginId,
      version: '11.0.0',
      value: privatePlugin.value,
    });
    if (
      !restartedHealthyPeerRegistration
      || restartedHealthyPeerAction.data?.result?.pid !== restartedHealthyPeerRegistration.pid
      || restartedHealthyPeerAction.data?.result?.activationInstanceId
        !== restartedHealthyPeerRegistration.activationInstanceId
    ) {
      fail(`Restarted healthy peer was not served by its adopted activation: ${JSON.stringify({
        registration: restartedHealthyPeerRegistration,
        invocation: restartedHealthyPeerAction.data?.result,
      })}`);
    }
    const restartCommit = await readCurrentCommit();
    assertRestartPreservedDesiredGeneration({
      initialCommit,
      restartCommit,
      pluginId: plugin.pluginId,
      desiredGeneration,
    });
    const newDaemonState = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    if (
      newDaemonState.pid !== restartedRegistration.pid
      || newDaemonState.pid === oldDaemonState.pid
      || isProcessAlive(oldDaemonState.pid)
    ) {
      fail(`Takeover did not retire the stale daemon process: ${JSON.stringify({
        oldPid: oldDaemonState.pid,
        newPid: newDaemonState.pid,
        servingPid: restartedRegistration.pid,
        oldAlive: isProcessAlive(oldDaemonState.pid),
      })}`);
    }
    let staleEndpointOutcome = 'unexpected-response';
    try {
      await postPackedDaemonControl(oldDaemonState, '/plugins/change/decide', {
        pendingChangeId: pendingTakeoverChange.pendingChangeId,
        decision: 'cancel',
      });
    } catch (error) {
      staleEndpointOutcome = classifyRetiredDaemonControlFailure(error);
    }
    if (staleEndpointOutcome === 'unexpected-response') {
      fail('Stale daemon control endpoint accepted a plugin decision after takeover');
    }
    const successorPendingOutcome = await postPackedDaemonControl(newDaemonState, '/plugins/change/decide', {
      pendingChangeId: pendingTakeoverChange.pendingChangeId,
      decision: 'cancel',
    });
    if (successorPendingOutcome?.kind !== 'expired') {
      fail(`Successor daemon adopted stale pending state: ${JSON.stringify(successorPendingOutcome)}`);
    }
    const commitAfterStaleDecision = await readCurrentCommit();
    assertRestartPreservedDesiredGeneration({
      initialCommit,
      restartCommit: commitAfterStaleDecision,
      pluginId: plugin.pluginId,
      desiredGeneration,
    });
    const servingDaemonPid = restartedRegistration.pid;
    stages.push({
      id: 'takeover-stale-incarnation-fenced',
      ok: true,
      candidate: takeoverCandidateArtifact,
      cli: {
        packageName: candidate.cli.packageName,
        version: candidate.cli.version,
        integrity: candidate.cli.integrity,
      },
      oldDaemon: {
        pid: oldDaemonState.pid,
        startedAt: oldDaemonState.startedAt ?? oldDaemonState.startTime ?? null,
        runtimeId: oldDaemonState.runtimeId ?? null,
        startedWithCliVersion: oldDaemonState.startedWithCliVersion ?? null,
        statePath: relative(childEnv.HAPPIER_HOME_DIR, oldDaemonState.statePath),
        controlAfterTakeover: staleEndpointOutcome,
      },
      newDaemon: {
        pid: newDaemonState.pid,
        startedAt: newDaemonState.startedAt ?? newDaemonState.startTime ?? null,
        runtimeId: newDaemonState.runtimeId ?? null,
        startedWithCliVersion: newDaemonState.startedWithCliVersion ?? null,
        statePath: relative(childEnv.HAPPIER_HOME_DIR, newDaemonState.statePath),
        stalePendingDecision: successorPendingOutcome.kind,
      },
      pluginRuntime: {
        pluginId: plugin.pluginId,
        desiredGeneration,
        appliedGeneration: desiredGeneration,
        revision: commitAfterStaleDecision.revision,
        rejectedCandidateVersion: '1.1.0',
        servingVersion: '1.0.0',
        servingPid: restartedRegistration.pid,
        activationInstanceId: restartedRegistration.activationInstanceId,
      },
    });
    stages.push({
      id: 'restart-applied-generation',
      ok: true,
      desiredGeneration,
      appliedGeneration: desiredGeneration,
      previousRevision: initialCommit.revision,
      revision: restartCommit.revision,
      previousDaemonPid: initialDaemonPid,
      daemonPid: servingDaemonPid,
      activationInstanceId: restartedRegistration.activationInstanceId,
      version: '1.0.0',
    });
    const restartedConnectedAccount = await options.probeConnectedAccounts({
      phase: 'restarted',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
      service: Object.freeze({
        pluginId: plugin.pluginId,
        localId: 'novel-cloud',
      }),
      configuredOrigin: connectedAccountProvider.origin,
      staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      oauthAttemptId: installedConnectedAccount.beginOAuth.attemptId,
      oauthCallbackUrl: installedConnectedAccount.beginOAuth.callbackUrl,
      oauthState: installedConnectedAccount.oauthState,
      deviceAttemptId: installedConnectedAccount.continueDevice.attemptId,
    });
    const restartedConnectedAccountProviderRequests =
      connectedAccountProvider.getRequests()
        .filter((request) => (
          decodeURIComponent(request.pathname) === `/${SDK_PACKAGE_NAME}`
        ));
    const restartedStaleConnectedAccountProviderRequests =
      staleConnectedAccountProvider.getRequests()
        .filter((request) => (
          decodeURIComponent(request.pathname) === `/${SDK_PACKAGE_NAME}`
        ));
    const providerReconciliationMarkers =
      (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
        .filter((event) => (
          event.kind === 'connected-account-reconcile'
          && event.version === '1.0.0'
          && event.activationInstanceId
            === restartedRegistration.activationInstanceId
          && event.pid === restartedRegistration.pid
        ));
    if (
      restartedConnectedAccount?.qualifiedAccountsCapability?.protocolVersion !== 4
      || restartedConnectedAccount?.completeOAuth?.status !== 'outcomeUnknown'
      || restartedConnectedAccount?.reconcileOAuth?.status !== 'connected'
      || restartedConnectedAccount.reconcileOAuth.account?.service?.pluginId
        !== plugin.pluginId
      || restartedConnectedAccount.reconcileOAuth.account?.service?.localId
        !== 'novel-cloud'
      || restartedConnectedAccount.reconcileOAuth.account?.accountId
        !== 'oauth-account'
      || restartedConnectedAccount?.resumeDevice?.status
        !== 'awaitingDeviceAuthorization'
      || restartedConnectedAccount.resumeDevice.attemptId
        !== installedConnectedAccount.continueDevice.attemptId
      || restartedConnectedAccount?.deviceFinal?.status !== 'connected'
      || restartedConnectedAccount.deviceFinal.account?.service?.pluginId
        !== plugin.pluginId
      || restartedConnectedAccount.deviceFinal.account?.service?.localId
        !== 'novel-cloud'
      || restartedConnectedAccount.deviceFinal.account?.accountId
        !== 'device-account'
      || restartedConnectedAccount?.deviceAccountConfiguration?.status
        !== 'configuration'
      || restartedConnectedAccount.deviceAccountConfiguration.configuration?.status
        !== 'ready'
      || typeof restartedConnectedAccount.deviceAccountConfiguration.configuration?.revision
        !== 'string'
      || restartedConnectedAccount.deviceAccountConfiguration.configuration.values?.['api-origin']
        !== connectedAccountProvider.origin
      || restartedConnectedAccount.deviceAccountConfiguration.configuration.values?.workspace
        !== 'packed-workspace'
      || restartedConnectedAccountProviderRequests.length !== 9
      || restartedConnectedAccountProviderRequests.some(
        (request) => request.authorization !== null,
      )
      || restartedStaleConnectedAccountProviderRequests.length !== 0
      || providerReconciliationMarkers.length !== 1
    ) {
      fail(`Packed OAuth/device attempts did not survive daemon restart through the exact generation/configuration owner: ${JSON.stringify({
        restartedConnectedAccount,
        configuredRequests: restartedConnectedAccountProviderRequests,
        staleRequests: restartedStaleConnectedAccountProviderRequests,
        providerReconciliationMarkers,
      })}`);
    }
    stages.push({
      id: 'packed-connected-account-restart-durability',
      ok: true,
      daemonPid: restartedRegistration.pid,
      activationInstanceId: restartedRegistration.activationInstanceId,
      oauth: {
        attemptId: installedConnectedAccount.beginOAuth.attemptId,
        outcome: restartedConnectedAccount.completeOAuth.status,
        reconciliation: restartedConnectedAccount.reconcileOAuth.status,
        accountId: restartedConnectedAccount.reconcileOAuth.account.accountId,
        reconciliationDeliveries: providerReconciliationMarkers.length,
      },
      device: {
        attemptId: installedConnectedAccount.continueDevice.attemptId,
        resumeStatus: restartedConnectedAccount.resumeDevice.status,
        polls: restartedConnectedAccount.devicePolls.length,
        status: restartedConnectedAccount.deviceFinal.status,
        accountId: restartedConnectedAccount.deviceFinal.account.accountId,
        configurationRevision:
          restartedConnectedAccount.deviceAccountConfiguration.configuration.revision,
      },
      providerFetches: restartedConnectedAccountProviderRequests.length,
      providerOrigin: connectedAccountProvider.origin,
      staleProviderFetches:
        restartedStaleConnectedAccountProviderRequests.length,
      staleProviderOrigin: staleConnectedAccountProvider.origin,
    });
    const establishedMarkerKinds = Object.freeze([
      'connected-account-status',
      'connected-account-refresh',
      'connected-account-quota',
      'connected-account-revoke',
    ]);
    const countCurrentEstablishedMarkers = async () => {
      const events = await readVerticalAMarkerEvents(markerPath);
      return Object.fromEntries(establishedMarkerKinds.map((kind) => [
        kind,
        events.filter((event) => (
          event.kind === kind
          && event.version === '1.0.0'
          && event.activationInstanceId
            === restartedRegistration.activationInstanceId
          && event.pid === restartedRegistration.pid
        )).length,
      ]));
    };
    const statusTickCountsAtStart =
      await countCurrentEstablishedMarkers();
    const statusTickSynchronizationStartedAt = Date.now();
    let establishedMarkerCountsBefore = statusTickCountsAtStart;
    while (
      establishedMarkerCountsBefore['connected-account-status']
        <= statusTickCountsAtStart['connected-account-status']
    ) {
      if (Date.now() - statusTickSynchronizationStartedAt >= 15_000) {
        fail(`Packed established operations did not observe a current status scheduler tick: ${JSON.stringify({
          before: statusTickCountsAtStart,
          latest: establishedMarkerCountsBefore,
          activationInstanceId: restartedRegistration.activationInstanceId,
          pid: restartedRegistration.pid,
        })}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      establishedMarkerCountsBefore =
        await countCurrentEstablishedMarkers();
    }
    let statusTickQuiescentAt = Date.now();
    while (Date.now() - statusTickQuiescentAt < 250) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      const latestCounts = await countCurrentEstablishedMarkers();
      const statusCountChanged =
        latestCounts['connected-account-status']
          !== establishedMarkerCountsBefore['connected-account-status'];
      establishedMarkerCountsBefore = latestCounts;
      if (
        statusCountChanged
      ) {
        statusTickQuiescentAt = Date.now();
      }
    }
    const establishedConnectedAccount =
      await options.probeConnectedAccounts({
        phase: 'establishedOperations',
        happyHomeDir: childEnv.HAPPIER_HOME_DIR,
        pluginId: plugin.pluginId,
        service: Object.freeze({
          pluginId: plugin.pluginId,
          localId: 'novel-cloud',
        }),
        configuredOrigin: connectedAccountProvider.origin,
        staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      });
    const statusLifecycle =
      establishedConnectedAccount?.statusLifecycle;
    const refreshLifecycle =
      establishedConnectedAccount?.refreshLifecycle;
    const quotaLifecycle =
      establishedConnectedAccount?.quotaLifecycle;
    const revokeLifecycle =
      establishedConnectedAccount?.revokeLifecycle;
    const bundledServiceDescriptions =
      establishedConnectedAccount?.bundledServiceDescriptions;
    const githubDescription =
      bundledServiceDescriptions?.githubDescription;
    const bitbucketDescription =
      bundledServiceDescriptions?.bitbucketDescription;
    const githubAuthenticationMode =
      githubDescription?.descriptor?.authentication?.modes
        ?.find((mode) => mode.id === 'fine-grained-pat');
    const bitbucketAuthenticationMode =
      bitbucketDescription?.descriptor?.authentication?.modes
        ?.find((mode) => mode.id === 'manual');
    const initialQuotaRequestsMeter =
      quotaLifecycle?.initialQuotaUsage?.meters
        ?.find((meter) => meter.meterId === 'requests');
    const quotaRequestsMeter = quotaLifecycle?.quotaUsage?.meters
      ?.find((meter) => meter.meterId === 'requests');
    const groupBeforeRevoke = revokeLifecycle?.groupBeforeRevoke?.group;
    const groupAfterRevoke = revokeLifecycle?.groupAfterRevoke?.group;
    if (
      githubDescription?.status !== 'described'
      || githubDescription.service?.pluginId
        !== 'happier.scm.hosting.github'
      || githubDescription.service.localId !== 'github-account'
      || githubDescription.descriptor?.id !== 'github-account'
      || githubDescription.descriptor.authentication.defaultModeId
        !== 'fine-grained-pat'
      || githubDescription.descriptor.authentication.modes?.length !== 1
      || githubAuthenticationMode?.kind !== 'manual'
      || JSON.stringify(
        githubAuthenticationMode.fields?.map((field) => [
          field.id,
          field.secret === true,
        ]),
      ) !== JSON.stringify([['token', true]])
      || JSON.stringify(githubDescription.descriptor.capabilities)
        !== JSON.stringify(['scmHostingToken'])
      || bitbucketDescription?.status !== 'described'
      || bitbucketDescription.service?.pluginId
        !== 'happier.scm.hosting.bitbucket'
      || bitbucketDescription.service.localId !== 'bitbucket-account'
      || bitbucketDescription.descriptor?.id !== 'bitbucket-account'
      || bitbucketDescription.descriptor.authentication.defaultModeId
        !== 'manual'
      || bitbucketDescription.descriptor.authentication.modes?.length !== 1
      || bitbucketAuthenticationMode?.kind !== 'manual'
      || JSON.stringify(
        bitbucketAuthenticationMode.fields?.map((field) => [
          field.id,
          field.secret === true,
        ]),
      ) !== JSON.stringify([
        ['identity', false],
        ['token', true],
      ])
      || JSON.stringify(bitbucketDescription.descriptor.capabilities)
        !== JSON.stringify(['scmHostingBasicAuth'])
      || githubDescription.generation
        !== refreshLifecycle?.deviceConfigurationBefore?.generation
      || bitbucketDescription.generation
        !== refreshLifecycle?.deviceConfigurationBefore?.generation
      || typeof githubDescription.immutableGenerationId !== 'string'
      || githubDescription.immutableGenerationId.length === 0
      || typeof bitbucketDescription.immutableGenerationId !== 'string'
      || bitbucketDescription.immutableGenerationId.length === 0
      || githubDescription.immutableGenerationId
        === bitbucketDescription.immutableGenerationId
      || githubDescription.immutableGenerationId
        === refreshLifecycle?.deviceConfigurationBefore
          ?.immutableGenerationId
      || bitbucketDescription.immutableGenerationId
        === refreshLifecycle?.deviceConfigurationBefore
          ?.immutableGenerationId
      || statusLifecycle?.healthMutation?.success !== true
      || statusLifecycle.healthMutation.credentialRevision
        !== statusLifecycle.accountACredentialBefore?.credentialRevision
      || statusLifecycle.healthMutation.configurationRevision
        !== statusLifecycle.accountACredentialBefore
          ?.configurationRevision
      || statusLifecycle?.accountAImmediatelyAfterHealth?.status
        !== 'needs_reauth'
      || statusLifecycle.accountAImmediatelyAfterHealth.credentialRevision
        !== statusLifecycle.accountACredentialBefore?.credentialRevision
      || statusLifecycle.accountAImmediatelyAfterHealth.configurationRevision
        !== statusLifecycle.accountACredentialBefore
          ?.configurationRevision
      || statusLifecycle?.accountAAfterScheduledStatus?.status
        !== 'connected'
      || statusLifecycle.accountAAfterScheduledStatus.credentialRevision
        !== statusLifecycle.accountACredentialBefore?.credentialRevision
      || statusLifecycle.accountAAfterScheduledStatus.configurationRevision
        !== statusLifecycle.accountACredentialBefore
          ?.configurationRevision
      || statusLifecycle.accountACredentialAfterScheduledStatus
        ?.credentialRevision
        !== statusLifecycle.accountACredentialBefore?.credentialRevision
      || statusLifecycle.accountACredentialAfterScheduledStatus
        ?.configurationRevision
        !== statusLifecycle.accountACredentialBefore
          ?.configurationRevision
      || refreshLifecycle?.deviceConfigurationBefore?.status
        !== 'configuration'
      || refreshLifecycle.deviceConfigurationBefore.configuration?.values
        ?.['api-origin'] !== connectedAccountProvider.origin
      || refreshLifecycle.deviceConfigurationBefore.configuration?.values
        ?.workspace !== 'packed-workspace'
      || JSON.stringify(
        refreshLifecycle.deviceConfigurationBefore.configuration
          ?.configuredSecretFieldIds,
      ) !== JSON.stringify(['account-secret'])
      || refreshLifecycle.deviceRefresh?.status
        !== 'configurationCommitted'
      || typeof refreshLifecycle.deviceCredentialBefore?.credentialRevision
        !== 'string'
      || refreshLifecycle.deviceCredentialBefore.configurationRevision
        !== refreshLifecycle.deviceConfigurationBefore.configuration
          .revision
      || refreshLifecycle.deviceCredentialAfter?.credentialRevision
        === refreshLifecycle.deviceCredentialBefore.credentialRevision
      || typeof refreshLifecycle.deviceConfigurationBefore.configuration
        ?.revision !== 'string'
      || refreshLifecycle.deviceRefresh.configuration?.revision
        === refreshLifecycle.deviceConfigurationBefore.configuration.revision
      || refreshLifecycle.deviceRefresh.configuration?.values?.['api-origin']
        !== connectedAccountProvider.origin
      || refreshLifecycle.deviceRefresh.configuration?.values?.workspace
        !== 'packed-workspace-refreshed'
      || JSON.stringify(
        refreshLifecycle.deviceRefresh.configuration
          ?.configuredSecretFieldIds,
      ) !== JSON.stringify(['account-secret'])
      || refreshLifecycle.deviceCredentialAfter?.configurationRevision
        !== refreshLifecycle.deviceRefresh.configuration.revision
      || refreshLifecycle.deviceConfigurationAfter?.status
        !== 'configuration'
      || refreshLifecycle.deviceConfigurationAfter.configuration?.revision
        !== refreshLifecycle.deviceRefresh.configuration.revision
      || refreshLifecycle.deviceConfigurationAfter.configuration?.values
        ?.['api-origin'] !== connectedAccountProvider.origin
      || refreshLifecycle.deviceConfigurationAfter.configuration?.values
        ?.workspace !== 'packed-workspace-refreshed'
      || JSON.stringify(
        refreshLifecycle.deviceConfigurationAfter.configuration
          ?.configuredSecretFieldIds,
      ) !== JSON.stringify(['account-secret'])
      || refreshLifecycle.deviceRefresh.generation
        !== refreshLifecycle.deviceConfigurationBefore.generation
      || refreshLifecycle.deviceRefresh.immutableGenerationId
        !== refreshLifecycle.deviceConfigurationBefore
          .immutableGenerationId
      || refreshLifecycle.deviceConfigurationAfter.generation
        !== refreshLifecycle.deviceConfigurationBefore.generation
      || refreshLifecycle.deviceConfigurationAfter.immutableGenerationId
        !== refreshLifecycle.deviceConfigurationBefore
          .immutableGenerationId
      || refreshLifecycle.deviceCredentialBefore.content?.t !== 'encrypted'
      || refreshLifecycle.deviceCredentialAfter.content?.t !== 'encrypted'
      || quotaLifecycle?.quotaRefreshRequested?.success !== true
      || typeof quotaLifecycle.initialQuota?.metadata?.fetchedAt !== 'number'
      || quotaLifecycle.initialQuota.content?.t !== 'encrypted'
      || quotaLifecycle.initialQuota.ref?.accountId !== 'account-b'
      || quotaLifecycle.initialQuotaUsage?.providerId
        !== 'acme.vertical-a/novel-cloud'
      || initialQuotaRequestsMeter?.remaining !== 42
      || quotaLifecycle.refreshedQuota?.metadata?.fetchedAt
        <= quotaLifecycle.initialQuota.metadata.fetchedAt
      || quotaLifecycle.refreshedQuota.content?.t !== 'encrypted'
      || quotaLifecycle.refreshedQuota.ref?.accountId !== 'account-b'
      || (
        quotaLifecycle.refreshedQuota.metadata.refreshRequestedAt
          !== undefined
        && quotaLifecycle.refreshedQuota.metadata.refreshRequestedAt
          > quotaLifecycle.refreshedQuota.metadata.fetchedAt
      )
      || quotaLifecycle.quotaUsage?.providerId
        !== 'acme.vertical-a/novel-cloud'
      || quotaRequestsMeter?.remaining !== 42
      || revokeLifecycle?.revoked?.status !== 'revoked'
      || revokeLifecycle.revoked.remoteStatus !== 'remoteRevoked'
      || revokeLifecycle.revoked.account?.service?.pluginId
        !== plugin.pluginId
      || revokeLifecycle.revoked.account?.service?.localId !== 'novel-cloud'
      || revokeLifecycle.revoked.account?.accountId !== 'account-a'
      || revokeLifecycle.accountACredentialAfterRevoke !== null
      || revokeLifecycle.accountAQuotaAfterRevoke !== null
      || revokeLifecycle.accountAProfileAfterRevoke !== null
      || revokeLifecycle.accountBProfileAfterRevoke?.status !== 'connected'
      || !groupBeforeRevoke
      || !groupAfterRevoke
      || groupBeforeRevoke.members?.length !== 2
      || !groupBeforeRevoke.members.some(
        ({ connectedAccountId }) => connectedAccountId === 'account-a',
      )
      || !groupBeforeRevoke.members.some(
        ({ connectedAccountId }) => connectedAccountId === 'account-b',
      )
      || groupBeforeRevoke.activeConnectedAccountId !== 'account-b'
      || groupAfterRevoke.members?.length !== 1
      || groupAfterRevoke.members[0]?.connectedAccountId !== 'account-b'
      || groupAfterRevoke.activeConnectedAccountId !== 'account-b'
      || groupAfterRevoke.generation !== groupBeforeRevoke.generation + 1
      || groupAfterRevoke.runtimeStateRevision
        !== groupBeforeRevoke.runtimeStateRevision
    ) {
      fail('Packed established Connected Account operations did not persist through canonical owners');
    }
    const establishedMarkerCountsAfter =
      await countCurrentEstablishedMarkers();
    const establishedMarkerDeltas = Object.fromEntries(
      establishedMarkerKinds.map((kind) => [
        kind,
        establishedMarkerCountsAfter[kind]
          - establishedMarkerCountsBefore[kind],
      ]),
    );
    if (establishedMarkerKinds.some(
      (kind) => establishedMarkerDeltas[kind] <= 0,
    )) {
      fail(`Packed established Connected Account runtime leaves did not execute in the current restarted activation: ${JSON.stringify({
        before: establishedMarkerCountsBefore,
        after: establishedMarkerCountsAfter,
        deltas: establishedMarkerDeltas,
        activationInstanceId: restartedRegistration.activationInstanceId,
        pid: restartedRegistration.pid,
      })}`);
    }
    const revokeMarkerCountBeforeDirectDelete =
      establishedMarkerCountsAfter['connected-account-revoke'];
    const directDeleteConnectedAccount =
      await options.probeConnectedAccounts({
        phase: 'directDelete',
        happyHomeDir: childEnv.HAPPIER_HOME_DIR,
        pluginId: plugin.pluginId,
        service: Object.freeze({
          pluginId: plugin.pluginId,
          localId: 'novel-cloud',
        }),
        configuredOrigin: connectedAccountProvider.origin,
        staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      });
    const directDelete =
      directDeleteConnectedAccount?.directDeleteLifecycle;
    const directDeleteGroupBefore = directDelete?.groupBefore?.group;
    const directDeleteGroupAfter = directDelete?.groupAfter?.group;
    const markerCountsAfterDirectDelete =
      await countCurrentEstablishedMarkers();
    if (
      directDelete?.deletion?.success !== true
      || directDelete.accountBProfileBeforeDelete?.status !== 'connected'
      || directDelete.accountBCredentialAfter !== null
      || directDelete.accountBQuotaAfter !== null
      || directDelete.accountBProfileAfterDelete !== null
      || !directDeleteGroupBefore
      || !directDeleteGroupAfter
      || directDeleteGroupAfter.members?.length !== 0
      || directDeleteGroupAfter.activeConnectedAccountId !== null
      || directDeleteGroupAfter.generation
        !== directDeleteGroupBefore.generation + 1
      || directDeleteGroupAfter.runtimeStateRevision
        !== directDeleteGroupBefore.runtimeStateRevision
      || markerCountsAfterDirectDelete['connected-account-revoke']
        !== revokeMarkerCountBeforeDirectDelete
    ) {
      fail('Packed direct V4 Connected Account delete did not remain separate from runtime revoke');
    }
    const connectedAccountDormancyBaseline =
      await options.probeConnectedAccounts({
        phase: 'prepareDormancy',
        happyHomeDir: childEnv.HAPPIER_HOME_DIR,
        pluginId: plugin.pluginId,
        service: Object.freeze({
          pluginId: plugin.pluginId,
          localId: 'novel-cloud',
        }),
        configuredOrigin: connectedAccountProvider.origin,
        staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      });
    if (
      connectedAccountDormancyBaseline?.binding?.purpose
        !== 'packed-novel-account'
      || connectedAccountDormancyBaseline.binding.target?.kind !== 'group'
      || connectedAccountDormancyBaseline.group?.activeConnectedAccountId
        !== 'device-account'
      || connectedAccountDormancyBaseline.account?.accountId
        !== 'device-account'
      || connectedAccountDormancyBaseline.account.credentialPresent !== true
      || connectedAccountDormancyBaseline.account.configurationPresent !== true
    ) {
      fail('Packed Connected Account dormancy baseline was not durable before generation retirement');
    }
    stages.push({
      id: 'packed-connected-account-established-operations',
      ok: true,
      daemonPid: restartedRegistration.pid,
      activationInstanceId: restartedRegistration.activationInstanceId,
      dormancyBaseline: {
        groupId: connectedAccountDormancyBaseline.group.ref.groupId,
        activeAccountId:
          connectedAccountDormancyBaseline.group.activeConnectedAccountId,
        accountId: connectedAccountDormancyBaseline.account.accountId,
      },
      bundledServices: {
        github: {
          generation: githubDescription.generation,
          immutableGenerationId:
            githubDescription.immutableGenerationId,
          defaultModeId:
            githubDescription.descriptor.authentication.defaultModeId,
        },
        bitbucket: {
          generation: bitbucketDescription.generation,
          immutableGenerationId:
            bitbucketDescription.immutableGenerationId,
          defaultModeId:
            bitbucketDescription.descriptor.authentication.defaultModeId,
        },
      },
      status: {
        patched: statusLifecycle.accountAImmediatelyAfterHealth.status,
        settled: statusLifecycle.accountAAfterScheduledStatus.status,
        credentialRevision:
          statusLifecycle.accountACredentialAfterScheduledStatus
            .credentialRevision,
        configurationRevision:
          statusLifecycle.accountACredentialAfterScheduledStatus
            .configurationRevision,
      },
      refresh: {
        credentialRevisionBefore:
          refreshLifecycle.deviceCredentialBefore.credentialRevision,
        credentialRevisionAfter:
          refreshLifecycle.deviceCredentialAfter.credentialRevision,
        configurationRevisionBefore:
          refreshLifecycle.deviceConfigurationBefore.configuration.revision,
        configurationRevisionAfter:
          refreshLifecycle.deviceRefresh.configuration.revision,
      },
      quota: {
        fetchedAtBefore: quotaLifecycle.initialQuota.metadata.fetchedAt,
        fetchedAtAfter: quotaLifecycle.refreshedQuota.metadata.fetchedAt,
        providerId: quotaLifecycle.quotaUsage.providerId,
        requestsRemaining: quotaRequestsMeter.remaining,
      },
      revoke: {
        remoteStatus: revokeLifecycle.revoked.remoteStatus,
        generationBefore: groupBeforeRevoke.generation,
        generationAfter: groupAfterRevoke.generation,
        runtimeStateRevision:
          groupAfterRevoke.runtimeStateRevision,
        remainingGroupMembers: groupAfterRevoke.members.length,
      },
      directDelete: {
        generationBefore: directDeleteGroupBefore.generation,
        generationAfter: directDeleteGroupAfter.generation,
        runtimeStateRevisionBefore:
          directDeleteGroupBefore.runtimeStateRevision,
        runtimeStateRevisionAfter:
          directDeleteGroupAfter.runtimeStateRevision,
      },
      markerCounts: establishedMarkerCountsAfter,
      evidencePairs: {
        status: {
          markerDelta:
            establishedMarkerDeltas['connected-account-status'],
          credentialRevision:
            statusLifecycle.accountACredentialAfterScheduledStatus
              .credentialRevision,
          configurationRevision:
            statusLifecycle.accountACredentialAfterScheduledStatus
              .configurationRevision,
        },
        refresh: {
          markerDelta:
            establishedMarkerDeltas['connected-account-refresh'],
          credentialRevision:
            refreshLifecycle.deviceCredentialAfter.credentialRevision,
          configurationRevision:
            refreshLifecycle.deviceConfigurationAfter.configuration
              .revision,
        },
        quota: {
          markerDelta:
            establishedMarkerDeltas['connected-account-quota'],
          fetchedAt: quotaLifecycle.refreshedQuota.metadata.fetchedAt,
          providerId: quotaLifecycle.quotaUsage.providerId,
        },
        revoke: {
          markerDelta:
            establishedMarkerDeltas['connected-account-revoke'],
          groupGeneration: groupAfterRevoke.generation,
          runtimeStateRevision:
            groupAfterRevoke.runtimeStateRevision,
          credentialAbsent:
            revokeLifecycle.accountACredentialAfterRevoke === null,
        },
      },
    });
    const restartedExternalSessions = await options.probeExternalSessions({
      phase: 'restarted',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      agentId: packedExternalAgentId,
      source: packedExternalSource,
      candidateCursor: initialPackedCandidateCursor,
      tailCursor: initialPackedTailCursor,
      sessionId: initialPackedSessionId,
    });
    if (
      restartedExternalSessions?.candidates?.ok !== true
      || restartedExternalSessions.candidates.candidates?.[0]?.remoteSessionId !== 'packed-session-1'
      || restartedExternalSessions?.link?.ok !== true
      || restartedExternalSessions.link.sessionId !== initialPackedSessionId
      || restartedExternalSessions.link.created !== false
      || restartedExternalSessions?.readAfter?.ok !== true
      || restartedExternalSessions.readAfter.items?.[0]?.id !== 'packed-read-after-1.0.0'
      || restartedExternalSessions?.hookStatus?.ok !== true
      || restartedExternalSessions.hookStatus.rows?.[0]?.status?.state !== 'installed_enabled'
      || restartedExternalSessions.hookStatus.rows[0].status.installationId
        !== initialPackedHookInstallationId
    ) {
      fail(`Packed External Sessions identity/cursors did not survive daemon restart: ${JSON.stringify(restartedExternalSessions)}`);
    }
    const restartedHookResolve = (await readVerticalAMarkerEvents(
      childEnv.HAPPIER_VERTICAL_A_MARKER,
    )).find((event) => (
      event.kind === 'external-hook-resolve'
      && event.version === '1.0.0'
      && event.activationInstanceId
        === restartedRegistration.activationInstanceId
      && event.pid === restartedRegistration.pid
    ));
    if (!restartedHookResolve) {
      fail('Packed hook status did not reach resolveInstallation in the restarted activation');
    }

    const beforeFailedUpdateState = await readCurrentInstallationState();
    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '2.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
      failActivation: true,
    });
    for (const operation of ['typecheck', 'build']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const failedUpdateArtifact = await replacePackedArchive('rejected-v2');
    const failedUpdateEnvelope = await runReviewedInstall([
      'install', 'plugin', 'update', plugin.pluginId, '--json',
    ]);
    if (
      failedUpdateEnvelope.change?.kind !== 'failed'
      || failedUpdateEnvelope.change.code !== 'plugin_install_failed'
    ) {
      fail(`Activation-failing update did not report a structured install failure: ${JSON.stringify(failedUpdateEnvelope)}`);
    }
    const failedUpdateMarkerEvents = (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
      .filter((event) => event.version === '2.0.0');
    if (
      JSON.stringify(failedUpdateMarkerEvents.map((event) => event.kind)) !== JSON.stringify(['module', 'activate'])
      || failedUpdateMarkerEvents.some((event) => event.pid !== servingDaemonPid)
      || new Set(failedUpdateMarkerEvents.map((event) => event.activationInstanceId)).size !== 1
    ) {
      fail(`Rejected v2 did not fail specifically during daemon activation: ${JSON.stringify(failedUpdateMarkerEvents)}`);
    }
    const afterFailedUpdateCommit = await readCurrentCommit();
    if (
      afterFailedUpdateCommit.revision !== restartCommit.revision
      || afterFailedUpdateCommit.pluginGenerations?.[plugin.pluginId]?.immutableGenerationId !== desiredGeneration
    ) {
      fail('Failed update changed the exact previous desired generation or current revision');
    }
    const afterFailedUpdateState = await readCurrentInstallationState();
    const rejectedCandidateAttributionEvidence = assertRejectedCandidateNotAttributedToCurrentHealth({
      before: beforeFailedUpdateState,
      after: afterFailedUpdateState,
      pluginId: plugin.pluginId,
      currentGenerationId: desiredGeneration,
    });
    const afterFailedUpdateAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(afterFailedUpdateAction, {
      pluginId: plugin.pluginId,
      version: '1.0.0',
      value: plugin.value,
      activationInstanceId: restartedRegistration.activationInstanceId,
    });
    if (afterFailedUpdateAction.data?.result?.pid !== servingDaemonPid) {
      fail('Failed update stopped the prior applied daemon handler from serving');
    }
    stages.push({
      id: 'failed-update-preservation',
      ok: true,
      rejectedArtifact: failedUpdateArtifact,
      failureCode: failedUpdateEnvelope.change.kind,
      causeCode: failedUpdateEnvelope.change.code,
      rejectedActivationEvents: failedUpdateMarkerEvents,
      rejectedCandidateAttribution: rejectedCandidateAttributionEvidence,
      preservedGeneration: desiredGeneration,
      preservedRevision: afterFailedUpdateCommit.revision,
      servingVersion: '1.0.0',
      daemonPid: servingDaemonPid,
    });

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '2.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build', 'test']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const replacementArtifact = await replacePackedArchive('accepted-v2');
    if (replacementArtifact.integrity === failedUpdateArtifact.integrity) {
      fail('Accepted v2 artifact did not differ from the activation-failing v2 bytes');
    }
    const updateEnvelope = await runReviewedInstall([
      'install', 'plugin', 'update', plugin.pluginId, '--json',
    ]);
    const updatedPlugin = updateEnvelope.change?.kind === 'committed'
      ? await readInstalledPlugin(updateEnvelope.change.pluginId)
      : null;
    const updatedGeneration = updateEnvelope.change?.desiredGeneration;
    if (
      updateEnvelope.change?.kind !== 'committed'
      || updateEnvelope.change.pluginId !== plugin.pluginId
      || updatedPlugin?.version !== '2.0.0'
      || typeof updatedGeneration !== 'string'
      || updatedGeneration === desiredGeneration
      || updateEnvelope.change.appliedGeneration !== updatedGeneration
      || !Array.isArray(updateEnvelope.change.pendingSurfaces)
      || updateEnvelope.change.pendingSurfaces.length !== 0
    ) {
      fail(`Successful update did not replace desired/applied generation exactly: ${JSON.stringify(updateEnvelope)}`);
    }
    const updatedCommit = await readCurrentCommit();
    if (
      updatedCommit.revision <= afterFailedUpdateCommit.revision
      || updatedCommit.pluginGenerations?.[plugin.pluginId]?.immutableGenerationId !== updatedGeneration
    ) {
      fail('Successful update did not advance canonical desired currentness');
    }
    const updatedAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(updatedAction, {
      pluginId: plugin.pluginId,
      version: '2.0.0',
      value: plugin.value,
    });
    if (updatedAction.data?.result?.pid !== servingDaemonPid) {
      fail('Successful update was not served by the active daemon runtime owner');
    }
    const successfulUpdateMarkerEvents = (await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER))
      .filter((event) => event.version === '2.0.0');
    const acceptedV2Registration = findLatestMarkerEvent(successfulUpdateMarkerEvents, 'registered', '2.0.0');
    if (
      !acceptedV2Registration
      || acceptedV2Registration.pid !== servingDaemonPid
      || updatedAction.data?.result?.activationInstanceId !== acceptedV2Registration.activationInstanceId
      || successfulUpdateMarkerEvents.filter((event) => event.kind === 'registered').length !== 1
    ) {
      fail(`Accepted v2 was not registered exactly once by the active daemon: ${JSON.stringify(successfulUpdateMarkerEvents)}`);
    }
    stages.push({
      id: 'successful-update-replacement',
      ok: true,
      artifact: replacementArtifact,
      previousGeneration: desiredGeneration,
      desiredGeneration: updatedGeneration,
      appliedGeneration: updateEnvelope.change.appliedGeneration,
      previousRevision: afterFailedUpdateCommit.revision,
      revision: updatedCommit.revision,
      servingVersion: '2.0.0',
      daemonPid: servingDaemonPid,
      activationInstanceId: acceptedV2Registration.activationInstanceId,
      activationEvents: successfulUpdateMarkerEvents,
    });
    const replacedConnectedAccount = await options.probeConnectedAccounts({
      phase: 'replaced',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
      service: Object.freeze({
        pluginId: plugin.pluginId,
        localId: 'novel-cloud',
      }),
      configuredOrigin: connectedAccountProvider.origin,
      staleConfiguredOrigin: staleConnectedAccountProvider.origin,
    });
    if (
      replacedConnectedAccount?.begin?.status !== 'awaitingManual'
      || replacedConnectedAccount?.cancellation?.status !== 'cancelled'
    ) {
      fail('Packed novel Connected Account did not admit the accepted replacement generation');
    }
    const replacedExternalSessions = await options.probeExternalSessions({
      phase: 'replaced',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      agentId: packedExternalAgentId,
      source: packedExternalSource,
      candidateCursor: initialPackedCandidateCursor,
      tailCursor: initialPackedTailCursor,
      sessionId: initialPackedSessionId,
    });
    if (
      replacedExternalSessions?.staleCandidates?.ok !== false
      || replacedExternalSessions.staleCandidates.errorCode !== 'invalid_request'
      || replacedExternalSessions?.staleReadAfter?.ok !== false
      || replacedExternalSessions.staleReadAfter.errorCode !== 'invalid_request'
      || replacedExternalSessions?.candidates?.ok !== true
      || replacedExternalSessions.candidates.candidates?.[0]?.remoteSessionId !== 'packed-session-0'
      || replacedExternalSessions?.page?.ok !== true
      || replacedExternalSessions.page.items?.[0]?.id !== 'packed-page-2.0.0'
      || replacedExternalSessions?.readAfter?.ok !== true
      || replacedExternalSessions.readAfter.items?.[0]?.id !== 'packed-read-after-2.0.0'
      || replacedExternalSessions?.hookStatus?.ok !== true
      || replacedExternalSessions.hookStatus.rows?.[0]?.status?.state !== 'installed_enabled'
      || replacedExternalSessions.hookStatus.rows[0].status.installationId
        !== initialPackedHookInstallationId
    ) {
      fail(`Packed External Sessions replacement did not fence stale generation cursors: ${JSON.stringify(replacedExternalSessions)}`);
    }
    const replacedHookResolve = (await readVerticalAMarkerEvents(
      childEnv.HAPPIER_VERTICAL_A_MARKER,
    )).find((event) => (
      event.kind === 'external-hook-resolve'
      && event.version === '2.0.0'
      && event.activationInstanceId
        === acceptedV2Registration.activationInstanceId
      && event.pid === acceptedV2Registration.pid
    ));
    if (!replacedHookResolve) {
      fail('Packed hook status did not reach resolveInstallation in the replacement activation');
    }

    const rollbackEnvelope = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'rollback', plugin.pluginId, '--json'],
    }, 'plugins_rollback');
    if (
      rollbackEnvelope.data?.pluginId !== plugin.pluginId
      || rollbackEnvelope.data?.desiredGeneration !== desiredGeneration
      || rollbackEnvelope.data?.appliedGeneration !== desiredGeneration
      || !Array.isArray(rollbackEnvelope.data?.pendingSurfaces)
      || rollbackEnvelope.data.pendingSurfaces.length !== 0
    ) {
      fail(`Rollback did not promote the exact retained predecessor: ${JSON.stringify(rollbackEnvelope.data)}`);
    }
    const rollbackCommit = await readCurrentCommit();
    if (
      rollbackCommit.revision <= updatedCommit.revision
      || rollbackCommit.pluginGenerations?.[plugin.pluginId]?.immutableGenerationId !== desiredGeneration
    ) {
      fail('Rollback did not advance currentness to the retained predecessor generation');
    }
    const rollbackAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(rollbackAction, {
      pluginId: plugin.pluginId,
      version: '1.0.0',
      value: plugin.value,
    });
    if (rollbackAction.data?.result?.pid !== servingDaemonPid) {
      fail('Rolled-back generation was not served by the active daemon runtime owner');
    }
    const rollbackRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '1.0.0',
    );
    if (
      !rollbackRegistration
      || rollbackRegistration.pid !== servingDaemonPid
      || rollbackAction.data?.result?.activationInstanceId !== rollbackRegistration.activationInstanceId
    ) {
      fail('Rollback did not reactivate the retained v1 generation in the active daemon');
    }
    const healthyPeerAfterSiblingMutations = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: privatePlugin.pluginId,
    });
    assertRoundtrip(healthyPeerAfterSiblingMutations, {
      pluginId: privatePlugin.pluginId,
      version: '11.0.0',
      value: privatePlugin.value,
    });
    const healthyPeerRegistrationCountAfterSiblingMutations = (
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER)
    ).filter((event) => event.kind === 'registered' && event.version === '11.0.0').length;
    stages.push({
      id: 'post-restart-peer-isolation',
      ok: true,
      siblingPluginId: plugin.pluginId,
      siblingMutations: ['rejected-update', 'accepted-update', 'explicit-rollback'],
      ...assertPostRestartHealthyPeerIsolation({
        pluginId: privatePlugin.pluginId,
        before: restartedHealthyPeerAction.data?.result,
        after: healthyPeerAfterSiblingMutations.data?.result,
        registrationCountBefore: restartedHealthyPeerRegistrationCount,
        registrationCountAfter: healthyPeerRegistrationCountAfterSiblingMutations,
      }),
    });
    stages.push({
      id: 'explicit-rollback',
      ok: true,
      fromGeneration: updatedGeneration,
      desiredGeneration,
      appliedGeneration: desiredGeneration,
      previousRevision: updatedCommit.revision,
      revision: rollbackCommit.revision,
      servingVersion: '1.0.0',
      daemonPid: servingDaemonPid,
      activationInstanceId: rollbackRegistration.activationInstanceId,
    });

    const trustedDevelopmentDaemonState = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    const discardedDevelopmentResponse = await postPackedDaemonControlDiscardingResponse(
      trustedDevelopmentDaemonState,
      '/plugins/change/request',
      {
        kind: 'development',
        pluginId: privatePlugin.pluginId,
        sourceRootPath: privatePlugin.root,
        sdkRegistryOrigin: registry.origin,
      },
    );
    const healthyControlAfterUnknownDevelopment = await readInstalledPlugin(privatePlugin.pluginId);
    const healthyControlGeneration = healthyControlAfterUnknownDevelopment?.desiredGeneration;
    const stateAfterUnknownDevelopment = await readCurrentInstallationState();
    if (
      discardedDevelopmentResponse.responseBodyDiscarded !== true
      || typeof healthyControlGeneration !== 'string'
      || healthyControlGeneration === initialHealthyControlGeneration
      || healthyControlAfterUnknownDevelopment?.enabled !== true
      || healthyControlAfterUnknownDevelopment.appliedGeneration !== healthyControlGeneration
      || stateAfterUnknownDevelopment.commit.pluginGenerations?.[privatePlugin.pluginId]?.immutableGenerationId
        !== healthyControlGeneration
      || stateAfterUnknownDevelopment.revision.plugins?.[privatePlugin.pluginId]?.enabled !== true
    ) {
      fail(`Ordinary current-state query did not resolve a discarded trusted-development response: ${JSON.stringify({
        discardedDevelopmentResponse,
        initialHealthyControlGeneration,
        healthyControlAfterUnknownDevelopment,
        committedGeneration: stateAfterUnknownDevelopment.commit
          .pluginGenerations?.[privatePlugin.pluginId]?.immutableGenerationId,
        installation: stateAfterUnknownDevelopment.revision.plugins?.[privatePlugin.pluginId],
      })}`);
    }
    const healthyControlAfterUnknownDevelopmentAction = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: privatePlugin.pluginId,
    });
    assertRoundtrip(healthyControlAfterUnknownDevelopmentAction, {
      pluginId: privatePlugin.pluginId,
      version: '11.0.0',
      value: privatePlugin.value,
    });
    if (healthyControlAfterUnknownDevelopmentAction.data?.result?.pid !== trustedDevelopmentDaemonState.pid) {
      fail('Trusted development response-loss currentness was not served by the active daemon owner');
    }
    stages.push({
      id: 'trusted-development-response-loss-currentness',
      ok: true,
      pluginId: privatePlugin.pluginId,
      request: 'development',
      response: 'body-discarded-before-client-result-parse',
      query: 'plugins-show',
      previousGeneration: initialHealthyControlGeneration,
      desiredGeneration: healthyControlGeneration,
      appliedGeneration: healthyControlAfterUnknownDevelopment.appliedGeneration,
      daemonPid: healthyControlAfterUnknownDevelopmentAction.data.result.pid,
      activationInstanceId: healthyControlAfterUnknownDevelopmentAction.data.result.activationInstanceId,
    });

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '3.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build', 'test']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const initialDevelopmentHealthStartedAtMs = Date.now();
    const developmentInstall = await runReviewedInstall([
        'plugins', 'install', plugin.root,
        '--dev',
        '--sdk-registry', registry.origin,
        '--json',
      ]);
    const healthyDevelopmentGeneration = developmentInstall.change?.desiredGeneration;
    if (
      developmentInstall.change?.kind !== 'committed'
      || developmentInstall.change.pluginId !== plugin.pluginId
      || typeof healthyDevelopmentGeneration !== 'string'
      || developmentInstall.change.appliedGeneration !== healthyDevelopmentGeneration
    ) {
      fail(`Development install did not commit its exact generation: ${JSON.stringify(developmentInstall)}`);
    }
    const initialHealthyCandidateRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '3.0.0',
    );
    if (!initialHealthyCandidateRegistration) {
      fail('Development install did not register its executable generation');
    }
    const healthyDevelopmentState = await waitForGenerationHealth({
      generationId: healthyDevelopmentGeneration,
      state: 'healthy',
      timeoutMs: 11 * 60_000,
    });
    const healthyControlState = await waitForGenerationHealth({
      generationId: healthyControlGeneration,
      state: 'healthy',
      timeoutMs: 30_000,
    });
    if (
      healthyControlState.commit.pluginGenerations?.[privatePlugin.pluginId]?.immutableGenerationId !== healthyControlGeneration
      || healthyControlState.revision.plugins?.[privatePlugin.pluginId]?.enabled !== true
    ) {
      fail('Control plugin did not remain enabled on its exact healthy generation');
    }
    const initialDevelopmentHealthCompletedAtMs = Date.now();
    const healthyDevelopmentAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(healthyDevelopmentAction, {
      pluginId: plugin.pluginId,
      version: '3.0.0',
      value: plugin.value,
      activationInstanceId: initialHealthyCandidateRegistration.activationInstanceId,
    });
    if (
      initialDevelopmentHealthCompletedAtMs - initialDevelopmentHealthStartedAtMs < 10 * 60_000
      || healthyDevelopmentAction.data?.result?.pid !== initialHealthyCandidateRegistration.pid
      || healthyDevelopmentAction.data?.result?.activationInstanceId !== initialHealthyCandidateRegistration.activationInstanceId
    ) {
      fail('Initial development generation did not establish a continuous healthy same-channel predecessor');
    }

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '4.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const candidateHealthStartedAtMs = Date.now();
    const developmentReload = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'reload', plugin.pluginId, '--json'],
    }, 'plugins_reload');
    const pendingDevelopmentGeneration = developmentReload.data?.desiredGeneration;
    if (
      developmentReload.data?.pluginId !== plugin.pluginId
      || typeof pendingDevelopmentGeneration !== 'string'
      || pendingDevelopmentGeneration === healthyDevelopmentGeneration
      || developmentReload.data?.appliedGeneration !== pendingDevelopmentGeneration
    ) {
      fail(`Development reload did not commit a distinct exact generation: ${JSON.stringify(developmentReload.data)}`);
    }
    const pendingDevelopmentState = await readCurrentInstallationState();
    const retainedLkg = pendingDevelopmentState.revision.rollbackRetention?.find((entry) => (
      entry.pluginId === plugin.pluginId
      && entry.immutableGenerationId === healthyDevelopmentGeneration
    ));
    if (
      pendingDevelopmentState.revision.health?.[pendingDevelopmentGeneration]?.state !== 'pending'
      || retainedLkg?.role !== 'lastKnownGood'
      || retainedLkg?.automaticRecoveryEligible !== true
      || retainedLkg?.byteAvailability !== 'available'
    ) {
      fail(`Healthy same-channel predecessor did not transition to automatic LKG: ${JSON.stringify({
        health: pendingDevelopmentState.revision.health?.[pendingDevelopmentGeneration],
        retainedLkg,
      })}`);
    }
    const pendingCandidateRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '4.0.0',
    );
    if (!pendingCandidateRegistration) {
      fail('Same-channel candidate did not register in the active daemon');
    }
    const healthyCandidateState = await waitForGenerationHealth({
      generationId: pendingDevelopmentGeneration,
      state: 'healthy',
      timeoutMs: 11 * 60_000,
    });
    const candidateHealthCompletedAtMs = Date.now();
    const healthyCandidateAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(healthyCandidateAction, {
      pluginId: plugin.pluginId,
      version: '4.0.0',
      value: plugin.value,
      activationInstanceId: pendingCandidateRegistration.activationInstanceId,
    });
    const priorAfterCandidateHealth = healthyCandidateState.revision.rollbackRetention?.find((entry) => (
      entry.pluginId === plugin.pluginId
      && entry.immutableGenerationId === healthyDevelopmentGeneration
    ));
    const continuousHealthEvidence = assertContinuousHealthEvidence({
      startedAtMs: candidateHealthStartedAtMs,
      completedAtMs: candidateHealthCompletedAtMs,
      requiredWindowMs: 10 * 60_000,
      initialRegistration: pendingCandidateRegistration,
      healthyInvocation: healthyCandidateAction.data?.result,
      candidateHealth: healthyCandidateState.revision.health?.[pendingDevelopmentGeneration],
      priorRetention: priorAfterCandidateHealth,
      initialDistribution: healthyDevelopmentState.revision.plugins?.[plugin.pluginId]?.install?.trust?.distribution,
      candidateDistribution: healthyCandidateState.revision.plugins?.[plugin.pluginId]?.install?.trust?.distribution,
    });
    stages.push({
      id: 'continuous-health-role-transition',
      ok: true,
      initialHealthyGeneration: healthyDevelopmentGeneration,
      initialHealthyRevision: healthyDevelopmentState.commit.revision,
      candidateGeneration: pendingDevelopmentGeneration,
      pendingCandidateRevision: pendingDevelopmentState.commit.revision,
      healthyCandidateRevision: healthyCandidateState.commit.revision,
      continuousHealthStartedAtMs: candidateHealthStartedAtMs,
      continuousHealthCompletedAtMs: candidateHealthCompletedAtMs,
      ...continuousHealthEvidence,
      pendingPredecessorRole: retainedLkg.role,
      pendingAutomaticRecoveryEligible: retainedLkg.automaticRecoveryEligible,
    });

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '5.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const failingDevelopmentReload = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'reload', plugin.pluginId, '--json'],
    }, 'plugins_reload');
    const failingDevelopmentGeneration = failingDevelopmentReload.data?.desiredGeneration;
    if (
      failingDevelopmentReload.data?.pluginId !== plugin.pluginId
      || typeof failingDevelopmentGeneration !== 'string'
      || failingDevelopmentGeneration === pendingDevelopmentGeneration
      || failingDevelopmentReload.data?.appliedGeneration !== failingDevelopmentGeneration
    ) {
      fail(`Fatal-attempt candidate did not commit a distinct exact generation: ${JSON.stringify(failingDevelopmentReload.data)}`);
    }
    const failingDevelopmentState = await readCurrentInstallationState();
    const recoveryLkg = failingDevelopmentState.revision.rollbackRetention?.find((entry) => (
      entry.pluginId === plugin.pluginId
      && entry.immutableGenerationId === pendingDevelopmentGeneration
    ));
    if (
      failingDevelopmentState.revision.health?.[failingDevelopmentGeneration]?.state !== 'pending'
      || recoveryLkg?.role !== 'lastKnownGood'
      || recoveryLkg?.automaticRecoveryEligible !== true
      || recoveryLkg?.byteAvailability !== 'available'
    ) {
      fail(`Healthy same-channel candidate was not retained for automatic recovery: ${JSON.stringify({
        health: failingDevelopmentState.revision.health?.[failingDevelopmentGeneration],
        recoveryLkg,
      })}`);
    }

    const fatalMarkerPath = `${childEnv.HAPPIER_VERTICAL_A_MARKER}.fatal`;
    await writeFile(fatalMarkerPath, '5.0.0\n', 'utf8');
    const fatalAttemptEvidence = [];
    const healthyControlInvocations = [];
    const initialFatalAttemptIds = [
      ...(failingDevelopmentState.revision.health?.[failingDevelopmentGeneration]?.consumedAttemptIds ?? []),
    ];
    let priorFatalAttemptIds = initialFatalAttemptIds;
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const restart = await runPackedCli({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        args: buildVerticalADaemonRestartArgs(),
      });
      assertCommandSucceeded(restart, `Packed daemon restart for fatal attempt ${attemptNumber}`);
      const restartEnvelope = parseJsonEnvelope(restart.stdout, 'daemon_restart');
      if (restartEnvelope?.ok !== true || restartEnvelope?.status !== 'restarted') {
        fail(`Fatal-attempt restart did not report a stable replacement: ${JSON.stringify(restartEnvelope)}`);
      }
      const progress = await waitForSupervisedAttemptProgress({
        generationId: failingDevelopmentGeneration,
        priorConsumedAttemptIds: priorFatalAttemptIds,
        readState: readCurrentInstallationState,
        timeoutMs: 15_000,
      });
      const state = progress.state;
      fatalAttemptEvidence.push({
        attemptNumber,
        revision: state.commit.revision,
        consumedAttemptIds: progress.consumedAttemptIds,
      });
      const healthyControl = await runPackedPluginRoundtrip({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        pluginId: privatePlugin.pluginId,
      });
      assertRoundtrip(healthyControl, {
        pluginId: privatePlugin.pluginId,
        version: '11.0.0',
        value: privatePlugin.value,
      });
      healthyControlInvocations.push({
        attemptNumber,
        ...healthyControl.data.result,
      });
      priorFatalAttemptIds = progress.consumedAttemptIds;
    }
    const fatalAttemptIds = assertUniqueSupervisedAttemptProgress({
      initialConsumedAttemptIds: initialFatalAttemptIds,
      attempts: fatalAttemptEvidence,
    });
    const recoveredState = await waitForGenerationHealth({
      generationId: failingDevelopmentGeneration,
      state: 'quarantined',
      timeoutMs: 15_000,
    });
    await rm(fatalMarkerPath, { force: true });
    const failedGenerationHealth = recoveredState.revision.health?.[failingDevelopmentGeneration];
    const quarantinedRetention = recoveredState.revision.rollbackRetention?.find((entry) => (
      entry.pluginId === plugin.pluginId
      && entry.immutableGenerationId === failingDevelopmentGeneration
    ));
    const quarantinedTombstone = recoveredState.revision.healthTombstones?.find((entry) => (
      entry.pluginId === plugin.pluginId
      && entry.fingerprint === failedGenerationHealth?.fingerprint
    ));
    if (
      recoveredState.commit.pluginGenerations?.[plugin.pluginId]?.immutableGenerationId !== pendingDevelopmentGeneration
      || new Set(failedGenerationHealth?.consumedAttemptIds ?? []).size < 3
      || quarantinedRetention?.role !== 'quarantined'
      || quarantinedRetention?.automaticRecoveryEligible !== false
      || quarantinedTombstone?.state !== 'quarantined'
    ) {
      fail(`Three distinct post-commit fatal attempts did not recover the exact LKG: ${JSON.stringify({
        current: recoveredState.commit.pluginGenerations?.[plugin.pluginId],
        failedGenerationHealth,
        quarantinedRetention,
        quarantinedTombstone,
      })}`);
    }
    const recoveredAction = await runPackedPluginRoundtrip({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv, pluginId: plugin.pluginId,
    });
    assertRoundtrip(recoveredAction, {
      pluginId: plugin.pluginId,
      version: '4.0.0',
      value: plugin.value,
    });
    const recoveryRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '4.0.0',
    );
    if (
      !recoveryRegistration
      || recoveredAction.data?.result?.pid !== recoveryRegistration.pid
      || recoveredAction.data?.result?.activationInstanceId !== recoveryRegistration.activationInstanceId
    ) {
      fail('Automatic LKG recovery did not reactivate the retained development generation');
    }
    stages.push({
      id: 'automatic-lkg-recovery',
      ok: true,
      failedGeneration: failingDevelopmentGeneration,
      recoveredGeneration: pendingDevelopmentGeneration,
      revision: recoveredState.commit.revision,
      distinctFatalAttempts: fatalAttemptIds.length - initialFatalAttemptIds.length,
      supervisedAttemptIds: fatalAttemptIds,
      fatalAttemptEvidence,
      healthyControlInvocations,
      failedFingerprint: failedGenerationHealth.fingerprint,
      retainedRole: quarantinedRetention.role,
      tombstoneState: quarantinedTombstone.state,
      servingVersion: '4.0.0',
      daemonPid: recoveryRegistration.pid,
      activationInstanceId: recoveryRegistration.activationInstanceId,
    });

    await writeFile(fatalMarkerPath, '4.0.0\n', 'utf8');
    const noLkgFatalAttemptEvidence = [];
    const initialNoLkgFatalAttemptIds = [
      ...(recoveredState.revision.health?.[pendingDevelopmentGeneration]?.consumedAttemptIds ?? []),
    ];
    let priorNoLkgFatalAttemptIds = initialNoLkgFatalAttemptIds;
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const restart = await runPackedCli({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        args: buildVerticalADaemonRestartArgs(),
      });
      assertCommandSucceeded(restart, `Packed daemon restart for no-LKG fatal attempt ${attemptNumber}`);
      const restartEnvelope = parseJsonEnvelope(restart.stdout, 'daemon_restart');
      if (restartEnvelope?.ok !== true || restartEnvelope?.status !== 'restarted') {
        fail(`No-LKG fatal-attempt restart did not report a stable replacement: ${JSON.stringify(restartEnvelope)}`);
      }
      const progress = await waitForSupervisedAttemptProgress({
        generationId: pendingDevelopmentGeneration,
        priorConsumedAttemptIds: priorNoLkgFatalAttemptIds,
        readState: readCurrentInstallationState,
        timeoutMs: 15_000,
      });
      const state = progress.state;
      noLkgFatalAttemptEvidence.push({
        attemptNumber,
        revision: state.commit.revision,
        consumedAttemptIds: progress.consumedAttemptIds,
      });
      const healthyControl = await runPackedPluginRoundtrip({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        pluginId: privatePlugin.pluginId,
      });
      assertRoundtrip(healthyControl, {
        pluginId: privatePlugin.pluginId,
        version: '11.0.0',
        value: privatePlugin.value,
      });
      healthyControlInvocations.push({
        attemptNumber: `no-lkg-${attemptNumber}`,
        ...healthyControl.data.result,
      });
      priorNoLkgFatalAttemptIds = progress.consumedAttemptIds;
    }
    const noLkgFatalAttemptIds = assertUniqueSupervisedAttemptProgress({
      initialConsumedAttemptIds: initialNoLkgFatalAttemptIds,
      attempts: noLkgFatalAttemptEvidence,
    });
    const disabledState = await waitForGenerationHealth({
      generationId: pendingDevelopmentGeneration,
      state: 'quarantined',
      timeoutMs: 15_000,
    });
    await rm(fatalMarkerPath, { force: true });
    const noLkgEvidence = assertNoEligibleLkgDisabled({
      state: disabledState,
      pluginId: plugin.pluginId,
      failedGenerationId: pendingDevelopmentGeneration,
      explicitRollbackGenerationId: failingDevelopmentGeneration,
      healthyPluginInvocation: healthyControlInvocations.at(-1),
    });
    const rootHelpAfterDisable = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['--help'],
    });
    assertCommandSucceeded(rootHelpAfterDisable, 'Root help after no-LKG disable');
    assertPluginCommandAbsentFromRootHelp({
      stdout: rootHelpAfterDisable.stdout,
      commandRoot: 'vertical-a',
    });
    const disabledCleanup = await waitForActivationCleanup({
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      version: '4.0.0',
      activationInstanceId: recoveryRegistration.activationInstanceId,
    });
    const connectedAccountDormant =
      await options.probeConnectedAccounts({
        phase: 'dormant',
        happyHomeDir: childEnv.HAPPIER_HOME_DIR,
        pluginId: plugin.pluginId,
        service: Object.freeze({
          pluginId: plugin.pluginId,
          localId: 'novel-cloud',
        }),
        configuredOrigin: connectedAccountProvider.origin,
        staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      });
    const dormantConnectedAccountConsumer = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: [
        'vertical-a',
        plugin.pluginId.split('.').at(-1),
        '--input',
        JSON.stringify({
          operation: 'connected-account-dormancy-materialize',
        }),
        '--json',
      ],
    });
    if (
      connectedAccountDormant?.runtime?.status !== 'unavailable'
      || connectedAccountDormant.runtime.code
        !== 'connected_account_daemon_runtime_unavailable'
      || (
        dormantConnectedAccountConsumer.code === 0
        && dormantConnectedAccountConsumer.signal === null
      )
    ) {
      fail('Packed Connected Account runtime or consumer remained callable while its generation was disabled');
    }
    stages.push({
      id: 'no-eligible-lkg-disable',
      ok: true,
      failedGeneration: pendingDevelopmentGeneration,
      retainedExplicitRollbackGeneration: failingDevelopmentGeneration,
      revision: disabledState.commit.revision,
      ...noLkgEvidence,
      supervisedAttemptIds: noLkgFatalAttemptIds,
      fatalAttemptEvidence: noLkgFatalAttemptEvidence,
      commandProjection: 'absent-from-root-help',
      connectedAccountDormancy: {
        runtime: connectedAccountDormant.runtime.code,
        consumer: 'unavailable',
        preservedAccountId: connectedAccountDormant.account?.accountId,
        preservedGroupId: connectedAccountDormant.group?.ref?.groupId,
      },
      cleanup: disabledCleanup,
    });

    const tryOnceInitialAttemptIds = [
      ...(disabledState.revision.health?.[pendingDevelopmentGeneration]?.consumedAttemptIds ?? []),
    ];
    await writeFile(fatalMarkerPath, '4.0.0\n', 'utf8');
    const tryOnceEnableEnvelope = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'enable', plugin.pluginId, '--json'],
    }, 'plugins_enable');
    if (
      tryOnceEnableEnvelope.data?.pluginId !== plugin.pluginId
      || tryOnceEnableEnvelope.data?.enabled !== true
      || tryOnceEnableEnvelope.data?.desiredGeneration !== pendingDevelopmentGeneration
      || tryOnceEnableEnvelope.data?.appliedGeneration !== pendingDevelopmentGeneration
    ) {
      fail(`Try-once enable did not target the exact quarantined generation: ${JSON.stringify(tryOnceEnableEnvelope.data)}`);
    }
    const tryOnceFailureProgress = await waitForSupervisedAttemptProgress({
      generationId: pendingDevelopmentGeneration,
      priorConsumedAttemptIds: tryOnceInitialAttemptIds,
      readState: readCurrentInstallationState,
      timeoutMs: 15_000,
    });
    await rm(fatalMarkerPath, { force: true });
    const tryOnceFailedState = tryOnceFailureProgress.state;
    if (
      tryOnceFailedState.revision.health?.[pendingDevelopmentGeneration]?.state !== 'quarantined'
      || tryOnceFailedState.revision.health?.[pendingDevelopmentGeneration]?.tryOnce !== 'consumed'
      || tryOnceFailedState.revision.plugins?.[plugin.pluginId]?.enabled !== false
      || tryOnceFailedState.revision.runtimeCatalog?.plugins?.[plugin.pluginId]?.state?.enabled !== false
    ) {
      fail(`Try-once fatal activation did not consume the one execution and disable the plugin: ${JSON.stringify({
        health: tryOnceFailedState.revision.health?.[pendingDevelopmentGeneration],
        installation: tryOnceFailedState.revision.plugins?.[plugin.pluginId],
        runtimeCatalog: tryOnceFailedState.revision.runtimeCatalog?.plugins?.[plugin.pluginId],
      })}`);
    }
    const rejectedSecondEnable = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'enable', plugin.pluginId, '--json'],
    });
    if (rejectedSecondEnable.code === 0 && rejectedSecondEnable.signal === null) {
      fail('Consumed Try once unexpectedly permitted a second enable');
    }
    const rejectedSecondEnableEnvelope = parseJsonEnvelope(
      rejectedSecondEnable.stdout,
      'plugins_enable_after_consumed_try_once',
    );
    const registrationCountBeforeRestart = (
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER)
    ).filter((event) => event.kind === 'registered' && event.version === '4.0.0').length;
    const daemonBeforeQuarantineRestart = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    const quarantineRestart = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: buildVerticalADaemonRestartArgs(),
    });
    assertCommandSucceeded(quarantineRestart, 'Packed daemon restart with consumed quarantine');
    const quarantineRestartEnvelope = parseJsonEnvelope(quarantineRestart.stdout, 'daemon_restart');
    if (quarantineRestartEnvelope?.ok !== true || quarantineRestartEnvelope?.status !== 'restarted') {
      fail(`Consumed-quarantine restart did not report a stable replacement: ${JSON.stringify(quarantineRestartEnvelope)}`);
    }
    const daemonAfterQuarantineRestart = await readPackedDaemonState(childEnv.HAPPIER_HOME_DIR);
    if (daemonAfterQuarantineRestart.pid === daemonBeforeQuarantineRestart.pid) {
      fail('Consumed-quarantine restart did not replace the daemon process');
    }
    const afterQuarantineRestartState = await readCurrentInstallationState();
    assertRestartPreservedDesiredGeneration({
      initialCommit: tryOnceFailedState.commit,
      restartCommit: afterQuarantineRestartState.commit,
      pluginId: plugin.pluginId,
      desiredGeneration: pendingDevelopmentGeneration,
    });

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '4.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build']) {
      await runPackedCliJson({
        cliEntrypoint, cwd: fixtureRoot, env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const quarantinedReinstall = await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'reload', plugin.pluginId, '--json'],
    }, 'plugins_reload');
    const reinstalledGeneration = quarantinedReinstall.data?.desiredGeneration;
    if (
      quarantinedReinstall.data?.pluginId !== plugin.pluginId
      || typeof reinstalledGeneration !== 'string'
      || reinstalledGeneration === pendingDevelopmentGeneration
      || quarantinedReinstall.data?.appliedGeneration !== reinstalledGeneration
    ) {
      fail(`Exact-byte quarantine reinstall did not commit a distinct generation: ${JSON.stringify(quarantinedReinstall.data)}`);
    }
    const reinstalledState = await readCurrentInstallationState();
    const registrationCountAfterReinstall = (
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER)
    ).filter((event) => event.kind === 'registered' && event.version === '4.0.0').length;
    const tryOnceReinstallEvidence = assertTryOnceReinstallQuarantine({
      state: reinstalledState,
      pluginId: plugin.pluginId,
      originalGenerationId: pendingDevelopmentGeneration,
      reinstalledGenerationId: reinstalledGeneration,
      fingerprint: noLkgEvidence.failedFingerprint,
      rejectedSecondEnable: rejectedSecondEnableEnvelope,
      registrationCountBeforeRestart,
      registrationCountAfterReinstall,
    });
    const rootHelpAfterQuarantinedReinstall = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['--help'],
    });
    assertCommandSucceeded(rootHelpAfterQuarantinedReinstall, 'Root help after exact-byte quarantine reinstall');
    assertPluginCommandAbsentFromRootHelp({
      stdout: rootHelpAfterQuarantinedReinstall.stdout,
      commandRoot: 'vertical-a',
    });
    stages.push({
      id: 'try-once-reinstall-quarantine',
      ok: true,
      revision: reinstalledState.commit.revision,
      tryOnceAttemptId: tryOnceFailureProgress.consumedAttemptIds.at(-1),
      restartFromPid: daemonBeforeQuarantineRestart.pid,
      restartToPid: daemonAfterQuarantineRestart.pid,
      commandProjection: 'absent-from-root-help',
      ...tryOnceReinstallEvidence,
    });

    const quarantinedRollbackEnvelope = await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'rollback', plugin.pluginId, '--json'],
    }, 'plugins_rollback');
    const afterQuarantinedRollback = await readCurrentInstallationState();
    const quarantinedRollbackAction = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
    });
    assertRoundtrip(quarantinedRollbackAction, {
      pluginId: plugin.pluginId,
      version: '5.0.0',
      value: plugin.value,
    });
    const quarantinedRollbackRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '5.0.0',
    );
    if (
      !quarantinedRollbackRegistration
      || quarantinedRollbackAction.data?.result?.pid !== quarantinedRollbackRegistration.pid
      || quarantinedRollbackAction.data?.result?.activationInstanceId
        !== quarantinedRollbackRegistration.activationInstanceId
    ) {
      fail('Explicit quarantined rollback did not serve from its adopted activation');
    }
    const connectedAccountReenabled =
      await options.probeConnectedAccounts({
        phase: 'reEnabled',
        happyHomeDir: childEnv.HAPPIER_HOME_DIR,
        pluginId: plugin.pluginId,
        service: Object.freeze({
          pluginId: plugin.pluginId,
          localId: 'novel-cloud',
        }),
        configuredOrigin: connectedAccountProvider.origin,
        staleConfiguredOrigin: staleConnectedAccountProvider.origin,
      });
    const reenabledConnectedAccountConsumer =
      await runPackedPluginRoundtrip({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: childEnv,
        pluginId: plugin.pluginId,
        input: {
          operation: 'connected-account-dormancy-materialize',
        },
      });
    const connectedAccountDormancy =
      assertPackedConnectedAccountDormancy({
        baseline: connectedAccountDormancyBaseline,
        dormant: connectedAccountDormant,
        reenabled: connectedAccountReenabled,
        materializationEnvelope: reenabledConnectedAccountConsumer,
      });
    const quarantinedRollbackEvidence = assertQuarantinedExplicitRollback({
      pluginId: plugin.pluginId,
      healthyGenerationId: reinstalledGeneration,
      quarantinedGenerationId: failingDevelopmentGeneration,
      before: reinstalledState,
      rollbackEnvelope: quarantinedRollbackEnvelope,
      after: afterQuarantinedRollback,
      invocation: quarantinedRollbackAction.data?.result,
    });
    stages.push({
      id: 'quarantined-explicit-rollback',
      ok: true,
      revision: afterQuarantinedRollback.commit.revision,
      ...quarantinedRollbackEvidence,
      connectedAccountDormancy,
      daemonPid: quarantinedRollbackRegistration.pid,
    });

    const cleanupFailureMarkerPath = `${childEnv.HAPPIER_VERTICAL_A_MARKER}.cleanup-fatal`;
    await writeFile(cleanupFailureMarkerPath, '5.0.0\n', 'utf8');
    const cleanupFailureUninstall = await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'uninstall', plugin.pluginId, '--json'],
    }, 'plugins_uninstall');
    const cleanupFailure = await waitForActivationCleanupFailure({
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      version: '5.0.0',
      activationInstanceId: quarantinedRollbackRegistration.activationInstanceId,
    });
    await rm(cleanupFailureMarkerPath, { force: true });

    await configureVerticalAPlugin({
      pluginRoot: plugin.root,
      pluginId: plugin.pluginId,
      version: '6.0.0',
      fetchOrigin: registry.origin,
      connectedAccountOrigin: connectedAccountProvider.origin,
    });
    for (const operation of ['typecheck', 'build']) {
      await runPackedCliJson({
        cliEntrypoint,
        cwd: fixtureRoot,
        env: authorEnv,
        args: ['plugins', 'author', operation, plugin.root, '--json'],
      }, `plugins_author_${operation}`);
    }
    const laterMutationEnvelope = await runReviewedInstall([
      'plugins', 'install', plugin.root,
      '--dev',
      '--sdk-registry', registry.origin,
      '--json',
    ]);
    const laterMutationGeneration = laterMutationEnvelope.change?.desiredGeneration;
    if (
      laterMutationEnvelope.change?.kind !== 'committed'
      || laterMutationEnvelope.change.pluginId !== plugin.pluginId
      || typeof laterMutationGeneration !== 'string'
      || laterMutationEnvelope.change.appliedGeneration !== laterMutationGeneration
    ) {
      fail(`Later same-plugin mutation did not commit after cleanup failure: ${JSON.stringify(laterMutationEnvelope)}`);
    }
    const laterMutationAction = await runPackedPluginRoundtrip({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      pluginId: plugin.pluginId,
    });
    assertRoundtrip(laterMutationAction, {
      pluginId: plugin.pluginId,
      version: '6.0.0',
      value: plugin.value,
    });
    const laterMutationRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '6.0.0',
    );
    if (
      !laterMutationRegistration
      || laterMutationAction.data?.result?.pid !== laterMutationRegistration.pid
      || laterMutationAction.data?.result?.activationInstanceId !== laterMutationRegistration.activationInstanceId
    ) {
      fail('Later same-plugin mutation was not served by its adopted activation');
    }
    const laterMutationState = await readCurrentInstallationState();
    stages.push({
      id: 'cleanup-failure-later-mutation',
      ok: true,
      revision: laterMutationState.commit.revision,
      ...assertCleanupFailureDidNotBlockLaterMutation({
        pluginId: plugin.pluginId,
        retiredGenerationId: failingDevelopmentGeneration,
        cleanupFailure,
        uninstallEnvelope: cleanupFailureUninstall,
        laterMutationEnvelope,
        laterInvocation: laterMutationAction.data?.result,
      }),
      laterMutationActivationInstanceId: laterMutationRegistration.activationInstanceId,
      daemonPid: laterMutationRegistration.pid,
    });

    const uninstallEnvelope = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'uninstall', plugin.pluginId, '--json'],
    }, 'plugins_uninstall');
    if (
      uninstallEnvelope.data?.pluginId !== plugin.pluginId
      || uninstallEnvelope.data?.desiredGeneration !== null
      || uninstallEnvelope.data?.appliedGeneration !== null
      || !Array.isArray(uninstallEnvelope.data?.pendingSurfaces)
      || uninstallEnvelope.data.pendingSurfaces.length !== 0
    ) {
      fail(`Uninstall did not remove desired/applied currentness: ${JSON.stringify(uninstallEnvelope.data)}`);
    }
    const uninstallCommit = await readCurrentCommit();
    if (
      uninstallCommit.revision <= recoveredState.commit.revision
      || uninstallCommit.pluginGenerations?.[plugin.pluginId] !== undefined
    ) {
      fail('Uninstall left the plugin in canonical desired currentness');
    }
    const afterDefaultUninstall = await readCurrentInstallationState();
    const explicitClearEnvelope = await runPackedCliJson({
      cliEntrypoint, cwd: fixtureRoot, env: childEnv,
      args: ['plugins', 'uninstall', plugin.pluginId, '--delete-data', '--yes', '--json'],
    }, 'plugins_uninstall');
    const afterExplicitClear = await readCurrentInstallationState();
    const healthHistoryClearEvidence = assertExplicitHealthHistoryClear({
      pluginId: plugin.pluginId,
      fingerprint: noLkgEvidence.failedFingerprint,
      afterDefaultUninstall,
      clearEnvelope: explicitClearEnvelope,
      afterExplicitClear,
    });
    const actionsAfterUninstall = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'actions', plugin.pluginId, '--json'],
    });
    if (actionsAfterUninstall.code === 0 && actionsAfterUninstall.signal === null) {
      fail('Uninstalled plugin remained visible on the action catalog surface');
    }
    const actionsAfterUninstallEnvelope = parseJsonEnvelope(actionsAfterUninstall.stdout, 'plugins_actions_after_uninstall');
    if (
      actionsAfterUninstallEnvelope?.ok !== false
      || actionsAfterUninstallEnvelope?.kind !== 'plugins_actions'
      || actionsAfterUninstallEnvelope?.error?.code !== 'plugin_not_found'
    ) {
      fail(`Uninstalled action catalog did not report exact absence: ${JSON.stringify(actionsAfterUninstallEnvelope)}`);
    }
    const rootHelpAfterUninstall = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['--help'],
    });
    assertCommandSucceeded(rootHelpAfterUninstall, 'Root help after plugin uninstall');
    assertPluginCommandAbsentFromRootHelp({
      stdout: rootHelpAfterUninstall.stdout,
      commandRoot: 'vertical-a',
    });
    const notificationAfterUninstall = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: [
        'vertical-a',
        plugin.pluginId.split('.').at(-1),
        '--input',
        JSON.stringify({
          operation: 'notification-send',
          clientRequestId: 'packed-notification-retired',
        }),
        '--json',
      ],
    });
    stages.push({
      id: 'packed-notification-delivery-lifecycle',
      ok: true,
      ...assertVerticalANotificationLifecycleEvidence({
        ...pendingNotificationEvidence,
        retiredInvocation: notificationAfterUninstall,
      }),
      revision: afterExplicitClear.commit.revision,
    });
    const uninstallCleanup = await waitForActivationCleanup({
      markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
      version: '6.0.0',
      activationInstanceId: laterMutationRegistration.activationInstanceId,
    });
    stages.push({
      id: 'uninstall-action-currentness-absence',
      ok: true,
      desiredGeneration: null,
      appliedGeneration: null,
      previousRevision: laterMutationState.commit.revision,
      revision: afterExplicitClear.commit.revision,
      actionCatalogError: actionsAfterUninstallEnvelope.error.code,
      commandProjection: 'absent-from-root-help',
      ...healthHistoryClearEvidence,
      cleanup: uninstallCleanup,
    });

    const latestHealthyControlRegistration = findLatestMarkerEvent(
      await readVerticalAMarkerEvents(childEnv.HAPPIER_VERTICAL_A_MARKER),
      'registered',
      '11.0.0',
    );
    const healthyControlUninstall = await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['plugins', 'uninstall', privatePlugin.pluginId, '--json'],
    }, 'plugins_uninstall');
    if (
      healthyControlUninstall.data?.desiredGeneration !== null
      || healthyControlUninstall.data?.appliedGeneration !== null
    ) {
      fail(`Healthy control plugin uninstall did not clear desired/applied state: ${JSON.stringify(healthyControlUninstall)}`);
    }
    if (latestHealthyControlRegistration) {
      await waitForActivationCleanup({
        markerPath: childEnv.HAPPIER_VERTICAL_A_MARKER,
        version: '11.0.0',
        activationInstanceId: latestHealthyControlRegistration.activationInstanceId,
      });
    }

    const uninstalledScmProbe = await options.probeScm({
      phase: 'uninstalled',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      cwd: fixtureRoot,
      pluginId: plugin.pluginId,
      backendId: packedScmBackendId,
      hostingProviderId: packedScmHostingProviderId,
    });
    stages.push({
      id: 'packed-scm-uninstall-stale-absence',
      ok: true,
      ...assertVerticalAScmUninstalledProbe({
        probe: uninstalledScmProbe,
        backendId: packedScmBackendId,
        hostingProviderId: packedScmHostingProviderId,
      }),
      revision: afterExplicitClear.commit.revision,
    });
    const uninstalledExternalSessions = await options.probeExternalSessions({
      phase: 'uninstalled',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      agentId: packedExternalAgentId,
      source: packedExternalSource,
    });
    if (
      uninstalledExternalSessions?.candidates?.ok !== false
      || uninstalledExternalSessions.candidates.errorCode !== 'agent_unavailable'
      || uninstalledExternalSessions?.hooksBeforeUninstall?.ok !== true
      || uninstalledExternalSessions.hooksBeforeUninstall.rows?.[0]?.status?.state
        !== 'unavailable'
      || uninstalledExternalSessions.hooksBeforeUninstall.rows[0].status.installationId
        !== initialPackedHookInstallationId
      || uninstalledExternalSessions?.hookUninstall?.ok !== true
      || uninstalledExternalSessions.hookUninstall.status?.state !== 'not_installed'
      || !Array.isArray(
        uninstalledExternalSessions?.hookConfigAfterUninstall?.hooks?.SessionStart,
      )
      || uninstalledExternalSessions.hookConfigAfterUninstall.hooks.SessionStart.length !== 0
    ) {
      fail(`Packed External Sessions retirement or plugin-independent hook cleanup failed: ${JSON.stringify(uninstalledExternalSessions)}`);
    }
    const uninstalledConnectedAccount = await options.probeConnectedAccounts({
      phase: 'uninstalled',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
      service: Object.freeze({
        pluginId: plugin.pluginId,
        localId: 'novel-cloud',
      }),
      configuredOrigin: connectedAccountProvider.origin,
      staleConfiguredOrigin: staleConnectedAccountProvider.origin,
    });
    if (
      uninstalledConnectedAccount?.begin?.status !== 'unavailable'
      || uninstalledConnectedAccount.begin.code
        !== 'connected_account_daemon_runtime_unavailable'
    ) {
      fail('Packed novel Connected Account remained callable after uninstall');
    }
    stages.push({
      id: 'packed-connected-account-generation-lifecycle',
      ok: true,
      pluginId: plugin.pluginId,
      serviceId: 'novel-cloud',
      replacement: {
        begin: replacedConnectedAccount.begin.status,
        cancellation: replacedConnectedAccount.cancellation.status,
      },
      uninstall: uninstalledConnectedAccount.begin.code,
    });
    const uninstalledRetainedCapabilities = await options.probeRetainedCapabilities({
      phase: 'uninstalled',
      happyHomeDir: childEnv.HAPPIER_HOME_DIR,
      pluginId: plugin.pluginId,
    });
    const uninstalledRetainedProjection = uninstalledRetainedCapabilities?.projection?.projection;
    const uninstalledPluginUiEntries = uninstalledRetainedProjection?.familiesById?.pluginUi?.entriesById ?? {};
    if (
      uninstalledRetainedProjection?.toolsById?.[`${plugin.pluginId}/roundtrip-tool`] !== undefined
      || uninstalledPluginUiEntries[`structuredMessage:${plugin.pluginId}:roundtrip-result`] !== undefined
      || uninstalledPluginUiEntries[`sessionHeaderAction:${plugin.pluginId}:roundtrip-header`] !== undefined
      || uninstalledPluginUiEntries[`hostedWeb:${plugin.pluginId}:main-web`] !== undefined
      || uninstalledRetainedCapabilities?.structuredResolution?.ok !== false
    ) {
      fail(`Packed retained capabilities survived plugin retirement: ${JSON.stringify(uninstalledRetainedCapabilities)}`);
    }
    stages.push({
      id: 'packed-retained-capabilities-lifecycle',
      ok: true,
      pluginId: plugin.pluginId,
      toolId: 'roundtrip-tool',
      structuredMessageId: 'roundtrip-result',
      sessionHeaderActionId: 'roundtrip-header',
      hostedWebRendererId: 'main-web',
      hostedWebArtifactDigest: installedHostedWeb.artifactGraph.digest,
      installedGeneration: installedRetainedProjection.generation,
      uninstalledGeneration: uninstalledRetainedProjection.generation,
    });
    stages.push({
      id: 'packed-external-sessions-lifecycle',
      ok: true,
      agentId: packedExternalAgentId,
      qualifiedPluginId: plugin.pluginId,
      primaryRuntime: 'absent',
      pluginRuntimeMarkers: [...packedExternalSessionMarkerKinds]
        .filter((kind) => kind.startsWith('external-'))
        .sort(),
      installed: {
        candidate: installedExternalSessions.candidates.candidates[0].remoteSessionId,
        sessionId: initialPackedSessionId,
        transcript: installedExternalSessions.page.items[0].id,
        readAfter: installedExternalSessions.readAfter.items[0].id,
        hookInstallationId: initialPackedHookInstallationId,
        hookState: installedExternalSessions.hooksAfterInstall.rows[0].status.state,
      },
      restart: {
        candidate: restartedExternalSessions.candidates.candidates[0].remoteSessionId,
        readAfter: restartedExternalSessions.readAfter.items[0].id,
        hookState: restartedExternalSessions.hookStatus.rows[0].status.state,
      },
      replacement: {
        candidateCursor: replacedExternalSessions.staleCandidates.errorCode,
        transcriptCursor: replacedExternalSessions.staleReadAfter.errorCode,
        transcript: replacedExternalSessions.page.items[0].id,
        readAfter: replacedExternalSessions.readAfter.items[0].id,
        hookState: replacedExternalSessions.hookStatus.rows[0].status.state,
      },
      uninstall: {
        externalSessions: uninstalledExternalSessions.candidates.errorCode,
        hookState: uninstalledExternalSessions.hookUninstall.status.state,
      },
    });

    stages.push({
      id: 'canonical-current-owner',
      ok: afterExplicitClear.commit.t === 'happier_plugin_registry_commit_v1'
        && Number.isInteger(afterExplicitClear.commit.revision)
        && afterExplicitClear.commit.pluginGenerations?.[plugin.pluginId] === undefined,
      revision: afterExplicitClear.commit.revision,
      generations: afterExplicitClear.commit.pluginGenerations,
      observedLifecycleRevisions: {
        install: initialCommit.revision,
        restart: restartCommit.revision,
        failedUpdate: afterFailedUpdateCommit.revision,
        update: updatedCommit.revision,
        rollback: rollbackCommit.revision,
        healthEligible: pendingDevelopmentState.commit.revision,
        healthRecovery: recoveredState.commit.revision,
        uninstall: uninstallCommit.revision,
        explicitHealthClear: afterExplicitClear.commit.revision,
      },
    });
    const daemonStop = await runPackedCli({
      cliEntrypoint,
      cwd: fixtureRoot,
      env: childEnv,
      args: ['daemon', 'stop'],
    });
    assertCommandSucceeded(daemonStop, 'Isolated packed daemon cleanup');
    daemonStopped = true;
    stages.push({ id: 'cleanup', ok: true, disposition: 'daemon-stopped-and-temp-root-scheduled' });

    const baseResult = buildVerticalAResult({
      candidate,
      stages,
      loadedIdentities: {
        packages: { sdk: `${candidate.sdk.packageName}@${candidate.sdk.version}`, cli: `${candidate.cli.packageName}@${candidate.cli.version}` },
        plugins: archiveAttestations,
        initialArtifact,
        daemonRuntime: observedDaemonRuntimeIdentity,
        currentRevision: afterExplicitClear.commit.revision,
        generations: afterExplicitClear.commit.pluginGenerations,
      },
    });
    assertPackedAuthorCredentialSentinelsAbsent({
      commandOutputs: [],
      logs: await readPackedAuthorLogEvidence(tempRoot),
      markerLog: await readFile(join(tempRoot, 'activation.log'), 'utf8')
        .catch((error) => {
          if (error?.code === 'ENOENT') return '';
          throw error;
        }),
      result: null,
    });
    const packedNovelQaHandoff = options.packedNovelQaHandoffRoot
      ? await createPackedNovelConnectedAccountQaHandoff({
          outputRoot: options.packedNovelQaHandoffRoot,
          candidate,
          archiveBytes: initialPackedNovelArchiveBytes,
          pluginArtifact: initialArtifact,
          stages,
        })
      : null;
    const result = packedNovelQaHandoff === null
      ? baseResult
      : {
          ...baseResult,
          packedNovelQaHandoff: {
            manifestPath: packedNovelQaHandoff.manifestPath,
            archivePath: packedNovelQaHandoff.plugin.archivePath,
            integrity: packedNovelQaHandoff.plugin.archive.integrity,
            cleanupOwner: packedNovelQaHandoff.cleanup.owner,
            disposition: 'retained-explicitly',
          },
        };
    succeeded = true;
    return result;
  } catch (error) {
    assertPackedAuthorCredentialSentinelsAbsent({
      commandOutputs: [],
      logs: await readPackedAuthorLogEvidence(tempRoot),
      markerLog: await readFile(join(tempRoot, 'activation.log'), 'utf8')
        .catch((readError) => {
          if (readError?.code === 'ENOENT') return '';
          throw readError;
        }),
      result: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (options.captureLayerResultsOnFailure !== true) {
      throw error;
    }
    const result = buildVerticalAResult({
      candidate,
      stages,
      loadedIdentities: {},
      executionFailure: {
        code: 'packed_author_stage_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return result;
  } finally {
    try {
      await Promise.all([
        registry?.close(),
        publicRegistry?.close(),
        privateRegistry?.close(),
        connectedAccountProvider?.close(),
        staleConnectedAccountProvider?.close(),
      ]);
    } finally {
      if (daemonCleanup && !daemonStopped) {
        await runPackedCli({ ...daemonCleanup, args: ['daemon', 'stop'] }).catch(() => undefined);
      }
      if (shouldRetainPackedAuthorTempRoot({
        succeeded,
        retainFailedTempRequested:
          process.env.HAPPIER_PACKED_AUTHOR_RETAIN_FAILED_TEMP === '1',
      })) {
        process.stderr.write(`Retained failed packed-author temp root: ${tempRoot}\n`);
      } else {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  }
}

export async function runVerticalA(candidate, options = {}) {
  const commandOutputs = [];
  return await packedAuthorCommandOutputCapture.run(commandOutputs, async () => {
    try {
      const result = await runVerticalAWithCapturedOutputs(candidate, options);
      assertPackedAuthorCredentialSentinelsAbsent({
        commandOutputs,
        markerLog: '',
        result,
      });
      return result;
    } catch (error) {
      assertPackedAuthorCredentialSentinelsAbsent({
        commandOutputs,
        markerLog: '',
        result: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  let candidate = null;
  let runStarted = false;
  try {
    const { packedNovelQaHandoffRoot } = parseRunnerArgs(argv);
    candidate = await loadPackedAuthorNaturalArtifacts(argv);
    runStarted = true;
    const result = await runVerticalA(candidate, {
      ...(packedNovelQaHandoffRoot
        ? { packedNovelQaHandoffRoot: resolve(packedNovelQaHandoffRoot) }
        : {}),
    });
    process.stdout.write(`${JSON.stringify({ ...result, startedAt, completedAt: new Date().toISOString(), cleanup: { disposition: 'removed' } })}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      scenario: 'vertical-a',
      candidate: candidate ? { runId: candidate.runId, sdk: candidate.sdk, cli: candidate.cli } : null,
      error: { code: 'packed_author_boundary_failed', message: error instanceof Error ? error.message : String(error) },
      cleanup: { disposition: runStarted ? 'attempted' : 'not_applicable' },
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main();
}
