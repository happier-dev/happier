import { join } from 'node:path';

import { findRunningExpoStateInRoot, looksLikeExpoMetro } from '../expo/expo.mjs';
import { isTcpPortListening } from '../net/ports.mjs';
import { resolveLocalhostHost } from '../paths/localhost_host.mjs';

function toPort(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export async function resolveVerifiedStackServerEndpoint(
  { port, host = '127.0.0.1' } = {},
  {
    fetchHappierHealthImpl = async (...args) => (await import('../server/server.mjs')).fetchHappierHealth(...args),
    isTcpPortListeningImpl = isTcpPortListening,
  } = {},
) {
  const p = toPort(port);
  if (!p) {
    return { running: false, port: null, url: null, health: null, portListening: false };
  }

  const url = `http://${host}:${p}`;
  const portListening = await isTcpPortListeningImpl(p, { host }).catch(() => false);
  const health = await fetchHappierHealthImpl(url).catch(() => null);
  if (health?.ready === true || health?.ok === true) {
    return { running: true, port: p, url, health, portListening: true };
  }

  return { running: false, port: p, url, health, portListening };
}

export async function resolveVerifiedStackUiEndpoint({
  stackName = '',
  baseDir = '',
  runtimeState = null,
  expectedProjectDir = '',
  serverPort = null,
  serverRunning = false,
  serveUiWanted = true,
  acceptExpoState = serveUiWanted,
  requireWeb = true,
  runtimeBackedStart = false,
  requireExpoOwnership = true,
} = {}, { looksLikeExpoMetroImpl = looksLikeExpoMetro } = {}) {
  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const runtimeExpoWebPort =
    runtimeState?.expo && typeof runtimeState.expo === 'object'
      ? toPort(runtimeState.expo.webPort ?? runtimeState.expo.port)
      : null;

  // Runtime metadata selects the endpoint; HTTP observes whether it serves.
  // A stale wrapper PID (or remote lifecycle record) cannot veto live Metro.
  if (!requireExpoOwnership && acceptExpoState && !runtimeBackedStart && runtimeExpoWebPort && (!requireWeb || runtimeState.expo.webEnabled !== false)) {
    const running = await looksLikeExpoMetroImpl({ port: runtimeExpoWebPort, statusOnly: true }).catch(() => false);
    return {
      expected: Boolean(serveUiWanted),
      running,
      port: running ? runtimeExpoWebPort : null,
      url: running && serveUiWanted ? `http://${host}:${runtimeExpoWebPort}` : null,
      source: running ? 'runtime_expo' : 'stale_runtime_expo',
      state: null,
    };
  }

  if (acceptExpoState && !runtimeBackedStart && String(baseDir ?? '').trim()) {
    const runningExpoState = await findRunningExpoStateInRoot({
      expoDevRoot: join(baseDir, 'expo-dev'),
      requireWeb,
      expectedProjectDir,
    }).catch(() => null);
    const expoPort = toPort(runningExpoState?.state?.port ?? runningExpoState?.state?.webPort);
    if (expoPort) {
      return {
        expected: Boolean(serveUiWanted),
        running: true,
        port: expoPort,
        url: serveUiWanted ? `http://${host}:${expoPort}` : null,
        source: 'expo_state',
        state: runningExpoState.state,
      };
    }
  }

  if (runtimeBackedStart && serveUiWanted) {
    const p = toPort(serverPort);
    return {
      expected: Boolean(p),
      running: Boolean(p && serverRunning),
      port: p && serverRunning ? p : null,
      url: p && serverRunning ? `http://${host}:${p}` : null,
      source: 'server',
      state: null,
    };
  }

  return {
    expected: Boolean(serveUiWanted && runtimeExpoWebPort),
    running: false,
    port: null,
    url: null,
    source: !serveUiWanted ? 'disabled' : runtimeExpoWebPort ? 'stale_runtime_expo' : 'none',
    state: null,
  };
}
