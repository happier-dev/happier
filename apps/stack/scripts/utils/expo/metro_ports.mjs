import { setTimeout as delay } from 'node:timers/promises';
import { isTcpPortListening, listListenPids, listListenPidsWithStatus, pickNextFreeTcpPort, probeTcpPortBinding } from '../net/ports.mjs';

const DEFAULT_METRO_LISTENER_OBSERVATION_TIMEOUT_MS = 5_000;
const DEFAULT_METRO_BINDING_OBSERVATION_TIMEOUT_MS = 1_000;
const DEFAULT_STABLE_METRO_PORT_ADMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_STABLE_METRO_PORT_RETRY_DELAY_MS = 250;

function hashStringToInt(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function coercePositiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolveStablePortStart({
  env = process.env,
  stackName,
  baseKey,
  rangeKey,
  defaultBase,
  defaultRange,
}) {
  const baseRaw = (env[baseKey] ?? '').toString().trim();
  const rangeRaw = (env[rangeKey] ?? '').toString().trim();
  const base = coercePositiveInt(baseRaw) ?? defaultBase;
  const range = coercePositiveInt(rangeRaw) ?? defaultRange;
  return base + (hashStringToInt(stackName) % range);
}

export async function pickMetroPort({
  startPort,
  forcedPort,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  const forced = coercePositiveInt(forcedPort);
  if (forced && !reservedPorts.has(forced)) {
    // Avoid bind-based probing for the forced port path: concurrent probes can temporarily occupy the port
    // and cause false negatives (flaky forced-port selection).
    //
    // Strategy:
    // - First detect any real listener via lsof (non-invasive; catches IPv6 listeners on macOS).
    // - Then do a best-effort connect probe (works even when lsof is missing).
    const pids = await listListenPids(forced);
    const listening = pids.length ? true : await isTcpPortListening(forced, { host });
    if (!listening) return forced;
  }
  return await pickNextFreeTcpPort(startPort, { reservedPorts, host });
}

export async function observeMetroPortAvailability(
  port,
  {
    host = '127.0.0.1',
    allowBindOnly = false,
    env = process.env,
    listenerTimeoutMs = DEFAULT_METRO_LISTENER_OBSERVATION_TIMEOUT_MS,
    bindingTimeoutMs = DEFAULT_METRO_BINDING_OBSERVATION_TIMEOUT_MS,
  } = {},
  {
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    probeTcpPortBindingImpl = probeTcpPortBinding,
  } = {},
) {
  const listeners = await listListenPidsWithStatusImpl(port, { timeoutMs: listenerTimeoutMs, env });
  if (listeners.status !== 'ok' && !(allowBindOnly && listeners.status === 'unsupported')) {
    return { status: 'inconclusive', reason: listeners.reason ?? listeners.status };
  }
  if (listeners.pids.length) return { status: 'occupied', reason: 'listener-present', pids: [...listeners.pids] };
  const binding = await probeTcpPortBindingImpl(port, { host, timeoutMs: bindingTimeoutMs });
  if (binding.status === 'free') return { status: 'free' };
  if (binding.status === 'in_use') return { status: 'occupied', reason: binding.reason };
  return { status: 'inconclusive', reason: binding.reason ?? binding.status };
}

function isRetryableMetroPortObservation(observation) {
  const reason = String(observation?.reason ?? '').trim();
  return reason === 'listener-discovery-timeout'
    || reason === 'listener-discovery-error'
    || reason === 'port-bind-timeout';
}

async function observeStableMetroPortUntilConclusive({
  port,
  host,
  env,
  timeoutMs,
  retryDelayMs,
  observePortImpl,
  nowImpl,
  delayImpl,
}) {
  const deadline = nowImpl() + timeoutMs;
  let observation = { status: 'inconclusive', reason: 'stable-port-admission-timeout' };
  while (nowImpl() < deadline) {
    const remainingMs = Math.max(1, deadline - nowImpl());
    // eslint-disable-next-line no-await-in-loop
    observation = await observePortImpl(port, {
      host,
      allowBindOnly: false,
      env,
      listenerTimeoutMs: Math.min(DEFAULT_METRO_LISTENER_OBSERVATION_TIMEOUT_MS, remainingMs),
      bindingTimeoutMs: Math.min(DEFAULT_METRO_BINDING_OBSERVATION_TIMEOUT_MS, remainingMs),
    });
    if (observation.status !== 'inconclusive') return observation;
    if (!isRetryableMetroPortObservation(observation)) return observation;

    const waitMs = Math.min(retryDelayMs, Math.max(0, deadline - nowImpl()));
    if (waitMs <= 0) break;
    // eslint-disable-next-line no-await-in-loop
    await delayImpl(waitMs);
  }
  return observation;
}

export function wantsStablePortStrategy({ env = process.env, strategyKey, legacyStrategyKey } = {}) {
  void legacyStrategyKey;
  const raw = (env[strategyKey] ?? 'ephemeral').toString().trim() || 'ephemeral';
  return raw === 'stable';
}

export async function pickUiDevMetroPort({
  env = process.env,
  stackMode,
  stackName,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  // Legacy alias: UI dev Metro is now the unified Expo dev server port.
  return await pickExpoDevMetroPort({ env, stackMode, stackName, reservedPorts, host });
}

export async function pickMobileDevMetroPort({
  env = process.env,
  stackMode,
  stackName,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  // Legacy alias: mobile dev Metro is now the unified Expo dev server port.
  return await pickExpoDevMetroPort({ env, stackMode, stackName, reservedPorts, host });
}

export async function pickExpoDevMetroPort({
  env = process.env,
  stackMode,
  stackName,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  const forcedPort = (env.HAPPIER_STACK_EXPO_DEV_PORT ?? '').toString().trim() || '';

  const stable =
    stackMode &&
    wantsStablePortStrategy({
      env,
      strategyKey: 'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY',
    });
  const startPort = stable
    ? resolveStablePortStart({
        env,
        stackName,
        baseKey: 'HAPPIER_STACK_EXPO_DEV_PORT_BASE',
        rangeKey: 'HAPPIER_STACK_EXPO_DEV_PORT_RANGE',
        defaultBase: 8081,
        defaultRange: 1000,
      })
    : 8081;

  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function selectExpoDevMetroPort({
  env = process.env,
  stackMode,
  stackName,
  reservedPorts = new Set(),
  host = '127.0.0.1',
  tries = 200,
  observePortImpl = observeMetroPortAvailability,
  onStableOccupied = null,
  stableObservationTimeoutMs = DEFAULT_STABLE_METRO_PORT_ADMISSION_TIMEOUT_MS,
  stableObservationRetryDelayMs = DEFAULT_STABLE_METRO_PORT_RETRY_DELAY_MS,
  nowImpl = Date.now,
  delayImpl = delay,
} = {}) {
  const forcedPort = (env.HAPPIER_STACK_EXPO_DEV_PORT ?? '').toString().trim() || '';
  const stable = stackMode && wantsStablePortStrategy({ env, strategyKey: 'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY' });
  const startPort = stable
    ? resolveStablePortStart({ env, stackName, baseKey: 'HAPPIER_STACK_EXPO_DEV_PORT_BASE', rangeKey: 'HAPPIER_STACK_EXPO_DEV_PORT_RANGE', defaultBase: 8081, defaultRange: 1000 })
    : 8081;
  const forced = coercePositiveInt(forcedPort);
  if (stable && forced && reservedPorts.has(forced)) {
    const error = new Error(`[expo] stable expo port ${forced} is reserved by another stack service`);
    error.code = 'EEXPOPORTOCCUPIED';
    error.observation = { status: 'occupied', reason: 'reserved' };
    throw error;
  }
  const observeStablePort = (port) => observeStableMetroPortUntilConclusive({
    port,
    host,
    env,
    timeoutMs: coercePositiveInt(stableObservationTimeoutMs) ?? DEFAULT_STABLE_METRO_PORT_ADMISSION_TIMEOUT_MS,
    retryDelayMs: coercePositiveInt(stableObservationRetryDelayMs) ?? DEFAULT_STABLE_METRO_PORT_RETRY_DELAY_MS,
    observePortImpl,
    nowImpl,
    delayImpl,
  });
  if (forced && !reservedPorts.has(forced)) {
    const observeForcedPort = stable
      ? () => observeStablePort(forced)
      : () => observePortImpl(forced, { host, allowBindOnly: false, env });
    let observation = await observeForcedPort();
    if (stable && observation.status === 'occupied' && typeof onStableOccupied === 'function') {
      await onStableOccupied({ port: forced, observation });
      observation = await observeForcedPort();
    }
    if (observation.status === 'free') return { port: forced, persistPin: false, preferredStatus: 'free' };
    if (stable) {
      const error = new Error(observation.status === 'occupied'
        ? `[expo] stable expo port ${forced} is already occupied`
        : `[expo] stable expo port ${forced} availability is inconclusive: ${observation.reason ?? 'unknown'}`);
      error.code = observation.status === 'occupied' ? 'EEXPOPORTOCCUPIED' : 'EEXPOPORTINCONCLUSIVE';
      error.observation = observation;
      throw error;
    }
  }
  for (let offset = 0; offset < tries; offset += 1) {
    const port = startPort + offset;
    if (reservedPorts.has(port) || port === forced) continue;
    // eslint-disable-next-line no-await-in-loop
    const observation = stable
      ? await observeStablePort(port)
      : await observePortImpl(port, { host, allowBindOnly: true, env });
    if (observation.status === 'free') return { port, persistPin: stable && !forced, preferredStatus: forced ? 'unavailable' : 'unset' };
    if (stable && observation.status === 'inconclusive') {
      const error = new Error(
        `[expo] stable expo port ${port} availability is inconclusive: ${observation.reason ?? 'unknown'}`,
      );
      error.code = 'EEXPOPORTINCONCLUSIVE';
      error.observation = observation;
      throw error;
    }
  }
  const error = new Error(`[expo] unable to establish a conclusively free Metro port starting at ${startPort}`);
  error.code = 'EEXPOPORTUNAVAILABLE';
  throw error;
}
