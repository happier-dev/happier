import { dirname, join } from 'node:path';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { resolvePidStackOwnership } from '../proc/ownership.mjs';
import {
  isPidAlive,
  mutateStackRuntimeDaemonMembership,
  readStackRuntimeStateFile,
  recordStackRuntimeUpdate,
} from './runtime_state.mjs';

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
    String(env?.HAPPIER_STACK_ENV_FILE ?? '').trim() ||
    (runtimeDir ? join(runtimeDir, 'env') : '');
  const resolvedCliHomeDir =
    String(cliHomeDir ?? '').trim() ||
    String(env?.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() ||
    String(env?.HAPPIER_HOME_DIR ?? '').trim();

  return { stackName, envPath, cliHomeDir: resolvedCliHomeDir };
}

function readRecordedDaemonProcessInstanceFingerprint(runtimeState, pid) {
  const normalizedPid = normalizeDaemonPid(pid);
  if (!normalizedPid) return null;
  const identities = runtimeState?.processInstances?.processes ?? {};
  const candidates = [
    identities.daemonPid,
    ...(Array.isArray(identities.daemonPids) ? identities.daemonPids : []),
  ];
  const identity = candidates.find((candidate) => Number(candidate?.pid) === normalizedPid);
  return String(identity?.fingerprint ?? '').trim() || null;
}

function createDaemonPidOwnershipEligibility({
  runtimeStatePath,
  runtimeState,
  cliHomeDir,
  env,
  authenticatedDaemonPid = null,
  authenticatedProcessInstanceFingerprint = null,
  resolvePidStackOwnershipImpl,
  readProcessInstanceFingerprintSyncImpl = readProcessInstanceFingerprintSync,
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
    const trustedFingerprint = String(
      authenticatedProcessInstanceFingerprint ?? '',
    ).trim();
    const processInstanceFingerprint =
      trustedFingerprint
      && normalizeDaemonPid(pid) === normalizeDaemonPid(authenticatedDaemonPid)
        ? trustedFingerprint
        : readRecordedDaemonProcessInstanceFingerprint(runtimeState, pid);
    const ownership = await resolvePidStackOwnershipImpl(pid, {
      ...ownershipContext,
      ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}),
    });
    if (ownership?.owned === true) return true;
    if (
      ownership?.owned == null
      && trustedFingerprint
      && normalizeDaemonPid(pid) === normalizeDaemonPid(authenticatedDaemonPid)
    ) {
      try {
        return readProcessInstanceFingerprintSyncImpl(pid, {
          expectedFingerprint: trustedFingerprint,
        }) === trustedFingerprint;
      } catch {
        return false;
      }
    }
    return false;
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
  if (statePid && isPidAliveImpl(statePid)) {
    return {
      running: false,
      pid: statePid,
      status: status || 'unreachable',
      source: 'daemon_state',
      daemonState,
    };
  }

  const runtimePidCandidates = [
    normalizeDaemonPid(runtimeDaemonPid),
    ...normalizeDaemonPidList(runtimeDaemonPids),
  ].filter(Boolean);
  const runtimePid = runtimePidCandidates.find((pid) => isPidAliveImpl(pid)) ?? null;
  if (runtimePid) {
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
    stackName = null,
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
      ? checkDaemonStateImpl(cliHomeDir, { serverUrl: internalServerUrl, env, stackName })
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
    stackName = null,
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
      ? await checkDaemonStateImpl(cliHomeDir, { serverUrl: internalServerUrl, env, stackName })
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
    daemonProcessInstanceFingerprint = null,
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
  const buildMutation = async (existing) => {
    const liveExistingPids = await pruneEligibleDaemonPids(
      getRuntimeDaemonPidSet(existing?.processes),
      { isPidAliveImpl, isDaemonPidEligibleImpl },
    );
    const acceptedDesiredPid = desiredPid && await isDaemonPidEligible(
      desiredPid,
      { isPidAliveImpl, isDaemonPidEligibleImpl },
    ) ? desiredPid : null;
    const desiredDaemonPids = desiredPid
      ? [...liveExistingPids.filter((pid) => pid !== acceptedDesiredPid), ...(acceptedDesiredPid ? [acceptedDesiredPid] : [])]
      : [];
    const currentPid = normalizeDaemonPid(existing?.processes?.daemonPid);
    const currentDaemonPids = normalizeDaemonPidList(existing?.processes?.daemonPids);
    const currentFingerprint = normalizeDaemonDistFingerprint(existing?.daemon?.distClosureFingerprint);
    const acceptedFingerprint = shouldUpdateFingerprint ? (acceptedDesiredPid ? desiredFingerprint : null) : currentFingerprint;
    const acceptedProcessInstanceFingerprint = acceptedDesiredPid
      ? String(daemonProcessInstanceFingerprint ?? '').trim()
      : '';
    const currentProcessInstanceFingerprint =
      readRecordedDaemonProcessInstanceFingerprint(existing, acceptedDesiredPid);
    const unchanged = currentPid === acceptedDesiredPid
      && currentDaemonPids.length === desiredDaemonPids.length
      && currentDaemonPids.every((pid, index) => pid === desiredDaemonPids[index])
      && (!shouldUpdateFingerprint || currentFingerprint === acceptedFingerprint)
      && (
        !acceptedProcessInstanceFingerprint
        || currentProcessInstanceFingerprint === acceptedProcessInstanceFingerprint
      );
    const result = { updated: !unchanged, pid: acceptedDesiredPid, daemonPids: desiredDaemonPids, daemonDistFingerprint: acceptedFingerprint };
    if (unchanged) return { patch: null, result };
    const patch = { processes: { daemonPid: acceptedDesiredPid, daemonPids: desiredDaemonPids } };
    if (acceptedProcessInstanceFingerprint) {
      const desiredIdentity = {
        pid: acceptedDesiredPid,
        fingerprint: acceptedProcessInstanceFingerprint,
      };
      patch.processInstances = {
        processes: {
          daemonPid: desiredIdentity,
          daemonPids: desiredDaemonPids.map((pid) => (
            pid === acceptedDesiredPid
              ? desiredIdentity
              : {
                  pid,
                  fingerprint: readRecordedDaemonProcessInstanceFingerprint(existing, pid),
                }
          )).filter((identity) => identity.fingerprint),
        },
      };
    }
    if (shouldUpdateFingerprint) patch.daemon = { distClosureFingerprint: acceptedFingerprint };
    return { patch, result };
  };

  if (readStackRuntimeStateFileImpl === readStackRuntimeStateFile && recordStackRuntimeUpdateImpl === recordStackRuntimeUpdate) {
    return await mutateStackRuntimeDaemonMembership(statePath, buildMutation);
  }
  const existing = await readStackRuntimeStateFileImpl(statePath).catch(() => null);
  const mutation = await buildMutation(existing);
  if (mutation.patch) await recordStackRuntimeUpdateImpl(statePath, mutation.patch);
  return mutation.result;
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
    readProcessInstanceFingerprintSyncImpl = readProcessInstanceFingerprintSync,
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
      readProcessInstanceFingerprintSyncImpl,
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
    authenticatedProcessInstanceFingerprint = null,
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
    resolvePidStackOwnershipImpl = resolvePidStackOwnership,
    readProcessInstanceFingerprintSyncImpl = readProcessInstanceFingerprintSync,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const shouldSyncFingerprint = Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'daemonDistFingerprint');
  const runtimeState = runtimeStatePath
    ? await readStackRuntimeStateFileImpl(runtimeStatePath).catch(() => null)
    : null;
  const effectiveRuntimeDaemonPid =
    normalizeDaemonPid(runtimeDaemonPid) ?? normalizeDaemonPid(runtimeState?.processes?.daemonPid);
  const explicitRuntimeDaemonPids = normalizeDaemonPidList(runtimeDaemonPids);
  const effectiveRuntimeDaemonPids = explicitRuntimeDaemonPids.length > 0
    ? explicitRuntimeDaemonPids
    : normalizeDaemonPidList(runtimeState?.processes?.daemonPids);
  const stackName =
    String(runtimeState?.stackName ?? '').trim()
    || String(env?.HAPPIER_STACK_STACK ?? '').trim()
    || null;
  const observed = await getObservedStackDaemonAsync(
    {
      cliHomeDir,
      internalServerUrl,
      stackName,
      runtimeDaemonPid: effectiveRuntimeDaemonPid,
      runtimeDaemonPids: effectiveRuntimeDaemonPids,
      env,
    },
    {
      checkDaemonStateImpl,
      isPidAliveImpl,
    },
  );
  const isDaemonPidEligibleImpl = createDaemonPidOwnershipEligibility({
    runtimeStatePath,
    runtimeState,
    cliHomeDir,
    env,
    authenticatedDaemonPid: observed.running === true ? observed.pid : null,
    authenticatedProcessInstanceFingerprint:
      authenticatedProcessInstanceFingerprint
      || observed.daemonState?.processInstanceFingerprint
      || null,
    resolvePidStackOwnershipImpl,
    readProcessInstanceFingerprintSyncImpl,
  });

  let acceptedObserved = observed;
  if (observed.pid) {
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
    daemonProcessInstanceFingerprint:
      authenticatedProcessInstanceFingerprint
      || observed.daemonState?.processInstanceFingerprint
      || null,
  };
  if (acceptedObserved.running) {
    const desiredFingerprint = shouldSyncFingerprint
      ? normalizeDaemonDistFingerprint(daemonDistFingerprint)
      : null;
    const observedFingerprint = normalizeDaemonDistFingerprint(
      acceptedObserved.daemonState?.distClosureFingerprint,
    );
    if (desiredFingerprint || observedFingerprint) {
      recordOptions.daemonDistFingerprint = observedFingerprint || desiredFingerprint;
    } else if (shouldSyncFingerprint) {
      recordOptions.daemonDistFingerprint = null;
    }
  } else if (acceptedObserved.pid) {
    const observedFingerprint = normalizeDaemonDistFingerprint(
      acceptedObserved.daemonState?.distClosureFingerprint,
    );
    if (observedFingerprint) {
      recordOptions.daemonDistFingerprint = observedFingerprint;
    }
  } else {
    recordOptions.daemonDistFingerprint = null;
  }

  const pidToRecord = acceptedObserved.pid;
  const recorded = await recordStackRuntimeDaemonPid(
    runtimeStatePath,
    pidToRecord,
    recordOptions,
  );
  const recordedPid = normalizeDaemonPid(recorded.pid);
  const recordedMatches = recordedPid === normalizeDaemonPid(acceptedObserved.pid);
  const recordedRunning = acceptedObserved.running === true && recordedMatches;

  return {
    ...acceptedObserved,
    running: recordedRunning,
    pid: recordedPid,
    status: recordedMatches ? acceptedObserved.status : 'stopped',
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
