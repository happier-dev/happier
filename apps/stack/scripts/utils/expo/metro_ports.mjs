import { isTcpPortListening, listListenPids, pickNextFreeTcpPort } from '../net/ports.mjs';

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
