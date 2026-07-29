const EXACT_SERVER_TOPOLOGIES = new Set(['absent', 'exact-owned-direct', 'exact-owned-proxy']);
const DEFAULT_STARTUP_PORT_OBSERVATION_TIMEOUT_MS = 3_000;

function coerceRuntimePid(pid) {
  const value = Number(pid);
  return Number.isFinite(value) && value > 1 ? value : null;
}

export async function observeDevServerStartupTopology({
  serverRequested,
  stackMode,
  serverPort,
  serverHealthObservation,
  ownershipArgs = {},
} = {}, {
  observeTcpPortAvailabilityImpl,
  observeRuntimePortOwnedByStackDevProxyImpl,
  resolveStackOwnedServerListenPidImpl,
} = {}) {
  if (!serverRequested) return Object.freeze({ topology: 'absent', proxyOwned: false, listenerPid: null });
  const availability = await observeTcpPortAvailabilityImpl(serverPort, {
    host: '127.0.0.1',
    timeoutMs: DEFAULT_STARTUP_PORT_OBSERVATION_TIMEOUT_MS,
  });
  if (availability?.status === 'free') return Object.freeze({ topology: 'absent', proxyOwned: false, listenerPid: null, availability });
  if (availability?.status !== 'occupied') return Object.freeze({ topology: 'inconclusive', proxyOwned: false, listenerPid: null, availability });
  if (!stackMode) {
    if (serverHealthObservation?.ok === true) {
      return Object.freeze({ topology: 'healthy-unowned', proxyOwned: false, listenerPid: null, availability });
    }
    const topology = serverHealthObservation?.status == null ? 'inconclusive' : 'foreign';
    return Object.freeze({ topology, proxyOwned: false, listenerPid: null, availability });
  }
  try {
    const proxyObservation = await observeRuntimePortOwnedByStackDevProxyImpl(ownershipArgs);
    if (proxyObservation === true || proxyObservation?.owned === true) return Object.freeze({
      topology: 'exact-owned-proxy', proxyOwned: true,
      proxyPid: Number(proxyObservation?.proxyPid) || null,
      listenerPid: Number(proxyObservation?.listenerPid) || null,
      availability,
    });
    const listenerPid = coerceRuntimePid(proxyObservation?.listenerPid)
      ?? coerceRuntimePid(await resolveStackOwnedServerListenPidImpl(ownershipArgs));
    if (!listenerPid) {
      return Object.freeze({ topology: 'foreign', proxyOwned: false, proxyPid: null, listenerPid: null, availability });
    }
    const proxyPid = coerceRuntimePid(proxyObservation?.proxyPid);
    const serverPid = coerceRuntimePid(proxyObservation?.serverPid);
    const matchesProxy = proxyPid === listenerPid;
    const matchesDirectServer = serverPid === listenerPid;
    if (matchesProxy !== matchesDirectServer) {
      return Object.freeze({
        topology: matchesProxy ? 'exact-owned-proxy' : 'exact-owned-direct',
        proxyOwned: matchesProxy,
        proxyPid,
        listenerPid,
        availability,
      });
    }
    return Object.freeze({ topology: 'inconclusive', proxyOwned: false, proxyPid, listenerPid, availability });
  } catch {
    return Object.freeze({ topology: 'inconclusive', proxyOwned: false, listenerPid: null, availability });
  }
}

export function decideDevStartupTopology({
  serverRequested,
  serverTopology = 'absent',
  daemonRequested,
  daemonRunning,
  expoRequested,
  expoRunning,
  restart = false,
} = {}) {
  if (serverTopology === 'healthy-unowned' && restart) {
    const error = new Error(
      '[local] the occupied server endpoint is healthy but unowned; refusing restart or destructive cleanup.',
    );
    error.code = 'ESERVERTOPOLOGYUNOWNED';
    throw error;
  }
  if (!EXACT_SERVER_TOPOLOGIES.has(serverTopology)) {
    if (serverTopology === 'healthy-unowned') {
      return Object.freeze({
        serverTopology,
        startServer: false,
        startDaemon: Boolean(daemonRequested && !daemonRunning),
        startExpo: Boolean(expoRequested && !expoRunning),
        adoptedServer: Boolean(serverRequested),
      });
    }
    const error = new Error(
      `[local] server startup topology is ${serverTopology}; refusing dependency, infrastructure, migration, ` +
        'ownership-claim, kill, or spawn side effects.',
    );
    error.code = serverTopology === 'foreign' ? 'ESERVERTOPOLOGYFOREIGN' : 'ESERVERTOPOLOGYINCONCLUSIVE';
    throw error;
  }
  const serverAlreadyOwned = serverTopology === 'exact-owned-direct' || serverTopology === 'exact-owned-proxy';
  return Object.freeze({
    serverTopology,
    startServer: Boolean(serverRequested && (restart || !serverAlreadyOwned)),
    startDaemon: Boolean(daemonRequested && (restart || !daemonRunning)),
    startExpo: Boolean(expoRequested && (restart || !expoRunning)),
    adoptedServer: Boolean(serverRequested && serverAlreadyOwned && !restart),
  });
}
