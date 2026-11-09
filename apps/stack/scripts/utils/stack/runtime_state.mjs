import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { isPidAlive, observePidLiveness } from '../proc/pids.mjs';
import { isPidOwnedByStack } from '../proc/ownership.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { normalizeStackRuntimeOwnerStartedAt } from './runtime_owner_incarnation.mjs';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

export { isPidAlive };

export function getStackRuntimeStatePath(stackName) {
  const { baseDir } = resolveStackEnvPath(stackName);
  return join(baseDir, 'stack.runtime.json');
}

export async function readStackRuntimeStateFile(statePath) {
  const parsed = await readJsonIfExists(statePath, { defaultValue: null });
  return parsed && typeof parsed === 'object' ? parsed : null;
}

const STACK_SERVER_LIFECYCLE_PHASES = new Set([
  'idle',
  'planned',
  'replacing',
  'maintenance',
  'retry-scheduled',
  'blocked',
  'unavailable',
  'completed',
]);

function normalizeServerReloadPlan(plan) {
  if (!isPlainObject(plan)) return null;
  const mode = String(plan.mode ?? '').trim();
  const generation = plan.generation;
  const reason = String(plan.reason ?? '').trim();
  if (!mode || !Number.isInteger(generation) || generation < 0 || !reason) return null;
  return { mode, generation, reason };
}

function normalizeLastCompletedServerReload(value) {
  if (!isPlainObject(value)) return null;
  const mode = String(value.mode ?? '').trim();
  const generation = value.generation;
  if (!mode || !Number.isInteger(generation) || generation < 0) return null;
  return { mode, generation };
}

function normalizeServerLifecycleDisposition(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) return null;
  const code = String(value.code ?? '').trim();
  if (!code) return null;
  return { code };
}

export function readStackServerLifecycle(runtimeState) {
  const value = runtimeState?.serverLifecycle;
  if (!isPlainObject(value)) return null;
  const phase = String(value.phase ?? '').trim();
  if (!STACK_SERVER_LIFECYCLE_PHASES.has(phase)) return null;
  const planned = value.planned == null ? null : normalizeServerReloadPlan(value.planned);
  const lastCompleted = value.lastCompleted == null
    ? null
    : normalizeLastCompletedServerReload(value.lastCompleted);
  const retry = value.retry == null
    ? null
    : isPlainObject(value.retry) && Number.isInteger(Number(value.retry.afterMs)) && Number(value.retry.afterMs) > 0
      ? { afterMs: Number(value.retry.afterMs) }
      : null;
  const disposition = normalizeServerLifecycleDisposition(value.disposition);
  if (value.planned != null && !planned) return null;
  if (value.lastCompleted != null && !lastCompleted) return null;
  if (value.retry != null && !retry) return null;
  if (value.disposition != null && !disposition) return null;
  if (['planned', 'replacing', 'maintenance', 'retry-scheduled', 'blocked', 'unavailable'].includes(phase) && !planned) {
    return null;
  }
  if (phase === 'retry-scheduled' && !retry) return null;
  if (['blocked', 'unavailable'].includes(phase) && !disposition) return null;
  if (phase === 'completed' && !lastCompleted) return null;
  if (phase === 'idle' && (planned || lastCompleted || retry || disposition)) return null;
  if (['planned', 'replacing', 'maintenance'].includes(phase) && (retry || disposition)) return null;
  if (phase === 'retry-scheduled' && disposition) return null;
  if (['blocked', 'unavailable'].includes(phase) && retry) return null;
  if (phase === 'completed' && (planned || retry || disposition)) return null;
  return { phase, planned, lastCompleted, retry, disposition };
}

export function createStackServerLifecycleProjection({
  phase,
  plan = null,
  retryAfterMs = null,
  disposition = null,
  lastCompleted = null,
} = {}) {
  const normalizedPhase = String(phase ?? '').trim();
  if (!STACK_SERVER_LIFECYCLE_PHASES.has(normalizedPhase)) {
    throw new Error(`[stack] invalid server lifecycle phase: ${normalizedPhase || '(missing)'}`);
  }
  const planned = plan == null ? null : normalizeServerReloadPlan(plan);
  if (plan != null && !planned) throw new Error('[stack] invalid planned server reload');
  const projection = {
    phase: normalizedPhase,
    planned,
    retry: normalizedPhase === 'retry-scheduled'
      ? { afterMs: Math.trunc(Number(retryAfterMs)) }
      : null,
    disposition: ['blocked', 'unavailable'].includes(normalizedPhase)
      ? normalizeServerLifecycleDisposition(disposition)
      : null,
  };
  if (normalizedPhase === 'idle') projection.lastCompleted = null;
  if (normalizedPhase === 'completed') {
    projection.lastCompleted = normalizeLastCompletedServerReload(lastCompleted);
  }
  if (!readStackServerLifecycle({ serverLifecycle: {
    ...projection,
    ...(Object.hasOwn(projection, 'lastCompleted') ? {} : { lastCompleted: null }),
  } })) {
    throw new Error(`[stack] invalid server lifecycle projection for phase ${normalizedPhase}`);
  }
  return projection;
}

function resolveStackRuntimeStateLockPath(statePath) {
  return `${statePath}.lock`;
}

async function withStackRuntimeStateMutationLock(statePath, fn) {
  if (!statePath) {
    throw new Error('[stack] missing runtime state path');
  }
  return await withJsonOwnerFileLock(fn, {
    lockPath: resolveStackRuntimeStateLockPath(statePath),
    timeoutMs: 30_000,
    pollIntervalMs: 5,
    staleAfterMs: 60_000,
    errorLabel: 'stack runtime state mutation lock',
  });
}

async function writeStackRuntimeStateFileUnlocked(statePath, state) {
  const projectedState = isPlainObject(state)
    ? {
        ...state,
        processInstances: createRuntimeProcessInstanceProjection(
          state.ownerPid,
          state.processes,
          state.processInstances,
        ),
      }
    : state;
  await writeJsonAtomic(statePath, projectedState);
}

export async function writeStackRuntimeStateFile(statePath, state) {
  return await withStackRuntimeStateMutationLock(statePath, () => writeStackRuntimeStateFileUnlocked(statePath, state));
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return b;
  }
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A recorded process whose identity could not be established. Its PID may belong to anything by
 * now, so a later read would only adopt whatever has it: the entry stays unverified, is never
 * re-read or judged for ownership, and is never acted on. It leaves state once the PID is gone.
 */
export function isUnverifiedProcessInstance(identity, pid) {
  return identity?.unverified === true && Number(identity?.pid) === Number(pid);
}

function retainUnverifiedProcessInstances(processInstances) {
  const entries = Object.entries(processInstances?.processes ?? {});
  return { processes: Object.fromEntries(entries.filter(([, identity]) => identity?.unverified === true)) };
}

function createRuntimeProcessInstanceProjection(ownerPid, processes, previous = {}) {
  const projectPid = (value, previousIdentity) => {
    const pid = normalizeRuntimePid(value);
    if (!pid) return null;
    if (isUnverifiedProcessInstance(previousIdentity, pid)) {
      return { pid, fingerprint: null, unverified: true };
    }
    if (
      Number(previousIdentity?.pid) === pid
      && String(previousIdentity?.fingerprint ?? '').trim()
    ) {
      return {
        pid,
        fingerprint: String(previousIdentity.fingerprint).trim(),
        ...(previousIdentity.apiInstanceId ? { apiInstanceId: String(previousIdentity.apiInstanceId) } : {}),
      };
    }
    const fingerprint = readProcessInstanceFingerprintSync(pid);
    return fingerprint ? { pid, fingerprint } : null;
  };
  const projectedProcesses = {};
  for (const [key, value] of Object.entries(isPlainObject(processes) ? processes : {})) {
    if (/Pids$/.test(key) && Array.isArray(value)) {
      const previousByPid = new Map(
        (Array.isArray(previous?.processes?.[key]) ? previous.processes[key] : [])
          .map((identity) => [Number(identity?.pid), identity]),
      );
      projectedProcesses[key] = value
        .map((pid) => projectPid(pid, previousByPid.get(Number(pid))))
        .filter(Boolean);
    } else if (/Pid$/.test(key)) {
      projectedProcesses[key] = projectPid(value, previous?.processes?.[key]);
    }
  }
  return {
    owner: projectPid(ownerPid, previous?.owner),
    processes: projectedProcesses,
  };
}

// What the caller already knows about a PID replaces any older identity, whichever process keys
// carry it, so the projection records that instead of probing the process again.
function seedKnownProcessInstances(previous, processes, { verifiedProcessInstances, unverifiedProcessPids }) {
  const verifiedByPid = new Map([
    ...Object.values(verifiedProcessInstances ?? {}).map((identity) => [Number(identity?.pid), identity]),
    ...(unverifiedProcessPids ?? []).map((pid) => [Number(pid), { pid: Number(pid), fingerprint: null, unverified: true }]),
  ]);
  if (verifiedByPid.size === 0) return previous;
  const seeded = { ...previous?.processes };
  for (const [key, value] of Object.entries(isPlainObject(processes) ? processes : {})) {
    const identity = /Pid$/.test(key) ? verifiedByPid.get(Number(value)) : null;
    if (identity) seeded[key] = identity;
  }
  return { ...previous, processes: seeded };
}

export async function updateStackRuntimeStateFile(statePath, patch) {
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
    const { verifiedProcessInstances, unverifiedProcessPids, ...runtimePatch } = patch ?? {};
    const next = deepMerge(existing, runtimePatch);
    next.processInstances = createRuntimeProcessInstanceProjection(
      next.ownerPid,
      next.processes,
      seedKnownProcessInstances(existing.processInstances, next.processes, {
        verifiedProcessInstances,
        unverifiedProcessPids,
      }),
    );
    await writeStackRuntimeStateFileUnlocked(statePath, next);
    return next;
  });
}

function runtimeOwnerClaimLockPath(statePath) {
  return resolveStackRuntimeStateLockPath(statePath);
}

async function observeRuntimePidLiveness(pid, { observePidLivenessImpl, isPidAliveImpl } = {}) {
  const normalizedPid = normalizeRuntimePid(pid);
  if (!normalizedPid) return { status: 'dead', reason: 'invalid_pid' };
  if (typeof observePidLivenessImpl === 'function') {
    const observed = await observePidLivenessImpl(normalizedPid);
    if (['alive', 'dead', 'inconclusive'].includes(observed?.status)) return observed;
    return { status: 'inconclusive', reason: 'invalid_liveness_observation' };
  }
  if (typeof isPidAliveImpl === 'function') {
    return isPidAliveImpl(normalizedPid)
      ? { status: 'alive', reason: 'legacy_probe' }
      : { status: 'dead', reason: 'legacy_probe' };
  }
  return observePidLiveness(normalizedPid);
}

function runtimeOwnerAdmissionError(existing, stackName, code, message) {
  const error = new Error(
    `[stack] ${String(stackName ?? existing?.stackName ?? 'stack')} ${message}`,
  );
  error.code = code;
  return error;
}

async function assertNoDifferentLiveRuntimeOwner(existing, { stackName, ownerPid } = {}, options = {}) {
  const existingOwnerPid = Number(existing?.ownerPid);
  const ownerPidNum = Number(ownerPid);
  const sameOwner = Number.isFinite(existingOwnerPid) && existingOwnerPid > 1
    && Number.isFinite(ownerPidNum) && ownerPidNum > 1
    && ownerPidNum === existingOwnerPid;
  if (isPlainObject(existing.stopRequest)) {
    throw runtimeOwnerAdmissionError(existing, stackName, 'ESTACKRUNTIMECLEANUPINCOMPLETE',
      'stop cleanup is incomplete');
  }
  if (sameOwner) return;
  if (!Number.isFinite(existingOwnerPid) || existingOwnerPid <= 1) return;
  const liveness = await observeRuntimePidLiveness(existingOwnerPid, {
    observePidLivenessImpl: options.observePidLivenessImpl,
  });
  if (liveness.status === 'inconclusive') {
    throw runtimeOwnerAdmissionError(existing, stackName, 'ESTACKRUNTIMEOWNERINCONCLUSIVE',
      `lifecycle owner liveness is inconclusive (pid=${existingOwnerPid}, reason=${liveness.reason})`);
  }
  if (liveness.status === 'alive') {
    throw runtimeOwnerAdmissionError(existing, stackName, 'ESTACKRUNTIMEOWNERALIVE',
      `already has a live lifecycle owner (pid=${existingOwnerPid})`);
  }
}

async function reconcileRuntimeProcessMembership(processes, processInstances, stackName, options = {}) {
  if (!isPlainObject(processes)) return {};
  const next = { ...processes };
  const trustContext = resolveStackEnvPath(stackName);
  const observeOwnership = async (pid, key) => {
    if (typeof options.isRuntimeProcessTrustedImpl === 'function') {
      return Boolean(await options.isRuntimeProcessTrustedImpl(pid, {
        key,
        stackName,
        envPath: trustContext.envPath,
        cliHomeDir: join(trustContext.baseDir, 'cli'),
      }));
    }
    return await isPidOwnedByStack(pid, {
      stackName,
      envPath: trustContext.envPath,
      cliHomeDir: join(trustContext.baseDir, 'cli'),
    });
  };
  for (const [key, value] of Object.entries(next)) {
    const values = /Pids$/.test(key) && Array.isArray(value)
      ? value
      : /Pid$/.test(key)
        ? [value]
        : null;
    if (!values) continue;
    const retained = [];
    for (const valuePid of values) {
      const pid = normalizeRuntimePid(valuePid);
      if (!pid || retained.includes(pid)) continue;
      // eslint-disable-next-line no-await-in-loop
      const liveness = await observeRuntimePidLiveness(pid, options);
      if (liveness.status === 'inconclusive') {
        throw runtimeOwnerAdmissionError({}, stackName, 'ESTACKRUNTIMEPROCESSINCONCLUSIVE',
          `recorded ${key} liveness is inconclusive (pid=${pid}, reason=${liveness.reason})`);
      }
      if (liveness.status === 'dead') continue;
      if (isUnverifiedProcessInstance(processInstances?.processes?.[key], pid)) {
        retained.push(pid);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await observeOwnership(pid, key)) retained.push(pid);
      } catch (error) {
        if (error?.code !== 'EPROCESSIDENTITYINCONCLUSIVE') throw error;
        throw runtimeOwnerAdmissionError({}, stackName, 'ESTACKRUNTIMEPROCESSINCONCLUSIVE',
          `recorded ${key} ownership is inconclusive (pid=${pid})`);
      }
    }
    next[key] = /Pids$/.test(key) ? retained : (retained[0] ?? null);
  }
  return next;
}

async function recordStackRuntimeStartUnlocked(statePath, { stackName, script, ephemeral, ownerPid, ports, ...rest } = {}, options = {}) {
  const wallClockMs = Date.now();
  const now = new Date(wallClockMs).toISOString();
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  await assertNoDifferentLiveRuntimeOwner(existing, { stackName, ownerPid }, options);
  const sameOwner = normalizeRuntimePid(existing.ownerPid) === normalizeRuntimePid(ownerPid);
  const restPatch = rest ?? {};
  const { processes: restProcesses, ...restWithoutProcesses } = restPatch;
  const reconciledExistingProcesses = sameOwner
    ? (isPlainObject(existing.processes) ? existing.processes : {})
    : await reconcileRuntimeProcessMembership(existing.processes, existing.processInstances, stackName, options);
  const processes = deepMerge(
    reconciledExistingProcesses,
    isPlainObject(restProcesses) ? restProcesses : {},
  );
  // A canonical start publication is a new lifecycle incarnation even when the OS reused the PID.
  const existingStartedAt = normalizeStackRuntimeOwnerStartedAt(existing.startedAt);
  const existingStartedAtMs = existingStartedAt ? Date.parse(existingStartedAt) : Number.NaN;
  const nextStartedAtMs = Number.isFinite(existingStartedAtMs)
    ? Math.max(wallClockMs, existingStartedAtMs + 1)
    : wallClockMs;
  const nextStartedAt = new Date(nextStartedAtMs);
  const startedAt = Number.isFinite(nextStartedAt.getTime()) ? nextStartedAt.toISOString() : now;
  const next = deepMerge(existing, {
    version: 1,
    stackName,
    script,
    ephemeral: Boolean(ephemeral),
    ownerPid,
    ports: ports ?? {},
    ...restWithoutProcesses,
    runtimeSnapshotId: String(restWithoutProcesses?.runtimeSnapshotId ?? '').trim() || null,
    serveUi: typeof restWithoutProcesses?.serveUi === 'boolean' ? restWithoutProcesses.serveUi : null,
    processes,
    startedAt,
    updatedAt: now,
    stopRequest: null,
    serverLifecycle: createStackServerLifecycleProjection({ phase: 'idle' }),
  });
  next.processInstances = createRuntimeProcessInstanceProjection(
    next.ownerPid,
    next.processes,
    retainUnverifiedProcessInstances(existing.processInstances),
  );
  await writeStackRuntimeStateFileUnlocked(statePath, next);
  return next;
}

export async function recordStackRuntimeStart(statePath, input = {}, options = {}) {
  return await withJsonOwnerFileLock(
    () => recordStackRuntimeStartUnlocked(statePath, input, options),
    {
      lockPath: runtimeOwnerClaimLockPath(statePath),
      timeoutMs: 30_000,
      pollIntervalMs: 50,
      staleAfterMs: 60_000,
      errorLabel: 'stack lifecycle owner claim',
    },
  );
}

export async function withStackRuntimeStartClaim(statePath, { stackName = '' } = {}, fn, options = {}) {
  if (typeof fn !== 'function') throw new Error('withStackRuntimeStartClaim requires a callback');
  return await withJsonOwnerFileLock(async () => {
    const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
    await assertNoDifferentLiveRuntimeOwner(existing, { stackName, ownerPid: null }, options);
    let committed = false;
    return await fn({
      existing,
      recordStart: async (input) => {
        if (committed) throw new Error('[stack] lifecycle owner claim was already committed');
        const next = await recordStackRuntimeStartUnlocked(statePath, input, options);
        committed = true;
        return next;
      },
    });
  }, {
    lockPath: runtimeOwnerClaimLockPath(statePath),
    timeoutMs: 30_000,
    pollIntervalMs: 50,
    staleAfterMs: 60_000,
    errorLabel: 'stack lifecycle owner claim',
  });
}

export async function deleteStackRuntimeStateIfOwnedBy(statePath, expected) {
  if (!normalizeRuntimePid(expected?.ownerPid)) return false;
  if (!normalizeStackRuntimeOwnerStartedAt(expected?.startedAt)) return false;
  const result = await finalizeStackRuntimeStop(statePath, { expected, requireNoStopRequest: true });
  return result.finalized === true;
}

export async function recordStackRuntimeUpdate(statePath, patch = {}) {
  return await updateStackRuntimeStateFile(statePath, {
    ...(patch ?? {}),
    updatedAt: new Date().toISOString(),
  });
}

export async function mutateStackRuntimeDaemonMembership(statePath, mutate) {
  if (typeof mutate !== 'function') throw new Error('[stack] missing daemon membership mutation');
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    const existing = await readStackRuntimeStateFile(statePath);
    if (!existing) return { updated: false, reason: 'missing_state', runtimeState: null };
    const mutation = await mutate(existing);
    if (!mutation?.patch) return { ...(mutation?.result ?? {}), runtimeState: existing };
    const next = deepMerge(existing, mutation?.patch ?? {});
    await writeStackRuntimeStateFileUnlocked(statePath, next);
    return { ...(mutation?.result ?? {}), runtimeState: next };
  });
}

export async function recordStackRuntimeServerLifecycle(statePath, transition = {}, {
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
} = {}) {
  const serverLifecycle = createStackServerLifecycleProjection(transition);
  const patch = { serverLifecycle };
  if (serverLifecycle.phase === 'unavailable') {
    patch.processes = {
      serverPid: null,
      serverWrapperPid: null,
      serverBackendPid: null,
      serverDrainingPid: null,
    };
    patch.ports = { serverBackend: null };
  }
  return await recordStackRuntimeUpdateImpl(statePath, patch);
}

export async function recordStackRuntimeExpoPublication(statePath, {
  generation,
  publicationToken,
  expectedPreviousToken = null,
  processes,
  expo,
} = {}) {
  const expectedGeneration = Number(generation);
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new Error('[stack] invalid Expo publication generation');
  }
  if (!String(publicationToken ?? '').trim()) throw new Error('[stack] missing Expo publication token');
  return await withJsonOwnerFileLock(async () => {
    const current = (await readStackRuntimeStateFile(statePath)) ?? {};
    const currentToken = current?.expo?.publicationToken ?? null;
    if (currentToken !== expectedPreviousToken) {
      const error = new Error('[stack] Expo runtime publication generation was superseded');
      error.code = 'EEXPORUNTIMEGENERATION';
      throw error;
    }
    const next = deepMerge(current, {
      processes: processes ?? {},
      expo: { ...(expo ?? {}), publicationGeneration: expectedGeneration, publicationToken },
    });
    await writeStackRuntimeStateFileUnlocked(statePath, next);
    return next;
  }, {
    lockPath: runtimeOwnerClaimLockPath(statePath),
    timeoutMs: 30_000,
    pollIntervalMs: 50,
    staleAfterMs: 60_000,
    errorLabel: 'Expo runtime publication',
  });
}

export async function restoreStackRuntimeExpoPublication(statePath, { publicationToken, priorExpo, priorProcesses } = {}) {
  return await withJsonOwnerFileLock(async () => {
    const current = (await readStackRuntimeStateFile(statePath)) ?? {};
    if (current?.expo?.publicationToken !== publicationToken) return false;
    const next = { ...current, processes: { ...(current.processes ?? {}) } };
    for (const key of ['expoPid', 'expoTailscaleForwarderPid']) {
      if (priorProcesses && Object.hasOwn(priorProcesses, key)) next.processes[key] = priorProcesses[key];
      else delete next.processes[key];
    }
    if (priorExpo == null) delete next.expo;
    else next.expo = priorExpo;
    await writeStackRuntimeStateFileUnlocked(statePath, next);
    return true;
  }, {
    lockPath: runtimeOwnerClaimLockPath(statePath),
    timeoutMs: 30_000,
    pollIntervalMs: 50,
    staleAfterMs: 60_000,
    errorLabel: 'Expo runtime publication rollback',
  });
}

function normalizeRuntimePid(pid) {
  const n = Number(pid);
  return Number.isFinite(n) && n > 1 ? n : null;
}

export function createStackServerRuntimeProcessPatch({
  listenerPid,
  wrapperPid,
  serverPort,
  clearProxyState = false,
  restartMode,
  reloadGeneration,
  preserveReloadCompletion = false,
} = {}) {
  const serverPid = normalizeRuntimePid(listenerPid);
  const serverWrapperPid = normalizeRuntimePid(wrapperPid);
  const processes = {};
  if (serverPid) {
    processes.serverPid = serverPid;
  }
  if (wrapperPid !== undefined) {
    processes.serverWrapperPid = serverWrapperPid;
  }
  const patch = { processes };
  if (clearProxyState) {
    processes.proxyPid = null;
    processes.serverBackendPid = null;
    processes.serverDrainingPid = null;
    patch.ports = {
      server: normalizeRuntimePort(serverPort),
      serverBackend: null,
    };
    patch.serverProxy = {
      enabled: false,
      mode: 'direct',
      fallbackReason: null,
    };
    if (!preserveReloadCompletion) {
      patch.serverProxy.restartMode = restartMode ? String(restartMode) : null;
      patch.serverProxy.reloadGeneration = Number.isInteger(reloadGeneration) && reloadGeneration >= 0
        ? reloadGeneration
        : null;
    }
  }
  return patch;
}

export function createStackDevProxyRuntimePatch({
  stablePort,
  backendPort,
  proxyPid,
  backendPid,
  drainingPid,
  mode = 'proxy',
  restartMode,
  reloadGeneration,
  fallbackReason,
  enabled = true,
  preserveReloadCompletion = false,
} = {}) {
  const normalizedStablePort = normalizeRuntimePort(stablePort);
  const normalizedBackendPort = normalizeRuntimePort(backendPort);
  const serverProxy = {
    enabled: Boolean(enabled),
    mode,
    fallbackReason: fallbackReason ? String(fallbackReason) : null,
  };
  if (!preserveReloadCompletion) {
    serverProxy.restartMode = restartMode ? String(restartMode) : null;
    serverProxy.reloadGeneration = Number.isInteger(reloadGeneration) && reloadGeneration >= 0
      ? reloadGeneration
      : null;
  }

  return {
    processes: {
      proxyPid: normalizeRuntimePid(proxyPid),
      serverBackendPid: normalizeRuntimePid(backendPid),
      serverDrainingPid: normalizeRuntimePid(drainingPid),
    },
    ports: {
      server: normalizedStablePort,
      serverBackend: normalizedBackendPort,
    },
    serverProxy,
  };
}

export async function recordStackRuntimeServerActivation(
  statePath,
  {
    listenerPid,
    wrapperPid,
    stablePort,
    backendPort = null,
    proxyPid = null,
    drainingPid = null,
    mode = 'direct',
    restartMode = null,
    reloadGeneration = null,
    fallbackReason = null,
    clearProxyState = mode === 'direct',
    managedBackendPid = null,
    managedGatewayPid = null,
    preserveReloadCompletion = false,
    verifiedProcessInstances = null,
  } = {},
  {
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const normalizedMode = String(mode ?? 'direct');
  const isManagedBackend = normalizedMode === 'managed-backend';
  const isManagedGateway = normalizedMode === 'managed-gateway';
  const normalizedManagedBackendPid = normalizeRuntimePid(managedBackendPid);
  const normalizedManagedGatewayPid = normalizeRuntimePid(managedGatewayPid);
  const managedAuthoritativePid = isManagedGateway
    ? normalizedManagedGatewayPid
    : normalizedManagedBackendPid;
  const processPatch = createStackServerRuntimeProcessPatch({
    listenerPid,
    wrapperPid,
    serverPort: stablePort,
    clearProxyState: Boolean(clearProxyState),
    restartMode,
    reloadGeneration,
    preserveReloadCompletion,
  });
  const patch = isManagedBackend || isManagedGateway
    ? {
        processes: {
          serverPid: managedAuthoritativePid,
          serverWrapperPid: managedAuthoritativePid,
          proxyPid: null,
          serverBackendPid: null,
          serverDrainingPid: null,
          happierServerBackendPid: normalizedManagedBackendPid,
          uiGatewayPid: normalizedManagedGatewayPid,
        },
        ports: {
          server: normalizeRuntimePort(stablePort),
          serverBackend: null,
          backend: normalizeRuntimePort(backendPort),
        },
        serverProxy: {
          enabled: false,
          mode: normalizedMode,
          fallbackReason: null,
        },
      }
    : normalizedMode === 'proxy' || normalizedMode === 'directFallback'
      ? deepMerge(processPatch, createStackDevProxyRuntimePatch({
          stablePort,
          backendPort: normalizedMode === 'proxy' ? backendPort : null,
          proxyPid: normalizedMode === 'proxy' ? proxyPid : null,
          backendPid: normalizedMode === 'proxy' ? listenerPid : null,
          drainingPid,
          mode: normalizedMode,
          restartMode,
          reloadGeneration,
          fallbackReason,
          preserveReloadCompletion,
        }))
      : processPatch;

  if (!preserveReloadCompletion && restartMode && Number.isInteger(reloadGeneration) && reloadGeneration >= 0) {
    patch.serverLifecycle = createStackServerLifecycleProjection({
      phase: 'completed',
      lastCompleted: { mode: restartMode, generation: reloadGeneration },
    });
  }
  if ((isManagedBackend || isManagedGateway) && !preserveReloadCompletion) {
    patch.serverProxy.restartMode = restartMode ? String(restartMode) : null;
    patch.serverProxy.reloadGeneration = Number.isInteger(reloadGeneration) && reloadGeneration >= 0
      ? reloadGeneration
      : null;
  }

  if (verifiedProcessInstances) patch.verifiedProcessInstances = verifiedProcessInstances;

  try {
    return await recordStackRuntimeUpdateImpl(statePath, patch);
  } catch (cause) {
    if (cause?.code === 'ESERVERRUNTIMEPROJECTION' && cause?.serverActivationCommitted === true) {
      throw cause;
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(
      `[stack] server activation committed, but runtime projection failed: ${detail}`,
      { cause },
    );
    error.code = 'ESERVERRUNTIMEPROJECTION';
    error.serverActivationCommitted = true;
    error.authoritativeServerPid = normalizeRuntimePid(listenerPid);
    error.authoritativeServerWrapperPid = normalizeRuntimePid(wrapperPid);
    error.authoritativeProcessPid = isManagedBackend || isManagedGateway
      ? managedAuthoritativePid
      : normalizeRuntimePid(listenerPid);
    error.authoritativeProcessRole = isManagedBackend || isManagedGateway
      ? normalizedMode
      : 'server-listener';
    error.serverMode = normalizedMode;
    throw error;
  }
}

function normalizeRuntimePort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export async function recordStackRuntimeServerPids(
  statePath,
  { listenerPid, wrapperPid, serverPort, clearProxyState = false, verifiedProcessInstances = null } = {},
  dependencies = {},
) {
  return await recordStackRuntimeServerActivation(
    statePath,
    {
      listenerPid,
      wrapperPid,
      stablePort: serverPort,
      mode: 'direct',
      clearProxyState,
      verifiedProcessInstances,
    },
    dependencies,
  );
}

async function recordStackRuntimeStopRequestUnlocked(
  statePath,
  {
    signal = 'SIGTERM',
    requestedBy = 'unknown',
    reason = '',
    preserveDaemon = false,
    expectedOwnerPid = null,
    expectedOwnerStartedAt = null,
  } = {},
) {
  const existing = await readStackRuntimeStateFile(statePath);
  const requiredOwnerPid = expectedOwnerPid == null ? null : normalizeRuntimePid(expectedOwnerPid);
  const requiredOwnerStartedAt = expectedOwnerPid == null
    ? null
    : normalizeStackRuntimeOwnerStartedAt(expectedOwnerStartedAt);
  if (expectedOwnerPid != null && !requiredOwnerPid) {
    return { runtimeState: existing, expected: null, authorized: false, reason: 'invalid_expected_owner' };
  }
  if (requiredOwnerPid && !requiredOwnerStartedAt) {
    return {
      runtimeState: existing,
      expected: null,
      authorized: false,
      reason: 'invalid_expected_owner_incarnation',
      expectedOwnerPid: requiredOwnerPid,
    };
  }
  if (!existing) {
    return {
      runtimeState: null,
      expected: null,
      ...(requiredOwnerPid ? { authorized: false, reason: 'runtime_state_missing' } : {}),
    };
  }
  const currentOwnerPid = normalizeRuntimePid(existing.ownerPid);
  if (requiredOwnerPid && currentOwnerPid !== requiredOwnerPid) {
    return {
      runtimeState: existing,
      expected: null,
      authorized: false,
      reason: 'successor_owner',
      expectedOwnerPid: requiredOwnerPid,
      currentOwnerPid,
    };
  }
  const currentOwnerStartedAt = normalizeStackRuntimeOwnerStartedAt(existing.startedAt);
  if (requiredOwnerPid && !currentOwnerStartedAt) {
    const missingCurrentOwnerStartedAt = existing.startedAt == null || existing.startedAt === '';
    return {
      runtimeState: existing,
      expected: null,
      authorized: false,
      reason: missingCurrentOwnerStartedAt
        ? 'runtime_owner_incarnation_missing'
        : 'runtime_owner_incarnation_invalid',
      expectedOwnerPid: requiredOwnerPid,
      expectedOwnerStartedAt: requiredOwnerStartedAt,
      currentOwnerPid,
      currentOwnerStartedAt: null,
    };
  }
  if (requiredOwnerPid && currentOwnerStartedAt !== requiredOwnerStartedAt) {
    return {
      runtimeState: existing,
      expected: null,
      authorized: false,
      reason: 'successor_owner_incarnation',
      expectedOwnerPid: requiredOwnerPid,
      expectedOwnerStartedAt: requiredOwnerStartedAt,
      currentOwnerPid,
      currentOwnerStartedAt,
    };
  }
  const freshStopRequest = isPlainObject(existing.stopRequest)
    ? existing.stopRequest
    : null;
  const effectiveStopRequest = freshStopRequest ?? {
    signal: String(signal ?? 'SIGTERM'),
    requestedBy: String(requestedBy ?? 'unknown'),
    reason: String(reason ?? ''),
    preserveDaemon: preserveDaemon === true,
    requestedAt: new Date().toISOString(),
  };
  const next = freshStopRequest
    ? existing
    : deepMerge(existing, {
      stopRequest: effectiveStopRequest,
      updatedAt: new Date().toISOString(),
    });
  if (!freshStopRequest) await writeStackRuntimeStateFileUnlocked(statePath, next);
  const expected = createStackRuntimeStopSnapshot(next);
  return {
    runtimeState: next,
    expected,
    authorized: true,
    reason: 'authorized',
    preserveDaemon: effectiveStopRequest.preserveDaemon === true,
  };
}

export async function recordStackRuntimeStopRequest(statePath, input = {}) {
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    return await recordStackRuntimeStopRequestUnlocked(statePath, input);
  });
}

export async function withStackRuntimeStopTransaction(statePath, input = {}, fn) {
  if (typeof fn !== 'function') throw new Error('withStackRuntimeStopTransaction requires a callback');
  const stop = await withStackRuntimeStateMutationLock(statePath, async () => {
    return await recordStackRuntimeStopRequestUnlocked(statePath, input);
  });
  const resolvedPreserveDaemon = stop.preserveDaemon ?? input.preserveDaemon === true;
  return await fn({
    ...stop,
    preserveDaemon: resolvedPreserveDaemon,
    finalize: async ({ cleanupResults = null } = {}) => await finalizeStackRuntimeStop(statePath, {
      expected: stop.expected,
      preserveDaemon: resolvedPreserveDaemon,
      cleanupResults,
    }),
  });
}

function createStackRuntimeStopSnapshot(runtimeState) {
  if (!runtimeState) return null;
  const processes = isPlainObject(runtimeState.processes) ? runtimeState.processes : {};
  const processMembership = {};
  for (const key of Object.keys(processes).sort()) {
    if (!/(?:Pid|Pids)$/.test(key)) continue;
    const value = processes[key];
    processMembership[key] = Array.isArray(value) ? [...value] : value;
  }
  return {
    ownerPid: normalizeRuntimePid(runtimeState.ownerPid),
    startedAt: normalizeStackRuntimeOwnerStartedAt(runtimeState.startedAt),
    stopRequestedAt: normalizeStackRuntimeOwnerStartedAt(runtimeState?.stopRequest?.requestedAt),
    processMembership,
    daemonDistFingerprint: String(runtimeState?.daemon?.distClosureFingerprint ?? '').trim() || null,
    generationMembership: {
      phase: String(runtimeState?.serverLifecycle?.phase ?? ''),
      planned: runtimeState?.serverLifecycle?.planned?.generation ?? null,
      lastCompleted: runtimeState?.serverLifecycle?.lastCompleted?.generation ?? null,
      proxy: runtimeState?.serverProxy?.reloadGeneration ?? null,
    },
  };
}

function stackRuntimeStopSnapshotMatches(current, expected) {
  const observed = createStackRuntimeStopSnapshot(current);
  if (!observed) return false;
  const expectedOwnerPid = normalizeRuntimePid(expected?.ownerPid);
  const expectedStartedAt = normalizeStackRuntimeOwnerStartedAt(expected?.startedAt);
  if (observed.ownerPid !== expectedOwnerPid) return false;
  if (observed.startedAt || expectedStartedAt) {
    if (!observed.startedAt || !expectedStartedAt || observed.startedAt !== expectedStartedAt) return false;
  } else {
    const expectedStopRequestedAt = normalizeStackRuntimeOwnerStartedAt(expected?.stopRequestedAt);
    if (
      observed.ownerPid
      || expectedOwnerPid
      || !observed.stopRequestedAt
      || !expectedStopRequestedAt
      || observed.stopRequestedAt !== expectedStopRequestedAt
    ) return false;
  }
  const hasExpectedProcessMembership = Object.prototype.hasOwnProperty.call(expected, 'processMembership');
  const hasExpectedGenerationMembership = Object.prototype.hasOwnProperty.call(expected, 'generationMembership');
  if (!hasExpectedProcessMembership && !hasExpectedGenerationMembership) return true;
  if (!isPlainObject(expected.processMembership) || !isPlainObject(expected.generationMembership)) return false;
  if (JSON.stringify(observed.generationMembership) !== JSON.stringify(expected.generationMembership)) return false;
  if (observed.daemonDistFingerprint && observed.daemonDistFingerprint !== expected.daemonDistFingerprint) return false;
  for (const [key, value] of Object.entries(observed.processMembership)) {
    const observedPids = (Array.isArray(value) ? value : [value]).map(normalizeRuntimePid).filter(Boolean);
    const expectedValue = expected.processMembership?.[key];
    const expectedPids = new Set((Array.isArray(expectedValue) ? expectedValue : [expectedValue]).map(normalizeRuntimePid).filter(Boolean));
    if (observedPids.some((pid) => !expectedPids.has(pid))) return false;
  }
  return true;
}

export async function captureStackRuntimeStopSnapshot(statePath) {
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    return createStackRuntimeStopSnapshot(await readStackRuntimeStateFile(statePath));
  });
}

async function finalizeStackRuntimeStopUnlocked(
  statePath,
  { expected, preserveDaemon = false, cleanupResults = null, requireNoStopRequest = false } = {},
) {
  if (Array.isArray(cleanupResults) && cleanupResults.some((result) => result?.ok !== true)) {
    return { finalized: false, reason: 'cleanup_incomplete', cleanupResults };
  }
  const current = await readStackRuntimeStateFile(statePath);
  if (!current) return { finalized: true, reason: 'missing_state' };
  if (requireNoStopRequest && current.stopRequest && typeof current.stopRequest === 'object') {
    return { finalized: false, reason: 'external_stop_in_progress', runtimeState: current };
  }
  if (!expected || !stackRuntimeStopSnapshotMatches(current, expected)) {
    return { finalized: false, reason: 'successor_state', runtimeState: current };
  }
  if (preserveDaemon) {
    const daemonPid = normalizeRuntimePid(current?.processes?.daemonPid);
    const daemonPids = Array.from(new Set((Array.isArray(current?.processes?.daemonPids) ? current.processes.daemonPids : [])
      .map(normalizeRuntimePid).filter(Boolean)));
    if (daemonPid && !daemonPids.includes(daemonPid)) daemonPids.push(daemonPid);
    if (daemonPids.length > 0) {
      const next = {
        ...current,
        ownerPid: null,
        processes: { daemonPid: daemonPid ?? daemonPids.at(-1), daemonPids },
        stopRequest: null,
        updatedAt: new Date().toISOString(),
      };
      await writeStackRuntimeStateFileUnlocked(statePath, next);
      return { finalized: true, reason: 'daemon_preserved', runtimeState: next };
    }
  }
  try { if (existsSync(statePath)) await unlink(statePath); } catch { /* ignore */ }
  return { finalized: true, reason: 'deleted', runtimeState: null };
}

export async function finalizeStackRuntimeStop(statePath, input = {}) {
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    return await finalizeStackRuntimeStopUnlocked(statePath, input);
  });
}
