import { join } from 'node:path';

import { createStepPrinter } from '../cli/progress.mjs';
import { createFileLogForwarder } from '../cli/log_forwarder.mjs';
import { resolveStackEnvPath } from '../paths/paths.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { readEnvObjectFromFile } from '../env/read.mjs';
import { getWebappUrlEnvOverride, resolveServerUrls } from '../server/urls.mjs';
import { readLastLines } from '../fs/tail.mjs';
import { run } from '../proc/proc.mjs';

import {
  guidedStackAuthLoginNow,
  assertGuidedAuthWebappReadyOrThrow,
  resolveStackWebappTargetForAuth,
  resolveStackAuthCliExecutable,
} from './stack_guided_login.mjs';
import { checkDaemonState, startLocalDaemonWithAuth } from '../../daemon.mjs';
import { isTty } from '../cli/wizard.mjs';
import { resolveStackRuntimeLaunchContext } from '../../runtime/launch/resolveStackRuntimeLaunchContext.mjs';

function appendCauseText(baseMessage, cause) {
  const msg = String(baseMessage ?? '').trim();
  const c = String(cause ?? '').trim();
  if (!c) return msg;
  return `${msg}\n\n[auth] Cause: ${c}`;
}

async function readTextWithTimeout(path, { timeoutMs = 1200 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(path, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function formatPidStatus(label, pidRaw) {
  const pid = Number(pidRaw);
  if (!Number.isFinite(pid) || pid <= 1) return `[auth] ${label}: unavailable`;
  return `[auth] ${label}: ${pid} (${isPidAlive(pid) ? 'alive' : 'stale/dead'})`;
}

function formatLogPath(label, logPath) {
  const p = String(logPath ?? '').trim();
  return p ? `[auth] ${label}: ${p}` : `[auth] ${label}: unavailable`;
}

async function appendRuntimeHealthDiagnostics(message, stackName) {
  const name = String(stackName ?? '').trim() || 'main';
  const statePath = getStackRuntimeStatePath(name);

  const state = await readStackRuntimeStateFile(statePath).catch(() => null);
  if (!state || typeof state !== 'object') {
    return `${message}\n\n[auth] Stack runtime state unavailable: ${statePath}`;
  }

  const serverPort = Number(state?.ports?.server);
  let serverHealth = 'not configured';
  if (Number.isFinite(serverPort) && serverPort > 0) {
    const probe = await readTextWithTimeout(`http://127.0.0.1:${serverPort}/health`, { timeoutMs: 1200 });
    if (probe.ok) {
      serverHealth = `HTTP ${probe.status}`;
    } else if (probe.error) {
      serverHealth = probe.error;
    } else {
      serverHealth = `HTTP ${probe.status}`;
    }
  }

  const runtimeSummary = [
    `[auth] Stack runtime path: ${statePath}`,
    formatPidStatus('ownerPid', state?.ownerPid),
    formatPidStatus('serverPid', state?.processes?.serverPid),
    formatPidStatus('expoPid', state?.processes?.expoPid),
    formatPidStatus('expoTailscaleForwarderPid', state?.processes?.expoTailscaleForwarderPid),
    `[auth] server port: ${Number.isFinite(serverPort) && serverPort > 0 ? serverPort : 'unconfigured'}`,
    `[auth] server health: ${serverHealth}`,
    formatLogPath('runner log', state?.logs?.runner),
    formatLogPath('cli log', state?.logs?.cli),
  ].join('\n');

  return `${String(message ?? '').trim()}\n\n${runtimeSummary}`;
}

function resolveAuthUiStartTimeoutMs(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_AUTH_UI_START_TIMEOUT_MS ?? '').trim();
  const parsed = raw ? Number(raw) : NaN;
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
  return timeoutMs;
}

function resolveAuthExpoProgressIntervalMs(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_AUTH_EXPO_PROGRESS_INTERVAL_MS ?? '').trim();
  if (!raw) return 20_000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20_000;
  if (n <= 0) return 0;
  return n;
}

function resolveAuthExpoBundleReadyTimeoutMs(env = process.env) {
  const raw = String(env?.HAPPIER_STACK_AUTH_EXPO_BUNDLE_READY_TIMEOUT_MS ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

async function appendRunnerLogTailDiagnostics({ message, stackName, lines = 140 }) {
  const base = String(message ?? '').trim();
  const logPath = await resolveRunnerLogPathFromRuntime({ stackName, waitMs: 1000, pollMs: 100 }).catch(() => '');
  const withState = await appendRuntimeHealthDiagnostics(base, stackName).catch(() => base);
  if (!logPath) return withState;
  const tail = await readLastLines(logPath, lines).catch(() => null);
  if (!tail || !String(tail).trim()) {
    return `${withState}\n\n[auth] Stack runner log: ${logPath}`;
  }
  return `${withState}\n\n[auth] Stack runner log: ${logPath}\n\n[auth] Last runner log lines:\n${String(tail).trimEnd()}`;
}

async function tryStartStackUiInBackgroundForAuth({ rootDir, stackName, env = process.env } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  try {
    const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({ argv: [], env });
    const useRuntimeStart = Boolean(runtimeLaunchContext.snapshot);
    const command = useRuntimeStart ? 'start' : 'dev';
    await run(
      process.execPath,
      [
        join(rootDir, 'scripts', 'stack.mjs'),
        command,
        name,
        '--background',
        ...(useRuntimeStart ? ['--runtime'] : []),
        '--no-daemon',
        '--no-browser',
      ],
      {
        cwd: rootDir,
        timeoutMs: resolveAuthUiStartTimeoutMs(env),
        env: {
          ...process.env,
          ...(env ?? {}),
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          ...(useRuntimeStart ? {} : { HAPPIER_STACK_AUTH_FLOW: '1' }),
        },
      }
    );
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function resolveRunnerLogPathFromRuntime({ stackName, waitMs = 10_000, pollMs = 200 } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const runtimeStatePath = getStackRuntimeStatePath(name);
  const deadline = Date.now() + (Number.isFinite(Number(waitMs)) ? Number(waitMs) : 10_000);

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const st = await readStackRuntimeStateFile(runtimeStatePath);
    // Returning '' here is intentional: log forwarding is optional best-effort telemetry.
    // Callers must treat this as "no runner log available", not as a hard failure.
    const ownerPid = Number(st?.ownerPid);
    if (Number.isFinite(ownerPid) && ownerPid > 1 && !isPidAlive(ownerPid)) return '';
    const logPath = String(st?.logs?.runner ?? '').trim();
    if (logPath) return logPath;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return '';
}

export async function prepareGuidedLoginWebapp({ rootDir, stackName, env, steps } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const label = 'prepare login (waiting for web UI)';
  const printer = steps && typeof steps.start === 'function' && typeof steps.stop === 'function' ? steps : null;

  if (printer) printer.start(label);
  const progressIntervalMs = resolveAuthExpoProgressIntervalMs(env ?? process.env);
  const progressEnabled = Boolean(isTty() && progressIntervalMs > 0);
  const startedAt = Date.now();
  let stopProgress = null;
  if (progressEnabled) {
    let stopped = false;
    let printedLogHint = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({ argv: [], env });
        const waitingForRuntimeUi = Boolean(runtimeLaunchContext.snapshot);
        const st = await readStackRuntimeStateFile(getStackRuntimeStatePath(name)).catch(() => null);
        const ownerPid = Number(st?.ownerPid);
        const ownerAlive = Number.isFinite(ownerPid) && ownerPid > 1 ? isPidAlive(ownerPid) : null;
        const expoPid = Number(st?.processes?.expoPid);
        const expoAlive = Number.isFinite(expoPid) && expoPid > 1 ? isPidAlive(expoPid) : null;
        const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        const stateText =
          waitingForRuntimeUi
            ? 'Stack UI is still starting; waiting for the runtime-backed web UI...'
            : expoAlive === true
            ? 'Expo dev server is running; waiting for the first web build to finish...'
            : 'Stack UI is still starting; waiting for Expo dev server...';
        // eslint-disable-next-line no-console
        console.error(`[auth] ${name}: ${stateText} (${elapsedSec}s elapsed; this can take several minutes on first run)`);

        const logPath = String(st?.logs?.runner ?? '').trim();
        if (!printedLogHint && logPath) {
          printedLogHint = true;
          // eslint-disable-next-line no-console
          console.error(`[auth] ${name}: tip: tail runner log for details: ${logPath}`);
        }
        if (ownerAlive === false) {
          // eslint-disable-next-line no-console
          console.error(`[auth] ${name}: note: stack runtime owner pid looks stale; continuing to wait...`);
        }
      } catch {
        // ignore
      } finally {
        if (!stopped) {
          setTimeout(tick, progressIntervalMs).unref?.();
        }
      }
    };
    setTimeout(tick, progressIntervalMs).unref?.();
    stopProgress = () => {
      stopped = true;
    };
  }
  try {
    const resolveAndAssert = async () => {
      const target = await resolveStackWebappTargetForAuth({ rootDir, stackName: name, env });
      await assertGuidedAuthWebappReadyOrThrow({
        rootDir,
        stackName: name,
        webappUrl: target.webappUrl,
        kind: target.kind,
        timeoutMs: resolveAuthExpoBundleReadyTimeoutMs(env ?? process.env),
      });
      return target;
    };

    try {
      const webappTarget = await resolveAndAssert();
      if (printer) printer.stop('✓', label);
      return webappTarget;
    } catch (initialErr) {
      const recovery = await tryStartStackUiInBackgroundForAuth({
        rootDir,
        stackName: name,
        env,
      });
      if (recovery.ok) {
        try {
          const webappTarget = await resolveAndAssert();
          if (printer) printer.stop('✓', label);
          return webappTarget;
        } catch (retryErr) {
          const enriched = await appendRunnerLogTailDiagnostics({
            stackName: name,
            message: appendCauseText(
              '[auth] attempted to start stack UI in background, but guided login web UI is still not ready.',
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            ),
          });
          throw new Error(enriched);
        }
      }
      const enriched = await appendRunnerLogTailDiagnostics({
        stackName: name,
        message: appendCauseText(
          '[auth] attempted to start stack UI in background, but startup failed.',
          recovery.error || (initialErr instanceof Error ? initialErr.message : String(initialErr))
        ),
      });
      throw new Error(enriched);
    }
  } catch (e) {
    if (printer) printer.stop('x', label);
    throw e;
  } finally {
    try {
      stopProgress?.();
    } catch {
      // ignore
    }
  }
}

export async function runGuidedLogin({ rootDir, stackName, env, webappUrl, forwarder } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const target =
    webappUrl && typeof webappUrl === 'object'
      ? webappUrl
      : { webappUrl: String(webappUrl ?? '').trim(), kind: 'server' };
  const url = String(target.webappUrl ?? '').trim();
  if (!url) {
    throw new Error('[auth] guided login requires a webappUrl');
  }

  try {
    forwarder?.pause?.();
  } catch {
    // ignore
  }
  try {
    await guidedStackAuthLoginNow({
      rootDir,
      stackName: name,
      env: { ...(env ?? process.env), HAPPIER_STACK_AUTH_SKIP_BUNDLE_CHECK: '1' },
      webappUrl: url,
      webappKind: target.kind,
    });
  } finally {
    try {
      forwarder?.resume?.();
    } catch {
      // ignore
    }
  }
}

export async function resolveServerPortForPostAuthDaemonStart({ stackName, env = process.env } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const runtimeStatePath = getStackRuntimeStatePath(name);
  const st = await readStackRuntimeStateFile(runtimeStatePath);
  const runtimePort = Number(st?.ports?.server);
  const ownerPid = Number(st?.ownerPid);
  const runtimeOwnerAlive = !Number.isFinite(ownerPid) || ownerPid <= 1 || isPidAlive(ownerPid);
  if (runtimeOwnerAlive && Number.isFinite(runtimePort) && runtimePort > 0) {
    return runtimePort;
  }

  const envPort = Number((env?.HAPPIER_STACK_SERVER_PORT ?? '').toString().trim());
  if (Number.isFinite(envPort) && envPort > 0) {
    return envPort;
  }

  throw new Error('[auth] post-auth daemon start failed: could not resolve server port from stack.runtime.json');
}

export async function startDaemonPostAuth({
  rootDir,
  stackName,
  env = process.env,
  forceRestart = true,
  webappUrl = '',
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const serverPort = await resolveServerPortForPostAuthDaemonStart({ stackName: name, env });

  const { envPath, baseDir } = resolveStackEnvPath(name, env);
  const stackEnv = await readEnvObjectFromFile(envPath);
  const mergedEnv = { ...process.env, ...(stackEnv ?? {}), ...(env ?? {}) };

  const cliHomeDir =
    (mergedEnv.HAPPIER_STACK_CLI_HOME_DIR ?? '').toString().trim() ||
    join(baseDir, 'cli');
  const cliBin = await resolveStackAuthCliExecutable({ rootDir, env: mergedEnv });

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const explicitWebappUrl = String(webappUrl ?? '').trim();
  const { publicServerUrl: resolvedPublicServerUrl } = await resolveServerUrls({
    env: mergedEnv,
    serverPort,
    allowEnable: false,
  });
  const { envWebappUrl } = getWebappUrlEnvOverride({ env: mergedEnv, stackName: name });
  const publicServerUrl = explicitWebappUrl || envWebappUrl || resolvedPublicServerUrl;

  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: Boolean(forceRestart),
    env: mergedEnv,
    stackName: name,
  });

  // Verify (best-effort): daemon wrote state.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const s = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: mergedEnv });
    if (s.status === 'running') {
      return {
        ok: true,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        pid: s.pid,
      };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    ok: false,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    pid: null,
    error: '[auth] post-auth daemon start verification timed out (daemon did not report running)',
  };
}

export async function runOrchestratedGuidedAuthFlow({
  rootDir,
  stackName,
  env = process.env,
  verbosity = 0,
  json = false,
  webappUrl = '',
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';

  const steps = createStepPrinter({ enabled: Boolean(process.stdout.isTTY && !json) });

  let forwarder = null;
  if (!json && verbosity > 0) {
    try {
      const logPath = await resolveRunnerLogPathFromRuntime({ stackName: name, waitMs: 10_000 });
      if (logPath) {
        forwarder = createFileLogForwarder({
          path: logPath,
          enabled: true,
          label: 'stack',
          startFromEnd: false,
        });
        await forwarder.start();
      }
    } catch {
      forwarder = null;
    }
  }

  let resolved = String(webappUrl ?? '').trim() ? { webappUrl: String(webappUrl).trim(), kind: 'server' } : null;
  try {
    if (!resolved) {
      resolved = await prepareGuidedLoginWebapp({ rootDir, stackName: name, env, steps });
    }
    await runGuidedLogin({ rootDir, stackName: name, env, webappUrl: resolved, forwarder });
  } finally {
    try {
      await forwarder?.stop?.();
    } catch {
      // ignore
    }
  }

  return { ok: true, webappUrl: resolved?.webappUrl ?? '', webappKind: resolved?.kind ?? 'server' };
}
