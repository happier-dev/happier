import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeUpdate } from './runtime_state.mjs';

export function normalizeDaemonPid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
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
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!statePath) return { updated: false, pid: normalizeDaemonPid(daemonPid) };

  const desiredPid = normalizeDaemonPid(daemonPid);
  const existing = await readStackRuntimeStateFileImpl(statePath).catch(() => null);
  const currentPid = normalizeDaemonPid(existing?.processes?.daemonPid);
  if (currentPid === desiredPid) {
    return { updated: false, pid: desiredPid };
  }

  await recordStackRuntimeUpdateImpl(statePath, { processes: { daemonPid: desiredPid } });
  return { updated: true, pid: desiredPid };
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
    env = process.env,
  } = {},
  {
    checkDaemonStateImpl = null,
    isPidAliveImpl = isPidAlive,
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  } = {},
) {
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

  const recorded = await recordStackRuntimeDaemonPid(
    runtimeStatePath,
    observed.running ? observed.pid : null,
    {
      readStackRuntimeStateFileImpl,
      recordStackRuntimeUpdateImpl,
    },
  );

  return {
    ...observed,
    updated: recorded.updated,
  };
}
