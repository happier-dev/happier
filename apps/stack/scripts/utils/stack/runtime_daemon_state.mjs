import { dirname, join } from 'node:path';
import { resolvePidStackOwnership } from '../proc/ownership.mjs';
import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeUpdate } from './runtime_state.mjs';

export function normalizeDaemonPid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

export function normalizeDaemonPidList(value) {
  const raw = Array.isArray(value) ? value : [];
  const pids = [];
  for (const entry of raw) {
    const pid = normalizeDaemonPid(entry);
    if (pid && !pids.includes(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

function getRuntimeDaemonPidSet(processes) {
  const set = new Set();
  const add = (value) => {
    const pid = normalizeDaemonPid(value);
    if (pid) set.add(pid);
  };
  add(processes?.daemonPid);
  for (const pid of normalizeDaemonPidList(processes?.daemonPids)) {
    add(pid);
  }
  return Array.from(set);
}

function pruneLiveDaemonPids(pids, isPidAliveImpl) {
  const out = [];
  for (const pid of pids) {
    if (!normalizeDaemonPid(pid)) continue;
    if (typeof isPidAliveImpl === 'function' && !isPidAliveImpl(pid)) continue;
    if (!out.includes(pid)) out.push(pid);
  }
  return out;
}

async function isDaemonPidEligible(pid, { isPidAliveImpl, isDaemonPidEligibleImpl } = {}) {
  const normalized = normalizeDaemonPid(pid);
  if (!normalized) return false;
  if (typeof isPidAliveImpl === 'function' && !isPidAliveImpl(normalized)) return false;
  if (typeof isDaemonPidEligibleImpl === 'function') {
    return (await isDaemonPidEligibleImpl(normalized)) === true;
  }
  return true;
}

async function pruneEligibleDaemonPids(pids, { isPidAliveImpl, isDaemonPidEligibleImpl } = {}) {
  const out = [];
  for (const pid of pids) {
    const normalized = normalizeDaemonPid(pid);
    if (!normalized) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await isDaemonPidEligible(normalized, { isPidAliveImpl, isDaemonPidEligibleImpl }))) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function resolveStackIdentityForDaemonPidOwnership({ runtimeStatePath, runtimeState, cliHomeDir, env } = {}) {
  const statePath = String(runtimeStatePath ?? '').trim();
  const runtimeDir = statePath ? dirname(statePath) : '';
  const stackName =
    String(runtimeState?.stackName ?? '').trim() ||
    String(env?.HAPPIER_STACK_STACK ?? '').trim();
  const envPath =
    (runtimeDir ? join(runtimeDir, 'env') : '') ||
    String(env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
  const resolvedCliHomeDir =
    String(cliHomeDir ?? '').trim() ||
    String(env?.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() ||
    String(env?.HAPPIER_HOME_DIR ?? '').trim();

  return { stackName, envPath, cliHomeDir: resolvedCliHomeDir };
}

function createDaemonPidOwnershipEligibility({
  runtimeStatePath,
  runtimeState,
  cliHomeDir,
  env,
  resolvePidStackOwnershipImpl,
} = {}) {
  if (typeof resolvePidStackOwnershipImpl !== 'function') return null;
  const ownershipContext = resolveStackIdentityForDaemonPidOwnership({
    runtimeStatePath,
    runtimeState,
    cliHomeDir,
    env,
  });
  if (!ownershipContext.stackName && !ownershipContext.envPath && !ownershipContext.cliHomeDir) {
    return null;
  }
  return async (pid) => {
    const ownership = await resolvePidStackOwnershipImpl(pid, ownershipContext);
    return ownership?.owned === true;
  };
}

async function findFirstEligibleRuntimeDaemonPid(
  runtimeDaemonPid,
  runtimeDaemonPids,
  { isPidAliveImpl, isDaemonPidEligibleImpl } = {},
) {
  const candidates = [
    normalizeDaemonPid(runtimeDaemonPid),
    ...normalizeDaemonPidList(runtimeDaemonPids),
  ].filter(Boolean);
  for (const pid of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await isDaemonPidEligible(pid, { isPidAliveImpl, isDaemonPidEligibleImpl })) {
      return pid;
    }
  }
  return null;
}

function normalizeDaemonDistFingerprint(value) {
  const fingerprint = String(value ?? '').trim();
  return fingerprint ? fingerprint : null;
}

export function observeStackDaemonRuntime(
  { runtimeDaemonPid = null, runtimeDaemonPids = [], daemonState = null } = {},
  { isPidAliveImpl = isPidAlive } = {},
) {
  const status = String(daemonState?.status ?? '').trim();
  const statePid = normalizeDaemonPid(daemonState?.pid);
  if (status === 'running' || status === 'starting') {
    return {
      running: true,
      pid: statePid,
      status,
      source: 'daemon_state',
      daemonState,
    };
  }

  const runtimePidCandidates = [
    normalizeDaemonPid(runtimeDaemonPid),
    ...normalizeDaemonPidList(runtimeDaemonPids),
  ].filter(Boolean);
  const runtimePid = runtimePidCandidates.find((pid) => isPidAliveImpl(pid)) ?? null;
  if (runtimePid && isPidAliveImpl(runtimePid)) {
    return {
      running: false,
      pid: runtimePid,
      status: status || 'stopped',
      source: 'runtime_pid',
      daemonState,
    };
  }

  return {
    running: false,
    pid: null,
    status: status || 'stopped',
    source: status ? 'daemon_state' : 'none',
    daemonState,
  };
}

export function getObservedStackDaemon(
  {
    cliHomeDir = '',
    internalServerUrl = '',
    runtimeDaemonPid = null,
    runtimeDaemonPids = [],
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
  } = {},
) {
  const daemonState =
    typeof checkDaemonStateImpl === 'function' && String(cliHomeDir ?? '').trim()
      ? checkDaemonStateImpl(cliHomeDir, { serverUrl: internalServerUrl, env })
      : null;

  return observeStackDaemonRuntime(
    { runtimeDaemonPid, runtimeDaemonPids, daemonState },
    { isPidAliveImpl },
  );
}

export async function getObservedStackDaemonAsync(
  {
    cliHomeDir = '',
    internalServerUrl = '',
    runtimeDaemonPid = null,
    runtimeDaemonPids = [],
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
  } = {},
) {
  const daemonState =
    typeof checkDaemonStateImpl === 'function' && String(cliHomeDir ?? '').trim()
      ? await checkDaemonStateImpl(cliHomeDir, { serverUrl: internalServerUrl, env })
      : null;

  return observeStackDaemonRuntime(
    { runtimeDaemonPid, runtimeDaemonPids, daemonState },
    { isPidAliveImpl },
  );
}

export async function recordStackRuntimeDaemonPid(
  runtimeStatePath,
  daemonPid,
  {
    daemonDistFingerprint,
    isPidAliveImpl = isPidAlive,
    isDaemonPidEligibleImpl = null,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!statePath) return { updated: false, pid: normalizeDaemonPid(daemonPid) };

  const desiredPid = normalizeDaemonPid(daemonPid);
  const shouldUpdateFingerprint = Object.prototype.hasOwnProperty.call(arguments[2] ?? {}, 'daemonDistFingerprint');
  const desiredFingerprint = shouldUpdateFingerprint
    ? normalizeDaemonDistFingerprint(daemonDistFingerprint)
    : undefined;
  const existing = await readStackRuntimeStateFileImpl(statePath).catch(() => null);
  const liveExistingPids = await pruneEligibleDaemonPids(
    getRuntimeDaemonPidSet(existing?.processes),
    { isPidAliveImpl, isDaemonPidEligibleImpl },
  );
  const acceptedDesiredPid = desiredPid && await isDaemonPidEligible(
    desiredPid,
    { isPidAliveImpl, isDaemonPidEligibleImpl },
  )
    ? desiredPid
    : null;
  const desiredDaemonPids = desiredPid
    ? [...liveExistingPids.filter((pid) => pid !== acceptedDesiredPid), ...(acceptedDesiredPid ? [acceptedDesiredPid] : [])]
    : [];
  const currentPid = normalizeDaemonPid(existing?.processes?.daemonPid);
  const currentDaemonPids = normalizeDaemonPidList(existing?.processes?.daemonPids);
  const currentFingerprint = normalizeDaemonDistFingerprint(existing?.daemon?.distClosureFingerprint);
  if (
    currentPid === acceptedDesiredPid
    && currentDaemonPids.length === desiredDaemonPids.length
    && currentDaemonPids.every((pid, index) => pid === desiredDaemonPids[index])
    && (!shouldUpdateFingerprint || currentFingerprint === desiredFingerprint)
  ) {
    return {
      updated: false,
      pid: acceptedDesiredPid,
      daemonPids: desiredDaemonPids,
      daemonDistFingerprint: shouldUpdateFingerprint ? desiredFingerprint : currentFingerprint,
    };
  }

  const patch = { processes: { daemonPid: acceptedDesiredPid, daemonPids: desiredDaemonPids } };
  if (shouldUpdateFingerprint) {
    patch.daemon = { distClosureFingerprint: desiredFingerprint };
  }

  await recordStackRuntimeUpdateImpl(statePath, patch);
  return {
    updated: true,
    pid: acceptedDesiredPid,
    daemonPids: desiredDaemonPids,
    daemonDistFingerprint: shouldUpdateFingerprint ? desiredFingerprint : currentFingerprint,
  };
}

export async function readStackRuntimeStateWithDaemonSync(
  {
    runtimeStatePath,
    cliHomeDir = '',
    internalServerUrl = '',
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
    resolvePidStackOwnershipImpl = resolvePidStackOwnership,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!statePath) return null;

  const runtimeState = await readStackRuntimeStateFileImpl(statePath).catch(() => null);
  if (!runtimeState || !String(cliHomeDir ?? '').trim()) {
    return runtimeState;
  }

  const synced = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath: statePath,
      cliHomeDir,
      internalServerUrl,
      runtimeDaemonPid: runtimeState?.processes?.daemonPid ?? null,
      runtimeDaemonPids: runtimeState?.processes?.daemonPids ?? [],
      env,
    },
    {
      checkDaemonStateImpl,
      isPidAliveImpl,
      resolvePidStackOwnershipImpl,
      readStackRuntimeStateFileImpl,
      recordStackRuntimeUpdateImpl,
    },
  );

  if (!synced.updated) {
    return runtimeState;
  }

  return await readStackRuntimeStateFileImpl(statePath).catch(() => runtimeState);
}

export async function syncStackRuntimeDaemonPidFromDaemonState(
  {
    runtimeStatePath,
    cliHomeDir = '',
    internalServerUrl = '',
    runtimeDaemonPid = null,
    runtimeDaemonPids = [],
    daemonDistFingerprint,
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
    resolvePidStackOwnershipImpl = resolvePidStackOwnership,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const shouldUpdateFingerprint = Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'daemonDistFingerprint');
  const runtimeState = String(runtimeStatePath ?? '').trim()
    ? await readStackRuntimeStateFileImpl(String(runtimeStatePath).trim()).catch(() => null)
    : null;
  const hasRuntimeDaemonPid = Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'runtimeDaemonPid');
  const hasRuntimeDaemonPids = Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'runtimeDaemonPids');
  let effectiveRuntimeDaemonPid = runtimeDaemonPid;
  let effectiveRuntimeDaemonPids = runtimeDaemonPids;
  if (!hasRuntimeDaemonPid || !hasRuntimeDaemonPids) {
    if (!hasRuntimeDaemonPid) {
      effectiveRuntimeDaemonPid = runtimeState?.processes?.daemonPid ?? null;
    }
    if (!hasRuntimeDaemonPids) {
      effectiveRuntimeDaemonPids = runtimeState?.processes?.daemonPids ?? [];
    }
  }
  const isDaemonPidEligibleImpl = createDaemonPidOwnershipEligibility({
    runtimeStatePath,
    runtimeState,
    cliHomeDir,
    env,
    resolvePidStackOwnershipImpl,
  });

  const observed = await getObservedStackDaemonAsync(
    {
      cliHomeDir,
      internalServerUrl,
      runtimeDaemonPid: effectiveRuntimeDaemonPid,
      runtimeDaemonPids: effectiveRuntimeDaemonPids,
      env,
    },
    {
      checkDaemonStateImpl,
      isPidAliveImpl,
    },
  );

  let acceptedObserved = observed;
  if (observed.running && observed.pid) {
    const observedEligible = await isDaemonPidEligible(observed.pid, {
      isPidAliveImpl,
      isDaemonPidEligibleImpl,
    });
    if (!observedEligible) {
      const fallbackRuntimePid = await findFirstEligibleRuntimeDaemonPid(
        effectiveRuntimeDaemonPid,
        effectiveRuntimeDaemonPids,
        { isPidAliveImpl, isDaemonPidEligibleImpl },
      );
      acceptedObserved = fallbackRuntimePid
        ? {
            running: false,
            pid: fallbackRuntimePid,
            status: 'stopped',
            source: 'runtime_pid',
            daemonState: observed.daemonState,
          }
        : {
            running: false,
            pid: null,
            status: 'stopped',
            source: observed.source === 'daemon_state' ? 'daemon_state_unowned' : 'runtime_pid_unowned',
            daemonState: observed.daemonState,
          };
    }
  }

  const recordOptions = {
    readStackRuntimeStateFileImpl,
    recordStackRuntimeUpdateImpl,
    isPidAliveImpl,
    isDaemonPidEligibleImpl,
  };
  if (acceptedObserved.running) {
    if (shouldUpdateFingerprint) {
      recordOptions.daemonDistFingerprint = daemonDistFingerprint;
    }
  } else {
    recordOptions.daemonDistFingerprint = null;
  }

  const recorded = await recordStackRuntimeDaemonPid(
    runtimeStatePath,
    acceptedObserved.running || acceptedObserved.source === 'runtime_pid' ? acceptedObserved.pid : null,
    recordOptions,
  );

  return {
    ...acceptedObserved,
    updated: recorded.updated,
    daemonDistFingerprint: recorded.daemonDistFingerprint,
  };
}

export function startStackRuntimeDaemonPidReconciler(
  {
    runtimeStatePath,
    cliHomeDir = '',
    internalServerUrl = '',
    env = process.env,
    intervalMs = 10_000,
    isShuttingDown = () => false,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
    resolvePidStackOwnershipImpl = resolvePidStackOwnership,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
    syncStackRuntimeDaemonPidFromDaemonStateImpl = syncStackRuntimeDaemonPidFromDaemonState,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    logger = console,
  } = {},
) {
  const statePath = String(runtimeStatePath ?? '').trim();
  const homeDir = String(cliHomeDir ?? '').trim();
  if (!statePath || !homeDir) {
    return null;
  }

  let closed = false;
  let inFlight = false;

  const syncNow = async () => {
    if (closed || isShuttingDown?.() === true || inFlight) {
      return { skipped: true };
    }
    inFlight = true;
    try {
      return await syncStackRuntimeDaemonPidFromDaemonStateImpl(
        {
          runtimeStatePath: statePath,
          cliHomeDir: homeDir,
          internalServerUrl,
          env,
        },
        {
          checkDaemonStateImpl,
          isPidAliveImpl,
          resolvePidStackOwnershipImpl,
          readStackRuntimeStateFileImpl,
          recordStackRuntimeUpdateImpl,
        },
      );
    } catch (error) {
      logger?.warn?.(`[stack] daemon runtime pid reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      return { skipped: true, error };
    } finally {
      inFlight = false;
    }
  };

  const interval = Math.max(1000, Number(intervalMs) || 10_000);
  const timer = setIntervalImpl(() => {
    void syncNow();
  }, interval);
  timer?.unref?.();

  return {
    syncNow,
    close() {
      closed = true;
      clearIntervalImpl(timer);
    },
  };
}
