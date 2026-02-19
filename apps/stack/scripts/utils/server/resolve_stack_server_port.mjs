import { isTcpPortFree, pickNextFreeTcpPort } from '../net/ports.mjs';
import { resolveStablePortStart } from '../expo/metro_ports.mjs';
import { readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { isHappierServerRunning } from './server.mjs';
import { resolveServerPortFromEnv } from './port.mjs';

function coercePort(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function resolveLocalServerPortForStack({
  env = process.env,
  stackMode,
  stackName,
  runtimeStatePath,
  defaultPort = 3005,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const inStackMode = Boolean(stackMode);

  const explicitPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  if (explicitPort) {
    return explicitPort;
  }

  // For main stack (and stackless=false mode), keep legacy behavior: allow HAPPIER_SERVER_URL to determine the port.
  if (!inStackMode || name === 'main') {
    return resolveServerPortFromEnv({ env, defaultPort });
  }

  // Non-main stacks: avoid leaking global HAPPIER_SERVER_URL into local stack port selection.
  // Prefer runtime state, else pick a stable per-stack port range.
  const runtime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  const runtimePort = coercePort(runtime?.ports?.server);
  if (runtimePort) {
    const url = `http://127.0.0.1:${runtimePort}`;
    if (await isHappierServerRunning(url)) {
      return runtimePort;
    }
    if (await isTcpPortFree(runtimePort, { host: '127.0.0.1' })) {
      return runtimePort;
    }
  }

  const startPort = resolveStablePortStart({
    env: {
      ...env,
      HAPPIER_STACK_SERVER_PORT_BASE: (env.HAPPIER_STACK_SERVER_PORT_BASE ?? '4101').toString(),
      HAPPIER_STACK_SERVER_PORT_RANGE: (env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '1000').toString(),
    },
    stackName: name,
    baseKey: 'HAPPIER_STACK_SERVER_PORT_BASE',
    rangeKey: 'HAPPIER_STACK_SERVER_PORT_RANGE',
    defaultBase: 4101,
    defaultRange: 1000,
  });

  return await pickNextFreeTcpPort(startPort, { host: '127.0.0.1' });
}

