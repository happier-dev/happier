import { join } from 'node:path';

import { createStepPrinter } from '../cli/progress.mjs';
import { createFileLogForwarder } from '../cli/log_forwarder.mjs';
import { getComponentDir, resolveStackEnvPath } from '../paths/paths.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { readEnvObjectFromFile } from '../env/read.mjs';
import { getWebappUrlEnvOverride, resolveServerUrls } from '../server/urls.mjs';
import { readLastLines } from '../fs/tail.mjs';
import { run } from '../proc/proc.mjs';

import { guidedStackAuthLoginNow, assertExpoWebappBundlesOrThrow, resolveStackWebappUrlForAuth } from './stack_guided_login.mjs';
import { checkDaemonState, startLocalDaemonWithAuth } from '../../daemon.mjs';

function appendCauseText(baseMessage, cause) {
  const msg = String(baseMessage ?? '').trim();
  const c = String(cause ?? '').trim();
  if (!c) return msg;
  return `${msg}\n\n[auth] Cause: ${c}`;
}

async function appendRunnerLogTailDiagnostics({ message, stackName, lines = 140 }) {
  const base = String(message ?? '').trim();
  const logPath = await resolveRunnerLogPathFromRuntime({ stackName, waitMs: 1000, pollMs: 100 }).catch(() => '');
  if (!logPath) return base;
  const tail = await readLastLines(logPath, lines).catch(() => null);
  if (!tail || !String(tail).trim()) {
    return `${base}\n\n[auth] Stack runner log: ${logPath}`;
  }
  return `${base}\n\n[auth] Stack runner log: ${logPath}\n\n[auth] Last runner log lines:\n${String(tail).trimEnd()}`;
}

async function tryStartStackUiInBackgroundForAuth({ rootDir, stackName, env = process.env } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  try {
    await run(
      process.execPath,
      [join(rootDir, 'scripts', 'stack.mjs'), 'dev', name, '--background', '--no-daemon', '--no-browser'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          ...(env ?? {}),
          HAPPIER_STACK_AUTH_FLOW: '1',
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
  try {
    const resolveAndAssert = async () => {
      const webappUrl = await resolveStackWebappUrlForAuth({ rootDir, stackName: name, env });
      await assertExpoWebappBundlesOrThrow({ rootDir, stackName: name, webappUrl });
      return webappUrl;
    };

    try {
      const webappUrl = await resolveAndAssert();
      if (printer) printer.stop('✓', label);
      return webappUrl;
    } catch (initialErr) {
      const recovery = await tryStartStackUiInBackgroundForAuth({
        rootDir,
        stackName: name,
        env,
      });
      if (recovery.ok) {
        try {
          const webappUrl = await resolveAndAssert();
          if (printer) printer.stop('✓', label);
          return webappUrl;
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
  }
}

export async function runGuidedLogin({ rootDir, stackName, env, webappUrl, forwarder } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const url = String(webappUrl ?? '').trim();
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
  const cliDir = getComponentDir(rootDir, 'happier-cli', mergedEnv);
  const cliBin = join(cliDir, 'bin', 'happier.mjs');

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

  let resolved = String(webappUrl ?? '').trim();
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

  return { ok: true, webappUrl: resolved };
}
