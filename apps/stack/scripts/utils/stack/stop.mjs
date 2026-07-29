import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getComponentDir, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { isPidAlive, readPidState } from '../expo/expo.mjs';
import { stopLocalDaemon } from '../../daemon.mjs';
import { stopHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import {
  finalizeStackRuntimeStop,
  getStackRuntimeProcessEntries,
  getStackRuntimeProcessInstanceFingerprint,
  readStackRuntimeStateFile,
  recordStackRuntimeStopRequest,
  withStackRuntimeStopTransaction,
} from './runtime_state.mjs';
import {
  getPsEnvLine,
  killPidOwnedByStack,
  killProcessGroupOwnedByStack,
  listPidsWithEnvNeedles,
  listPidsWithEnvNeedlesAndEnvBindingNames,
  observePsEnvLine,
  readStackProcessKindFromEnvLine,
  textContainsEnvBindingName,
  textContainsNeedle,
} from '../proc/ownership.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { coercePort } from '../server/port.mjs';
import { resolveServerShutdownGraceMs } from '../server/shutdown_grace.mjs';
import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';
import { daemonControlPost } from './daemonControlClient.mjs';

function resolveServerComponentFromStackEnv(env) {
  const v =
    (env.HAPPIER_STACK_SERVER_COMPONENT ?? '').toString().trim() || 'happier-server-light';
  return v === 'happier-server' ? 'happier-server' : 'happier-server-light';
}

function normalizeCleanupResults(results) {
  const normalized = [];
  const pidIndexes = new Map();
  for (const result of results) {
    const pid = Number(result?.pid);
    if (!Number.isFinite(pid) || pid <= 1) {
      normalized.push(result);
      continue;
    }
    const existingIndex = pidIndexes.get(pid);
    if (existingIndex == null) {
      pidIndexes.set(pid, normalized.length);
      normalized.push(result);
    } else {
      normalized[existingIndex] = result;
    }
  }
  return normalized;
}

const DEFINITIVE_NOT_OWNED_REASONS = new Set([
  'not_owned',
  'session_process_kind',
  'stack_name_mismatch',
  'missing_process_env',
  'process-not-found',
]);

function isServerRuntimeProcessKey(key) {
  return key === 'serverPid'
    || key === 'serverWrapperPid'
    || key === 'happierServerBackendPid'
    || key === 'serverBackendPid'
    || key === 'serverDrainingPid';
}

function isEphemeralRuntimeFallbackKillAllowed(line, stackName) {
  if (!line || !textContainsNeedle(line, `HAPPIER_STACK_STACK=${stackName}`)) {
    return false;
  }
  const kind = readStackProcessKindFromEnvLine(line);
  if (kind === 'session') return false;
  if (kind === 'infra' || kind === 'server') return true;
  if (kind) return false;

  return (
    textContainsNeedle(line, 'npm_package_name=@happier-dev/server') &&
    textContainsEnvBindingName(line, 'npm_lifecycle_event')
  );
}

async function requestLifecycleOwnerShutdown(
  pid,
  { stackName, envPath, cliHomeDir, json, serverShutdownGraceMs, processInstanceFingerprint },
) {
  return await killPidOwnedByStack(pid, {
    stackName,
    envPath,
    cliHomeDir,
    label: 'runner',
    json,
    signal: 'SIGTERM',
    graceMs: serverShutdownGraceMs,
    processInstanceFingerprint,
  });
}

async function stopDaemonTrackedSessions({ cliHomeDir, serverUrl, json }) {
  // Read daemon state file written by happier-cli; needed to call control server (/list, /stop-session).
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl });
  if (!existsSync(statePath)) {
    return { ok: true, skipped: true, reason: 'missing_state', stoppedSessionIds: [] };
  }

  let state = null;
  try {
    state = JSON.parse(await readFile(statePath, 'utf-8'));
  } catch {
    return { ok: false, skipped: true, reason: 'bad_state', stoppedSessionIds: [] };
  }

  const httpPort = Number(state?.httpPort);
  const pid = Number(state?.pid);
  const controlToken = String(state?.controlToken ?? '').trim();
  if (!Number.isFinite(httpPort) || httpPort <= 0) {
    return { ok: false, skipped: true, reason: 'missing_http_port', stoppedSessionIds: [] };
  }
  if (!Number.isFinite(pid) || pid <= 1) {
    return { ok: false, skipped: true, reason: 'missing_pid', stoppedSessionIds: [] };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { ok: true, skipped: true, reason: 'daemon_not_running', stoppedSessionIds: [] };
  }

  // Prefer a single /stop call with stopSessions, so the daemon can stop *all* tracked sessions
  // (including PID-fallback sessions) in a centralized, versioned way.
  const stopOk = await daemonControlPost({ httpPort, path: '/stop', body: { stopSessions: true }, controlToken })
    .then(() => true)
    .catch((e) => {
      if (!json) console.warn(`[stack] failed to stop daemon with sessions: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    });

  if (stopOk) {
    return { ok: true, skipped: false, stoppedSessionIds: [] };
  }

  // Back-compat fallback: older daemons may not support /stop with stopSessions.
  const listed = await daemonControlPost({ httpPort, path: '/list', controlToken }).catch((e) => {
    if (!json) console.warn(`[stack] failed to list daemon sessions: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  const children = Array.isArray(listed?.children) ? listed.children : [];

  const stoppedSessionIds = [];
  for (const child of children) {
    const sid = String(child?.happySessionId ?? '').trim();
    if (!sid) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await daemonControlPost({ httpPort, path: '/stop-session', body: { sessionId: sid }, controlToken }).catch(() => null);
    if (res?.success) {
      stoppedSessionIds.push(sid);
    }
  }

  return { ok: true, skipped: false, stoppedSessionIds };
}

async function stopExpoStateDir({ stackName, baseDir, kind, stateFileName, envPath, json, cleanupResults, confirmedCleanupPids, killProcessGroupOwnedByStackImpl }) {
  const root = join(baseDir, kind);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const killed = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const statePath = join(root, e.name, stateFileName);
    // eslint-disable-next-line no-await-in-loop
    const state = await readPidState(statePath);
    if (!state) continue;
    const pid = Number(state.pid);

    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (confirmedCleanupPids?.has(pid)) continue;
    if (!isPidAlive(pid)) continue;

    if (!json) {
      // eslint-disable-next-line no-console
      console.log(`[stack] stopping ${kind} (pid=${pid}) for ${stackName}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await killProcessGroupOwnedByStackImpl(pid, {
      stackName,
      envPath,
      label: kind,
      json,
      processInstanceFingerprint: state.processInstanceFingerprint ?? null,
    });
    if (result?.killed === true) {
      cleanupResults.push({ ok: true, step: kind, pid, reason: result.reason ?? 'killed' });
      confirmedCleanupPids?.add(pid);
      killed.push({ pid, port: null, statePath });
    } else if (!DEFINITIVE_NOT_OWNED_REASONS.has(result?.reason)) {
      cleanupResults.push({ ok: false, step: kind, pid, reason: result?.reason ?? 'cleanup_unconfirmed' });
    }
  }
  return killed;
}

export function resolveStackCleanupExecutorLockPath(baseDir) {
  const root = String(baseDir ?? '').trim();
  if (!root) throw new Error('resolveStackCleanupExecutorLockPath requires baseDir');
  return join(root, 'stack.cleanup-executor.lock');
}

async function withStackCleanupExecutorLock(input, dependencies, fn) {
  const lockOptions = dependencies.cleanupExecutorLockOptions ?? {};
  const lockPath = lockOptions.lockPath ?? resolveStackCleanupExecutorLockPath(input.baseDir);
  const timeoutMs = lockOptions.timeoutMs ?? 300_000;
  return await withJsonOwnerFileLock(fn, {
    lockPath,
    timeoutMs,
    pollIntervalMs: lockOptions.pollIntervalMs ?? 125,
    staleAfterMs: lockOptions.staleAfterMs ?? Math.max(60_000, timeoutMs),
    errorLabel: 'stack cleanup executor lock',
    allowLiveOwnerStaleReclaim: true,
    onWait: lockOptions.onWait,
  });
}

export async function stopStackWithEnv(input = {}, dependencies = {}) {
  return await withStackCleanupExecutorLock(input, dependencies, async () => {
    return await stopStackWithEnvSerialized(input, dependencies);
  });
}

export async function stopStackServiceWithEnv(input = {}, stopServiceImpl, dependencies = {}) {
  if (typeof stopServiceImpl !== 'function') throw new Error('stopStackServiceWithEnv requires stopServiceImpl');
  return await withStackCleanupExecutorLock(input, dependencies, async () => {
    const runtimeStatePath = join(input.baseDir, 'stack.runtime.json');
    const attribution = {
      requestedBy: String(input.stopAttribution?.requestedBy ?? 'service stop'),
      reason: String(input.stopAttribution?.reason ?? 'service lifecycle stop'),
    };
    await recordStackRuntimeStopRequest(runtimeStatePath, {
      signal: 'SIGTERM',
      requestedBy: attribution.requestedBy,
      reason: attribution.reason,
      preserveDaemon: input.preserveDaemon === true,
    });
    await stopServiceImpl();
    const actions = await stopStackWithEnvSerialized({ ...input, stopAttribution: attribution }, dependencies);
    if (actions.finalization?.finalized !== true) {
      const error = new Error(`[stack] service cleanup is incomplete (${String(actions.finalization?.reason ?? 'unknown')})`);
      error.code = 'ESTACKRUNTIMECLEANUPINCOMPLETE';
      error.actions = actions;
      throw error;
    }
    return actions;
  });
}

export async function completeInterruptedStackStopBeforeStart(input = {}, dependencies = {}) {
  const runtimeStatePath = join(input.baseDir, 'stack.runtime.json');
  const observed = await readStackRuntimeStateFile(runtimeStatePath);
  if (!observed?.stopRequest || typeof observed.stopRequest !== 'object') {
    return { completed: false, reason: 'no_stop_request' };
  }

  return await withStackCleanupExecutorLock(input, dependencies, async ({ waited }) => {
    const current = await readStackRuntimeStateFile(runtimeStatePath);
    if (!current?.stopRequest || typeof current.stopRequest !== 'object') {
      return { completed: true, reason: 'completed_by_active_cleanup', waited };
    }
    const ownerPid = Number(current.ownerPid);
    const normalizedOwnerPid = Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null;
    const ownerStartedAt = String(current.startedAt ?? '').trim();
    const stopRequest = current.stopRequest;
    const actions = await stopStackWithEnvSerialized({
      ...input,
      preserveDaemon: stopRequest.preserveDaemon === true,
      stopAttribution: {
        requestedBy: String(stopRequest.requestedBy ?? 'startup cleanup continuation'),
        reason: String(stopRequest.reason ?? 'complete interrupted stop before startup'),
      },
      ...(normalizedOwnerPid && ownerStartedAt
        ? { expectedOwnerPid: normalizedOwnerPid, expectedOwnerStartedAt: ownerStartedAt }
        : {}),
    }, dependencies);
    if (actions.finalization?.finalized !== true) {
      const error = new Error(
        `[stack] ${String(input.stackName ?? 'stack')} stop cleanup is incomplete (${String(actions.finalization?.reason ?? actions.stopAuthorization?.reason ?? 'unknown')})`,
      );
      error.code = 'ESTACKRUNTIMECLEANUPINCOMPLETE';
      error.actions = actions;
      throw error;
    }
    return { completed: true, waited, ...actions };
  });
}

async function stopStackWithEnvSerialized(input = {}, dependencies = {}) {
  if (input.expectedOwnerPid == null) {
    return await stopStackWithEnvInternal(input, dependencies);
  }
  const resolvedStopAttribution = {
    requestedBy: String(input.stopAttribution?.requestedBy ?? 'stack stop'),
    reason: String(input.stopAttribution?.reason ?? persistentReason(input.aggressive, input.sweepOwned, input.autoSweep)),
  };
  const runtimeStatePath = join(input.baseDir, 'stack.runtime.json');
  return await withStackRuntimeStopTransaction(runtimeStatePath, {
    signal: 'SIGTERM',
    requestedBy: resolvedStopAttribution.requestedBy,
    reason: resolvedStopAttribution.reason,
    preserveDaemon: input.preserveDaemon === true,
    expectedOwnerPid: input.expectedOwnerPid,
    expectedOwnerStartedAt: input.expectedOwnerStartedAt,
  }, async (transaction) => {
    const freshRequest = transaction.runtimeState?.stopRequest;
    return await stopStackWithEnvInternal({
      ...input,
      preserveDaemon: transaction.preserveDaemon,
      stopAttribution: freshRequest ? {
        requestedBy: freshRequest.requestedBy,
        reason: freshRequest.reason,
      } : input.stopAttribution,
    }, dependencies, transaction);
  });
}

async function stopStackWithEnvInternal({
  rootDir,
  stackName,
  baseDir,
  env,
  json,
  noDocker = false,
  aggressive = false,
  sweepOwned = false,
  autoSweep = true,
  preserveDaemon = false,
  stopAttribution = null,
  expectedOwnerPid = null,
  expectedOwnerStartedAt = null,
}, {
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  stopHappyServerManagedInfraImpl = stopHappyServerManagedInfra,
  observePsEnvLineImpl = observePsEnvLine,
  requestLifecycleOwnerShutdownImpl = requestLifecycleOwnerShutdown,
} = {}, runtimeStopTransaction = null) {
  const resolvedStopAttribution = {
    requestedBy: String(stopAttribution?.requestedBy ?? 'stack stop'),
    reason: String(stopAttribution?.reason ?? persistentReason(aggressive, sweepOwned, autoSweep)),
  };
  const actions = {
    stackName,
    baseDir,
    aggressive,
    sweepOwned,
    preserveDaemon,
    stopAttribution: resolvedStopAttribution,
    stopAuthorization: null,
    runner: null,
    daemonSessionsStopped: null,
    daemonStopped: false,
    killedPorts: [],
    expoDev: [],
    uiDev: [],
    mobile: [],
    infra: null,
    errors: [],
  };

  const serverComponent = resolveServerComponentFromStackEnv(env);
  const port = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  const backendPort = coercePort(env.HAPPIER_STACK_SERVER_BACKEND_PORT);
  const internalServerUrl = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:3005';
  const cliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(baseDir, 'cli')).toString();
  const cliDir = getComponentDir(rootDir, 'happier-cli', env);
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const envPath = resolveExplicitStackEnvFilePath(env);
  const cleanupResults = [];
  const confirmedCleanupPids = new Set();
  const serverShutdownGraceMs = resolveServerShutdownGraceMs(env);

  // Preferred: stop stack-started processes (by PID) recorded in stack.runtime.json.
  // This is safer than killing whatever happens to listen on a port, and doesn't rely on the runner's shutdown handler.
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  let runtimeState = runtimeStopTransaction?.runtimeState ?? await readStackRuntimeStateFile(runtimeStatePath);
  let expectedStopState = null;
  if (runtimeStopTransaction || runtimeState || expectedOwnerPid != null) {
    let stopTransaction = runtimeStopTransaction;
    try {
      if (!stopTransaction) stopTransaction = await recordStackRuntimeStopRequest(runtimeStatePath, {
        signal: 'SIGTERM',
        requestedBy: resolvedStopAttribution.requestedBy,
        reason: resolvedStopAttribution.reason,
        preserveDaemon,
        expectedOwnerPid,
        expectedOwnerStartedAt,
      });
    } catch (error) {
      if (expectedOwnerPid != null) {
        actions.stopAuthorization = { authorized: false, reason: 'authorization_failed' };
        actions.errors.push({ step: 'stop-authorization', error: error instanceof Error ? error.message : String(error) });
        return actions;
      }
    }
    if (expectedOwnerPid != null && stopTransaction?.authorized !== true) {
      actions.stopAuthorization = {
        authorized: false,
        reason: stopTransaction?.reason ?? 'authorization_failed',
        expectedOwnerPid: Number(expectedOwnerPid),
        expectedOwnerStartedAt: String(expectedOwnerStartedAt ?? '') || null,
        currentOwnerPid: stopTransaction?.currentOwnerPid ?? null,
        currentOwnerStartedAt: stopTransaction?.currentOwnerStartedAt ?? null,
      };
      return actions;
    }
    actions.stopAuthorization = stopTransaction
      ? { authorized: stopTransaction.authorized !== false, reason: stopTransaction.reason ?? 'authorized' }
      : null;
    runtimeState = stopTransaction?.runtimeState ?? runtimeState;
    expectedStopState = stopTransaction?.expected ?? null;
  }
  const runnerPid = Number(runtimeState?.ownerPid);
  const processEntries = getStackRuntimeProcessEntries(runtimeState);

  actions.runner = { stopped: false, pid: Number.isFinite(runnerPid) ? runnerPid : null, reason: runtimeState ? 'not_running_or_not_owned' : 'missing_state' };
  if (Number.isFinite(runnerPid) && runnerPid > 1 && isPidAlive(runnerPid)) {
    const res = await requestLifecycleOwnerShutdownImpl(runnerPid, {
      stackName,
      envPath,
      cliHomeDir,
      json,
      serverShutdownGraceMs,
      processInstanceFingerprint: getStackRuntimeProcessInstanceFingerprint(runtimeState, 'ownerPid', runnerPid),
    });
    actions.runner = { stopped: res.killed, pid: runnerPid, reason: res.reason };
    const definitivelyUnowned = DEFINITIVE_NOT_OWNED_REASONS.has(res?.reason);
    cleanupResults.push({ ok: res.killed === true || definitivelyUnowned, step: 'lifecycle-owner', pid: runnerPid, reason: res.reason ?? 'cleanup_unconfirmed' });
    if (res.killed === true) confirmedCleanupPids.add(runnerPid);
  }

  const killedProcessPids = [];
  const seenProcessPids = new Set();
  for (const { key, pid, processInstanceFingerprint } of processEntries) {
    if (preserveDaemon && isDaemonRuntimeProcessKey(key)) {
      continue;
    }
    if (pid === runnerPid) continue;
    if (seenProcessPids.has(pid)) continue;
    seenProcessPids.add(pid);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (!isPidAlive(pid)) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await killProcessGroupOwnedByStackImpl(pid, {
      stackName, envPath, cliHomeDir, label: key, json,
      processInstanceFingerprint,
      ...(isServerRuntimeProcessKey(key) ? { graceMs: serverShutdownGraceMs } : {}),
    });
    if (res.killed) {
      confirmedCleanupPids.add(pid);
      killedProcessPids.push({ key, pid, reason: res.reason, pgid: res.pgid ?? null });
      cleanupResults.push({ ok: true, step: key, pid, reason: res.reason ?? 'killed' });
      continue;
    }

    // Back-compat for earlier "stackless" runs:
    // Some repo-local runs started infra without HAPPIER_STACK_ENV_FILE/HAPPIER_HOME_DIR markers.
    // For ephemeral stacks, allow stopping runtime-recorded PIDs when the process environment still
    // proves the stack name, to avoid leaving orphaned servers/expo after quitting the TUI.
    if (runtimeState?.ephemeral && res.reason === 'not_owned') {
      // eslint-disable-next-line no-await-in-loop
      const fallback = await killProcessGroupOwnedByStackImpl(pid, {
        stackName,
        envPath,
        cliHomeDir,
        label: `${key}-ephemeral-runtime`,
        json,
        graceMs: 800,
        signal: 'SIGTERM',
        processInstanceFingerprint,
        resolvePidStackOwnershipImpl: async (candidatePid) => {
          const line = await getPsEnvLine(candidatePid);
          return isEphemeralRuntimeFallbackKillAllowed(line, stackName)
            ? { status: 'owned', owned: true, reason: 'ephemeral_runtime_signature' }
            : { status: 'not_owned', owned: false, reason: 'process_identity_mismatch' };
        },
      });
      if (fallback?.killed) {
        confirmedCleanupPids.add(pid);
        killedProcessPids.push({ key, pid, reason: 'killed_ephemeral_runtime', pgid: fallback.pgid ?? null });
        cleanupResults.push({ ok: true, step: key, pid, reason: 'killed_ephemeral_runtime' });
      } else {
        cleanupResults.push({ ok: false, step: key, pid, reason: fallback?.reason ?? 'cleanup_unconfirmed' });
      }
      continue;
    }
    if (DEFINITIVE_NOT_OWNED_REASONS.has(res?.reason)) {
      cleanupResults.push({ ok: true, step: key, pid, reason: res.reason });
      continue;
    }
    cleanupResults.push({ ok: false, step: key, pid, reason: res.reason ?? 'cleanup_unconfirmed' });
  }
  actions.killedPorts = actions.killedPorts ?? [];
  actions.processes = { killed: killedProcessPids };

  if (aggressive && !preserveDaemon) {
    try {
      actions.daemonSessionsStopped = await stopDaemonTrackedSessions({ cliHomeDir, serverUrl: internalServerUrl, json });
    } catch (e) {
      actions.errors.push({ step: 'daemon-sessions', error: e instanceof Error ? e.message : String(e) });
    }
  } else if (preserveDaemon) {
    actions.daemonSessionsStopped = { ok: true, skipped: true, reason: 'preserve_daemon', stoppedSessionIds: [] };
  }

  if (!preserveDaemon) {
    try {
      // If happier-cli isn't built yet (common in repo checkouts), running `happier.mjs` can fail noisily.
      // Stopping stack infra should still work without the daemon stop step.
      const cliDistIndex = join(cliDir, 'dist', 'index.mjs');
      if (existsSync(cliDistIndex)) {
        await stopLocalDaemon({
          cliBin,
          internalServerUrl,
          cliHomeDir,
          runtimeStatePath,
          stackName,
        });
        actions.daemonStopped = true;
      }
    } catch (e) {
      actions.errors.push({ step: 'daemon', error: e instanceof Error ? e.message : String(e) });
    }
  }

  try {
    actions.expoDev = await stopExpoStateDir({ stackName, baseDir, kind: 'expo-dev', stateFileName: 'expo.state.json', envPath, json, cleanupResults, confirmedCleanupPids, killProcessGroupOwnedByStackImpl });
  } catch (e) {
    actions.errors.push({ step: 'expo-dev', error: e instanceof Error ? e.message : String(e) });
    cleanupResults.push({ ok: false, step: 'expo-dev', reason: 'cleanup_failed' });
  }
  try {
    // Legacy cleanups (best-effort): older runs used separate state dirs.
    actions.uiDev = await stopExpoStateDir({ stackName, baseDir, kind: 'ui-dev', stateFileName: 'ui.state.json', envPath, json, cleanupResults, confirmedCleanupPids, killProcessGroupOwnedByStackImpl });
    const killedDev = await stopExpoStateDir({ stackName, baseDir, kind: 'mobile-dev', stateFileName: 'mobile.state.json', envPath, json, cleanupResults, confirmedCleanupPids, killProcessGroupOwnedByStackImpl });
    const killedLegacy = await stopExpoStateDir({ stackName, baseDir, kind: 'mobile', stateFileName: 'expo.state.json', envPath, json, cleanupResults, confirmedCleanupPids, killProcessGroupOwnedByStackImpl });
    actions.mobile = [...killedDev, ...killedLegacy];
  } catch (e) {
    actions.errors.push({ step: 'expo-mobile', error: e instanceof Error ? e.message : String(e) });
    cleanupResults.push({ ok: false, step: 'expo-mobile', reason: 'cleanup_failed' });
  }

  // IMPORTANT:
  // Never kill "whatever is listening on a port" in stack mode.
  void backendPort;
  void port;

  const managed = (env.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0';
  if (!noDocker && serverComponent === 'happier-server' && managed) {
    try {
      actions.infra = await stopHappyServerManagedInfraImpl({ stackName, baseDir, removeVolumes: false });
      cleanupResults.push({ ok: actions.infra?.ok === true, step: 'infra', reason: actions.infra?.reason ?? (actions.infra?.ok ? 'stopped' : 'cleanup_unconfirmed') });
    } catch (e) {
      actions.errors.push({ step: 'infra', error: e instanceof Error ? e.message : String(e) });
      cleanupResults.push({ ok: false, step: 'infra', reason: 'cleanup_failed' });
    }
  } else {
    actions.infra = { ok: true, skipped: true, reason: noDocker ? 'no_docker' : 'not_managed_or_not_happier_server' };
  }

  // Last resort: sweep any remaining processes that still carry this stack env file in their environment.
  // IMPORTANT:
  // This must NOT kill daemon-spawned sessions/LLM/agent processes. Those should survive infra restarts.
  //
  // We only target infra processes by requiring HAPPIER_STACK_PROCESS_KIND=infra in addition to the stack env file.
  // We also exclude our own PID.
  const autoSweepFromEnvRaw = (env?.HAPPIER_STACK_STOP_AUTO_SWEEP ?? '').toString().trim();
  const autoSweepFromEnv = autoSweepFromEnvRaw ? autoSweepFromEnvRaw !== '0' : null;
  const autoSweepResolved = typeof autoSweepFromEnv === 'boolean' ? autoSweepFromEnv : Boolean(autoSweep);

  // If the runtime state exists but its owner PID is stale (e.g. runner was Ctrl+C'd),
  // treat it like "missing" and fall back to a safe infra-only sweep.
  const runtimeStateUsable = Boolean(runtimeState) && Number.isFinite(runnerPid) && runnerPid > 1 && isPidAlive(runnerPid);
  const shouldAutoSweep = autoSweepResolved && envPath && !runtimeStateUsable;
  if ((sweepOwned || shouldAutoSweep) && envPath) {
    const envNeedle = `HAPPIER_STACK_ENV_FILE=${envPath}`;
    const infraTagged = await listPidsWithEnvNeedles([envNeedle, 'HAPPIER_STACK_PROCESS_KIND=infra']);

    // Compatibility sweep for older stacks: some long-running infra (notably server dev loops)
    // may not have been started with HAPPIER_STACK_PROCESS_KIND=infra yet. We restrict this
    // fallback to npm/yarn managed server processes to avoid touching daemon-spawned sessions.
    const legacyServer = await listPidsWithEnvNeedlesAndEnvBindingNames([
      envNeedle,
      'npm_package_name=@happier-dev/server',
    ], ['npm_lifecycle_event']);

    const pids = [...new Set([...infraTagged, ...legacyServer])]
      .filter((pid) => pid !== process.pid)
      .filter((pid) => Number.isFinite(pid) && pid > 1);
    const preservedPids = preserveDaemon
      ? new Set(
          processEntries
            .filter(({ key }) => isDaemonRuntimeProcessKey(key))
            .map(({ pid }) => pid)
            .filter((pid) => Number.isFinite(pid) && pid > 1),
        )
      : null;

    const swept = [];
    const sweepSkipped = [];
    for (const pid of Array.from(new Set(pids))) {
      if (preservedPids?.has(pid)) continue;
      if (confirmedCleanupPids.has(pid)) continue;
      if (!isPidAlive(pid)) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await killProcessGroupOwnedByStackImpl(pid, { stackName, envPath, cliHomeDir, label: 'sweep', json });
      if (res.killed) {
        confirmedCleanupPids.add(pid);
        swept.push({ pid, reason: res.reason, pgid: res.pgid ?? null });
      }
      cleanupResults.push({
        ok: res?.killed === true || DEFINITIVE_NOT_OWNED_REASONS.has(res?.reason),
        step: 'sweep',
        pid,
        reason: res?.reason ?? 'cleanup_unconfirmed',
      });
    }

    // Repo-local fallback: older stackless infra runs may have omitted HAPPIER_STACK_ENV_FILE.
    // Do not sweep by only (stackName + repoDir): daemon-spawned session runners inherit
    // those repo-local markers and must survive stack/TUI restarts.
    const repoDir = String(env.HAPPIER_STACK_REPO_DIR ?? '').trim();
    const isRepoLocalStack = stackName && stackName !== 'main' && String(stackName).startsWith('repo-');
    if (autoSweepResolved && shouldAutoSweep && swept.length === 0 && isRepoLocalStack && repoDir) {
      const repoLocalNeedles = [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      ];
      const repoLocalInfraTagged = await listPidsWithEnvNeedles([
        ...repoLocalNeedles,
        'HAPPIER_STACK_PROCESS_KIND=infra',
      ]);
      const repoLocalLegacyServer = await listPidsWithEnvNeedlesAndEnvBindingNames([
        ...repoLocalNeedles,
        'npm_package_name=@happier-dev/server',
      ], ['npm_lifecycle_event']);
      const repoLocalInfraPidSet = new Set(repoLocalInfraTagged);
      const repoLocalLegacyPidSet = new Set(repoLocalLegacyServer);
      const repoLocalPids = [...new Set([...repoLocalInfraTagged, ...repoLocalLegacyServer])]
        .filter((pid) => pid !== process.pid)
        .filter((pid) => Number.isFinite(pid) && pid > 1);
      for (const pid of Array.from(new Set(repoLocalPids))) {
        if (preservedPids?.has(pid)) continue;
        if (confirmedCleanupPids.has(pid)) continue;
        if (!isPidAlive(pid)) continue;
        // eslint-disable-next-line no-await-in-loop
        const identity = await observePsEnvLineImpl(pid);
        if (identity?.status !== 'ok' || !identity.line) {
          const reason = identity?.reason ?? 'process-identity-inconclusive';
          sweepSkipped.push({ pid, reason });
          if (identity?.status !== 'not_found') {
            cleanupResults.push({ ok: false, step: 'repo-local-sweep', pid, reason });
          }
          continue;
        }
        const line = identity.line;
        const processKind = readStackProcessKindFromEnvLine(line);
        const exactRepoIdentity = repoLocalNeedles.every((needle) => textContainsNeedle(line, needle));
        const stillInfraTagged = repoLocalInfraPidSet.has(pid) && processKind === 'infra';
        const stillLegacyServer = repoLocalLegacyPidSet.has(pid)
          && textContainsNeedle(line, 'npm_package_name=@happier-dev/server')
          && textContainsEnvBindingName(line, 'npm_lifecycle_event');
        if (processKind === 'session' || !exactRepoIdentity || (!stillInfraTagged && !stillLegacyServer)) {
          const reason = processKind === 'session' ? 'session_process_kind' : 'process_identity_mismatch';
          sweepSkipped.push({ pid, reason });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const stopped = await killProcessGroupOwnedByStackImpl(pid, {
          stackName,
          envPath,
          cliHomeDir,
          label: 'repo-local-stackless-sweep',
          json,
          graceMs: 800,
          signal: 'SIGTERM',
          resolvePidStackOwnershipImpl: async (candidatePid) => {
            const current = await observePsEnvLineImpl(candidatePid);
            if (current?.status !== 'ok' || !current.line) {
              return { status: 'inconclusive', owned: false, reason: current?.reason ?? 'process-identity-inconclusive' };
            }
            const currentKind = readStackProcessKindFromEnvLine(current.line);
            const currentExactRepoIdentity = repoLocalNeedles.every((needle) => textContainsNeedle(current.line, needle));
            const currentInfraTagged = repoLocalInfraPidSet.has(candidatePid) && currentKind === 'infra';
            const currentLegacyServer = repoLocalLegacyPidSet.has(candidatePid)
              && textContainsNeedle(current.line, 'npm_package_name=@happier-dev/server')
              && textContainsEnvBindingName(current.line, 'npm_lifecycle_event');
            return currentKind !== 'session' && currentExactRepoIdentity && (currentInfraTagged || currentLegacyServer)
              ? { status: 'owned', owned: true, reason: 'repo_local_stackless_signature' }
              : { status: 'not_owned', owned: false, reason: 'process_identity_mismatch' };
          },
        });
        const confirmed = stopped?.killed === true && !isPidAlive(pid);
        if (stopped?.killed) {
          swept.push({ pid, reason: 'killed_repo_local_stackless_sweep', pgid: stopped.pgid ?? null });
        }
        if (confirmed) confirmedCleanupPids.add(pid);
        cleanupResults.push({ ok: confirmed, step: 'repo-local-sweep', pid, reason: confirmed ? 'killed_repo_local_stackless_sweep' : 'cleanup_unconfirmed' });
      }
    }

    actions.sweep = { pids: swept, skipped: sweepSkipped, auto: shouldAutoSweep && !sweepOwned };
  }

  actions.finalization = await (runtimeStopTransaction
    ? runtimeStopTransaction.finalize({ cleanupResults: normalizeCleanupResults(cleanupResults) })
    : finalizeStackRuntimeStop(runtimeStatePath, {
      expected: expectedStopState,
      preserveDaemon,
      cleanupResults: normalizeCleanupResults(cleanupResults),
    })).catch((error) => ({ finalized: false, reason: 'finalization_failed', error: error instanceof Error ? error.message : String(error) }));
  if (actions.finalization.reason === 'cleanup_incomplete' || actions.finalization.reason === 'finalization_failed') {
    actions.errors.push({ step: 'runtime-finalization', reason: actions.finalization.reason, ...(actions.finalization.error ? { error: actions.finalization.error } : {}) });
  }

  return actions;
}

function persistentReason(aggressive, sweepOwned, autoSweep) {
  if (aggressive) return 'explicit stack stop (aggressive)';
  if (sweepOwned) return 'explicit stack stop (sweep-owned)';
  if (autoSweep === false) return 'explicit stack stop (no-auto-sweep)';
  return 'explicit stack stop';
}

function isDaemonRuntimeProcessKey(key) {
  return String(key) === 'daemonPid' || String(key) === 'daemonPids';
}
