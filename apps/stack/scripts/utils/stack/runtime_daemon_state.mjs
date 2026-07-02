import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeUpdate } from './runtime_state.mjs';

export function normalizeDaemonPid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

function normalizeDaemonDistFingerprint(value) {
  const fingerprint = String(value ?? '').trim();
  return fingerprint ? fingerprint : null;
}

export function observeStackDaemonRuntime(
  { runtimeDaemonPid = null, daemonState = null } = {},
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

  const runtimePid = normalizeDaemonPid(runtimeDaemonPid);
  if (runtimePid && isPidAliveImpl(runtimePid)) {
    return {
      running: true,
      pid: runtimePid,
      status: 'running',
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
    { runtimeDaemonPid, daemonState },
    { isPidAliveImpl },
  );
}

export async function recordStackRuntimeDaemonPid(
  runtimeStatePath,
  daemonPid,
  {
    daemonDistFingerprint,
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
  const currentPid = normalizeDaemonPid(existing?.processes?.daemonPid);
  const currentFingerprint = normalizeDaemonDistFingerprint(existing?.daemon?.distClosureFingerprint);
  if (
    currentPid === desiredPid
    && (!shouldUpdateFingerprint || currentFingerprint === desiredFingerprint)
  ) {
    return {
      updated: false,
      pid: desiredPid,
      daemonDistFingerprint: shouldUpdateFingerprint ? desiredFingerprint : currentFingerprint,
    };
  }

  const patch = { processes: { daemonPid: desiredPid } };
  if (shouldUpdateFingerprint) {
    patch.daemon = { distClosureFingerprint: desiredFingerprint };
  }

  await recordStackRuntimeUpdateImpl(statePath, patch);
  return {
    updated: true,
    pid: desiredPid,
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
      env,
    },
    {
      checkDaemonStateImpl,
      isPidAliveImpl,
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
    daemonDistFingerprint,
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const shouldUpdateFingerprint = Object.prototype.hasOwnProperty.call(arguments[0] ?? {}, 'daemonDistFingerprint');
  const observed = getObservedStackDaemon(
    {
      cliHomeDir,
      internalServerUrl,
      runtimeDaemonPid,
      env,
    },
    {
      checkDaemonStateImpl,
      isPidAliveImpl,
    },
  );

  const recordOptions = {
    readStackRuntimeStateFileImpl,
    recordStackRuntimeUpdateImpl,
  };
  if (observed.running) {
    if (shouldUpdateFingerprint) {
      recordOptions.daemonDistFingerprint = daemonDistFingerprint;
    }
  } else {
    recordOptions.daemonDistFingerprint = null;
  }

  const recorded = await recordStackRuntimeDaemonPid(
    runtimeStatePath,
    observed.running ? observed.pid : null,
    recordOptions,
  );

  return {
    ...observed,
    updated: recorded.updated,
    daemonDistFingerprint: recorded.daemonDistFingerprint,
  };
}
