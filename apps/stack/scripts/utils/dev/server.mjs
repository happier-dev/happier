import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureDepsInstalled, pmExecBin, pmSpawnScript } from '../proc/pm.mjs';
import { killProcessTree, markSpawnedProcessPlannedExit, spawnProc } from '../proc/proc.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { applyServerLightEnvDefaults } from '../server/apply_server_light_env_defaults.mjs';
import { applyRuntimeServerLightSqliteEnv } from '../server/apply_runtime_server_light_sqlite_env.mjs';
import { applyEffectiveDbProviderEnv, resolveEffectiveDbProvider } from '../server/effective_db_provider.mjs';
import { resolveServerDevScript } from '../server/flavor_scripts.mjs';
import { resolveServerShutdownGraceMs } from '../server/shutdown_grace.mjs';
import {
  createListenerOwnershipObservationScope,
  resolveSpawnedProcessGroupListenPid,
  resolveStackOwnedListenPid,
} from '../server/listener_ownership.mjs';
import {
  createServerReadinessDeadline,
  resolveServerMigrationTimeoutMs,
  resolveServerReadyTimeoutMs,
  waitForServerReady,
} from '../server/server.mjs';
import {
  listListenPids,
  listListenPidsWithStatus,
  observeTcpPortAvailability,
  pickNextFreeTcpPort,
  waitForTcpPortFree,
} from '../net/ports.mjs';
import {
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeServerActivation,
  recordStackRuntimeServerLifecycle,
} from '../stack/runtime_state.mjs';
import { getProcessGroupId, isPidOwnedByStack, killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { waitForPgliteDirLockRelease } from '../pglite_lock.mjs';
import { pickMetroPort, resolveStablePortStart } from '../expo/metro_ports.mjs';
import { buildServerRuntimeEnv } from '../server/server_env.mjs';
import { ensureSourceServerWorkspacePackagesBuilt } from '../server/source_server_workspace_deps.mjs';
import {
  readDevReloadWatchChangeSignature as readDevServerWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync as readDevServerWatchChangeSignatureAsync,
} from './watchSignature.mjs';

function readPackageScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function hasPackageScript(dir, scriptName) {
  const script = readPackageScripts(dir)?.[scriptName];
  return typeof script === 'string' && script.trim().length > 0;
}

const DEFAULT_SERVER_RESTART_FAILURE_POLICY = {
  maxFailures: 3,
  windowMs: 60_000,
  backoffMs: 30_000,
  recentLineLimit: 8,
};
const POST_STOP_RELEASE_RETRY_MS = 250;

function normalizeServerRestartFailurePolicy(policy = {}) {
  const readPositive = (name) => {
    const value = Number(policy?.[name] ?? DEFAULT_SERVER_RESTART_FAILURE_POLICY[name]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_SERVER_RESTART_FAILURE_POLICY[name];
  };

  return {
    maxFailures: readPositive('maxFailures'),
    windowMs: readPositive('windowMs'),
    backoffMs: readPositive('backoffMs'),
    recentLineLimit: readPositive('recentLineLimit'),
  };
}

function createRecentLineBuffer(limit) {
  const max = Math.max(0, Number(limit) || 0);
  const lines = [];
  return {
    onLine({ stream, line } = {}) {
      if (max <= 0) return;
      const normalizedLine = String(line ?? '').trimEnd();
      if (!normalizedLine) return;
      lines.push({ stream: stream === 'stdout' ? 'stdout' : 'stderr', line: normalizedLine });
      while (lines.length > max) lines.shift();
    },
    snapshot() {
      return lines.slice();
    },
  };
}

function formatRecentServerOutput(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return [
    '[local] recent server output:',
    ...lines.map((entry) => `[local]   [${entry.stream}] ${entry.line}`),
  ].join('\n');
}

function createServerRestartFailureTracker({ policy, nowImpl }) {
  const normalizedPolicy = normalizeServerRestartFailurePolicy(policy);
  let failures = [];
  let backoffUntilMs = 0;

  const now = () => {
    const value = Number(nowImpl?.());
    return Number.isFinite(value) ? value : Date.now();
  };

  return {
    policy: normalizedPolicy,
    getBackoffRemainingMs() {
      return Math.max(0, backoffUntilMs - now());
    },
    reset() {
      failures = [];
      backoffUntilMs = 0;
    },
    record(failure) {
      if (!failure?.countsTowardBackoff) {
        return { count: failures.length, thresholdReached: false, backoffMs: 0 };
      }

      const currentTime = now();
      const windowStart = currentTime - normalizedPolicy.windowMs;
      failures = failures.filter((timestamp) => timestamp >= windowStart);
      failures.push(currentTime);

      if (failures.length < normalizedPolicy.maxFailures) {
        return { count: failures.length, thresholdReached: false, backoffMs: 0 };
      }

      backoffUntilMs = currentTime + normalizedPolicy.backoffMs;
      failures = [];
      return {
        count: normalizedPolicy.maxFailures,
        thresholdReached: true,
        backoffMs: normalizedPolicy.backoffMs,
      };
    },
  };
}

function classifyServerRestartFailure({
  error,
  stage,
  child,
  oldServerStopped,
  recentLines,
  transportCommitted = false,
  serviceRestored = false,
  directReplacementActive = false,
}) {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = child?.exitCode;
  const signalCode = child?.signalCode;
  let kind = stage || 'restart';
  if (exitCode === 1) {
    kind = 'early_exit';
  } else if (stage === 'spawn') {
    kind = 'spawn';
  } else if (stage === 'readiness' || stage === 'ownership') {
    kind = 'readiness';
  }

  return {
    kind,
    message,
    oldServerStopped: Boolean(oldServerStopped),
    transportCommitted: Boolean(transportCommitted),
    serviceRestored: Boolean(serviceRestored),
    directReplacementActive: Boolean(directReplacementActive),
    exitCode,
    signalCode,
    recentLines: Array.isArray(recentLines) ? recentLines : [],
    countsTowardBackoff: kind === 'spawn' || kind === 'readiness' || kind === 'early_exit',
  };
}

function annotateServerRestartError(error, failure) {
  const annotated = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(annotated, 'serverRestartFailure', {
    value: failure,
    enumerable: false,
    configurable: true,
  });
  return annotated;
}

function requestTransientListenerDiscoveryRetry(error) {
  const observation = error?.observation;
  if (
    error?.code !== 'ELISTENERDISCOVERYINCONCLUSIVE'
    || observation?.supported !== true
    || (observation.status !== 'timeout' && observation.status !== 'error')
  ) return error;
  if (error.reloadRetryAfterMs == null) {
    error.reloadRetryAfterMs = POST_STOP_RELEASE_RETRY_MS;
  }
  return error;
}

function hasChildExited(child) {
  return (
    (child?.exitCode !== null && child?.exitCode !== undefined) ||
    (child?.signalCode !== null && child?.signalCode !== undefined)
  );
}

function getDbProviderFromServerEnv(serverEnv = {}, serverComponentName = 'happier-server-light') {
  const effective = resolveEffectiveDbProvider({ serverComponentName, env: serverEnv });
  return effective.ok ? effective.provider : '';
}

export function createDevServerReloadPlan({ changedDescriptors, descriptorEvidenceConclusive, generation } = {}) {
  const hasGenerationEvidence = Number.isInteger(generation) && generation >= 0;
  // The reload coordinator can carry daemon/build descriptors alongside a shared server change.
  // Prisma inputs have one canonical descriptor; every other known descriptor leaves them unchanged.
  const isKnownReloadDescriptor = (descriptor) => (
    descriptor === 'server:app'
    || descriptor === 'server:prisma'
    || ['shared:', 'daemon:', 'build:'].some((prefix) => (
      descriptor.startsWith(prefix) && descriptor.length > prefix.length
    ))
  );
  const hasDescriptorEvidence = Array.isArray(changedDescriptors)
    && changedDescriptors.length > 0
    && descriptorEvidenceConclusive !== false
    && changedDescriptors.every((descriptor) => (
      typeof descriptor === 'string' && isKnownReloadDescriptor(descriptor)
    ));
  const prismaChanged = hasDescriptorEvidence && changedDescriptors.includes('server:prisma');
  const migrationInputsUnchanged = hasGenerationEvidence
    && hasDescriptorEvidence
    && !prismaChanged;
  return {
    mode: 'exclusiveDb',
    migrationMode: migrationInputsUnchanged ? 'skip' : 'apply',
    generation: hasGenerationEvidence ? generation : 0,
    reason: prismaChanged
      ? 'prisma_changed'
      : migrationInputsUnchanged
        ? 'app_only_descriptor_unchanged'
        : 'migration_evidence_inconclusive',
  };
}

function serverReloadMigrationEnv(reloadPlan) {
  return {
    HAPPIER_STACK_MIGRATE_MODE: reloadPlan.migrationMode === 'skip' ? 'skip' : 'always',
  };
}

function getPgliteDbDirFromServerEnv(serverEnv = {}) {
  return String(serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR ?? serverEnv.HAPPY_SERVER_LIGHT_DB_DIR ?? '').trim();
}

async function waitForProviderDbReleaseIfNeeded(
  serverEnv,
  { waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease } = {},
) {
  if (getDbProviderFromServerEnv(serverEnv) !== 'pglite') return;
  const dbDir = getPgliteDbDirFromServerEnv(serverEnv);
  if (!dbDir) return;
  const released = await waitForPgliteDirLockReleaseImpl(dbDir, { timeoutMs: 5_000, intervalMs: 100 });
  if (released === false) {
    throw new Error(`[local] restart refused: pglite DB lock did not release for ${dbDir}.`);
  }
}

function assertTcpPortReleased(availability, { port, pid, scope }) {
  if (availability?.status === 'free') return;
  const inconclusive = availability?.status === 'inconclusive';
  const reason = availability?.reason ?? 'unknown';
  const error = new Error(
    `[local] watch restart refused: ${scope} ${port} release is ` +
      `${inconclusive ? 'inconclusive' : 'still occupied'} after stopping pid=${pid} (${reason}).`,
  );
  error.code = inconclusive
    ? 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE'
    : 'ESERVERBACKENDPORTOCCUPIED';
  if (inconclusive) error.reloadRetryAfterMs = POST_STOP_RELEASE_RETRY_MS;
  throw error;
}

function requestSafePostStopRetry(error) {
  if (error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE') {
    return requestTransientListenerDiscoveryRetry(error);
  }
  if (
    error?.reloadRetryAfterMs != null
    || error?.code === 'ESERVERPROVISIONALCLEANUPINCOMPLETE'
    || error?.code === 'ESERVERBACKENDPORTOCCUPIED'
  ) return error;
  error.code = error?.code ?? 'ESERVERPOSTSTOPRECOVERYFAILED';
  error.reloadRetryAfterMs = POST_STOP_RELEASE_RETRY_MS;
  return error;
}

export function createDevServerReloadDescriptors({ serverDir, existsSyncImpl = existsSync } = {}) {
  const repoRoot = resolve(serverDir, '..', '..');
  const sharedPackages = ['agents', 'cli-common', 'protocol'];
  const serverAppPaths = [
    join(serverDir, 'sources'),
    join(serverDir, 'scripts'),
    join(serverDir, 'package.json'),
    join(serverDir, 'tsconfig.json'),
    join(serverDir, 'tsconfig.build.json'),
  ];
  const serverPrismaPaths = [join(serverDir, 'prisma')];
  const makeDescriptor = (id, target, paths) => {
    const existingPaths = paths.filter((p) => existsSyncImpl(p));
    return {
      id,
      target,
      paths: existingPaths,
      readSignature: () => readDevServerWatchChangeSignature(existingPaths),
      readSignatureAsync: () => readDevServerWatchChangeSignatureAsync(existingPaths),
    };
  };

  return [
    makeDescriptor('server:app', 'server', serverAppPaths),
    makeDescriptor('server:prisma', 'server', serverPrismaPaths),
    ...sharedPackages.map((pkg) => makeDescriptor(
      `shared:${pkg}`,
      'shared',
      [
        join(repoRoot, 'packages', pkg, 'src'),
        join(repoRoot, 'packages', pkg, 'package.json'),
        join(repoRoot, 'packages', pkg, 'tsconfig.json'),
      ],
    )),
  ].filter((descriptor) => descriptor.paths.length > 0);
}

export async function resolveStackOwnedServerListenPid(
  { serverPort, stackName, envPath },
  {
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    getProcessGroupIdImpl = getProcessGroupId,
    observationScope,
  } = {},
) {
  return await resolveStackOwnedListenPid(
    { port: serverPort, stackName, envPath },
    { listListenPidsImpl, listListenPidsWithStatusImpl, isPidOwnedByStackImpl, getProcessGroupIdImpl, observationScope },
  );
}

async function assertServerPortOwnedBySpawnedProcessGroup({
  serverPort,
  spawnedPid,
  listenerObservationScope,
  ...options
}) {
  return await resolveSpawnedProcessGroupListenPid(
    { port: serverPort, spawnedPid },
    { ...options, observationScope: listenerObservationScope },
  );
}

async function isServerPortOwnedByProcessGroup({
  serverPort,
  rootPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationScope,
}) {
  return Boolean(await resolveServerPortListenerPidInProcessGroup({
    serverPort,
    rootPid,
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
    getProcessGroupIdImpl,
    listenerObservationScope,
  }));
}

async function resolveServerPortListenerPidInProcessGroup({
  serverPort,
  rootPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationScope,
}) {
  try {
    const listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort,
      spawnedPid: rootPid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
      listenerObservationScope,
    });
    if (Number.isFinite(Number(listenerPid)) && Number(listenerPid) > 1) return Number(listenerPid);
    // Unlike provisioning, every caller here is about to stop or adopt a process, so an unproven
    // listener must stay a refusal. Re-read the scope's memoized observation (no second discovery)
    // so the refusal keeps the transient-vs-permanent classification its caller retries on.
    const observation = await listenerObservationScope?.observe(serverPort, {}, { requireListener: true });
    if (observation && observation.status !== 'ok') {
      const error = new Error(
        `[local] server listener ownership could not be proven on port ${serverPort}: ` +
          `${observation.reason ?? observation.status}`,
      );
      error.code = 'ELISTENERDISCOVERYINCONCLUSIVE';
      error.observation = observation;
      throw error;
    }
    return null;
  } catch (error) {
    if (error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE') throw error;
    return null;
  }
}

export async function cleanupProvisionalServerChild({
  child,
  children,
  stackName,
  envPath,
  env = process.env,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
}) {
  if (!child) return true;

  const pid = Number(child.pid);
  let terminationConfirmed = hasChildExited(child);
  if (Number.isFinite(pid) && pid > 1) {
    const result = await killProcessGroupOwnedByStackImpl(
      pid,
      {
        stackName,
        envPath,
        label: 'server',
        json: false,
        graceMs: resolveServerShutdownGraceMs(env),
      },
    ).catch(() => null);
    terminationConfirmed = terminationConfirmed || Boolean(
      result?.killed && result?.reason !== 'killed_pid_only',
    );
  }
  if (!terminationConfirmed) {
    const fallback = await killSpawnedChildImpl(child, 'SIGTERM', {
      graceMs: resolveServerShutdownGraceMs(env),
    }).catch(() => null);
    terminationConfirmed = fallback?.ok === true;
  }

  if (terminationConfirmed) {
    const index = children.indexOf(child);
    if (index >= 0) children.splice(index, 1);
  }
  return terminationConfirmed;
}

function createServerProvisioningCleanupIncompleteError(error, child) {
  const cleanupError = new Error(
    `[local] server provisioning failed and termination of provisional pid=${child?.pid ?? 'unknown'} remains unconfirmed.`,
    { cause: error },
  );
  cleanupError.code = 'ESERVERPROVISIONINGCLEANUPINCOMPLETE';
  cleanupError.provisionalPid = Number(child?.pid) || null;
  return cleanupError;
}

async function killServerProcessGroupForPlannedReload({
  child,
  pid,
  terminationPid = pid,
  stackName,
  envPath,
  serverEnv,
  killProcessGroupOwnedByStackImpl,
  onTerminationRequested,
}) {
  const clearPlannedExit = markSpawnedProcessPlannedExit(child, 'dev-reload');
  let result = null;
  try {
    onTerminationRequested?.();
    result = await killProcessGroupOwnedByStackImpl(terminationPid, {
      stackName,
      envPath,
      label: 'server',
      json: false,
      graceMs: resolveServerShutdownGraceMs(serverEnv),
    });
  } catch (error) {
    clearPlannedExit();
    throw error;
  }
  if (!result?.killed) {
    clearPlannedExit();
  }
  return result;
}

export async function resolveStackOwnedServerRuntimePid(
  { runtimeStatePath, runtimeServerPid, serverPort, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
    observationScope,
  } = {},
) {
  const ownershipScope = observationScope ?? createListenerOwnershipObservationScope({ listListenPidsImpl, listListenPidsWithStatusImpl });
  const state = runtimeStatePath ? await readStackRuntimeStateFileImpl(runtimeStatePath) : null;
  const candidatePid = Number(runtimeServerPid ?? state?.processes?.serverPid);
  if (Number.isFinite(candidatePid) && candidatePid > 1 && isPidAliveImpl(candidatePid)) {
    const owned = await isPidOwnedByStackImpl(candidatePid, { stackName, envPath }).catch(() => false);
    if (owned) {
      const listenerPid = await resolveServerPortListenerPidInProcessGroup({
        serverPort,
        rootPid: candidatePid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
        listenerObservationScope: ownershipScope,
      });
      if (Number.isFinite(Number(listenerPid)) && Number(listenerPid) > 1) {
        return Number(listenerPid);
      }
    }
  }

  const listenPid = await resolveStackOwnedServerListenPidImpl(
    { serverPort, stackName, envPath },
    { listListenPidsImpl, listListenPidsWithStatusImpl, isPidOwnedByStackImpl, getProcessGroupIdImpl, observationScope: ownershipScope },
  );
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1 ? Number(listenPid) : null;
}

export async function stopStackOwnedServerForRestart(
  { pid, serverPort, runtimeStatePath, stackName, envPath, label = 'server', serverEnv = {} },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    waitForTcpPortFreeImpl = waitForTcpPortFree,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
    observeTcpPortAvailabilityImpl = observeTcpPortAvailability,
    listenerObservationScope,
  } = {},
) {
  const observationScope = listenerObservationScope ?? createListenerOwnershipObservationScope({
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
  });
  const state = runtimeStatePath ? await readStackRuntimeStateFileImpl(runtimeStatePath) : null;
  const recordedPid = Number(pid ?? state?.processes?.serverPid);
  let stopPid = null;
  let recordedPidAliveAndOwned = false;

  if (Number.isFinite(recordedPid) && recordedPid > 1 && isPidAliveImpl(recordedPid)) {
    recordedPidAliveAndOwned = await isPidOwnedByStackImpl(recordedPid, { stackName, envPath }).catch(() => false);
    if (recordedPidAliveAndOwned) {
      const listenerPid = await resolveServerPortListenerPidInProcessGroup({
        serverPort,
        rootPid: recordedPid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
        listenerObservationScope: observationScope,
      });
      if (Number.isFinite(Number(listenerPid)) && Number(listenerPid) > 1) {
        stopPid = Number(listenerPid);
      }
    }
  }

  if (!stopPid) {
    const availability = await observeTcpPortAvailabilityImpl(serverPort, {
      host: '127.0.0.1',
      timeoutMs: 1_000,
    });
    if (availability?.status === 'inconclusive') {
      assertTcpPortReleased(availability, { port: serverPort, pid: recordedPid, scope: 'server port' });
    }
    if (availability?.status !== 'free') {
      const listenPid = await resolveStackOwnedServerListenPidImpl(
        { serverPort, stackName, envPath },
        { listListenPidsImpl, listListenPidsWithStatusImpl, isPidOwnedByStackImpl, getProcessGroupIdImpl, observationScope },
      );
      if (!(Number.isFinite(Number(listenPid)) && Number(listenPid) > 1)) {
        throw new Error(
          `[local] restart refused: server port ${serverPort} is occupied and the PID is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
        );
      }
      stopPid = Number(listenPid);
    } else if (recordedPidAliveAndOwned) {
      throw new Error(
        `[local] restart refused: recorded server pid ${recordedPid} is still alive, but server port ${serverPort} has no listener proof for it.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  if (stopPid) {
    const res = await killProcessGroupOwnedByStackImpl(stopPid, {
      stackName,
      envPath,
      label,
      json: true,
      graceMs: resolveServerShutdownGraceMs(serverEnv),
    });
    if (!res?.killed) {
      throw new Error(
        `[local] restart refused: server port ${serverPort} is occupied by a process that could not be stopped safely.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
  assertTcpPortReleased(released, { port: serverPort, pid: recordedPid, scope: 'server port' });

  return { stopped: Boolean(stopPid), pid: recordedPid };
}

export async function preflightDevServerRestart(
  { serverDir, serverEnv = {}, consoleImpl = console },
  { pmExecBinImpl = pmExecBin } = {},
) {
  const parentPreflightAlreadyDone = String(
    serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE ?? '',
  ).trim() === '1';
  delete serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE;
  const enabled = String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT ?? '').trim() !== '0';
  if (!enabled) return { ran: false, reason: 'disabled' };
  if (parentPreflightAlreadyDone) {
    return { ran: false, reason: 'already-done' };
  }
  const runtimeTypecheckScript = hasPackageScript(serverDir, 'typecheck:runtime')
    ? 'typecheck:runtime'
    : hasPackageScript(serverDir, 'build')
      ? 'build'
      : null;
  if (!runtimeTypecheckScript) return { ran: false, reason: 'missing-build-script' };

  consoleImpl.log('[local] watch: server changed → preflight build...');
  if (runtimeTypecheckScript === 'typecheck:runtime' && hasPackageScript(serverDir, 'generate:providers')) {
    await pmExecBinImpl({
      dir: serverDir,
      bin: 'generate:providers',
      args: [],
      env: {
        ...serverEnv,
        HAPPIER_STACK_SKIP_REFRESH_DEPS: serverEnv.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '1',
      },
      quiet: false,
    });
  }
  await pmExecBinImpl({
    dir: serverDir,
    bin: runtimeTypecheckScript,
    args: [],
    env: {
      ...serverEnv,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: serverEnv.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '1',
    },
    quiet: false,
  });
  return {
    ran: true,
    reason: runtimeTypecheckScript === 'typecheck:runtime' ? 'runtime-typecheck-ok' : 'build-ok',
  };
}

export function resolveStackUiDevPortStart({ env = process.env, stackName }) {
  return resolveStablePortStart({
    env: {
      ...env,
      HAPPIER_STACK_UI_DEV_PORT_BASE: (env.HAPPIER_STACK_UI_DEV_PORT_BASE ?? '8081').toString(),
      HAPPIER_STACK_UI_DEV_PORT_RANGE: (env.HAPPIER_STACK_UI_DEV_PORT_RANGE ?? '1000').toString(),
    },
    stackName,
    baseKey: 'HAPPIER_STACK_UI_DEV_PORT_BASE',
    rangeKey: 'HAPPIER_STACK_UI_DEV_PORT_RANGE',
    defaultBase: 8081,
    defaultRange: 1000,
  });
}

export async function pickDevMetroPort({ startPort, reservedPorts = new Set(), host = '127.0.0.1' } = {}) {
  const forcedPort = (process.env.HAPPIER_STACK_UI_DEV_PORT ?? '').toString().trim();
  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function startDevServer({
  serverComponentName,
  serverDir,
  autostart,
  baseEnv,
  serverPort,
  serverBindPort = serverPort,
  internalServerUrl,
  publicServerUrl,
  envPath,
  stackMode,
  runtimeStatePath,
  serverAlreadyRunning,
  restart,
  admitPriorBuildsImmediately = false,
  priorRuntimeServerLaunchSpec = null,
  children,
  spawnOptions = {},
  quiet = false,
  serverProxyRuntime = null,
}, {
  ensureDepsInstalledImpl = ensureDepsInstalled,
  ensureSourceServerWorkspacePackagesBuiltImpl = ensureSourceServerWorkspacePackagesBuilt,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  stopStackOwnedServerForRestartImpl = stopStackOwnedServerForRestart,
  pmSpawnScriptImpl = pmSpawnScript,
  waitForServerReadyImpl = waitForServerReady,
  assertServerPortOwnedBySpawnedProcessGroupImpl = assertServerPortOwnedBySpawnedProcessGroup,
  recordStackRuntimeServerActivationImpl = recordStackRuntimeServerActivation,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  ensureHappyServerManagedInfraImpl = ensureHappyServerManagedInfra,
  applyHappyServerMigrationsImpl = applyHappyServerMigrations,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  spawnPriorRuntimeServerImpl = ({ launchSpec, env, options }) => spawnProc(
    'server',
    launchSpec.command,
    Array.isArray(launchSpec.args) ? launchSpec.args : [],
    env,
    { ...options, cwd: launchSpec.serverDir },
  ),
} = {}) {
  const bindPort = Number(serverBindPort || serverPort);
  const backendInternalServerUrl = `http://127.0.0.1:${bindPort}`;
  const serverEnv = buildServerRuntimeEnv({
    baseEnv,
    serverPort: bindPort,
    publicServerUrl,
  });
  delete baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE;
  const dbProvider = applyEffectiveDbProviderEnv({ serverComponentName, env: baseEnv, targetEnv: serverEnv });
  const explicitDatabaseUrl = serverEnv.DATABASE_URL;
  if (dbProvider === 'mysql' && !String(explicitDatabaseUrl ?? '').trim()) {
    throw new Error('[local] mysql requires an explicit DATABASE_URL before managed infra startup');
  }

  if (serverComponentName === 'happier-server-light') {
    applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir: autostart.baseDir });
  }
  let usePriorRuntime = Boolean(
    serverComponentName === 'happier-server-light'
    && priorRuntimeServerLaunchSpec?.source === 'runtime'
    && String(priorRuntimeServerLaunchSpec?.command ?? '').trim(),
  );

  // Dependency preparation owns the tools used by infrastructure and migrations.
  // Keep it after provider/topology admission so invalid configurations remain side-effect free.
  const prepareDependencies = async ({ admitPrior }) => {
    await ensureDepsInstalledImpl(serverDir, serverComponentName, {
      quiet,
      env: serverEnv,
      ...(admitPrior
        ? { refreshExisting: false, prepareComponentOutputs: false }
        : {}),
    });
  };
  if (!usePriorRuntime) {
    await prepareDependencies({ admitPrior: admitPriorBuildsImmediately });
  }

  if (serverComponentName === 'happier-server') {
    const managed = (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      const infra = await ensureHappyServerManagedInfraImpl({
        stackName: autostart.stackName,
        baseDir: autostart.baseDir,
        serverPort,
        publicServerUrl,
        envPath,
        env: serverEnv,
        dbProvider,
      });
      Object.assign(serverEnv, infra.env);
      if (dbProvider === 'mysql') serverEnv.DATABASE_URL = explicitDatabaseUrl;
    }

    const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
    if (autoMigrate) {
      await applyHappyServerMigrationsImpl({ serverDir, env: serverEnv, dbProvider });
    }
  }

  const prismaPush = (baseEnv.HAPPIER_STACK_PRISMA_PUSH ?? '1').toString().trim() !== '0';
  const serverScript = resolveServerDevScript({ serverComponentName, serverDir, prismaPush });

  const ensureWorkspacePackagesBuiltBeforeSpawn = async ({
    admitPrior = admitPriorBuildsImmediately,
  } = {}) => {
    try {
      await ensureSourceServerWorkspacePackagesBuiltImpl({
        runtimeBackedStart: false,
        serverDir,
        quiet,
        env: serverEnv,
        admitPriorOutputsImmediately: admitPrior,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure.code !== 'EEXIT') throw failure;
      Object.defineProperty(failure, 'devServerWorkspaceAdmissionFailure', {
        value: {
          stage: 'workspace-admission',
          serverEnv,
          serverScript,
        },
        enumerable: false,
        configurable: true,
      });
      throw failure;
    }
  };

  // Restart behavior (stack-safe): only kill when we can prove ownership via runtime state
  // or a stale listener that is still bound to this stack.
  if (restart && stackMode && runtimeStatePath) {
    if (!usePriorRuntime) {
      if (admitPriorBuildsImmediately) {
        // The workspace-build owner validates retained outputs and rebuilds when they are missing
        // or invalid. Do not make source freshness a startup gate for a watch lifecycle.
        await ensureWorkspacePackagesBuiltBeforeSpawn({ admitPrior: true });
      } else {
        const preflightResult = await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, consoleImpl: console });
        if (preflightResult?.ran !== true) {
          await ensureWorkspacePackagesBuiltBeforeSpawn();
        }
      }
    }
  }

  if (restart && stackMode && runtimeStatePath && serverAlreadyRunning) {
    await stopStackOwnedServerForRestartImpl({
      serverPort,
      runtimeStatePath,
      stackName: autostart.stackName,
      envPath,
      serverEnv,
    });
    await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
  }

  if (serverAlreadyRunning && !restart) {
    return { serverEnv, serverScript, serverProc: null };
  }

  if (!usePriorRuntime && !(restart && stackMode && runtimeStatePath)) {
    await ensureWorkspacePackagesBuiltBeforeSpawn();
  }

  const provisionServer = async () => {
    const launchEnv = usePriorRuntime ? { ...serverEnv } : serverEnv;
    if (usePriorRuntime) {
      applyRuntimeServerLightSqliteEnv({
        env: launchEnv,
        serverDir: priorRuntimeServerLaunchSpec.serverDir,
      });
      // A last-known-good runtime must not replay its older migration ledger against a database
      // that may already have advanced. The current source refresh remains the migration owner.
      launchEnv.HAPPIER_SQLITE_AUTO_MIGRATE = '0';
    }
    const readinessTimeoutMs = resolveServerReadyTimeoutMs({ serverComponentName, env: launchEnv });
    const startupDeadline = createServerReadinessDeadline({
      readinessTimeoutMs,
      migrationTimeoutMs: resolveServerMigrationTimeoutMs({ env: launchEnv }),
    });
    const existingOnLine = spawnOptions?.onLine;
    const options = {
      ...spawnOptions,
      onLine(lineEvent) {
        startupDeadline.observeLine(lineEvent);
        existingOnLine?.(lineEvent);
      },
    };
    const server = usePriorRuntime
      ? await spawnPriorRuntimeServerImpl({
          launchSpec: priorRuntimeServerLaunchSpec,
          env: launchEnv,
          options,
        })
      : await pmSpawnScriptImpl({
        label: 'server',
        dir: serverDir,
        script: serverScript,
        env: launchEnv,
        options: {
          ...spawnOptions,
          onLine(lineEvent) {
            startupDeadline.observeLine(lineEvent);
            existingOnLine?.(lineEvent);
          },
        },
        quiet,
      });
    children.push(server);
    let listenerPid = null;
    try {
      startupDeadline.startReadiness();
      await waitForServerReadyImpl(backendInternalServerUrl, {
        timeoutMs: readinessTimeoutMs,
        childProcess: server,
        startupDeadline,
      });
      if (backendInternalServerUrl !== internalServerUrl) {
        await waitForServerReadyImpl(internalServerUrl, {
          timeoutMs: readinessTimeoutMs,
          childProcess: server,
        });
      }
      listenerPid = await assertServerPortOwnedBySpawnedProcessGroupImpl({
        serverPort: bindPort,
        spawnedPid: server.pid,
      });
      if (!(Number(listenerPid) > 1) && !quiet) {
        console.warn(
          `[local] server listener ownership on port ${bindPort} could not be proven ` +
            `(listener discovery inconclusive); keeping the ready server (pid=${server.pid}) ` +
            'and recording no listener PID.',
        );
      }
      if (hasChildExited(server)) {
        throw new Error(`[local] server process exited after readiness check (pid=${server.pid}, code=${server.exitCode})`);
      }
      return { server, listenerPid };
    } catch (error) {
      const cleanupConfirmed = await cleanupProvisionalServerChild({
        child: server,
        children,
        stackName: autostart.stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
        killSpawnedChildImpl,
      });
      if (!cleanupConfirmed) {
        throw createServerProvisioningCleanupIncompleteError(error, server);
      }
      throw error;
    }
  };

  const attemptedPriorRuntime = usePriorRuntime;
  let provisioned;
  try {
    provisioned = await provisionServer();
  } catch (error) {
    if (!admitPriorBuildsImmediately || error?.code === 'ESERVERPROVISIONINGCLEANUPINCOMPLETE') {
      throw error;
    }
    const failureMessage = error instanceof Error ? error.message : String(error);
    if (attemptedPriorRuntime) {
      if (!quiet) {
        console.warn(`[local] prior runtime server could not start (${failureMessage}); trying existing source outputs before refreshing.`);
      }
      usePriorRuntime = false;
      await prepareDependencies({ admitPrior: true });
      await ensureWorkspacePackagesBuiltBeforeSpawn({ admitPrior: true });
      try {
        provisioned = await provisionServer();
      } catch (sourceError) {
        if (sourceError?.code === 'ESERVERPROVISIONINGCLEANUPINCOMPLETE') {
          throw sourceError;
        }
        const sourceFailureMessage = sourceError instanceof Error ? sourceError.message : String(sourceError);
        if (!quiet) {
          console.warn(`[local] existing source server could not start (${sourceFailureMessage}); refreshing once before retrying.`);
        }
      }
    } else if (!quiet) {
      console.warn(`[local] prior server generation could not start (${failureMessage}); refreshing once before retrying.`);
    }
    if (!provisioned) {
      await prepareDependencies({ admitPrior: false });
      await ensureWorkspacePackagesBuiltBeforeSpawn({ admitPrior: false });
      usePriorRuntime = false;
      provisioned = await provisionServer();
    }
  }
  const { server, listenerPid } = provisioned;
  if (stackMode && runtimeStatePath) {
    const activationMode = serverProxyRuntime?.mode === 'proxy'
      ? 'proxy'
      : serverProxyRuntime?.mode === 'directFallback'
        ? 'directFallback'
        : 'direct';
    await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
      listenerPid,
      wrapperPid: server.pid,
      stablePort: serverPort,
      backendPort: activationMode === 'proxy' ? bindPort : null,
      proxyPid: activationMode === 'proxy' ? serverProxyRuntime?.proxyPid : null,
      drainingPid: null,
      mode: activationMode,
      restartMode: serverProxyRuntime?.restartMode ?? null,
      reloadGeneration: serverProxyRuntime?.reloadGeneration ?? null,
      fallbackReason: serverProxyRuntime?.fallbackReason ?? null,
      clearProxyState: activationMode === 'direct',
    });
  }
  return {
    serverEnv,
    serverScript,
    serverProc: server,
    bootstrapSource: usePriorRuntime ? 'runtime' : 'source',
  };
}

function localServerUrlForPort(port) {
  return `http://127.0.0.1:${Number(port)}`;
}

function resolveDevProxyDrainMs(serverEnv = {}) {
  const rawValue = serverEnv.HAPPIER_STACK_DEV_PROXY_DRAIN_MS;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return 2000;
  const raw = Number(rawValue);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 2000;
}

function sleepMs(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  return delayMs > 0 ? new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)) : Promise.resolve();
}

function removeChildFromChildren(children, child) {
  const index = Array.isArray(children) ? children.indexOf(child) : -1;
  if (index >= 0) children.splice(index, 1);
}

export function createDevServerReloadExecutor({
  enabled,
  stackMode,
  serverComponentName,
  serverDir,
  serverPort,
  serverBindPort = serverPort,
  internalServerUrl,
  serverScript,
  serverEnv,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  serverProcRef,
  isShuttingDown,
  proxyController = null,
  priorRuntimeServerLaunchSpec = null,
}, {
  preflightDevServerRestartImpl = preflightDevServerRestart,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  pmSpawnScriptImpl = pmSpawnScript,
  spawnPriorRuntimeServerImpl = ({ launchSpec, env, options }) => spawnProc(
    'server',
    launchSpec.command,
    Array.isArray(launchSpec.args) ? launchSpec.args : [],
    env,
    { ...options, cwd: launchSpec.serverDir },
  ),
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  isPidAliveImpl = isPidAlive,
  recordStackRuntimeServerActivationImpl = recordStackRuntimeServerActivation,
  recordStackRuntimeServerLifecycleImpl = recordStackRuntimeServerLifecycle,
  nowImpl = Date.now,
  monotonicNowImpl = () => performance.now(),
  restartFailurePolicy,
  logger = console,
  sleepImpl = sleepMs,
} = {}) {
  let activeBackendPort = Number(serverBindPort || serverPort);
  let activeReloadGeneration = null;
  let availabilityRecoveryPromise = null;
  let unresolvedProvisional = null;
  const restartFailureTracker = createServerRestartFailureTracker({ policy: restartFailurePolicy, nowImpl });
  let unexpectedExitHandler = null;
  let observedActiveChild = null;
  let observedActiveExitListener = null;
  const disarmActiveChildExit = (child = observedActiveChild) => {
    if (!child || child !== observedActiveChild) return;
    if (observedActiveExitListener) {
      child.off?.('exit', observedActiveExitListener);
      child.removeListener?.('exit', observedActiveExitListener);
    }
    observedActiveChild = null;
    observedActiveExitListener = null;
  };
  const reportUnexpectedActiveExit = (child, code, signal) => {
    const handler = unexpectedExitHandler;
    if (typeof handler !== 'function' || isShuttingDown?.()) return;
    Promise.resolve(handler({
      child,
      pid: Number(child?.pid) || null,
      code: code ?? child?.exitCode ?? null,
      signal: signal ?? child?.signalCode ?? null,
    })).catch((error) => {
      logger.error?.(`[local] watch: active server exit recovery request failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const observeActiveChildExit = (child) => {
    disarmActiveChildExit();
    if (!child || typeof unexpectedExitHandler !== 'function') return;
    observedActiveChild = child;
    observedActiveExitListener = (code, signal) => {
      if (observedActiveChild !== child) return;
      observedActiveChild = null;
      observedActiveExitListener = null;
      reportUnexpectedActiveExit(child, code, signal);
    };
    if (hasChildExited(child)) {
      queueMicrotask(() => observedActiveExitListener?.(child.exitCode, child.signalCode));
      return;
    }
    child.once?.('exit', observedActiveExitListener);
  };
  const createReloadPlanForContext = (context = {}) => context.reloadPlans?.server ?? createDevServerReloadPlan({
    dbProvider: getDbProviderFromServerEnv(serverEnv, serverComponentName),
    changedDescriptors: context.changedDescriptors,
    descriptorEvidenceConclusive: context.descriptorEvidenceConclusive,
    generation: context.generation,
  });
  const publishLifecycle = async (transition) => {
    if (!(stackMode && runtimeStatePath)) return null;
    return await recordStackRuntimeServerLifecycleImpl(runtimeStatePath, transition);
  };
  const activeBackendIsProvablyUnavailable = async () => {
    const activeChild = serverProcRef?.current;
    const activePid = Number(activeChild?.pid);
    if (!Number.isInteger(activePid) || activePid <= 1) return false;
    if (!hasChildExited(activeChild) && isPidAliveImpl(activePid)) return false;
    try {
      const observation = await listListenPidsWithStatusImpl(
        proxyController ? activeBackendPort : serverPort,
        { timeoutMs: 1_000 },
      );
      return observation?.status === 'ok' && observation.pids.length === 0;
    } catch {
      return false;
    }
  };
  const publishFailureDisposition = async ({ error, plan, retryScheduled, retryAfterMs }) => {
    const failure = error?.serverRestartFailure;
    const annotatedUnavailable = failure?.oldServerStopped === true
      && failure?.serviceRestored !== true
      && failure?.transportCommitted !== true
      && failure?.activationCommitUnknown !== true
      && failure?.kind !== 'cleanup_incomplete'
      && error?.code !== 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
    const observedUnavailable = failure?.serviceRestored !== true
      && failure?.transportCommitted !== true
      && failure?.activationCommitUnknown !== true
      && failure?.kind !== 'cleanup_incomplete'
      && error?.code !== 'ESERVERPROVISIONALCLEANUPINCOMPLETE'
      && await activeBackendIsProvablyUnavailable();
    const unavailable = annotatedUnavailable || observedUnavailable;
    const transition = {
      phase: retryScheduled ? 'retry-scheduled' : unavailable ? 'unavailable' : 'blocked',
      plan,
      ...(retryScheduled ? { retryAfterMs } : {
        disposition: { code: String(failure?.stage ?? failure?.kind ?? error?.code ?? 'restart_failed') },
      }),
    };
    let projectionError = null;
    try {
      await publishLifecycle(transition);
    } catch (caught) {
      projectionError = caught;
    }

    const activationAmbiguous = failure?.activationCommitUnknown === true
      && failure?.activationTargetObserved === 'other';
    if (proxyController && (unavailable || activationAmbiguous)) {
      try {
        await proxyController.enterMaintenance?.(retryScheduled ? {
          retryAfterMs,
          retryable: true,
          message: 'Server reload recovery pending',
        } : {
          retryAfterMs: 0,
          retryable: false,
          message: activationAmbiguous
            ? 'Server activation outcome is unresolved; operator attention is required.'
            : 'Server unavailable; edit or restart the stack.',
        });
      } catch (caught) {
        if (!projectionError) projectionError = caught;
        else projectionError.message += `; proxy maintenance projection failed: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    }
    if (projectionError) throw projectionError;
    return transition;
  };
  const emitTransitionEvent = (event, details = {}) => {
    try {
      const nowMs = Number(nowImpl?.());
      const monotonicMs = Number(monotonicNowImpl?.());
      const timestamp = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
      const payload = Object.fromEntries(Object.entries({
        event,
        timestamp,
        monotonicMs: Number.isFinite(monotonicMs) ? monotonicMs : null,
        ...details,
      }).filter(([, value]) => value !== null && value !== undefined));
      logger.log(JSON.stringify(payload));
    } catch {
      // Observability must not become lifecycle authority.
    }
  };

  const cleanupSpawnedChild = async (child) => {
    return await cleanupProvisionalServerChild({
      child,
      children,
      stackName,
      envPath,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
    });
  };

  const retainUnresolvedChild = (child, details = {}) => {
    unresolvedProvisional = { child, ...details };
  };

  const spawnServerBackend = async ({
    port,
    recentLineBuffer,
    envOverrides = {},
    reloadPlan,
    purpose = 'replacement',
    launchSource = 'source',
  }) => {
    const nextEnv = { ...serverEnv, ...envOverrides, PORT: String(port) };
    const usePriorRuntime = launchSource === 'prior-runtime';
    if (usePriorRuntime) {
      applyRuntimeServerLightSqliteEnv({
        env: nextEnv,
        serverDir: priorRuntimeServerLaunchSpec.serverDir,
      });
      nextEnv.HAPPIER_SQLITE_AUTO_MIGRATE = '0';
    }
    let next = null;
    const transition = {
      generation: reloadPlan?.generation,
      mode: reloadPlan?.mode,
      migrationMode: reloadPlan?.migrationMode,
      targetPort: port,
      purpose,
    };
    let migrationStarted = false;
    let migrationCompleted = false;
    const startupDeadline = createServerReadinessDeadline({
      readinessTimeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: nextEnv }),
      migrationTimeoutMs: resolveServerMigrationTimeoutMs({ env: nextEnv }),
    });
    if (reloadPlan?.migrationMode === 'skip') emitTransitionEvent('migration_skipped', transition);
    const onLine = (lineEvent) => {
      recentLineBuffer.onLine(lineEvent);
      const signal = startupDeadline.observeLine(lineEvent);
      if (reloadPlan?.migrationMode === 'skip') return;
      if (signal === 'migration_started' && !migrationStarted) {
        migrationStarted = true;
        emitTransitionEvent('migration_started', transition);
      } else if (signal === 'migration_completed' && migrationStarted && !migrationCompleted) {
        migrationCompleted = true;
        emitTransitionEvent('migration_completed', { ...transition, disposition: 'succeeded' });
      }
    };
    try {
      next = usePriorRuntime
        ? await spawnPriorRuntimeServerImpl({
            launchSpec: priorRuntimeServerLaunchSpec,
            env: nextEnv,
            options: { onLine },
          })
        : await pmSpawnScriptImpl({
            label: 'server',
            dir: serverDir,
            script: serverScript,
            env: nextEnv,
            options: { onLine },
          });
      children.push(next);
      emitTransitionEvent('replacement_spawned', { ...transition, pid: next.pid });
      const readyUrl = localServerUrlForPort(port);
      startupDeadline.startReadiness();
      await waitForServerReadyImpl(readyUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: nextEnv }),
        childProcess: next,
        startupDeadline,
      });
      const listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort: port,
        spawnedPid: next.pid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
      emitTransitionEvent('replacement_ready', { ...transition, pid: next.pid, listenerPid });
      return { child: next, listenerPid };
    } catch (error) {
      if (migrationStarted && !migrationCompleted) {
        emitTransitionEvent('migration_completed', { ...transition, pid: next?.pid, disposition: 'failed' });
      }
      if (next) emitTransitionEvent('replacement_readiness_failed', { ...transition, pid: next.pid });
      const cleanupConfirmed = await cleanupSpawnedChild(next);
      if (next && !cleanupConfirmed) {
        const cleanupError = new Error(
          `[local] provisional server termination was not confirmed after startup failure ` +
            `(pid=${next.pid ?? 'unknown'}, port=${port}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        cleanupError.code = 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
        cleanupError.provisionalChild = next;
        throw cleanupError;
      }
      throw error;
    }
  };

  const observePortAndDatabaseRelease = async ({ port, pid, scope, reloadPlan }) => {
    const transition = {
      generation: reloadPlan?.generation,
      mode: reloadPlan?.mode,
      currentPort: port,
      purpose: 'replacement',
    };
    let portDisposition = 'inconclusive';
    let databaseDisposition = getDbProviderFromServerEnv(serverEnv, serverComponentName) === 'pglite'
      ? 'pending'
      : 'not_applicable';
    try {
      const availability = await waitForTcpPortFreeImpl(port, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
      portDisposition = availability?.status === 'free' ? 'free' : String(availability?.status ?? 'inconclusive');
      assertTcpPortReleased(availability, { port, pid, scope });
      await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
      if (databaseDisposition === 'pending') databaseDisposition = 'released';
      emitTransitionEvent('port_database_release_result', {
        ...transition,
        disposition: 'released',
        portDisposition,
        databaseDisposition,
      });
    } catch (error) {
      if (error?.code === 'ESERVERBACKENDPORTOCCUPIED') portDisposition = 'occupied';
      if (error?.code === 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE') portDisposition = 'inconclusive';
      if (portDisposition === 'free' && databaseDisposition === 'pending') databaseDisposition = 'blocked';
      emitTransitionEvent('port_database_release_result', {
        ...transition,
        disposition: portDisposition === 'occupied'
          ? 'occupied'
          : portDisposition === 'inconclusive'
            ? 'inconclusive'
            : 'blocked',
        portDisposition,
        databaseDisposition,
      });
      throw error;
    }
  };

  const recordProxyBackend = async ({ backendPort, listenerPid, wrapperPid, reloadPlan, drainingPid = null }) => {
    if (!(stackMode && runtimeStatePath)) return;
    await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
      listenerPid,
      wrapperPid,
      stablePort: serverPort,
      backendPort,
      proxyPid: proxyController?.pid,
      drainingPid,
      mode: 'proxy',
      restartMode: reloadPlan.mode,
      reloadGeneration: reloadPlan.generation,
    });
    if (Number.isInteger(reloadPlan.generation) && reloadPlan.generation >= 0) {
      activeReloadGeneration = reloadPlan.generation;
    }
  };

  const recoverUnexpectedExit = async (event = {}) => {
    const recoverySupported = Boolean(
      proxyController
      && serverComponentName === 'happier-server-light'
      && priorRuntimeServerLaunchSpec?.source === 'runtime'
      && String(priorRuntimeServerLaunchSpec?.command ?? '').trim(),
    );
    if (!recoverySupported || isShuttingDown?.()) return { recovered: false, reason: 'unavailable' };
    if (availabilityRecoveryPromise) return await availabilityRecoveryPromise;

    const exitedChild = event?.child ?? serverProcRef?.current;
    if (serverProcRef?.current && serverProcRef.current !== exitedChild && !hasChildExited(serverProcRef.current)) {
      return { recovered: false, reason: 'replacement-active' };
    }

    availabilityRecoveryPromise = (async () => {
      const exitedPid = Number(event?.pid ?? exitedChild?.pid);
      const reloadPlan = {
        mode: 'exclusiveDb',
        migrationMode: 'skip',
        generation: activeReloadGeneration,
        reason: 'prior_runtime_availability_recovery',
      };
      removeChildFromChildren(children, exitedChild);
      await observePortAndDatabaseRelease({
        port: activeBackendPort,
        pid: exitedPid,
        scope: 'exited server backend port',
        reloadPlan,
      });
      const fallbackPort = await pickNextFreeTcpPortImpl(activeBackendPort + 1, {
        host: '127.0.0.1',
        reservedPorts: new Set([Number(serverPort), activeBackendPort]),
      });
      const fallback = await spawnServerBackend({
        port: fallbackPort,
        recentLineBuffer: createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit),
        envOverrides: { HAPPIER_SQLITE_AUTO_MIGRATE: '0' },
        reloadPlan,
        purpose: 'prior-runtime-fallback',
        launchSource: 'prior-runtime',
      });
      await proxyController.flipUpstream?.({ targetPort: fallbackPort });
      serverProcRef.current = fallback.child;
      activeBackendPort = fallbackPort;
      observeActiveChildExit(fallback.child);
      await recordProxyBackend({
        backendPort: fallbackPort,
        listenerPid: fallback.listenerPid,
        wrapperPid: fallback.child.pid,
        reloadPlan,
      });
      logger.warn?.(
        `[local] watch: restored prior runtime after active server exit ` +
          `(pid=${fallback.child.pid}, backendPort=${fallbackPort}); refreshing source in the background.`,
      );
      return { recovered: true, pid: fallback.child.pid, backendPort: fallbackPort };
    })();
    try {
      return await availabilityRecoveryPromise;
    } finally {
      availabilityRecoveryPromise = null;
    }
  };

  const backendDrainTarget = (port) => ({
    targetHost: '127.0.0.1',
    targetPort: Number(port),
  });

  const normalizeDrainTarget = (target) => {
    if (!target) return null;
    const targetPort = Number(target.targetPort ?? target.port);
    if (!Number.isInteger(targetPort) || targetPort <= 0) return null;
    return {
      targetHost: String(target.targetHost ?? target.host ?? '127.0.0.1'),
      targetPort,
    };
  };

  const drainProxyTargets = async (targets, { graceMs = 0 } = {}) => {
    const normalizedTargets = targets
      .map((target) => normalizeDrainTarget(target))
      .filter(Boolean);

    if (typeof proxyController?.drainConnections === 'function') {
      for (const target of normalizedTargets) {
        await proxyController.drainConnections({ ...target, graceMs });
      }
      return;
    }

    if (normalizedTargets.length === 0 && typeof proxyController?.drainOldConnections === 'function') {
      await proxyController.drainOldConnections({ graceMs });
    }
  };

  const flipProxyUpstreamAndDrainTargets = async ({
    targetPort,
    drainTargets,
    graceMs = resolveDevProxyDrainMs(serverEnv),
    transition = {},
  }) => {
    emitTransitionEvent('backend_activation_requested', { targetPort, ...transition });
    await proxyController.flipUpstream?.({ targetPort });
    emitTransitionEvent('backend_activation_acknowledged', { targetPort, ...transition });
    emitTransitionEvent('maintenance_exited', { targetPort, ...transition });
    await drainProxyTargets(drainTargets, { graceMs });
  };

  const restartWithExclusiveDbProxy = async (reloadPlan, context = {}) => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    const hasCurrentServer = Number.isFinite(pid) && pid > 1;

    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    const oldBackendPort = activeBackendPort;
    const oldBackendTarget = backendDrainTarget(oldBackendPort);
    let oldServerStopped = false;
    let replacement = null;
    let replacementTransportCommitted = false;
    let maintenanceTarget = null;
    let attemptedReplacementTarget = null;

    const currentPidWasAlive = hasCurrentServer && !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
    const precheckObservationScope = currentPidWasAlive
      ? createListenerOwnershipObservationScope({
          listListenPidsImpl,
          listListenPidsWithStatusImpl,
        })
      : null;
    const currentListenerPid = currentPidWasAlive
      ? await resolveServerPortListenerPidInProcessGroup({
          serverPort: oldBackendPort,
          rootPid: pid,
          listListenPidsImpl,
          listListenPidsWithStatusImpl,
          getProcessGroupIdImpl,
          listenerObservationScope: precheckObservationScope,
        })
      : null;
    const ownsCurrentListener = Number.isFinite(Number(currentListenerPid)) && Number(currentListenerPid) > 1;
    if (
      hasCurrentServer
      && context.allowSupersededActivation !== true
      && typeof context.revalidateGeneration === 'function'
      && !await context.revalidateGeneration()
    ) return false;
    if (!ownsCurrentListener && currentPidWasAlive) {
      const availability = await waitForTcpPortFreeImpl(oldBackendPort, {
        host: '127.0.0.1',
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (!currentPidStillAlive && availability?.status !== 'free') {
        assertTcpPortReleased(availability, {
          port: oldBackendPort,
          pid,
          scope: 'server backend port',
        });
      }
      if (currentPidStillAlive || availability?.status !== 'free') {
        throw new Error(
          `[local] watch restart refused: server backend port ${oldBackendPort} is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
    } else if (!ownsCurrentListener) {
      oldServerStopped = true;
    }

    maintenanceTarget = normalizeDrainTarget(await proxyController.enterMaintenance?.({
      retryAfterMs: Math.max(1, resolveDevProxyDrainMs(serverEnv)),
      message: 'Server reload in progress',
    }));
    emitTransitionEvent('maintenance_entered', {
      generation: reloadPlan.generation,
      pid,
      currentPort: oldBackendPort,
      mode: reloadPlan.mode,
      purpose: 'replacement',
    });
    try {
      await publishLifecycle({ phase: 'maintenance', plan: reloadPlan });
    } catch (error) {
      if (hasCurrentServer) {
        await flipProxyUpstreamAndDrainTargets({
          targetPort: oldBackendPort,
          drainTargets: [maintenanceTarget],
          transition: {
            generation: reloadPlan.generation,
            pid,
            mode: reloadPlan.mode,
            purpose: 'maintenance_restore',
          },
        });
      }
      throw error;
    }
    if (
      hasCurrentServer
      && context.allowSupersededActivation !== true
      && typeof context.revalidateGeneration === 'function'
      && !await context.revalidateGeneration()
    ) {
      await flipProxyUpstreamAndDrainTargets({
        targetPort: oldBackendPort,
        drainTargets: [maintenanceTarget],
        transition: {
          generation: reloadPlan.generation,
          pid,
          mode: reloadPlan.mode,
          purpose: 'maintenance_restore',
        },
      });
      return false;
    }
    if (ownsCurrentListener) {
      disarmActiveChildExit(currentServerProc);
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        terminationPid: Number(currentListenerPid),
        stackName,
        envPath,
        serverEnv,
        killProcessGroupOwnedByStackImpl,
        onTerminationRequested: () => emitTransitionEvent('old_server_shutdown_requested', {
          generation: reloadPlan.generation,
          pid,
          currentPort: oldBackendPort,
          mode: reloadPlan.mode,
          purpose: 'replacement',
        }),
      });
      if (!killResult?.killed) {
        const release = await waitForTcpPortFreeImpl(oldBackendPort, {
          host: '127.0.0.1',
          timeoutMs: 5_000,
          intervalMs: 100,
        });
        const exitedConcurrently = (
          hasChildExited(currentServerProc)
          || !isPidAliveImpl(pid)
        ) && release?.status === 'free';
        if (!exitedConcurrently) {
          observeActiveChildExit(currentServerProc);
          await flipProxyUpstreamAndDrainTargets({
            targetPort: oldBackendPort,
            drainTargets: [maintenanceTarget],
            transition: {
              generation: reloadPlan.generation,
              pid,
              mode: reloadPlan.mode,
              purpose: 'maintenance_restore',
            },
          });
          throw new Error(
            `[local] watch restart refused: server pid ${pid} owns backend port ${oldBackendPort} but could not be stopped safely ` +
              `(reason=${killResult?.reason ?? 'unknown'}).\n` +
              `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
          );
        }
      }
      oldServerStopped = true;
      removeChildFromChildren(children, currentServerProc);
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: oldBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'exited',
      });
    } else {
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: oldBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'already_exited',
      });
    }

    try {
      await observePortAndDatabaseRelease({
        port: oldBackendPort,
        pid: hasCurrentServer ? pid : null,
        scope: hasCurrentServer ? 'server backend port' : 'unavailable server backend port',
        reloadPlan,
      });
      const nextBackendPort = hasCurrentServer
        ? await pickNextFreeTcpPortImpl(oldBackendPort + 1, {
            host: '127.0.0.1',
            reservedPorts: new Set([Number(serverPort), oldBackendPort]),
          })
        : oldBackendPort;
      attemptedReplacementTarget = backendDrainTarget(nextBackendPort);
      replacement = await spawnServerBackend({
        port: nextBackendPort,
        recentLineBuffer,
        envOverrides: serverReloadMigrationEnv(reloadPlan),
        reloadPlan,
        purpose: 'replacement',
      });
      emitTransitionEvent('backend_activation_requested', {
        generation: reloadPlan.generation,
        pid: replacement.child.pid,
        currentPort: oldBackendPort,
        targetPort: nextBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
      });
      await proxyController.flipUpstream?.({ targetPort: nextBackendPort });
      emitTransitionEvent('backend_activation_acknowledged', {
        generation: reloadPlan.generation,
        pid: replacement.child.pid,
        currentPort: oldBackendPort,
        targetPort: nextBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
      });
      emitTransitionEvent('maintenance_exited', {
        generation: reloadPlan.generation,
        pid: replacement.child.pid,
        targetPort: nextBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
      });
      replacementTransportCommitted = true;
      serverProcRef.current = replacement.child;
      observeActiveChildExit(replacement.child);
      activeBackendPort = nextBackendPort;
      await drainProxyTargets([maintenanceTarget, oldBackendTarget], {
        graceMs: resolveDevProxyDrainMs(serverEnv),
      });
      await recordProxyBackend({
        backendPort: nextBackendPort,
        listenerPid: replacement.listenerPid,
        wrapperPid: replacement.child.pid,
        reloadPlan,
      }).catch((error) => {
        throw annotateServerRestartError(
          error,
          classifyServerRestartFailure({
            error,
            stage: 'post_commit',
            child: replacement.child,
            oldServerStopped,
            transportCommitted: true,
            serviceRestored: true,
            recentLines: recentLineBuffer.snapshot(),
          }),
        );
      });
      logger.log(`[local] watch: server restarted behind proxy (pid=${replacement.child.pid}, backendPort=${nextBackendPort})`);
      return true;
    } catch (error) {
      if (error?.serverRestartFailure?.serviceRestored === true) throw error;
      let observedUpstream = null;
      if (replacement && !replacementTransportCommitted) {
        try {
          observedUpstream = await proxyController?.getUpstream?.();
          if (Number(observedUpstream?.targetPort) === Number(attemptedReplacementTarget?.targetPort)) {
            replacementTransportCommitted = true;
          }
        } catch {
          observedUpstream = null;
        }
      }
      if (replacement && !replacementTransportCommitted && observedUpstream) {
        const observedTarget = normalizeDrainTarget(observedUpstream);
        const isKnownNonCandidateTarget = [maintenanceTarget, oldBackendTarget]
          .filter(Boolean)
          .some((target) => (
            Number(target.targetPort) === Number(observedTarget?.targetPort)
            && String(target.targetHost ?? '127.0.0.1') === String(observedTarget?.targetHost ?? '127.0.0.1')
          ));
        if (isKnownNonCandidateTarget) {
          const provisionalChild = replacement.child;
          if (!await cleanupSpawnedChild(provisionalChild)) {
            retainUnresolvedChild(provisionalChild, {
              oldServerStopped: true,
              activationCommitUnknown: false,
              cleanupIncomplete: true,
            });
            const cleanupError = new Error(
              `[local] provisional server termination was not confirmed after authoritative non-candidate activation ` +
                `(pid=${provisionalChild?.pid ?? 'unknown'}).`,
              { cause: error },
            );
            cleanupError.code = 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
            throw cleanupError;
          }
          replacement = null;
        }
      }
      if (replacement && replacementTransportCommitted) {
        serverProcRef.current = replacement.child;
        observeActiveChildExit(replacement.child);
        activeBackendPort = Number(attemptedReplacementTarget?.targetPort);
        try {
          await recordProxyBackend({
            backendPort: activeBackendPort,
            listenerPid: replacement.listenerPid,
            wrapperPid: replacement.child.pid,
            reloadPlan,
          });
        } catch (projectionError) {
          error.message += `; failed to record transport-committed replacement: ` +
            `${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
        }
        throw annotateServerRestartError(
          error,
          classifyServerRestartFailure({
            error,
            stage: 'post_commit',
            child: replacement.child,
            oldServerStopped,
            transportCommitted: true,
            serviceRestored: true,
            recentLines: recentLineBuffer.snapshot(),
          }),
        );
      }
      if (replacement) {
        retainUnresolvedChild(replacement.child, { oldServerStopped: true, activationCommitUnknown: true });
        const annotated = annotateServerRestartError(error, classifyServerRestartFailure({
          error,
          stage: 'activation_commit_unknown',
          child: replacement.child,
          oldServerStopped: true,
          recentLines: recentLineBuffer.snapshot(),
        }));
        annotated.serverRestartFailure.activationCommitUnknown = true;
        annotated.serverRestartFailure.activationTargetObserved = observedUpstream ? 'other' : 'inconclusive';
        delete annotated.reloadRetryAfterMs;
        throw annotated;
      }
      if (
        oldServerStopped &&
        error?.code !== 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE' &&
        error?.code !== 'ESERVERBACKENDPORTOCCUPIED'
      ) {
        await drainProxyTargets([attemptedReplacementTarget], {
          graceMs: resolveDevProxyDrainMs(serverEnv),
        }).catch((drainError) => {
          logger.error(
            `[local] watch: failed to drain the attempted replacement while maintenance remains active: ` +
              `${drainError instanceof Error ? drainError.message : String(drainError)}`
          );
        });
      }
      let priorRuntimeRestored = false;
      if (
        oldServerStopped
        && error?.code !== 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE'
        && error?.code !== 'ESERVERBACKENDPORTOCCUPIED'
      ) {
        try {
          const recovery = await recoverUnexpectedExit({
            child: currentServerProc,
            pid,
            code: currentServerProc?.exitCode,
            signal: currentServerProc?.signalCode,
          });
          priorRuntimeRestored = recovery?.recovered === true;
          if (priorRuntimeRestored) {
            await drainProxyTargets([maintenanceTarget, attemptedReplacementTarget], {
              graceMs: resolveDevProxyDrainMs(serverEnv),
            });
          }
        } catch (recoveryError) {
          logger.error?.(
            `[local] watch: prior-runtime recovery after replacement failure was unavailable: ` +
              `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          );
        }
      }
      if (oldServerStopped) requestSafePostStopRetry(error);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: oldServerStopped ? 'readiness' : 'restart',
          child: replacement?.child ?? null,
          oldServerStopped,
          serviceRestored: priorRuntimeRestored,
          recentLines: recentLineBuffer.snapshot(),
        }),
      );
    }
  };

  const restartDirect = async (reloadPlan, context = {}) => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    if (!Number.isFinite(pid) || pid <= 1) {
      let next = null;
      try {
        await observePortAndDatabaseRelease({
          port: serverPort,
          pid: null,
          scope: 'unavailable server port',
          reloadPlan,
        });
        next = await spawnServerBackend({
          port: serverPort,
          recentLineBuffer,
          envOverrides: serverReloadMigrationEnv(reloadPlan),
          reloadPlan,
          purpose: 'initial-recovery',
        });
        serverProcRef.current = next.child;
        observeActiveChildExit(next.child);
        if (stackMode && runtimeStatePath) {
          await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
            listenerPid: next.listenerPid,
            wrapperPid: next.child.pid,
            stablePort: serverPort,
            mode: 'direct',
            restartMode: reloadPlan.mode,
            reloadGeneration: reloadPlan.generation,
            clearProxyState: true,
          }).catch((error) => {
            throw annotateServerRestartError(
              error,
              classifyServerRestartFailure({
                error,
                stage: 'post_commit',
                child: next.child,
                oldServerStopped: false,
                serviceRestored: true,
                directReplacementActive: true,
                recentLines: recentLineBuffer.snapshot(),
              }),
            );
          });
        }
        logger.log(`[local] watch: server started after unavailable admission (pid=${next.child.pid}, port=${serverPort})`);
        return true;
      } catch (error) {
        if (error?.serverRestartFailure?.serviceRestored === true) throw error;
        throw annotateServerRestartError(
          error,
          classifyServerRestartFailure({
            error,
            stage: 'spawn',
            child: next?.child ?? null,
            oldServerStopped: false,
            recentLines: recentLineBuffer.snapshot(),
          }),
        );
      }
    }

    let oldServerStopped = false;
    const currentPidWasAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
    const precheckObservationScope = currentPidWasAlive
      ? createListenerOwnershipObservationScope({
          listListenPidsImpl,
          listListenPidsWithStatusImpl,
        })
      : null;
    const currentListenerPid = currentPidWasAlive
      ? await resolveServerPortListenerPidInProcessGroup({
          serverPort,
          rootPid: pid,
          listListenPidsImpl,
          listListenPidsWithStatusImpl,
          getProcessGroupIdImpl,
          listenerObservationScope: precheckObservationScope,
        })
      : null;
    const ownsCurrentListener = Number.isFinite(Number(currentListenerPid)) && Number(currentListenerPid) > 1;
    if (
      context.allowSupersededActivation !== true
      && typeof context.revalidateGeneration === 'function'
      && !await context.revalidateGeneration()
    ) return false;
    if (ownsCurrentListener) {
      disarmActiveChildExit(currentServerProc);
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        terminationPid: Number(currentListenerPid),
        stackName,
        envPath,
        serverEnv,
        killProcessGroupOwnedByStackImpl,
        onTerminationRequested: () => emitTransitionEvent('old_server_shutdown_requested', {
          generation: reloadPlan.generation,
          pid,
          currentPort: serverPort,
          mode: reloadPlan.mode,
          purpose: 'replacement',
        }),
      });
      if (!killResult?.killed) {
        observeActiveChildExit(currentServerProc);
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns port ${serverPort} but could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
      removeChildFromChildren(children, currentServerProc);
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: serverPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'exited',
      });
    } else if (currentPidWasAlive) {
      const availability = await waitForTcpPortFreeImpl(serverPort, {
        host: '127.0.0.1',
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (!currentPidStillAlive && availability?.status !== 'free') {
        assertTcpPortReleased(availability, {
          port: serverPort,
          pid,
          scope: 'server port',
        });
      }
      if (currentPidStillAlive || availability?.status !== 'free') {
        throw new Error(
          `[local] watch restart refused: server port ${serverPort} is occupied and the running PID does not own it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: serverPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'already_exited',
      });
    } else {
      oldServerStopped = true;
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: serverPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'already_exited',
      });
    }
    try {
      await observePortAndDatabaseRelease({
        port: serverPort,
        pid,
        scope: 'server port',
        reloadPlan,
      });
    } catch (error) {
      if (oldServerStopped) requestSafePostStopRetry(error);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({ error, stage: 'post-stop', child: null, oldServerStopped, recentLines: recentLineBuffer.snapshot() }),
      );
    }
    let next = null;
    try {
      next = await spawnServerBackend({
        port: serverPort,
        recentLineBuffer,
        envOverrides: serverReloadMigrationEnv(reloadPlan),
        reloadPlan,
        purpose: 'replacement',
      });
      serverProcRef.current = next.child;
      observeActiveChildExit(next.child);
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
          listenerPid: next.listenerPid,
          wrapperPid: next.child.pid,
          stablePort: serverPort,
          mode: 'direct',
          restartMode: reloadPlan.mode,
          reloadGeneration: reloadPlan.generation,
          clearProxyState: true,
        }).catch((error) => {
          throw annotateServerRestartError(
            error,
            classifyServerRestartFailure({
              error,
              stage: 'post_commit',
              child: next.child,
              oldServerStopped,
              serviceRestored: true,
              directReplacementActive: true,
              recentLines: recentLineBuffer.snapshot(),
            }),
          );
        });
      }
      logger.log(`[local] watch: server restarted (pid=${next.child.pid}, port=${serverPort})`);
      return true;
    } catch (error) {
      if (error?.serverRestartFailure?.serviceRestored === true) throw error;
      if (oldServerStopped) requestSafePostStopRetry(error);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({ error, stage: 'readiness', child: next?.child ?? null, oldServerStopped, recentLines: recentLineBuffer.snapshot() }),
      );
    }
  };

  const restartOnce = async (reloadPlan, context = {}) => {
    if (unresolvedProvisional?.child) {
      if (hasChildExited(unresolvedProvisional.child)) {
        removeChildFromChildren(children, unresolvedProvisional.child);
        unresolvedProvisional = null;
      } else {
        const error = new Error(
          `[local] watch restart refused: provisional server activation remains unresolved ` +
            `(pid=${unresolvedProvisional.child.pid ?? 'unknown'}); no competing server will be started.`,
        );
        error.code = 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
        error.provisionalChild = unresolvedProvisional.child;
        const annotated = annotateServerRestartError(error, classifyServerRestartFailure({
          error,
          stage: 'cleanup_incomplete',
          child: unresolvedProvisional.child,
          oldServerStopped: unresolvedProvisional.oldServerStopped,
          recentLines: [],
        }));
        annotated.serverRestartFailure.activationCommitUnknown = true;
        throw annotated;
      }
    }
    if (proxyController) return await restartWithExclusiveDbProxy(reloadPlan, context);
    return await restartDirect(reloadPlan, context);
  };

  return {
    target: 'server',
    async recoverUnexpectedExit(event) {
      return await recoverUnexpectedExit(event);
    },
    setUnexpectedExitHandler(handler) {
      disarmActiveChildExit();
      unexpectedExitHandler = typeof handler === 'function' ? handler : null;
      if (unexpectedExitHandler) observeActiveChildExit(serverProcRef?.current);
    },
    createPlan(context = {}) {
      return createReloadPlanForContext(context);
    },
    emitTransitionEvent(event, details) {
      emitTransitionEvent(event, details);
    },
    async publishLifecycle(transition) {
      return await publishLifecycle(transition);
    },
    async publishFailureDisposition(disposition) {
      return await publishFailureDisposition(disposition);
    },
    getBackoffRemainingMs() {
      return restartFailureTracker.getBackoffRemainingMs();
    },
    async build(context = {}) {
      if (!enabled || isShuttingDown?.()) return { skipped: true };
      const reloadPlan = createReloadPlanForContext(context);
      const transition = {
        generation: reloadPlan.generation,
        mode: reloadPlan.mode,
        migrationMode: reloadPlan.migrationMode,
        purpose: 'replacement',
      };
      emitTransitionEvent('preflight_started', transition);
      try {
        await preflightDevServerRestartImpl({
          serverDir,
          serverComponentName,
          serverEnv,
          reloadMigrationMode: reloadPlan.migrationMode,
          consoleImpl: logger,
          logger,
        });
        emitTransitionEvent('preflight_completed', { ...transition, disposition: 'succeeded' });
        const activeServer = serverProcRef?.current;
        return {
          ok: true,
          ...(!activeServer || hasChildExited(activeServer)
            ? { allowSupersededActivation: true }
            : {}),
        };
      } catch (error) {
        emitTransitionEvent('preflight_completed', { ...transition, disposition: 'failed' });
        throw error;
      }
    },
    async restart(context = {}) {
      if (!enabled || isShuttingDown?.()) return { skipped: true };
      const backoffRemainingMs = restartFailureTracker.getBackoffRemainingMs();
      if (backoffRemainingMs > 0) {
        logger.error(
          `[local] watch: server restart suppressed; backing off for ${backoffRemainingMs}ms after repeated startup failures.`
        );
        return {
          skipped: true,
          reason: 'backoff',
          retryAfterMs: Math.ceil(backoffRemainingMs) + 1,
        };
      }
      const reloadPlan = createReloadPlanForContext(context);
      try {
        await publishLifecycle({ phase: 'replacing', plan: reloadPlan });
        const restarted = await restartOnce(reloadPlan, context);
        if (restarted) restartFailureTracker.reset();
        return { restarted };
      } catch (error) {
        requestTransientListenerDiscoveryRetry(error);
        const failure = error?.serverRestartFailure;
        if (failure?.serviceRestored === true) {
          logger.error(
            `[local] watch: server replacement remains active, but restart completion could not be published ` +
              `(will retry on next change).`
          );
        } else if (failure?.oldServerStopped) {
          logger.error(
            `[local] watch: server restart failed after stopping the previous process; ` +
              `no server is running on port ${serverPort} (will retry on next change).`
          );
        } else {
          logger.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
        }
        const recentOutput = formatRecentServerOutput(failure?.recentLines);
        if (recentOutput) logger.error(recentOutput);
        const backoff = restartFailureTracker.record(failure);
        if (backoff.thresholdReached) {
          logger.error(
            `[local] watch: server failed to start ${backoff.count} times within ` +
              `${restartFailureTracker.policy.windowMs}ms; backing off for ${backoff.backoffMs}ms.`
          );
        }
        throw error;
      }
    },
  };
}
