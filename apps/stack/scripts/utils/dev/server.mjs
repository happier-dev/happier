import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureDepsInstalled, pmExecBin, pmSpawnScript } from '../proc/pm.mjs';
import { killProcessTree, markSpawnedProcessPlannedExit } from '../proc/proc.mjs';
import {
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './devReloadCoordinator.mjs';
import { ensureHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { applyServerMigrations } from '../server/server_migrations.mjs';
import { applyServerPresetEnvDefaults } from '../server/apply_server_preset_env_defaults.mjs';
import { applyEffectiveDbProviderEnv, resolveEffectiveDbProvider } from '../server/effective_db_provider.mjs';
import { applyServerComponentFlavorEnv, resolveServerDevScript } from '../server/flavor_scripts.mjs';
import { applyStackServerLoggingDefaults } from '../server/logging_env.mjs';
import { DEV_SERVER_SHARED_RUNTIME_PACKAGE_IDS } from './devReloadTargets.mjs';
import { resolveServerShutdownGraceMs } from '../server/shutdown_grace.mjs';
import { ensureSourceServerWorkspacePackagesBuilt } from '../server/source_server_workspace_deps.mjs';
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
import { listListenPids, listListenPidsWithStatus, pickNextFreeTcpPort, probeTcpPortBinding, waitForTcpPortFree } from '../net/ports.mjs';
import {
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeServerActivation,
  recordStackRuntimeServerLifecycle,
  recordStackRuntimeUpdate,
} from '../stack/runtime_state.mjs';
import { getProcessGroupId, isPidOwnedByStack, killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { pickMetroPort, resolveStablePortStart } from '../expo/metro_ports.mjs';
import { waitForPgliteDirLockRelease } from '../pglite_lock.mjs';

const DEFAULT_LISTENER_OWNERSHIP_TIMEOUT_MS = 3000;
const POST_STOP_RELEASE_RETRY_MS = 250;

function readPackageScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function getDbProviderFromServerEnv(serverEnv = {}, serverComponentName = 'happier-server-light') {
  const effective = resolveEffectiveDbProvider({ serverComponentName, env: serverEnv });
  return effective.ok ? effective.provider : '';
}

function getPgliteDbDirFromServerEnv(serverEnv = {}) {
  return String(serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR ?? serverEnv.HAPPY_SERVER_LIGHT_DB_DIR ?? '').trim();
}

export function createDevServerReloadPlan({
  changedDescriptors,
  descriptorEvidenceConclusive,
  generation,
} = {}) {
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
  const mode = 'exclusiveDb';
  const reason = prismaChanged
    ? 'prisma_changed'
    : migrationInputsUnchanged
      ? 'app_only_descriptor_unchanged'
      : 'migration_evidence_inconclusive';
  return {
    generation: Number.isInteger(generation) && generation >= 0 ? generation : null,
    mode,
    migrationMode: migrationInputsUnchanged ? 'skip' : 'apply',
    reason,
  };
}

const DEFAULT_SERVER_RESTART_FAILURE_POLICY = {
  maxFailures: 3,
  windowMs: 60_000,
  backoffMs: 30_000,
  recentLineLimit: 8,
};

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
    exitCode,
    signalCode,
    recentLines: Array.isArray(recentLines) ? recentLines : [],
    countsTowardBackoff: kind === 'spawn' || kind === 'readiness' || kind === 'early_exit',
    transportCommitted: Boolean(transportCommitted),
    serviceRestored: Boolean(serviceRestored),
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

async function waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease } = {}) {
  if (getDbProviderFromServerEnv(serverEnv) !== 'pglite') return;
  const dbDir = getPgliteDbDirFromServerEnv(serverEnv);
  if (!dbDir) return;
  const released = await waitForPgliteDirLockReleaseImpl(dbDir, { timeoutMs: 5_000, intervalMs: 100 });
  if (released === false) {
    throw new Error(`[local] restart refused: pglite DB lock did not release for ${dbDir}.`);
  }
}

function hasPackageScript(dir, scriptName) {
  const script = readPackageScripts(dir)?.[scriptName];
  return typeof script === 'string' && script.trim().length > 0;
}

export function createDevServerReloadDescriptors({ serverDir, existsSyncImpl = existsSync } = {}) {
  const repoRoot = resolve(serverDir, '..', '..');
  const serverAppPaths = [
    join(serverDir, 'sources'),
    join(serverDir, 'scripts'),
    join(serverDir, 'package.json'),
    join(serverDir, 'tsconfig.json'),
    join(serverDir, 'tsconfig.runtime.json'),
  ];
  const serverPrismaPaths = [
    join(serverDir, 'prisma'),
  ];
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
    ...DEV_SERVER_SHARED_RUNTIME_PACKAGE_IDS.map((pkg) => makeDescriptor(
      `shared:${pkg}`,
      'shared',
      [
        join(repoRoot, 'packages', pkg, 'src'),
        join(repoRoot, 'packages', pkg, 'package.json'),
        join(repoRoot, 'packages', pkg, 'tsconfig.json'),
        join(repoRoot, 'packages', pkg, 'tsconfig.build.json'),
      ],
    )),
  ].filter((descriptor) => descriptor.paths.length > 0);
}

function readDevServerWatchChangeSignature(paths) {
  return readDevReloadWatchChangeSignature(paths, { ignorePath: isDevRuntimeReloadIgnoredPath });
}

function readDevServerWatchChangeSignatureAsync(paths) {
  return readDevReloadWatchChangeSignatureAsync(paths, { ignorePath: isDevRuntimeReloadIgnoredPath });
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

async function resolveServerPortListenerPidInProcessGroup({
  serverPort,
  rootPid,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationScope,
  listenerOwnershipTimeoutMs,
  listenerOwnershipRetryDelayMs,
}) {
  try {
    return await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort,
      spawnedPid: rootPid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
      listenerObservationScope,
      listenerOwnershipTimeoutMs,
      listenerOwnershipRetryDelayMs,
    });
  } catch (error) {
    if (error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE') throw error;
    return null;
  }
}

async function isServerPortProvenFree({ serverPort, listenerObservationScope }) {
  const availability = await listenerObservationScope.checkPortFree(serverPort, { host: '127.0.0.1' });
  if (availability.status === 'inconclusive') {
    const reason = availability.binding?.reason
      ?? availability.observation?.reason
      ?? 'port-availability-inconclusive';
    const error = new Error(`[local] server port ${serverPort} availability is inconclusive: ${reason}`);
    error.code = 'ELISTENERDISCOVERYINCONCLUSIVE';
    error.observation = availability.observation;
    error.binding = availability.binding;
    throw error;
  }
  return availability.status === 'free';
}

export async function resolveStackOwnedServerRuntimePid(
  { runtimeStatePath, serverPort, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
    observationScope,
  } = {}
) {
  const suppliedScopeRemainingMs = typeof observationScope?.remainingMs === 'function'
    ? Number(observationScope.remainingMs())
    : null;
  const ownershipScope = observationScope && (suppliedScopeRemainingMs == null || suppliedScopeRemainingMs > 0)
    ? observationScope
    : createListenerOwnershipObservationScope({
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
      });
  const state = await readStackRuntimeStateFileImpl(runtimeStatePath);
  const runtimePid = Number(state?.processes?.serverPid);
  if (Number.isFinite(runtimePid) && runtimePid > 1 && isPidAliveImpl(runtimePid)) {
    const owned = await isPidOwnedByStackImpl(runtimePid, { stackName, envPath }).catch(() => false);
    if (owned) {
      try {
        const listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
          serverPort,
          spawnedPid: runtimePid,
          listListenPidsImpl,
          listListenPidsWithStatusImpl,
          getProcessGroupIdImpl,
          listenerObservationScope: ownershipScope,
        });
        if (Number.isFinite(Number(listenerPid)) && Number(listenerPid) > 1) {
          return Number(listenerPid);
        }
      } catch (error) {
        if (error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE') throw error;
      }
    }
  }

  const listenPid = await resolveStackOwnedServerListenPidImpl(
    { serverPort, stackName, envPath },
    {
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      isPidOwnedByStackImpl,
      getProcessGroupIdImpl,
      observationScope: ownershipScope,
    },
  );
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1 ? Number(listenPid) : null;
}

export async function stopStackOwnedServerForRestart(
  { serverPort, runtimeStatePath, stackName, envPath, serverEnv = {} },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
    waitForTcpPortFreeImpl = waitForTcpPortFree,
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
    probeTcpPortBindingImpl = probeTcpPortBinding,
    listenerObservationScope,
  } = {}
) {
  const observationScope = listenerObservationScope ?? createListenerOwnershipObservationScope({
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
    probeTcpPortBindingImpl,
  });
  const st = await readStackRuntimeStateFileImpl(runtimeStatePath);
  const pid = Number(st?.processes?.serverPid);
  let stopPid = null;
  let recordedPidAliveAndOwned = false;

  if (pid > 1 && isPidAliveImpl(pid)) {
    const owned = await isPidOwnedByStackImpl(pid, { stackName, envPath }).catch(() => false);
    recordedPidAliveAndOwned = owned;
    if (owned) {
      const listenerPid = await resolveServerPortListenerPidInProcessGroup({
        serverPort,
        rootPid: pid,
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
    const free = await isServerPortProvenFree({
      serverPort,
      listenerObservationScope: observationScope,
    });
    if (!free) {
      const listenPid = await resolveStackOwnedServerListenPidImpl(
        { serverPort, stackName, envPath },
        {
          listListenPidsImpl,
          listListenPidsWithStatusImpl,
          isPidOwnedByStackImpl,
          getProcessGroupIdImpl,
          observationScope,
        }
      );
      if (!(Number.isFinite(Number(listenPid)) && Number(listenPid) > 1)) {
        throw new Error(
          `[local] restart refused: server port ${serverPort} is occupied and the PID is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
        );
      }

      stopPid = Number(listenPid);
      await recordStackRuntimeServerActivation(
        runtimeStatePath,
        {
          listenerPid: Number(listenPid),
          wrapperPid: null,
          stablePort: serverPort,
          mode: 'direct',
          clearProxyState: true,
        },
        { recordStackRuntimeUpdateImpl },
      );
    } else if (recordedPidAliveAndOwned) {
      throw new Error(
        `[local] restart refused: recorded server pid ${pid} is still alive, but server port ${serverPort} has no listener proof for it.\n` +
          `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
      );
    }
  }

  if (stopPid) {
    const res = await killProcessGroupOwnedByStackImpl(Number(stopPid), {
      stackName,
      envPath,
      label: 'server',
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

  const availability = await waitForTcpPortFreeImpl(serverPort, {
    host: '127.0.0.1',
    timeoutMs: 5_000,
    intervalMs: 100,
  });
  assertTcpPortReleased(availability, {
    port: serverPort,
    pid: stopPid,
    scope: 'server port',
  });
}

function removeChildFromChildren(children, child) {
  const index = children.indexOf(child);
  if (index >= 0) {
    children.splice(index, 1);
  }
}

function hasChildExited(child) {
  return (
    (child?.exitCode !== null && child?.exitCode !== undefined) ||
    (child?.signalCode !== null && child?.signalCode !== undefined)
  );
}

export function updateUnresolvedChildRetention(current, child, {
  oldServerStopped = false,
  transportCommitted = false,
  serviceRestored = false,
  activationCommitUnknown = false,
} = {}) {
  const previous = current?.child === child ? current : null;
  return {
    child,
    oldServerStopped: Boolean(previous?.oldServerStopped || oldServerStopped),
    transportCommitted: Boolean(previous?.transportCommitted || transportCommitted),
    serviceRestored: Boolean(previous?.serviceRestored || serviceRestored),
    activationCommitUnknown: Boolean(previous?.activationCommitUnknown || activationCommitUnknown),
  };
}

function localServerUrlForPort(port) {
  return `http://127.0.0.1:${Number(port)}`;
}

function serverReloadMigrationEnv(reloadPlan) {
  return {
    HAPPIER_STACK_MIGRATE_MODE: reloadPlan.migrationMode === 'skip' ? 'skip' : 'always',
  };
}

function resolveDevProxyDrainMs(serverEnv = {}) {
  const rawValue = serverEnv.HAPPIER_STACK_DEV_PROXY_DRAIN_MS;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return 2000;
  }
  const raw = Number(rawValue);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 2000;
}

function sleepMs(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForChildExit(child, timeoutMs) {
  if (hasChildExited(child)) return true;
  if (!child || typeof child.once !== 'function') return false;

  return await new Promise((resolvePromise) => {
    let settled = false;
    let timeout = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolvePromise(value);
    };

    timeout = setTimeout(() => done(false), timeoutMs);
    child.once('exit', () => done(true));
    child.once('close', () => done(true));
  });
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

function assertTcpPortReleased(availability, { port, pid, scope = 'server port' } = {}) {
  if (availability?.status === 'free') return;

  const inconclusive = availability?.status === 'inconclusive';
  const reason = String(availability?.reason ?? 'unknown');
  const error = new Error(
    `[local] watch restart refused: ${scope} ${port} release is ` +
      `${inconclusive ? 'inconclusive' : 'still occupied'} after stopping pid=${pid} (${reason}).`,
  );
  error.code = inconclusive
    ? 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE'
    : 'ESERVERBACKENDPORTOCCUPIED';
  if (inconclusive) {
    error.reloadRetryAfterMs = POST_STOP_RELEASE_RETRY_MS;
  }
  throw error;
}

export async function terminateSpawnedChildForCleanup(
  child,
  {
    killSpawnedChildImpl = killProcessTree,
    env = process.env,
    gracefulMs = resolveServerShutdownGraceMs(env),
    forceMs = 300,
  } = {}
) {
  if (!child) return true;

  let gracefulResult = null;
  try {
    gracefulResult = await killSpawnedChildImpl(child, 'SIGTERM', { graceMs: gracefulMs });
  } catch {
    gracefulResult = null;
  }
  if (gracefulResult?.ok === true && hasChildExited(child)) return true;
  if (gracefulResult?.ok === true && await waitForChildExit(child, gracefulMs)) return true;

  let forceResult = null;
  try {
    forceResult = await killSpawnedChildImpl(child, 'SIGKILL', { graceMs: forceMs });
  } catch {
    forceResult = null;
  }
  if (forceResult?.ok !== true) return false;
  return hasChildExited(child) || await waitForChildExit(child, forceMs);
}

async function cleanupStackSpawnedChild({
  child,
  children,
  authoritativeChild = null,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  terminateSpawnedChildImpl,
  stackName,
  envPath,
  env = process.env,
}) {
  if (!child || authoritativeChild === child) return true;
  const pid = Number(child?.pid);
  if (!Number.isFinite(pid) || pid <= 1) {
    const terminated = await (terminateSpawnedChildImpl
      ? terminateSpawnedChildImpl(child)
      : terminateSpawnedChildForCleanup(child, { killSpawnedChildImpl, env }));
    if (terminated) {
      removeChildFromChildren(children, child);
    }
    return Boolean(terminated);
  }

  const res = await killProcessGroupOwnedByStackImpl(pid, {
    stackName,
    envPath,
    label: 'server',
    json: false,
    graceMs: resolveServerShutdownGraceMs(env),
  }).catch(() => ({ killed: false }));
  if (!res?.killed || res?.reason === 'killed_pid_only') {
    const terminated = await (terminateSpawnedChildImpl
      ? terminateSpawnedChildImpl(child)
      : terminateSpawnedChildForCleanup(child, { killSpawnedChildImpl, env }));
    if (!terminated) return false;
  }
  removeChildFromChildren(children, child);
  return true;
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

export async function preflightDevServerRestart(
  { serverDir, serverEnv = {}, reloadMigrationMode = null, logger = console },
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

  logger.log('[local] watch: server changed → preflight build...');
  if (reloadMigrationMode === 'apply' && hasPackageScript(serverDir, 'generate:providers')) {
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
  children,
  spawnOptions = {},
  quiet = false,
  serverProxyRuntime = null,
}, {
  ensureDepsInstalledImpl = ensureDepsInstalled,
  ensureSourceServerWorkspacePackagesBuiltImpl = ensureSourceServerWorkspacePackagesBuilt,
  ensureHappyServerManagedInfraImpl = ensureHappyServerManagedInfra,
  applyServerMigrationsImpl = applyServerMigrations,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  stopStackOwnedServerForRestartImpl = stopStackOwnedServerForRestart,
  pmSpawnScriptImpl = pmSpawnScript,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  getProcessGroupIdImpl = getProcessGroupId,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  recordStackRuntimeServerActivationImpl = recordStackRuntimeServerActivation,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  killSpawnedChildImpl = killProcessTree,
  terminateSpawnedChildImpl,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  listenerOwnershipTimeoutMs = DEFAULT_LISTENER_OWNERSHIP_TIMEOUT_MS,
  listenerOwnershipRetryDelayMs = 25,
} = {}) {
  const bindPort = Number(serverBindPort || serverPort);
  const serverReadyUrl = localServerUrlForPort(bindPort);
  const serverEnv = {
    ...baseEnv,
    PORT: String(bindPort),
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };
  applyServerComponentFlavorEnv({ serverComponentName, targetEnv: serverEnv });
  delete baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE;
  const dbProvider = applyEffectiveDbProviderEnv({ serverComponentName, env: baseEnv, targetEnv: serverEnv });
  const explicitDatabaseUrl = serverEnv.DATABASE_URL;
  if (dbProvider === 'mysql' && !String(explicitDatabaseUrl ?? '').trim()) {
    throw new Error('[local] mysql requires an explicit DATABASE_URL before managed infra startup');
  }
  const usesFullManagedInfra = serverComponentName === 'happier-server'
    && (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
  if (dbProvider === 'postgres' && !usesFullManagedInfra && !String(explicitDatabaseUrl ?? '').trim()) {
    throw new Error('[local] postgres requires DATABASE_URL when the selected preset does not manage Postgres');
  }
  applyStackServerLoggingDefaults({ baseEnv, serverEnv });

  applyServerPresetEnvDefaults({ serverComponentName, baseEnv, serverEnv, baseDir: autostart.baseDir });

  // Dependency preparation owns the tools used by infrastructure and migrations.
  // Keep it after provider/topology admission so invalid configurations remain side-effect free.
  await ensureDepsInstalledImpl(serverDir, serverComponentName, { quiet, env: serverEnv });

  if (serverComponentName === 'happier-server') {
    if (usesFullManagedInfra) {
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

  }
  const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
  if (autoMigrate) {
    await applyServerMigrationsImpl({ serverDir, env: serverEnv, dbProvider });
  }

  const prismaPush = (baseEnv.HAPPIER_STACK_PRISMA_PUSH ?? '1').toString().trim() !== '0';
  const serverScript = resolveServerDevScript({ serverComponentName, serverDir, prismaPush });

  const ensureWorkspacePackagesBuiltBeforeSpawn = async () => {
    await ensureSourceServerWorkspacePackagesBuiltImpl({
      runtimeBackedStart: false,
      serverDir,
      quiet,
      env: serverEnv,
    });
  };

  // Restart behavior (stack-safe): only kill when we can prove ownership via runtime state.
  if (restart && stackMode && runtimeStatePath) {
    const preflightResult = await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, logger: console });
    if (preflightResult?.ran !== true) {
      await ensureWorkspacePackagesBuiltBeforeSpawn();
    }
  }

  if (restart && stackMode && runtimeStatePath && serverAlreadyRunning) {
    await stopStackOwnedServerForRestartImpl(
      {
        serverPort,
        runtimeStatePath,
        stackName: autostart.stackName,
        envPath,
        serverEnv,
      },
      { killProcessGroupOwnedByStackImpl, recordStackRuntimeUpdateImpl }
    );
    await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
  }

  if (serverAlreadyRunning && !restart) {
    return { serverEnv, serverScript, serverProc: null };
  }

  if (!(restart && stackMode && runtimeStatePath)) {
    await ensureWorkspacePackagesBuiltBeforeSpawn();
  }

  const readinessTimeoutMs = resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv });
  const startupDeadline = createServerReadinessDeadline({
    readinessTimeoutMs,
    migrationTimeoutMs: resolveServerMigrationTimeoutMs({ env: serverEnv }),
  });
  const existingOnLine = spawnOptions?.onLine;
  const server = await pmSpawnScriptImpl({
    label: 'server',
    dir: serverDir,
    script: serverScript,
    env: serverEnv,
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
    await waitForServerReadyImpl(internalServerUrl, {
      timeoutMs: readinessTimeoutMs,
      childProcess: server,
      startupDeadline,
    });
    if (serverReadyUrl !== internalServerUrl) {
      await waitForServerReadyImpl(serverReadyUrl, {
        timeoutMs: readinessTimeoutMs,
        childProcess: server,
      });
    }
    listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort: bindPort,
      spawnedPid: server.pid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
      listenerOwnershipTimeoutMs,
      listenerOwnershipRetryDelayMs,
    });
    if (hasChildExited(server)) {
      throw new Error(
        `[local] server process exited after readiness check ` +
          `(pid=${server.pid}, code=${server.exitCode ?? 'null'}, signal=${server.signalCode ?? 'null'})`
      );
    }
  } catch (error) {
    const cleanupConfirmed = await cleanupStackSpawnedChild({
      child: server,
      children,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      terminateSpawnedChildImpl,
      stackName: autostart.stackName,
      envPath,
      env: serverEnv,
    });
    if (!cleanupConfirmed) {
      throw createServerProvisioningCleanupIncompleteError(error, server);
    }
    throw error;
  }
  if (stackMode && runtimeStatePath) {
    const activationMode = serverProxyRuntime?.mode === 'proxy'
      ? 'proxy'
      : serverProxyRuntime?.mode === 'directFallback'
        ? 'directFallback'
        : 'direct';
    await recordStackRuntimeServerActivationImpl(
      runtimeStatePath,
      {
        listenerPid,
        wrapperPid: server.pid,
        stablePort: serverPort,
        backendPort: activationMode === 'proxy' ? bindPort : null,
        proxyPid: activationMode === 'proxy' ? serverProxyRuntime?.proxyPid : null,
        mode: activationMode,
        fallbackReason: serverProxyRuntime?.fallbackReason,
      },
      { recordStackRuntimeUpdateImpl },
    );
  }
  return { serverEnv, serverScript, serverProc: server };
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
}, {
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  pmSpawnScriptImpl = pmSpawnScript,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  recordStackRuntimeServerActivationImpl = recordStackRuntimeServerActivation,
  recordStackRuntimeServerLifecycleImpl = recordStackRuntimeServerLifecycle,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  probeTcpPortBindingImpl = probeTcpPortBinding,
  getProcessGroupIdImpl = getProcessGroupId,
  isPidAliveImpl = isPidAlive,
  killSpawnedChildImpl = killProcessTree,
  terminateSpawnedChildImpl,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  nowImpl = Date.now,
  monotonicNowImpl = () => performance.now(),
  restartFailurePolicy,
  logger = console,
  sleepImpl = sleepMs,
  listenerOwnershipTimeoutMs = DEFAULT_LISTENER_OWNERSHIP_TIMEOUT_MS,
  listenerOwnershipRetryDelayMs = 25,
} = {}) {
  let activeBackendPort = Number(serverBindPort || serverPort);
  let unresolvedProvisional = null;
  const restartFailureTracker = createServerRestartFailureTracker({
    policy: restartFailurePolicy,
    nowImpl,
  });
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
      logger.error?.(`[local] watch: active server exit recovery request failed: ${formatError(error)}`);
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
  const publishLifecycle = async (transition) => {
    if (!stackMode || !runtimeStatePath) return null;
    if (
      transition?.phase !== 'idle'
      && (!Number.isInteger(transition?.plan?.generation) || transition.plan.generation < 0)
    ) return null;
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
        else projectionError.message += `; proxy maintenance projection failed: ${formatError(caught)}`;
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

  const cleanupProvisionalChild = async (child) => {
    return await cleanupStackSpawnedChild({
      child,
      children,
      authoritativeChild: serverProcRef.current,
      killProcessGroupOwnedByStackImpl,
      killSpawnedChildImpl,
      terminateSpawnedChildImpl,
      stackName,
      envPath,
      env: serverEnv,
    });
  };

  const retainUnresolvedChild = (child, {
    oldServerStopped = false,
    transportCommitted = false,
    serviceRestored = false,
    activationCommitUnknown = false,
  } = {}) => {
    unresolvedProvisional = updateUnresolvedChildRetention(unresolvedProvisional, child, {
      oldServerStopped,
      transportCommitted,
      serviceRestored,
      activationCommitUnknown,
    });
  };

  const spawnServerBackend = async ({
    port,
    recentLineBuffer,
    envOverrides = {},
    reloadPlan,
    purpose = 'replacement',
  }) => {
    const nextEnv = { ...serverEnv, ...envOverrides, PORT: String(port) };
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
      next = await pmSpawnScriptImpl({
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
        listenerOwnershipTimeoutMs,
        listenerOwnershipRetryDelayMs,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
      emitTransitionEvent('replacement_ready', { ...transition, pid: next.pid, listenerPid });
      return { child: next, listenerPid, readyUrl };
    } catch (error) {
      if (migrationStarted && !migrationCompleted) {
        emitTransitionEvent('migration_completed', { ...transition, pid: next?.pid, disposition: 'failed' });
      }
      if (next) {
        emitTransitionEvent('replacement_readiness_failed', { ...transition, pid: next.pid });
      }
      const cleaned = await cleanupProvisionalChild(next);
      if (!cleaned) {
        retainUnresolvedChild(next);
        const cleanupError = new Error(
          `[local] provisional server termination was not confirmed after startup failure ` +
            `(pid=${next?.pid ?? 'unknown'}, port=${port}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        cleanupError.code = 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
        cleanupError.provisionalChild = next;
        cleanupError.provisionalPort = port;
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
    let databaseDisposition = getDbProviderFromServerEnv(serverEnv) === 'pglite'
      ? 'pending'
      : 'not_applicable';
    try {
      const availability = await waitForTcpPortFreeImpl(port, {
        host: '127.0.0.1',
        timeoutMs: 5_000,
        intervalMs: 100,
      });
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
      const disposition = portDisposition === 'occupied'
        ? 'occupied'
        : portDisposition === 'inconclusive'
          ? 'inconclusive'
          : 'blocked';
      emitTransitionEvent('port_database_release_result', {
        ...transition,
        disposition,
        portDisposition,
        databaseDisposition,
      });
      throw error;
    }
  };

  const backendDrainTarget = (targetPort) => ({
    targetHost: '127.0.0.1',
    targetPort: Number(targetPort),
  });

  const normalizeDrainTarget = (target) => {
    const targetPort = Number(target?.targetPort ?? target?.port);
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) return null;
    const targetHost = String(target?.targetHost ?? target?.host ?? '127.0.0.1').trim();
    return {
      targetHost: targetHost || '127.0.0.1',
      targetPort,
    };
  };

  const drainProxyTargets = async (targets, { graceMs = 0 } = {}) => {
    const seen = new Set();
    for (const target of targets) {
      const normalized = normalizeDrainTarget(target);
      if (!normalized) continue;
      const key = `${normalized.targetHost}:${normalized.targetPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await proxyController.drainConnections?.({
        graceMs,
        targetHost: normalized.targetHost,
        targetPort: normalized.targetPort,
      });
    }
  };

  const flipProxyUpstreamAndDrainTargets = async ({
    targetPort,
    drainTargets = [],
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
    if (!Number.isFinite(pid) || pid <= 1) return false;

    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    const oldBackendPort = activeBackendPort;
    let oldServerStopped = false;
    let replacement = null;
    let maintenanceEntered = false;
    let maintenanceTarget = null;
    let attemptedReplacementBackendPort = null;
    let replacementTransportCommitted = false;

    const enterMaintenance = async () => {
      if (maintenanceEntered) return;
      maintenanceTarget = await proxyController.enterMaintenance?.({
        retryAfterMs: Math.max(1, resolveDevProxyDrainMs(serverEnv)),
        message: 'Server reload in progress',
      });
      maintenanceEntered = true;
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
        throw error;
      }
    };

    const precheckObservationScope = createListenerOwnershipObservationScope({
      totalTimeoutMs: listenerOwnershipTimeoutMs,
      retryDelayMs: listenerOwnershipRetryDelayMs,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      probeTcpPortBindingImpl,
    });
    const currentListenerPid = await resolveServerPortListenerPidInProcessGroup({
      serverPort: oldBackendPort,
      rootPid: pid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
      listenerObservationScope: precheckObservationScope,
    });
    const ownsCurrentListener = Number.isFinite(Number(currentListenerPid)) && Number(currentListenerPid) > 1;
    if (!ownsCurrentListener) {
      const free = await isServerPortProvenFree({
        serverPort: oldBackendPort,
        listenerObservationScope: precheckObservationScope,
      });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive || !free) {
        throw new Error(
          `[local] watch restart refused: server backend port ${oldBackendPort} is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      if (typeof context.revalidateGeneration === 'function' && !await context.revalidateGeneration()) return false;
      oldServerStopped = true;
      await enterMaintenance();
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: oldBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'already_exited',
      });
    } else {
      if (typeof context.revalidateGeneration === 'function' && !await context.revalidateGeneration()) return false;
      await enterMaintenance();
      if (typeof context.revalidateGeneration === 'function' && !await context.revalidateGeneration()) {
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
      if (!killResult.killed) {
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
          `[local] watch restart refused: server pid ${pid} owns backend port ${oldBackendPort} but could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
      emitTransitionEvent('old_server_exited', {
        generation: reloadPlan.generation,
        pid,
        currentPort: oldBackendPort,
        mode: reloadPlan.mode,
        purpose: 'replacement',
        disposition: 'exited',
      });
    }

    try {
      await observePortAndDatabaseRelease({
        port: oldBackendPort,
        pid,
        scope: 'server backend port',
        reloadPlan,
      });

      const nextBackendPort = await pickNextFreeTcpPortImpl(oldBackendPort + 1, {
        host: '127.0.0.1',
        reservedPorts: new Set([Number(serverPort), oldBackendPort]),
      });
      attemptedReplacementBackendPort = nextBackendPort;

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
      await drainProxyTargets([maintenanceTarget, backendDrainTarget(oldBackendPort)], {
        graceMs: resolveDevProxyDrainMs(serverEnv),
      });
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
          stablePort: serverPort,
          backendPort: nextBackendPort,
          proxyPid: proxyController?.pid,
          listenerPid: replacement.listenerPid,
          wrapperPid: replacement.child.pid,
          mode: 'proxy',
          restartMode: reloadPlan.mode,
          reloadGeneration: reloadPlan.generation,
        }, { recordStackRuntimeUpdateImpl });
      }
      logger.log(`[local] watch: server restarted behind proxy (pid=${replacement.child.pid}, backendPort=${nextBackendPort})`);
      return true;
    } catch (error) {
      if (error?.code === 'ESERVERPROVISIONALCLEANUPINCOMPLETE') {
        if (unresolvedProvisional?.child === error.provisionalChild) {
          retainUnresolvedChild(error.provisionalChild, { oldServerStopped });
        }
        if (stackMode && runtimeStatePath && Number(error?.provisionalChild?.pid) > 1) {
          try {
            await recordStackRuntimeUpdateImpl(runtimeStatePath, {
              processes: { serverDrainingPid: Number(error.provisionalChild.pid) },
            });
          } catch (projectionError) {
            error.message += `; failed to record provisional cleanup attention: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
          }
        }
        throw annotateServerRestartError(error, classifyServerRestartFailure({
          error,
          stage: 'cleanup_incomplete',
          child: error.provisionalChild ?? null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        }));
      }
      if (replacement) {
        let observedUpstream = null;
        let upstreamObservation = 'unavailable';
        if (!replacementTransportCommitted) {
          try {
            observedUpstream = await proxyController?.getUpstream?.();
            if (Number(observedUpstream?.targetPort) === Number(attemptedReplacementBackendPort)) {
              replacementTransportCommitted = true;
              upstreamObservation = 'candidate';
            } else {
              upstreamObservation = 'known_non_candidate';
            }
          } catch {
            observedUpstream = null;
            upstreamObservation = 'unavailable';
          }
        }
        if (replacementTransportCommitted) {
          serverProcRef.current = replacement.child;
          observeActiveChildExit(replacement.child);
          activeBackendPort = attemptedReplacementBackendPort;
          try {
            if (stackMode && runtimeStatePath) {
              await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
                stablePort: serverPort,
                backendPort: attemptedReplacementBackendPort,
                proxyPid: proxyController?.pid,
                listenerPid: replacement.listenerPid,
                wrapperPid: replacement.child.pid,
                mode: 'proxy',
                restartMode: reloadPlan.mode,
                reloadGeneration: reloadPlan.generation,
              }, { recordStackRuntimeUpdateImpl });
            }
          } catch (projectionError) {
            error.message += `; failed to record transport-committed replacement: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
          }
          throw annotateServerRestartError(error, classifyServerRestartFailure({
            error,
            stage: 'post_commit',
            child: replacement.child,
            oldServerStopped: true,
            recentLines: recentLineBuffer.snapshot(),
            transportCommitted: true,
            serviceRestored: true,
          }));
        }

        if (upstreamObservation === 'known_non_candidate') {
          const staleChild = replacement.child;
          replacement = null;
          if (!await cleanupProvisionalChild(staleChild)) {
            retainUnresolvedChild(staleChild, { oldServerStopped: true });
            const cleanupError = new Error(
              `[local] non-activated replacement termination was not confirmed (pid=${staleChild?.pid ?? 'unknown'}).`,
            );
            cleanupError.code = 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
            cleanupError.provisionalChild = staleChild;
            throw cleanupError;
          }
        }
        if (replacement) {
          retainUnresolvedChild(replacement.child, {
            oldServerStopped: true,
            activationCommitUnknown: true,
          });
          try {
            if (stackMode && runtimeStatePath) {
              await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
                stablePort: serverPort,
                backendPort: oldBackendPort,
                proxyPid: proxyController?.pid,
                listenerPid: null,
                wrapperPid: null,
                drainingPid: replacement.listenerPid ?? replacement.child.pid,
                mode: 'proxy',
                restartMode: reloadPlan.mode,
                reloadGeneration: reloadPlan.generation,
                preserveReloadCompletion: true,
              }, { recordStackRuntimeUpdateImpl });
            }
          } catch (projectionError) {
            error.message += `; failed to record activation-ambiguous replacement: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
          }
          const ambiguousActivationError = annotateServerRestartError(error, classifyServerRestartFailure({
            error,
            stage: 'activation_commit_unknown',
            child: replacement.child,
            oldServerStopped: true,
            recentLines: recentLineBuffer.snapshot(),
          }));
          ambiguousActivationError.serverRestartFailure.activationCommitUnknown = true;
          ambiguousActivationError.serverRestartFailure.activationTargetObserved = 'inconclusive';
          throw ambiguousActivationError;
        }
      }
      if (
        error?.code === 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE'
        || error?.code === 'ESERVERBACKENDPORTOCCUPIED'
      ) {
        throw annotateServerRestartError(error, classifyServerRestartFailure({
          error,
          stage: 'post-stop',
          child: null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        }));
      }
      if (oldServerStopped) {
        let recoveryTransportCommitted = false;
        let recoveryActivationAttempted = false;
        let recovery = null;
        try {
          recovery = await spawnServerBackend({
            port: oldBackendPort,
            recentLineBuffer,
            envOverrides: serverReloadMigrationEnv(reloadPlan),
            reloadPlan,
            purpose: 'recovery',
          });
          serverProcRef.current = recovery.child;
          observeActiveChildExit(recovery.child);
          activeBackendPort = oldBackendPort;
          recoveryActivationAttempted = true;
          emitTransitionEvent('backend_activation_requested', {
            generation: reloadPlan.generation,
            pid: recovery.child.pid,
            targetPort: oldBackendPort,
            mode: reloadPlan.mode,
            purpose: 'recovery',
          });
          await proxyController.flipUpstream?.({ targetPort: oldBackendPort });
          emitTransitionEvent('backend_activation_acknowledged', {
            generation: reloadPlan.generation,
            pid: recovery.child.pid,
            targetPort: oldBackendPort,
            mode: reloadPlan.mode,
            purpose: 'recovery',
          });
          emitTransitionEvent('maintenance_exited', {
            generation: reloadPlan.generation,
            pid: recovery.child.pid,
            targetPort: oldBackendPort,
            mode: reloadPlan.mode,
            purpose: 'recovery',
          });
          recoveryTransportCommitted = true;
          await drainProxyTargets([
            maintenanceTarget,
            attemptedReplacementBackendPort ? backendDrainTarget(attemptedReplacementBackendPort) : null,
          ], { graceMs: resolveDevProxyDrainMs(serverEnv) });
          if (stackMode && runtimeStatePath) {
            await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
              stablePort: serverPort,
              backendPort: oldBackendPort,
              proxyPid: proxyController?.pid,
              listenerPid: recovery.listenerPid,
              wrapperPid: recovery.child.pid,
              mode: 'proxy',
              restartMode: reloadPlan.mode,
              reloadGeneration: reloadPlan.generation,
            }, { recordStackRuntimeUpdateImpl });
          }
        } catch (recoveryError) {
          const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          if (recoveryError?.code === 'ESERVERPROVISIONALCLEANUPINCOMPLETE') {
            if (unresolvedProvisional?.child === recoveryError.provisionalChild) {
              retainUnresolvedChild(recoveryError.provisionalChild, { oldServerStopped: true });
            }
            if (stackMode && runtimeStatePath && Number(recoveryError?.provisionalChild?.pid) > 1) {
              try {
                await recordStackRuntimeUpdateImpl(runtimeStatePath, {
                  processes: { serverDrainingPid: Number(recoveryError.provisionalChild.pid) },
                });
              } catch (projectionError) {
                recoveryError.message += `; failed to record recovery cleanup attention: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
              }
            }
            throw annotateServerRestartError(recoveryError, classifyServerRestartFailure({
              error: recoveryError,
              stage: 'cleanup_incomplete',
              child: recoveryError.provisionalChild ?? null,
              oldServerStopped: true,
              recentLines: recentLineBuffer.snapshot(),
            }));
          }
          if (recovery && recoveryActivationAttempted && !recoveryTransportCommitted) {
            retainUnresolvedChild(recovery.child, {
              oldServerStopped: true,
              activationCommitUnknown: true,
            });
            try {
              if (stackMode && runtimeStatePath) {
                await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
                  stablePort: serverPort,
                  backendPort: oldBackendPort,
                  proxyPid: proxyController?.pid,
                  listenerPid: null,
                  wrapperPid: null,
                  drainingPid: recovery.listenerPid ?? recovery.child.pid,
                  mode: 'proxy',
                  restartMode: reloadPlan.mode,
                  reloadGeneration: reloadPlan.generation,
                  preserveReloadCompletion: true,
                }, { recordStackRuntimeUpdateImpl });
              }
            } catch (projectionError) {
              recoveryError.message += `; failed to record activation-ambiguous current-code recovery: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
            }
            const ambiguousRecoveryError = annotateServerRestartError(recoveryError, classifyServerRestartFailure({
              error: recoveryError,
              stage: 'activation_commit_unknown',
              child: recovery.child,
              oldServerStopped: true,
              recentLines: recentLineBuffer.snapshot(),
            }));
            ambiguousRecoveryError.serverRestartFailure.activationCommitUnknown = true;
            throw ambiguousRecoveryError;
          }
          if (recoveryTransportCommitted) {
            try {
              if (stackMode && runtimeStatePath) {
                await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
                  stablePort: serverPort,
                  backendPort: oldBackendPort,
                  proxyPid: proxyController?.pid,
                  listenerPid: recovery?.listenerPid ?? null,
                  wrapperPid: recovery?.child?.pid ?? null,
                  mode: 'proxy',
                  restartMode: reloadPlan.mode,
                  reloadGeneration: reloadPlan.generation,
                }, { recordStackRuntimeUpdateImpl });
              }
            } catch (projectionError) {
              recoveryError.message += `; failed to record transport-committed current-code recovery: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
            }
            const committedRecoveryError = annotateServerRestartError(recoveryError, classifyServerRestartFailure({
              error: recoveryError,
              stage: 'recovery_projection',
              child: serverProcRef.current,
              oldServerStopped: true,
              recentLines: recentLineBuffer.snapshot(),
              transportCommitted: true,
              serviceRestored: true,
            }));
            committedRecoveryError.serverRestartFailure.currentCodeRecoveryActive = true;
            throw committedRecoveryError;
          }
          throw annotateServerRestartError(
            error,
            classifyServerRestartFailure({
              error: new Error(`${error instanceof Error ? error.message : String(error)}; recovery failed: ${recoveryMessage}`),
              stage: 'recovery',
              child: null,
              oldServerStopped: true,
              recentLines: recentLineBuffer.snapshot(),
            })
          );
        }
      }
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'readiness',
          child: replacement?.child ?? null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
          serviceRestored: oldServerStopped,
        })
      );
    }
  };

  const createReloadPlanForContext = (context = {}) => context.reloadPlans?.server ?? createDevServerReloadPlan({
    changedDescriptors: context.changedDescriptors,
    descriptorEvidenceConclusive: context.descriptorEvidenceConclusive,
    generation: context.generation,
  });

  const restartOnce = async (context = {}) => {
    if (unresolvedProvisional?.child) {
      if (hasChildExited(unresolvedProvisional.child)) {
        removeChildFromChildren(children, unresolvedProvisional.child);
        unresolvedProvisional = null;
      } else {
        const error = new Error(
          `[local] watch restart refused: provisional or draining server termination was not confirmed and remains unresolved ` +
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
          transportCommitted: unresolvedProvisional.transportCommitted,
          serviceRestored: unresolvedProvisional.serviceRestored,
        }));
        annotated.serverRestartFailure.activationCommitUnknown = unresolvedProvisional.activationCommitUnknown;
        throw annotated;
      }
    }
    const reloadPlan = createReloadPlanForContext(context);
    if (proxyController) {
      return await restartWithExclusiveDbProxy(reloadPlan, context);
    }

    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    let restartStage = 'stopping-old';
    let oldServerStopped = false;
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);

    logger.log('[local] watch: server preflight passed → restarting...');
    const precheckObservationScope = createListenerOwnershipObservationScope({
      totalTimeoutMs: listenerOwnershipTimeoutMs,
      retryDelayMs: listenerOwnershipRetryDelayMs,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      probeTcpPortBindingImpl,
    });
    const currentListenerPid = await resolveServerPortListenerPidInProcessGroup({
      serverPort,
      rootPid: pid,
      listListenPidsImpl,
      listListenPidsWithStatusImpl,
      getProcessGroupIdImpl,
      listenerOwnershipTimeoutMs,
      listenerOwnershipRetryDelayMs,
      listenerObservationScope: precheckObservationScope,
    });
    const ownsCurrentListener = Number.isFinite(Number(currentListenerPid)) && Number(currentListenerPid) > 1;
    if (typeof context.revalidateGeneration === 'function' && !await context.revalidateGeneration()) return false;
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
      if (!killResult.killed) {
        observeActiveChildExit(currentServerProc);
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns port ${serverPort} but could not be stopped safely.\n` +
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
        disposition: 'exited',
      });
    } else {
      const free = await isServerPortProvenFree({
        serverPort,
        listenerObservationScope: precheckObservationScope,
      });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} is still alive, but port ${serverPort} has no listener proof for it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      if (!free) {
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
    }
    try {
      await observePortAndDatabaseRelease({
        port: serverPort,
        pid,
        scope: 'server port',
        reloadPlan,
      });
    } catch (error) {
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: 'post-stop',
          child: null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }

    let next = null;
    let listenerPid = null;
    const spawnTransition = {
      generation: reloadPlan.generation,
      mode: reloadPlan.mode,
      migrationMode: reloadPlan.migrationMode,
      targetPort: serverPort,
      purpose: 'replacement',
    };
    let migrationStarted = false;
    let migrationCompleted = false;
    const startupDeadline = createServerReadinessDeadline({
      readinessTimeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
      migrationTimeoutMs: resolveServerMigrationTimeoutMs({ env: serverEnv }),
    });
    if (reloadPlan.migrationMode === 'skip') emitTransitionEvent('migration_skipped', spawnTransition);
    const onLine = (lineEvent) => {
      recentLineBuffer.onLine(lineEvent);
      const signal = startupDeadline.observeLine(lineEvent);
      if (reloadPlan.migrationMode === 'skip') return;
      if (signal === 'migration_started' && !migrationStarted) {
        migrationStarted = true;
        emitTransitionEvent('migration_started', spawnTransition);
      } else if (signal === 'migration_completed' && migrationStarted && !migrationCompleted) {
        migrationCompleted = true;
        emitTransitionEvent('migration_completed', { ...spawnTransition, disposition: 'succeeded' });
      }
    };
    try {
      restartStage = 'spawn';
      next = await pmSpawnScriptImpl({
        label: 'server',
        dir: serverDir,
        script: serverScript,
        env: { ...serverEnv, ...serverReloadMigrationEnv(reloadPlan) },
        options: { onLine },
      });
      children.push(next);
      emitTransitionEvent('replacement_spawned', { ...spawnTransition, pid: next.pid });
      restartStage = 'readiness';
      startupDeadline.startReadiness();
      await waitForServerReadyImpl(internalServerUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
        childProcess: next,
        startupDeadline,
      });
      restartStage = 'ownership';
      listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort,
        spawnedPid: next.pid,
        listListenPidsImpl,
        listListenPidsWithStatusImpl,
        getProcessGroupIdImpl,
        listenerOwnershipTimeoutMs,
        listenerOwnershipRetryDelayMs,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
      emitTransitionEvent('replacement_ready', { ...spawnTransition, pid: next.pid, listenerPid });
    } catch (error) {
      if (migrationStarted && !migrationCompleted) {
        emitTransitionEvent('migration_completed', { ...spawnTransition, pid: next?.pid, disposition: 'failed' });
      }
      if (next) emitTransitionEvent('replacement_readiness_failed', { ...spawnTransition, pid: next.pid });
      const cleaned = await cleanupProvisionalChild(next);
      if (!cleaned) {
        retainUnresolvedChild(next, { oldServerStopped });
        const cleanupError = new Error(
          `[local] provisional server termination was not confirmed after direct reload startup failure ` +
            `(pid=${next?.pid ?? 'unknown'}, port=${serverPort}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        cleanupError.code = 'ESERVERPROVISIONALCLEANUPINCOMPLETE';
        if (stackMode && runtimeStatePath && Number(next?.pid) > 1) {
          try {
            await recordStackRuntimeUpdateImpl(runtimeStatePath, {
              processes: { serverDrainingPid: Number(next.pid) },
            });
          } catch (projectionError) {
            cleanupError.message += `; failed to record provisional cleanup attention: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`;
          }
        }
        throw annotateServerRestartError(
          cleanupError,
          classifyServerRestartFailure({
            error: cleanupError,
            stage: 'cleanup_incomplete',
            child: next,
            oldServerStopped,
            recentLines: recentLineBuffer.snapshot(),
          }),
        );
      }
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: restartStage,
          child: next,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        })
      );
    }
    serverProcRef.current = next;
    observeActiveChildExit(next);
    if (stackMode && runtimeStatePath) {
      try {
        await recordStackRuntimeServerActivationImpl(runtimeStatePath, {
          listenerPid,
          wrapperPid: next.pid,
          stablePort: serverPort,
          mode: 'direct',
          clearProxyState: true,
          restartMode: reloadPlan.mode,
          reloadGeneration: reloadPlan.generation,
        }, { recordStackRuntimeUpdateImpl });
      } catch (projectionError) {
        const error = new Error(
          `[local] direct replacement server is active, but runtime projection failed: ` +
            `${projectionError instanceof Error ? projectionError.message : String(projectionError)}`,
          { cause: projectionError },
        );
        const annotated = annotateServerRestartError(error, classifyServerRestartFailure({
          error,
          stage: 'post_commit',
          child: next,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
          serviceRestored: true,
        }));
        annotated.serverRestartFailure.directReplacementActive = true;
        throw annotated;
      }
    }
    logger.log(`[local] watch: server restarted (pid=${next.pid}, port=${serverPort})`);
    return true;
  };

  return {
    target: 'server',
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
    getBackoffRemainingMs() {
      return restartFailureTracker.getBackoffRemainingMs();
    },
    recordFailure(failure) {
      return restartFailureTracker.record(failure);
    },
    resetFailureBackoff() {
      restartFailureTracker.reset();
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
          logger,
        });
        emitTransitionEvent('preflight_completed', { ...transition, disposition: 'succeeded' });
        return { ok: true };
      } catch (error) {
        emitTransitionEvent('preflight_completed', { ...transition, disposition: 'failed' });
        throw error;
      }
    },
    async publishLifecycle(transition) {
      return await publishLifecycle(transition);
    },
    async publishFailureDisposition(disposition) {
      return await publishFailureDisposition(disposition);
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
        await publishLifecycle({
          phase: 'replacing',
          plan: reloadPlan,
        });
        const restarted = await restartOnce(context);
        if (restarted) restartFailureTracker.reset();
        return { restarted };
      } catch (e) {
        requestTransientListenerDiscoveryRetry(e);
        const failure = e?.serverRestartFailure;
        if (failure?.activationCommitUnknown) {
          logger.error(
            '[local] watch: exclusive proxy activation outcome is unresolved; the provisional server remains tracked and no competing recovery was started.'
          );
        } else if (failure?.directReplacementActive) {
          logger.error(
            '[local] watch: direct replacement server is active, but runtime projection needs attention.'
          );
        } else if (failure?.currentCodeRecoveryActive) {
          logger.error(
            '[local] watch: current-code recovery server is active at the proxy, but post-activation cleanup or runtime projection needs attention.'
          );
        } else if (failure?.transportCommitted) {
          logger.error(
            '[local] watch: server restart committed at the proxy; replacement remains active, but post-activation cleanup or runtime projection needs attention.'
          );
        } else if (failure?.serviceRestored) {
          logger.error(
            '[local] watch: replacement startup failed after the old server was stopped; a current-code recovery server is active, and the original reload failure is reported for attention.'
          );
        } else if (failure?.oldServerStopped) {
          logger.error(
            '[local] watch: server restart failed after the old server was stopped; service has not been restored and the proxy remains in maintenance.'
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
        throw e;
      }
    },
  };
}
