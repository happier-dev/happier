import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveCommandPath } from '../proc/commands.mjs';
import { runCapture } from '../proc/proc.mjs';
import { terminateProcessPid } from '../proc/terminate.mjs';

const DEFAULT_TCP_PORT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_TCP_PORT_ALLOCATION_TIMEOUT_MS = 750;

export async function isTcpPortListening(port, { host = '127.0.0.1', timeoutMs = 250 } = {}) {
  if (!Number.isFinite(port) || port <= 0) return false;

  return await new Promise((resolvePromise) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let socket;
    try {
      socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        done(true);
      });
    } catch {
      done(false);
      return;
    }

    socket.unref();
    socket.on('error', () => done(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      // Fail-closed: treat timeouts as "in use / unknown" rather than "free".
      done(true);
    });
  });
}

function parseListenPidOutput(raw) {
  return Array.from(new Set(String(raw ?? '').split(/\s+/g).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 1)));
}

function parseWindowsNetstatListenPids(raw, port) {
  const suffix = `:${Number(port)}`;
  const pids = [];
  for (const line of String(raw ?? '').split('\n')) {
    const columns = line.trim().split(/\s+/g);
    if (columns.length < 5 || String(columns[0]).toUpperCase() !== 'TCP') continue;
    if (String(columns[3]).toUpperCase() !== 'LISTENING') continue;
    if (!String(columns[1]).endsWith(suffix)) continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 1) pids.push(pid);
  }
  return Array.from(new Set(pids));
}

function listenerObservation(status, pids = [], reason) {
  return { status, supported: status !== 'unsupported', pids, ...(reason ? { reason } : {}) };
}

function classifyListenerDiscoveryError(error, { silentExitCodeOneMeansNoMatch = false } = {}) {
  if (error && typeof error === 'object' && (error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR')) {
    return listenerObservation('timeout', [], 'listener-discovery-timeout');
  }
  if (silentExitCodeOneMeansNoMatch && error?.code === 'EEXIT' && error?.exitCode === 1 && !String(error?.out ?? '').trim() && !String(error?.err ?? '').trim()) {
    return listenerObservation('ok', []);
  }
  return listenerObservation('error', [], 'listener-discovery-error');
}

export async function listListenPidsWithStatus(port, {
  timeoutMs = 1000,
  processGroupId,
  candidatePids,
  platform = process.platform,
  resolveCommandPathImpl = resolveCommandPath,
  runCaptureImpl = runCapture,
  signal,
  env,
} = {}) {
  if (!Number.isFinite(port) || port <= 0) return listenerObservation('ok', []);
  const pgid = Number(processGroupId);
  const hasProcessGroupFilter = Number.isInteger(pgid) && pgid > 1;
  const normalizedCandidatePids = Array.from(new Set(
    (Array.isArray(candidatePids) ? candidatePids : [])
      .map((candidatePid) => Number(candidatePid))
      .filter((candidatePid) => Number.isInteger(candidatePid) && candidatePid > 1),
  )).sort((a, b) => a - b);
  const hasCandidatePidFilter = normalizedCandidatePids.length > 0;
  if (platform === 'win32') {
    if (hasProcessGroupFilter) return listenerObservation('unsupported', [], 'process-group-listener-discovery-unsupported');
    let resolved;
    try { resolved = await resolveCommandPathImpl('netstat', { timeoutMs, env }); }
    catch (error) { return classifyListenerDiscoveryError(error); }
    if (!resolved) return listenerObservation('unsupported', [], 'missing-listener-discovery-command');
    try {
      const observedPids = parseWindowsNetstatListenPids(
        await runCaptureImpl(resolved, ['-ano', '-p', 'TCP'], { timeoutMs, signal, env }),
        port,
      );
      return listenerObservation(
        'ok',
        hasCandidatePidFilter
          ? observedPids.filter((pid) => normalizedCandidatePids.includes(pid))
          : observedPids,
      );
    } catch (error) {
      return classifyListenerDiscoveryError(error);
    }
  }

  const candidates = platform === 'darwin' ? ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof'] : ['lsof'];
  const processGroupArgs = hasProcessGroupFilter ? ['-a', '-g', String(pgid)] : [];
  const candidatePidArgs = hasCandidatePidFilter
    ? ['-a', '-p', normalizedCandidatePids.join(',')]
    : [];
  for (const candidate of candidates) {
    let resolved;
    try { resolved = await resolveCommandPathImpl(candidate, { timeoutMs, env }); }
    catch (error) { return classifyListenerDiscoveryError(error); }
    if (!resolved) continue;
    try {
      const raw = await runCaptureImpl(
        resolved,
        ['-nP', ...processGroupArgs, ...candidatePidArgs, `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
        { timeoutMs, signal, env },
      );
      const observedPids = parseListenPidOutput(raw);
      return listenerObservation(
        'ok',
        hasCandidatePidFilter
          ? observedPids.filter((pid) => normalizedCandidatePids.includes(pid))
          : observedPids,
      );
    } catch (error) {
      return classifyListenerDiscoveryError(error, { silentExitCodeOneMeansNoMatch: true });
    }
  }
  return listenerObservation('unsupported', [], 'missing-listener-discovery-command');
}

// Positive-only compatibility adapter for cleanup paths. Empty never grants authority.
export async function listListenPids(port, options = {}) {
  const out = await listListenPidsWithStatus(port, options);
  return out.status === 'ok' ? out.pids : [];
}

/**
 * Best-effort: kill any processes LISTENing on a TCP port.
 * Used to avoid EADDRINUSE when a previous run left a server behind.
 */
export async function killPortListeners(port, {
  label = 'port',
  platform = process.platform,
  listListenPidsImpl = listListenPids,
  terminateProcessPidImpl = terminateProcessPid,
  logImpl = console.log,
} = {}) {
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }
  if (platform === 'win32') {
    return [];
  }

  const pids = await listListenPidsImpl(port, { timeoutMs: 1000, platform });

  if (!pids.length) {
    return [];
  }

  logImpl(`[local] ${label}: freeing tcp:${port} (killing pids: ${pids.join(', ')})`);
  const terminatedPids = [];
  for (const pid of pids) {
    // eslint-disable-next-line no-await-in-loop
    const result = await terminateProcessPidImpl(pid, { signal: 'SIGTERM', graceMs: 500 });
    if (result?.ok) terminatedPids.push(pid);
  }

  return terminatedPids;
}

export async function isTcpPortFree(
  port,
  {
    host = '127.0.0.1',
    timeoutMs = DEFAULT_TCP_PORT_PROBE_TIMEOUT_MS,
    observeTcpPortAvailabilityImpl = observeTcpPortAvailability,
    ...availabilityOptions
  } = {},
) {
  const availability = await observeTcpPortAvailabilityImpl(port, {
    host,
    timeoutMs,
    ...availabilityOptions,
  });
  return availability.status === 'free';
}

export async function probeTcpPortBinding(port, { host = '127.0.0.1', timeoutMs = 250, signal } = {}) {
  if (!Number.isFinite(port) || port <= 0) return { status: 'error', reason: 'invalid-port' };

  return await new Promise((resolvePromise) => {
    let settled = false;
    let timeoutId;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener?.('abort', onAbort);
      resolvePromise(result);
    };

    const onAbort = () => {
      try { srv?.close(); } catch {}
      done({ status: 'timeout', reason: 'port-bind-aborted' });
    };

    let srv;
    try {
      srv = net.createServer((socket) => {
        // Tests use this as a port reservation primitive too; if something external connects
        // (e.g. a browser tab), immediately close the socket so server.close() cannot hang
        // waiting for long-lived connections to drain.
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
    } catch {
      done({ status: 'error', reason: 'port-bind-create-error' });
      return;
    }

    srv.unref();

    timeoutId = setTimeout(() => {
      try {
        srv.close();
      } catch {
        // ignore
      }
      // Fail-closed: treat timeouts as "in use / unknown" rather than "free".
      done({ status: 'timeout', reason: 'port-bind-timeout' });
    }, timeoutMs);

    srv.on('error', (error) => done(
      error?.code === 'EADDRINUSE'
        ? { status: 'in_use', reason: 'address-in-use' }
        : { status: 'error', reason: 'port-bind-error' },
    ));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const onListening = () => {
        try {
          srv.close(() => done({ status: 'free' }));
        } catch {
          done({ status: 'error', reason: 'port-bind-close-error' });
        }
      };
      if (host == null) srv.listen(port, undefined, onListening);
      else srv.listen({ port, host }, onListening);
    } catch {
      done({ status: 'error', reason: 'port-bind-listen-error' });
    }
  });
}

function observeLocalNetworkInterfaces() {
  return { status: 'complete', interfaces: networkInterfaces() };
}

function listLocalInterfaceBindHosts(host, networkInterfacesImpl, platform) {
  const observation = networkInterfacesImpl();
  if (!observation || observation.status !== 'complete') return null;
  const interfaces = observation.interfaces;
  if (!interfaces || typeof interfaces !== 'object' || Array.isArray(interfaces)) return null;

  const hosts = [];
  const seen = new Set();
  let hasIpv4 = false;
  let hasIpv6 = false;
  const addHost = (candidate) => {
    const key = candidate == null ? '<default>' : String(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    hosts.push(candidate);
  };

  addHost(host);
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    if (!Array.isArray(addresses) || addresses.length === 0) return null;
    for (const entry of addresses) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const address = String(entry.address ?? '').trim();
      if (!address) return null;
      const addressWithoutScope = address.split('%')[0];
      const family = net.isIP(addressWithoutScope);
      const declaredFamily = entry.family === 4 || entry.family === 'IPv4'
        ? 4
        : entry.family === 6 || entry.family === 'IPv6'
          ? 6
          : 0;
      if (family === 0 || declaredFamily !== family) return null;
      if (family === 6) {
        hasIpv6 = true;
        const scopedAddress = Number(entry.scopeid) > 0 && !address.includes('%')
          ? `${address}%${platform === 'win32' ? Number(entry.scopeid) : interfaceName}`
          : address;
        addHost(scopedAddress);
      } else {
        hasIpv4 = true;
        addHost(address);
      }
    }
  }
  if (!hasIpv4 && !hasIpv6) return null;
  if (hasIpv4) addHost('0.0.0.0');
  if (hasIpv6) addHost('::');
  return hosts;
}

async function probeTcpPortBindingWithinDeadline({ port, host, remainingMs, probeTcpPortBindingImpl }) {
  const remaining = remainingMs();
  if (remaining <= 0) return { status: 'timeout', reason: 'port-bind-timeout' };
  const timeoutMs = Math.max(1, Math.min(DEFAULT_TCP_PORT_PROBE_TIMEOUT_MS, remaining));
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((resolvePromise) => {
    timer = setTimeout(() => {
      controller.abort();
      resolvePromise({ status: 'timeout', reason: 'port-bind-timeout' });
    }, timeoutMs);
  });
  const result = await Promise.race([
    Promise.resolve()
      .then(() => probeTcpPortBindingImpl(port, { host, timeoutMs, signal: controller.signal }))
      .catch((error) => (
        error?.code === 'EADDRINUSE'
          ? { status: 'in_use', reason: 'address-in-use' }
          : { status: 'error', reason: 'port-bind-error' }
      )),
    timedOut,
  ]);
  clearTimeout(timer);
  return result;
}

export async function observeTcpPortAvailability(
  port,
  {
    host = '127.0.0.1',
    timeoutMs = DEFAULT_TCP_PORT_PROBE_TIMEOUT_MS,
    deadline,
    networkInterfacesImpl = observeLocalNetworkInterfaces,
    platform = process.platform,
    nowImpl = Date.now,
    probeTcpPortBindingImpl = probeTcpPortBinding,
  } = {},
) {
  if (!Number.isFinite(port) || port <= 0) {
    return { status: 'inconclusive', reason: 'invalid-port' };
  }

  const absoluteDeadline = Number.isFinite(deadline)
    ? deadline
    : nowImpl() + Math.max(0, Number(timeoutMs) || 0);
  const remainingMs = () => Math.max(0, absoluteDeadline - nowImpl());
  let bindHosts;
  try {
    bindHosts = listLocalInterfaceBindHosts(host, networkInterfacesImpl, platform);
  } catch {
    return { status: 'inconclusive', reason: 'interface-inventory-unavailable' };
  }
  if (!bindHosts?.length) {
    return { status: 'inconclusive', reason: 'interface-inventory-unavailable' };
  }

  let incompleteReason = null;
  for (const bindHost of bindHosts) {
    if (remainingMs() <= 0) {
      return {
        status: 'inconclusive',
        reason: incompleteReason ?? 'port-availability-deadline-exceeded',
      };
    }
    // eslint-disable-next-line no-await-in-loop
    const binding = await probeTcpPortBindingWithinDeadline({
      port,
      host: bindHost,
      remainingMs,
      probeTcpPortBindingImpl,
    });
    if (binding?.status === 'in_use') {
      return { status: 'occupied', reason: binding.reason ?? 'address-in-use' };
    }
    if (binding?.status !== 'free' && incompleteReason == null) {
      incompleteReason = binding?.reason ?? 'port-bind-error';
    }
  }

  return incompleteReason == null
    ? { status: 'free' }
    : { status: 'inconclusive', reason: incompleteReason };
}

export async function waitForTcpPortFree(
  port,
  {
    host = '127.0.0.1',
    timeoutMs = 5_000,
    intervalMs = 100,
    nowImpl = Date.now,
    delayImpl = delay,
    observeTcpPortAvailabilityImpl = observeTcpPortAvailability,
    ...availabilityOptions
  } = {},
) {
  const deadline = nowImpl() + Math.max(0, Number(timeoutMs) || 0);
  let lastObservation = { status: 'inconclusive', reason: 'port-availability-deadline-exceeded' };
  while (nowImpl() < deadline) {
    const remaining = Math.max(0, deadline - nowImpl());
    // eslint-disable-next-line no-await-in-loop
    lastObservation = await observeTcpPortAvailabilityImpl(port, {
      host,
      timeoutMs: remaining,
      deadline,
      nowImpl,
      ...availabilityOptions,
    });
    if (lastObservation.status === 'free') {
      return lastObservation;
    }
    const waitMs = Math.min(
      Math.max(0, Number(intervalMs) || 0),
      Math.max(0, deadline - nowImpl()),
    );
    if (waitMs <= 0) break;
    // eslint-disable-next-line no-await-in-loop
    await delayImpl(waitMs);
  }
  return lastObservation;
}

export async function pickNextFreeTcpPort(
  startPort,
  {
    reservedPorts = new Set(),
    host = '127.0.0.1',
    tries = 200,
    totalTimeoutMs = DEFAULT_TCP_PORT_ALLOCATION_TIMEOUT_MS,
    networkInterfacesImpl = observeLocalNetworkInterfaces,
    platform = process.platform,
    nowImpl = Date.now,
    probeTcpPortBindingImpl = probeTcpPortBinding,
    observeTcpPortAvailabilityImpl = observeTcpPortAvailability,
  } = {},
) {
  const normalizedTimeoutMs = Math.max(1, Number(totalTimeoutMs) || 1);
  const deadline = nowImpl() + normalizedTimeoutMs;
  const throwDeadlineExceeded = () => {
    const error = new Error(`[local] unable to find a free TCP port within ${normalizedTimeoutMs}ms`);
    error.code = 'EPORTALLOCATIONTIMEOUT';
    throw error;
  };
  let port = startPort;
  for (let i = 0; i < tries; i++) {
    if (nowImpl() >= deadline) throwDeadlineExceeded();
    if (reservedPorts.has(port)) {
      port += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const availability = await observeTcpPortAvailabilityImpl(port, {
      host,
      deadline,
      networkInterfacesImpl,
      platform,
      nowImpl,
      probeTcpPortBindingImpl,
    });
    if (nowImpl() >= deadline) throwDeadlineExceeded();
    if (availability.status === 'free') {
      return port;
    }
    port += 1;
  }
  throw new Error(`[local] unable to find a free TCP port starting at ${startPort}`);
}
