import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { isPidAlive, observePidLiveness } from '../proc/pids.mjs';
import { isPidOwnedByStack } from '../proc/ownership.mjs';
import { resolveStackOwnedListenPid } from '../server/listener_ownership.mjs';
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
  if (!isPlainObject(value)) return null;
  const code = String(value.code ?? '').trim();
  return code ? { code } : null;
}

export function readStackServerLifecycle(runtimeState) {
  const value = runtimeState?.serverLifecycle;
  if (!isPlainObject(value)) return null;
  const phase = String(value.phase ?? '').trim();
  if (!STACK_SERVER_LIFECYCLE_PHASES.has(phase)) return null;
  const planned = value.planned == null ? null : normalizeServerReloadPlan(value.planned);
  const lastCompleted = value.lastCompleted == null ? null : normalizeLastCompletedServerReload(value.lastCompleted);
  const retry = value.retry == null
    ? null
    : isPlainObject(value.retry) && Number.isInteger(Number(value.retry.afterMs)) && Number(value.retry.afterMs) > 0
      ? { afterMs: Number(value.retry.afterMs) }
      : null;
  const disposition = value.disposition == null ? null : normalizeServerLifecycleDisposition(value.disposition);
  if (value.planned != null && !planned) return null;
  if (value.lastCompleted != null && !lastCompleted) return null;
  if (value.retry != null && !retry) return null;
  if (value.disposition != null && !disposition) return null;
  if (['planned', 'replacing', 'maintenance', 'retry-scheduled', 'blocked', 'unavailable'].includes(phase) && !planned) return null;
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
  const projection = {
    phase: normalizedPhase,
    planned: plan == null ? null : normalizeServerReloadPlan(plan),
    retry: normalizedPhase === 'retry-scheduled' ? { afterMs: Math.trunc(Number(retryAfterMs)) } : null,
    disposition: ['blocked', 'unavailable'].includes(normalizedPhase)
      ? normalizeServerLifecycleDisposition(disposition)
      : null,
  };
  if (normalizedPhase === 'idle') projection.lastCompleted = null;
  if (normalizedPhase === 'completed') projection.lastCompleted = normalizeLastCompletedServerReload(lastCompleted);
  if (!readStackServerLifecycle({
    serverLifecycle: {
      ...projection,
      ...(Object.hasOwn(projection, 'lastCompleted') ? {} : { lastCompleted: null }),
    },
  })) {
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
  const reconciled = reconcileStackRuntimeProcessInstances(state);
  await writeJsonAtomic(statePath, reconciled);
  return reconciled;
}

export async function writeStackRuntimeStateFile(statePath, state) {
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    await writeStackRuntimeStateFileUnlocked(statePath, state);
  });
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

function normalizeRuntimePid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 1 ? n : null;
}

function normalizeProcessInstanceRecord(value, pid) {
  const normalizedPid = normalizeRuntimePid(pid);
  const recordPid = normalizeRuntimePid(value?.pid);
  const fingerprint = String(value?.fingerprint ?? '').trim();
  return normalizedPid && recordPid === normalizedPid && fingerprint
    ? { pid: normalizedPid, fingerprint }
    : null;
}

function observeRuntimeProcessInstance(pid, previous = null) {
  const normalizedPid = normalizeRuntimePid(pid);
  if (!normalizedPid) return null;
  const recorded = normalizeProcessInstanceRecord(previous, normalizedPid);
  if (recorded) return recorded;
  const fingerprint = readProcessInstanceFingerprintSync(normalizedPid);
  if (fingerprint) return { pid: normalizedPid, fingerprint };
  return null;
}

function reconcileStackRuntimeProcessInstances(runtimeState) {
  const next = { ...(runtimeState ?? {}) };
  const previous = isPlainObject(runtimeState?.processInstances)
    ? runtimeState.processInstances
    : {};
  const owner = observeRuntimeProcessInstance(runtimeState?.ownerPid, previous.owner);
  const processInstances = {};
  const processes = isPlainObject(runtimeState?.processes) ? runtimeState.processes : {};
  const previousProcesses = isPlainObject(previous.processes) ? previous.processes : {};

  for (const [key, value] of Object.entries(processes)) {
    if (/Pid$/.test(key)) {
      const record = observeRuntimeProcessInstance(value, previousProcesses[key]);
      if (record) processInstances[key] = record;
      continue;
    }
    if (/Pids$/.test(key) && Array.isArray(value)) {
      const previousRecords = Array.isArray(previousProcesses[key]) ? previousProcesses[key] : [];
      const records = value
        .map((pid) => observeRuntimeProcessInstance(
          pid,
          previousRecords.find((record) => normalizeRuntimePid(record?.pid) === normalizeRuntimePid(pid)),
        ))
        .filter(Boolean);
      if (records.length > 0) processInstances[key] = records;
    }
  }

  if (owner || Object.keys(processInstances).length > 0) {
    next.processInstances = {
      owner,
      processes: processInstances,
    };
  } else {
    delete next.processInstances;
  }
  return next;
}

export function getStackRuntimeProcessInstanceFingerprint(runtimeState, key, pid) {
  const normalizedPid = normalizeRuntimePid(pid);
  if (!normalizedPid) return null;
  if (key === 'ownerPid') {
    return normalizeProcessInstanceRecord(runtimeState?.processInstances?.owner, normalizedPid)?.fingerprint ?? null;
  }
  const value = runtimeState?.processInstances?.processes?.[key];
  if (Array.isArray(value)) {
    return value
      .map((record) => normalizeProcessInstanceRecord(record, normalizedPid))
      .find(Boolean)?.fingerprint ?? null;
  }
  return normalizeProcessInstanceRecord(value, normalizedPid)?.fingerprint ?? null;
}

function normalizeRuntimePort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export function createStackServerRuntimeProcessPatch({
  listenerPid,
  wrapperPid,
  serverPort,
  clearProxyState = false,
  restartMode,
  reloadGeneration,
} = {}) {
  const patch = {
    processes: {
      serverPid: normalizeRuntimePid(listenerPid),
      serverWrapperPid: normalizeRuntimePid(wrapperPid),
    },
  };
  if (clearProxyState) {
    patch.processes.proxyPid = null;
    patch.processes.serverBackendPid = null;
    patch.processes.serverDrainingPid = null;
    patch.ports = {
      ...(Number.isFinite(Number(serverPort)) && Number(serverPort) > 0 ? { server: Number(serverPort) } : {}),
      serverBackend: null,
    };
    patch.serverProxy = {
      enabled: false,
      mode: 'direct',
      restartMode: restartMode ? String(restartMode) : null,
      reloadGeneration: Number.isInteger(reloadGeneration) && reloadGeneration >= 0 ? reloadGeneration : null,
      fallbackReason: null,
    };
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
  restartMode = null,
  reloadGeneration = null,
  fallbackReason = null,
} = {}) {
  const normalizedStablePort = Number(stablePort);
  const normalizedBackendPort = Number(backendPort);
  return {
    processes: {
      proxyPid: normalizeRuntimePid(proxyPid),
      serverBackendPid: normalizeRuntimePid(backendPid),
      serverDrainingPid: normalizeRuntimePid(drainingPid),
    },
    ports: {
      ...(Number.isFinite(normalizedStablePort) && normalizedStablePort > 0 ? { server: normalizedStablePort } : {}),
      serverBackend: Number.isFinite(normalizedBackendPort) && normalizedBackendPort > 0 ? normalizedBackendPort : null,
    },
    serverProxy: {
      enabled: mode !== 'direct',
      mode,
      restartMode: restartMode ?? null,
      reloadGeneration: Number.isInteger(reloadGeneration) && reloadGeneration >= 0 ? reloadGeneration : null,
      fallbackReason: fallbackReason ?? null,
    },
  };
}

export function getStackRuntimeProcessEntries(runtimeState) {
  const processes = runtimeState?.processes;
  if (!isPlainObject(processes)) return [];

  const entries = [];
  for (const [rawKey, value] of Object.entries(processes)) {
    const key = String(rawKey);
    if (/Pid$/.test(key)) {
      const pid = Number(value);
      if (Number.isFinite(pid) && pid > 1) {
        const processInstanceFingerprint = getStackRuntimeProcessInstanceFingerprint(runtimeState, key, pid);
        entries.push({
          key,
          pid,
          ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}),
        });
      }
      continue;
    }

    if (/Pids$/.test(key) && Array.isArray(value)) {
      const seen = new Set();
      for (const entry of value) {
        const pid = Number(entry);
        if (!Number.isFinite(pid) || pid <= 1 || seen.has(pid)) continue;
        seen.add(pid);
        const processInstanceFingerprint = getStackRuntimeProcessInstanceFingerprint(runtimeState, key, pid);
        entries.push({
          key,
          pid,
          ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}),
        });
      }
    }
  }
  return entries;
}

export function hasLiveStackRuntimeProcesses(runtimeState, { isPidAliveImpl = isPidAlive } = {}) {
  return getStackRuntimeProcessEntries(runtimeState).some(({ pid }) => isPidAliveImpl(pid));
}

export function resolveStackRuntimeProcessTrustContext({ stackName = '', envPath = '', cliHomeDir = '' } = {}) {
  const resolvedStackName = String(stackName ?? '').trim();
  const explicitEnvPath = String(envPath ?? '').trim();
  const explicitCliHomeDir = String(cliHomeDir ?? '').trim();
  if (!resolvedStackName) {
    return {
      stackName: '',
      envPath: explicitEnvPath,
      cliHomeDir: explicitCliHomeDir,
    };
  }

  const paths = resolveStackEnvPath(resolvedStackName);
  return {
    stackName: resolvedStackName,
    envPath: explicitEnvPath || paths.envPath,
    cliHomeDir: explicitCliHomeDir || join(paths.baseDir, 'cli'),
  };
}

export async function isStackRuntimeProcessTrusted(
  pid,
  { key = '', stackName = '', envPath = '', cliHomeDir = '' } = {},
  {
    isPidAliveImpl = isPidAlive,
    observePidLivenessImpl,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    isRuntimeProcessTrustedImpl = null,
    throwOnInconclusive = true,
  } = {},
) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  const liveness = await observeRuntimePidLiveness(n, { observePidLivenessImpl, isPidAliveImpl });
  if (liveness.status === 'dead') return false;
  if (liveness.status === 'inconclusive') {
    if (!throwOnInconclusive) return false;
    const error = new Error(`[stack] recorded ${key || 'process'} liveness is inconclusive (pid=${n}, reason=${liveness.reason})`);
    error.code = 'ESTACKRUNTIMEPROCESSINCONCLUSIVE';
    throw error;
  }

  const context = resolveStackRuntimeProcessTrustContext({ stackName, envPath, cliHomeDir });
  if (typeof isRuntimeProcessTrustedImpl === 'function') {
    return Boolean(await isRuntimeProcessTrustedImpl(n, { key, ...context }));
  }

  if (!context.stackName && !context.envPath && !context.cliHomeDir) {
    return true;
  }

  try {
    return await isPidOwnedByStackImpl(n, {
      stackName: context.stackName,
      envPath: context.envPath,
      cliHomeDir: context.cliHomeDir,
    });
  } catch (error) {
    if (!throwOnInconclusive && error?.code === 'EPROCESSIDENTITYINCONCLUSIVE') {
      return false;
    }
    throw error;
  }
}

export async function hasTrustedStackRuntimeProcesses(runtimeState, context = {}, options = {}) {
  for (const { key, pid } of getStackRuntimeProcessEntries(runtimeState)) {
    // eslint-disable-next-line no-await-in-loop
    if (await isStackRuntimeProcessTrusted(pid, { ...context, key }, options)) {
      return true;
    }
  }
  return false;
}

// A runtime snapshot is current only while its recorded lifecycle still has a
// trusted owner or child. Consumers use this instead of presenting the raw
// state-file identity after an unowned/stale runtime has exited.
export async function hasTrustedStackRuntimeLifecycle(runtimeState, context = {}, options = {}) {
  const ownerPid = normalizeRuntimePid(runtimeState?.ownerPid);
  if (ownerPid && await isStackRuntimeProcessTrusted(ownerPid, { ...context, key: 'ownerPid' }, options)) {
    return true;
  }
  return await hasTrustedStackRuntimeProcesses(runtimeState, context, options);
}

export async function resolveTrustedStackRuntimeServerPort(runtimeState, context = {}, options = {}) {
  const port = Number(runtimeState?.ports?.server);
  if (!Number.isFinite(port) || port <= 0) return null;
  const trustContext = resolveStackRuntimeProcessTrustContext(context);
  const serverProcessKey = runtimeState?.serverProxy?.mode === 'proxy' ? 'proxyPid' : 'serverPid';
  const serverPid = normalizeRuntimePid(runtimeState?.processes?.[serverProcessKey]);
  if (!serverPid) return null;
  const serverTrusted = await isStackRuntimeProcessTrusted(
    serverPid,
    { ...trustContext, key: serverProcessKey },
    options,
  );
  if (!serverTrusted) return null;

  const resolveStackOwnedListenPidImpl = options.resolveStackOwnedListenPidImpl ?? resolveStackOwnedListenPid;
  try {
    const listenerPid = await resolveStackOwnedListenPidImpl(
      {
        port,
        stackName: trustContext.stackName,
        envPath: trustContext.envPath,
      },
      {
        candidatePids: [serverPid],
        ...(options.listenerOwnershipOptions ?? {}),
      },
    );
    return Number(listenerPid) === serverPid ? port : null;
  } catch (error) {
    if (error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE') return null;
    throw error;
  }
}

async function pruneUntrustedRuntimeProcessPids(processes, context = {}, options = {}) {
  if (!isPlainObject(processes)) return {};
  const out = { ...processes };
  const strictTrustOptions = { ...options, throwOnInconclusive: true };
  for (const [key, value] of Object.entries(out)) {
    if (/Pids$/.test(String(key)) && Array.isArray(value)) {
      const trustedPids = [];
      for (const rawPid of value) {
        const pid = Number(rawPid);
        if (!Number.isFinite(pid) || pid <= 1 || trustedPids.includes(pid)) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await isStackRuntimeProcessTrusted(pid, { ...context, key: String(key) }, strictTrustOptions)) {
          trustedPids.push(pid);
        }
      }
      out[key] = trustedPids;
      continue;
    }

    if (!/Pid$/.test(String(key))) continue;
    const pid = Number(value);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isStackRuntimeProcessTrusted(pid, { ...context, key: String(key) }, strictTrustOptions))) {
      out[key] = null;
    }
  }
  return out;
}

async function observeRuntimePidLiveness(pid, { observePidLivenessImpl, isPidAliveImpl } = {}) {
  const normalizedPid = normalizeRuntimePid(pid);
  if (!normalizedPid) return { status: 'dead', reason: 'invalid_pid' };
  if (typeof observePidLivenessImpl === 'function') {
    const observed = await observePidLivenessImpl(normalizedPid);
    if (['alive', 'dead', 'inconclusive'].includes(observed?.status)) return observed;
    return { status: 'inconclusive', reason: 'invalid_liveness_observation' };
  }
  if (typeof isPidAliveImpl === 'function' && isPidAliveImpl !== isPidAlive) {
    return isPidAliveImpl(normalizedPid)
      ? { status: 'alive', reason: 'legacy_probe' }
      : { status: 'dead', reason: 'legacy_probe' };
  }
  return observePidLiveness(normalizedPid);
}

function runtimeOwnerAdmissionError(existing, stackName, code, message) {
  const error = new Error(`[stack] ${String(stackName ?? existing?.stackName ?? 'stack')} ${message}`);
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

async function recordStackRuntimeStartUnlocked(
  statePath,
  { stackName, script, ephemeral, ownerPid, ports, ...rest } = {},
  options = {},
) {
  const wallClockMs = Date.now();
  const now = new Date(wallClockMs).toISOString();
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  await assertNoDifferentLiveRuntimeOwner(existing, { stackName, ownerPid }, options);
  const restPatch = rest ?? {};
  const { processes: restProcesses, ...restWithoutProcesses } = restPatch;
  const processTrustContext = resolveStackRuntimeProcessTrustContext({ stackName });
  const reconciledExistingProcesses = await pruneUntrustedRuntimeProcessPids(
    existing.processes,
    processTrustContext,
    options,
  );
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
  return await writeStackRuntimeStateFileUnlocked(statePath, next);
}

export async function updateStackRuntimeStateFile(statePath, patch) {
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
    const next = deepMerge(existing, patch ?? {});
    return await writeStackRuntimeStateFileUnlocked(statePath, next);
  });
}

export async function recordStackRuntimeStart(
  statePath,
  input = {},
  options = {},
) {
  return await withStackRuntimeStateMutationLock(
    statePath,
    () => recordStackRuntimeStartUnlocked(statePath, input, options),
  );
}

export async function withStackRuntimeStartClaim(
  statePath,
  { stackName = '' } = {},
  fn,
  options = {},
) {
  if (typeof fn !== 'function') {
    throw new Error('withStackRuntimeStartClaim requires a callback');
  }
  return await withStackRuntimeStateMutationLock(statePath, async () => {
    const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
    await assertNoDifferentLiveRuntimeOwner(existing, { stackName, ownerPid: null }, options);
    let committed = false;
    return await fn({
      existing,
      recordStart: async (input) => {
        if (committed) {
          throw new Error('[stack] lifecycle owner claim was already committed');
        }
        const next = await recordStackRuntimeStartUnlocked(statePath, input, options);
        committed = true;
        return next;
      },
    });
  });
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
    const written = await writeStackRuntimeStateFileUnlocked(statePath, next);
    return { ...(mutation?.result ?? {}), runtimeState: written };
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

export function createStackServerRuntimeProjectionError(cause, {
  listenerPid,
  wrapperPid,
  mode = null,
  authoritativeProcessPid = listenerPid,
  authoritativeProcessRole = 'server-listener',
} = {}) {
  if (cause?.code === 'ESERVERRUNTIMEPROJECTION' && cause?.serverActivationCommitted === true) {
    return cause;
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
  error.authoritativeProcessPid = normalizeRuntimePid(authoritativeProcessPid);
  error.authoritativeProcessRole = authoritativeProcessRole;
  error.serverMode = mode;
  return error;
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
  } = {},
  { recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate } = {},
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
          restartMode: restartMode ? String(restartMode) : null,
          reloadGeneration: Number.isInteger(reloadGeneration) && reloadGeneration >= 0
            ? reloadGeneration
            : null,
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
        }))
      : processPatch;

  if (restartMode && Number.isInteger(reloadGeneration) && reloadGeneration >= 0) {
    patch.serverLifecycle = createStackServerLifecycleProjection({
      phase: 'completed',
      lastCompleted: { mode: restartMode, generation: reloadGeneration },
    });
  }

  try {
    return await recordStackRuntimeUpdateImpl(statePath, patch);
  } catch (cause) {
    throw createStackServerRuntimeProjectionError(cause, {
      listenerPid,
      wrapperPid,
      mode: normalizedMode,
      authoritativeProcessPid: isManagedBackend || isManagedGateway
        ? managedAuthoritativePid
        : listenerPid,
      authoritativeProcessRole: isManagedBackend || isManagedGateway
        ? normalizedMode
        : 'server-listener',
    });
  }
}

export async function recordStackRuntimeServerPids(
  statePath,
  { listenerPid, wrapperPid, serverPort, clearProxyState = false } = {},
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
  return await withStackRuntimeStateMutationLock(statePath, async () => createStackRuntimeStopSnapshot(await readStackRuntimeStateFile(statePath)));
}

async function finalizeStackRuntimeStopUnlocked(statePath, {
  expected,
  preserveDaemon = false,
  cleanupResults = null,
  requireNoStopRequest = false,
} = {}) {
  if (Array.isArray(cleanupResults) && cleanupResults.some((result) => result?.ok !== true)) {
    return { finalized: false, reason: 'cleanup_incomplete', cleanupResults };
  }
  const current = await readStackRuntimeStateFile(statePath);
  if (!current) return { finalized: true, reason: 'missing_state' };
  if (requireNoStopRequest && current.stopRequest && typeof current.stopRequest === 'object') {
    return { finalized: false, reason: 'external_stop_in_progress', runtimeState: current };
  }
  if (!expected || !stackRuntimeStopSnapshotMatches(current, expected)) return { finalized: false, reason: 'successor_state', runtimeState: current };
  if (preserveDaemon) {
    const daemonPid = normalizeRuntimePid(current?.processes?.daemonPid);
    const daemonPids = Array.from(new Set((Array.isArray(current?.processes?.daemonPids) ? current.processes.daemonPids : []).map(normalizeRuntimePid).filter(Boolean)));
    if (daemonPid && !daemonPids.includes(daemonPid)) daemonPids.push(daemonPid);
    if (daemonPids.length > 0) {
      const next = { ...current, ownerPid: null, processes: { daemonPid: daemonPid ?? daemonPids.at(-1), daemonPids }, stopRequest: null, updatedAt: new Date().toISOString() };
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

export async function deleteStackRuntimeStateIfOwnedBy(statePath, expected) {
  if (!normalizeRuntimePid(expected?.ownerPid)) return false;
  if (!normalizeStackRuntimeOwnerStartedAt(expected?.startedAt)) return false;
  const result = await finalizeStackRuntimeStop(statePath, { expected, requireNoStopRequest: true });
  return result.finalized === true;
}
