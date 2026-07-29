import { resolveStablePortStart } from '../expo/metro_ports.mjs';
import { pickNextFreeTcpPort, waitForTcpPortFree } from '../net/ports.mjs';
import { isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { resolveActiveStackEnvFilePath } from '../paths/paths.mjs';
import {
  createListenerOwnershipCommandScope,
  resolveStackOwnedListenPid,
} from './listener_ownership.mjs';
import { isHappierServerRunning } from './server.mjs';
import { resolveServerPortFromEnv } from './port.mjs';

function coercePort(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function coercePositiveInt(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isWithinRange(port, base, range) {
  const p = coercePositiveInt(port);
  const b = coercePositiveInt(base);
  const r = coercePositiveInt(range);
  if (!p || !b || !r) return false;
  return p >= b && p < b + r;
}

function portSelectionInconclusiveError({ stackName, port, source, availability }) {
  const reason = availability?.reason ?? 'port-availability-inconclusive';
  const error = new Error(
    `[stack] ${stackName}: could not determine whether the ${source} server port ${port} is available ` +
      `within the startup observation deadline (${reason}).\n` +
      '[stack] No process was proven to own the port; retry after host load decreases or inspect the listener directly.'
  );
  error.code = 'EPORTSELECTIONINCONCLUSIVE';
  error.availability = availability;
  return error;
}

function pinnedPortOccupiedError({ stackName, port }) {
  return new Error(
    `[stack] ${stackName}: pinned server port ${port} is not available (in use by another process).\n` +
      `[stack] Fix: stop the process using it, or reallocate by unsetting the pin:\n` +
      `  yarn env unset HAPPIER_STACK_SERVER_PORT\n` +
      `  # (or) hstack env unset HAPPIER_STACK_SERVER_PORT`
  );
}

export async function observeRuntimePortOwnedByStackDevProxy({
  env,
  port,
  stackName,
  runtimeStatePath,
  listenerObservationScope,
}) {
  const ownershipScope = listenerObservationScope ?? createListenerOwnershipCommandScope();
  const runtime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  if (!runtime) return { owned: false, proxyPid: null, serverPid: null, listenerPid: null };

  const runtimeStackName = String(runtime.stackName ?? '').trim();
  if (runtimeStackName && runtimeStackName !== stackName) return { owned: false, proxyPid: null, serverPid: null, listenerPid: null };
  if (coercePort(runtime?.ports?.server) !== port) return { owned: false, proxyPid: null, serverPid: null, listenerPid: null };

  const proxyPid = coercePositiveInt(runtime?.processes?.proxyPid);
  const serverPid = coercePositiveInt(runtime?.processes?.serverPid);
  const envPath = resolveActiveStackEnvFilePath(stackName, env);
  const listenPid = await resolveStackOwnedListenPid(
    { port, stackName, envPath },
    {
      observationScope: ownershipScope,
      ...(proxyPid ? { candidatePids: [proxyPid] } : {}),
    },
  );
  return {
    owned: runtime?.serverProxy?.enabled === true && isPidAlive(proxyPid) && listenPid === proxyPid,
    proxyPid,
    serverPid,
    listenerPid: listenPid,
  };
}

async function isHealthyServerPortOwnedByStack({ env, port, stackName, listenerObservationScope }) {
  if (!await isHappierServerRunning(`http://127.0.0.1:${port}`)) return false;
  const envPath = resolveActiveStackEnvFilePath(stackName, env);
  const listenPid = await resolveStackOwnedListenPid(
    { port, stackName, envPath },
    { observationScope: listenerObservationScope },
  );
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1;
}

async function selectLocalServerPortCandidate({
  env = process.env,
  stackMode,
  stackName,
  runtimeStatePath,
  defaultPort = 3005,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const inStackMode = Boolean(stackMode);
  const explicitPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  if (explicitPort) return { port: explicitPort, source: 'pinned', name, inStackMode };

  if (!inStackMode || name === 'main') {
    return { port: resolveServerPortFromEnv({ env, defaultPort }), source: 'legacy', name, inStackMode };
  }
  const runtime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  const runtimePort = coercePort(runtime?.ports?.server);
  const baseRaw = (env.HAPPIER_STACK_SERVER_PORT_BASE ?? '').toString().trim();
  const rangeRaw = (env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '').toString().trim();
  const hasExplicitStableRange = Boolean(baseRaw || rangeRaw);
  const stableBase = coercePositiveInt(baseRaw) ?? 4101;
  const stableRange = coercePositiveInt(rangeRaw) ?? 1000;
  if (runtimePort && (!hasExplicitStableRange || isWithinRange(runtimePort, stableBase, stableRange))) {
    return { port: runtimePort, source: 'recorded runtime', name, inStackMode };
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
  return {
    port: await pickNextFreeTcpPort(startPort, { host: '127.0.0.1' }),
    source: 'allocated',
    name,
    inStackMode,
  };
}

export async function selectLocalServerPortCandidateForStack(options = {}) {
  return (await selectLocalServerPortCandidate(options)).port;
}

export async function resolveLocalServerPortForStack({
  listenerObservationScope = createListenerOwnershipCommandScope(),
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  ...options
} = {}) {
  const candidate = await selectLocalServerPortCandidate(options);
  const { port, source, name, inStackMode } = candidate;
  if (!inStackMode || name === 'main' || source === 'allocated' || source === 'legacy') return port;

  const { env = process.env, runtimeStatePath } = options;
  const proxyObservation = await observeRuntimePortOwnedByStackDevProxy({
    env,
    port,
    stackName: name,
    runtimeStatePath,
    listenerObservationScope,
  });
  const projectedProxyPid = coercePositiveInt(proxyObservation?.proxyPid);
  const listenerPid = coercePositiveInt(proxyObservation?.listenerPid);
  if (projectedProxyPid && projectedProxyPid === listenerPid) return port;
  if (await isHealthyServerPortOwnedByStack({ env, port, stackName: name, listenerObservationScope })) return port;

  if (source === 'pinned' && await isHappierServerRunning(`http://127.0.0.1:${port}`)) {
    throw pinnedPortOccupiedError({ stackName: name, port });
  }

  const availability = await waitForTcpPortFreeImpl(port, {
    host: '127.0.0.1',
    timeoutMs: 5_000,
    intervalMs: 100,
  });
  if (availability.status === 'free') return port;
  if (availability.status === 'inconclusive') {
    throw portSelectionInconclusiveError({ stackName: name, port, source, availability });
  }
  if (source === 'pinned') {
    throw pinnedPortOccupiedError({ stackName: name, port });
  }

  return await selectLocalServerPortCandidateForStack({
    ...options,
    runtimeStatePath: null,
  });
}
