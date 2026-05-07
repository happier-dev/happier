import { isTuiStartLikeForwardedArgs } from './args.mjs';
import { buildTauriRuntimeEnv } from '../dev/tauri_dev.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRepoDir, resolveStackEnvPath } from '../paths/paths.mjs';
import { readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { looksLikeExpoMetro } from '../expo/expo.mjs';

export function buildTuiChildArgs({ forwardedArgs, withTauri } = {}) {
  const args = Array.isArray(forwardedArgs) ? forwardedArgs.map((arg) => String(arg ?? '')).filter(Boolean) : [];
  if (!withTauri) {
    return args.length > 0 ? args : ['dev'];
  }

  const childArgs = args.length > 0 ? args : ['dev'];
  if (childArgs.includes('--no-browser')) {
    return childArgs;
  }
  return [...childArgs, '--no-browser'];
}

export function shouldStartTauriPane(forwardedArgs) {
  if (!isTuiStartLikeForwardedArgs(forwardedArgs)) {
    return false;
  }

  const args = Array.isArray(forwardedArgs) ? forwardedArgs : [];
  const first = String(args[0] ?? '').trim();
  if (first === 'dev') return true;

  const stackIdx = args.indexOf('stack');
  if (stackIdx < 0) return false;
  return String(args[stackIdx + 1] ?? '').trim() === 'dev';
}

export function resolveTauriPaneCwd({ rootDir, env = process.env } = {}) {
  return getRepoDir(rootDir, env);
}

export function resolveTauriPaneInvocation({ rootDir, env = process.env } = {}) {
  const cwd = resolveTauriPaneCwd({ rootDir, env });
  return {
    command: process.execPath,
    args: [join(cwd, 'apps', 'stack', 'scripts', 'tauri_dev.mjs')],
    cwd,
  };
}

export function buildTauriPaneEnv({ env = process.env, resolveUserHomeDir, forceExpoClearCache = false } = {}) {
  const nextEnv = {
    ...buildTauriRuntimeEnv({ env, resolveUserHomeDir }),
    HAPPIER_STACK_TUI: '1',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_STRICT: '0',
  };
  if (forceExpoClearCache && !String(nextEnv.HAPPIER_STACK_EXPO_CLEAR_CACHE ?? '').trim()) {
    nextEnv.HAPPIER_STACK_EXPO_CLEAR_CACHE = '1';
  }
  return nextEnv;
}

export function resolveTauriPaneLaunchEnv({
  env = process.env,
  resolveUserHomeDir,
  expoPort = null,
  skipExpoWait = false,
} = {}) {
  const tauriEnv = buildTauriPaneEnv({ env, resolveUserHomeDir });
  const resolvedExpoPort = Number(expoPort);
  if (Number.isFinite(resolvedExpoPort) && resolvedExpoPort > 0) {
    tauriEnv.HAPPIER_STACK_EXPO_DEV_PORT = String(Math.floor(resolvedExpoPort));
  }
  if (skipExpoWait) {
    tauriEnv.HAPPIER_STACK_TAURI_WAIT_FOR_EXPO = '0';
  }
  return tauriEnv;
}

export function resolveTauriPaneSpawnConfig({
  rootDir,
  env = process.env,
  resolveUserHomeDir,
  expoPort = null,
  skipExpoWait = false,
} = {}) {
  const tauriEnv = resolveTauriPaneLaunchEnv({
    env,
    resolveUserHomeDir,
    expoPort,
    skipExpoWait,
  });
  return {
    invocation: resolveTauriPaneInvocation({ rootDir, env: tauriEnv }),
    env: tauriEnv,
  };
}

function resolveTauriPaneExpoWaitTimeoutMs(env = process.env) {
  const raw = String(
    env?.HAPPIER_STACK_TUI_TAURI_EXPO_WAIT_TIMEOUT_MS
      ?? env?.HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS
      ?? ''
  ).trim();
  if (!raw) {
    return null;
  }
  const timeoutMs = Number(raw);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null;
}

function resolveTauriPaneExpoWaitIntervalMs(env = process.env) {
  const raw = String(
    env?.HAPPIER_STACK_TUI_TAURI_EXPO_WAIT_INTERVAL_MS
      ?? env?.HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS
      ?? ''
  ).trim();
  const intervalMs = Number(raw);
  return Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 500;
}

export function resolveRuntimeExpoPort(runtimeState) {
  const expo = runtimeState && typeof runtimeState === 'object' ? runtimeState.expo : null;
  const port = Number(expo?.port ?? expo?.webPort ?? expo?.mobilePort);
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
}

export async function waitForTauriPaneExpoReady(
  {
    stackName,
    env = process.env,
    runtimeStatePath = '',
    timeoutMs = null,
    intervalMs = null,
    isCancelled = () => false,
  } = {},
  {
    readRuntimeStateImpl = readStackRuntimeStateFile,
    looksLikeExpoMetroImpl = looksLikeExpoMetro,
    delayImpl = delay,
    nowMsImpl = () => Date.now(),
  } = {},
) {
  const resolvedStackName = String(stackName ?? env?.HAPPIER_STACK_STACK ?? '').trim();
  const resolvedRuntimeStatePath =
    String(runtimeStatePath ?? '').trim()
    || (resolvedStackName ? join(resolveStackEnvPath(resolvedStackName, env).baseDir, 'stack.runtime.json') : '');
  if (!resolvedRuntimeStatePath) {
    return { ok: false, reason: 'missing_runtime_state', port: null };
  }

  const resolvedTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : resolveTauriPaneExpoWaitTimeoutMs(env);
  const resolvedIntervalMs =
    Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
      ? Number(intervalMs)
      : resolveTauriPaneExpoWaitIntervalMs(env);

  const startMs = nowMsImpl();
  let runtimeStateProbes = 0;
  let metroProbes = 0;
  const hasTimeout = Number.isFinite(resolvedTimeoutMs) && resolvedTimeoutMs > 0;

  while (!hasTimeout || nowMsImpl() - startMs <= resolvedTimeoutMs) {
    if (isCancelled()) {
      return { ok: false, reason: 'cancelled', port: null, runtimeStateProbes, metroProbes };
    }

    // eslint-disable-next-line no-await-in-loop
    const runtimeState = await readRuntimeStateImpl(resolvedRuntimeStatePath);
    runtimeStateProbes += 1;
    const port = resolveRuntimeExpoPort(runtimeState);
    if (Number.isFinite(port) && port > 0) {
      // eslint-disable-next-line no-await-in-loop
      const metroReady = await looksLikeExpoMetroImpl({ port });
      metroProbes += 1;
      if (metroReady) {
        return { ok: true, reason: 'ready', port, runtimeStateProbes, metroProbes };
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await delayImpl(resolvedIntervalMs);
  }

  return { ok: false, reason: 'timeout', port: null, runtimeStateProbes, metroProbes };
}
