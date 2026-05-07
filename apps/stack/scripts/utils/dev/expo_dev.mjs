import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  ensureExpoIsolationEnv,
  getExpoStatePaths,
  isStateProcessRunning,
  resolveExpoTmpDir,
  wantsExpoClearCache,
  writePidState,
} from '../expo/expo.mjs';
import { pickExpoDevMetroPort } from '../expo/metro_ports.mjs';
import { ensureEnvFileUpdated } from '../env/env_file.mjs';
import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { getProcessGroupId, getPsEnvLine, killProcessGroupOwnedByStack, listPidsWithEnvNeedle } from '../proc/ownership.mjs';
import { terminateProcessGroup } from '../proc/terminate.mjs';
import { expoSpawn } from '../expo/command.mjs';
import { run } from '../proc/proc.mjs';
import { resolveMobileExpoConfig } from '../mobile/config.mjs';
import { resolveMobileReachableServerUrl } from '../server/mobile_api_url.mjs';
import { getTailscaleStatus } from '../tailscale/ip.mjs';
import { isTcpPortFree } from '../net/ports.mjs';
import { resolveExpoTailscaleEnabled, startExpoTailscaleForwarder } from './expo_dev_tailscale.mjs';
import {
  computeExpoRestartDelayMs,
  createExpoCrashOutputTracker,
  describeExpoTermination,
  isIntentionalExpoTermination,
  resolveExpoRestartPolicy,
} from './expo_dev_supervision.mjs';

export { resolveExpoTailscaleEnabled, startExpoTailscaleForwarder } from './expo_dev_tailscale.mjs';

function createTrackedExpoProcHandle() {
  const handle = new EventEmitter();
  let currentProc = null;
  let exitCode = null;
  let signalCode = null;
  let pendingRestartTimer = null;
  let stopRequested = false;
  let exitEmitted = false;

  Object.defineProperties(handle, {
    pid: {
      enumerable: true,
      get() {
        return currentProc?.pid ?? null;
      },
    },
    exitCode: {
      enumerable: true,
      get() {
        return currentProc?.exitCode ?? exitCode;
      },
    },
    signalCode: {
      enumerable: true,
      get() {
        return currentProc?.signalCode ?? signalCode;
      },
    },
  });

  handle.setCurrentProc = (proc) => {
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
      pendingRestartTimer = null;
    }
    currentProc = proc ?? null;
    exitCode = null;
    signalCode = null;
    stopRequested = false;
    exitEmitted = false;
  };

  handle.clearCurrentProc = (proc) => {
    if (currentProc !== proc) {
      return false;
    }
    currentProc = null;
    return true;
  };

  handle.finalizeExit = ({ code = null, signal = null } = {}) => {
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
      pendingRestartTimer = null;
    }
    currentProc = null;
    exitCode = typeof code === 'number' ? code : null;
    signalCode = signal ?? null;
    if (exitEmitted) {
      return;
    }
    exitEmitted = true;
    handle.emit('exit', exitCode, signalCode);
  };

  handle.hasPendingRestart = () => Boolean(pendingRestartTimer);

  handle.requestStop = ({ signal = null } = {}) => {
    stopRequested = true;
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
      pendingRestartTimer = null;
    }
    if (!currentProc) {
      handle.finalizeExit({ code: null, signal });
    }
  };

  handle.shouldSuppressRestart = () => stopRequested;

  handle.setPendingRestartTimer = (timer) => {
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
    }
    pendingRestartTimer = timer ?? null;
  };

  handle.kill = (signal) => {
    handle.requestStop({ signal });
    currentProc?.kill?.(signal);
  };

  return handle;
}

function normalizeExpoHost(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'localhost' || v === 'lan' || v === 'tunnel') return v;
  return 'lan';
}

async function ensureWorkspacePackagesBuiltForExpoProject({ projectDir, env, quiet }) {
  const scriptPath = join(projectDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs');
  if (!existsSync(scriptPath)) {
    return;
  }
  await run(process.execPath, [scriptPath], {
    cwd: projectDir,
    env,
    stdio: quiet ? 'ignore' : 'inherit',
    timeoutMs: 10 * 60_000,
  });
}

export function resolveExpoDevHost({ env = process.env } = {}) {
  // Always prefer LAN by default so phones can reach Metro.
  const raw = (env.HAPPIER_STACK_EXPO_HOST ?? '').toString();
  return normalizeExpoHost(raw || 'lan');
}

export function buildExpoStartArgs({ port, host, wantWeb, wantDevClient, scheme, clearCache }) {
  const metroPort = Number(port);
  if (!Number.isFinite(metroPort) || metroPort <= 0) {
    throw new Error(`[expo] invalid Metro port: ${String(port)}`);
  }
  if (!wantWeb && !wantDevClient) {
    throw new Error('[expo] cannot build Expo args: neither web nor dev-client requested');
  }

  // IMPORTANT:
  // - We must only run one Expo per stack.
  // - Expo dev-client mode is known to still serve web when accessed locally, so when mobile is
  //   requested we prefer `--dev-client` as the single shared process (no second `--web` process).
  const args = wantDevClient
    ? ['start', '--dev-client', '--host', host, '--port', String(metroPort)]
    : ['start', '--web', '--host', host, '--port', String(metroPort)];

  if (wantDevClient) {
    const s = String(scheme ?? '').trim();
    if (s) {
      args.push('--scheme', s);
    }
  }

  if (clearCache && !args.includes('--clear')) {
    args.push('--clear');
  }

  return args;
}

function expoModeLabel({ wantWeb, wantDevClient }) {
  if (wantWeb && wantDevClient) return 'dev-client+web';
  if (wantDevClient) return 'dev-client';
  if (wantWeb) return 'web';
  return 'disabled';
}

function normalizeApiServerUrl(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

export function buildExpoDevEnv({
  baseEnv,
  apiServerUrl,
  wantDevClient,
  wantWeb,
  stackMode,
  stackName,
  expoTailscaleIp = '',
} = {}) {
  const env = { ...(baseEnv || process.env) };
  delete env.CI;

  // Expo app config: this is what both web + native app use to reach the Happy server.
  // When dev-client is enabled, `localhost` / `*.localhost` are not reachable from the phone,
  // so rewrite to LAN IP here (centralized) to avoid relying on call sites.
  const serverPortFromEnvRaw = (env.HAPPIER_STACK_SERVER_PORT ?? '').toString().trim();
  const serverPortFromEnv = serverPortFromEnvRaw ? Number(serverPortFromEnvRaw) : null;
  const effectiveApiServerUrl = wantDevClient
    ? resolveMobileReachableServerUrl({
        env,
        serverUrl: apiServerUrl,
        serverPort: Number.isFinite(serverPortFromEnv) ? serverPortFromEnv : null,
        preferredHost: expoTailscaleIp,
      })
    : apiServerUrl;

  // The UI prefers EXPO_PUBLIC_HAPPIER_SERVER_URL. Keep legacy aliases in sync to avoid
  // accidental precedence from a leaked shell env var (or from older tooling).
  env.EXPO_PUBLIC_HAPPIER_SERVER_URL = effectiveApiServerUrl;
  env.EXPO_PUBLIC_HAPPY_SERVER_URL = effectiveApiServerUrl;
  env.EXPO_PUBLIC_SERVER_URL = effectiveApiServerUrl;
  if (stackMode) {
    env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
  }
  env.EXPO_PUBLIC_DEBUG = env.EXPO_PUBLIC_DEBUG ?? '1';

  // Optional: allow per-stack storage isolation inside a single dev-client build by
  // scoping app persistence (MMKV / SecureStore) to a stack-specific namespace.
  //
  // This stays upstream-safe because the app behavior is unchanged unless the Expo public
  // env var is explicitly set. hstack sets it automatically for stack-mode dev-client.
  if (wantDevClient) {
    const explicitScope = (
      env.HAPPIER_STACK_STORAGE_SCOPE ??
      env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ??
      ''
    )
      .toString()
      .trim();
    const defaultScope = stackMode && stackName ? String(stackName).trim() : '';
    const scope = explicitScope || defaultScope;
    if (scope && !env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE) {
      env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
    }
  }

  // We own the browser opening behavior in hstack so we can reliably open the correct origin.
  env.EXPO_NO_BROWSER = '1';
  env.BROWSER = 'none';

  return env;
}

export async function ensureDevExpoServer({
  startUi,
  startMobile,
  uiDir,
  expoProjectDir = '',
  autostart,
  baseEnv,
  apiServerUrl,
  restart,
  stackMode,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  spawnOptions = {},
  expoTailscale = false,
  quiet = false,
} = {}) {
  const wantWeb = Boolean(startUi);
  const wantDevClient = Boolean(startMobile);
  if (!wantWeb && !wantDevClient) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  const wantTailscale = resolveExpoTailscaleEnabled({ env: baseEnv, expoTailscale });
  const tailscaleStatus = wantTailscale ? await getTailscaleStatus({ env: baseEnv }) : null;
  const expoTailscaleIp = tailscaleStatus?.available && tailscaleStatus?.ip ? tailscaleStatus.ip : '';

  const env = buildExpoDevEnv({
    baseEnv,
    apiServerUrl,
    wantDevClient,
    wantWeb,
    stackMode,
    stackName,
    expoTailscaleIp,
  });

  // Mobile config is needed for `--scheme` and for the app's environment.
  let scheme = '';
  if (wantDevClient) {
    const cfg = resolveMobileExpoConfig({ env });
    env.APP_ENV = cfg.appEnv;
    scheme = cfg.scheme;
  }

  const projectDir = String(expoProjectDir ?? '').trim() || uiDir;

  const paths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'expo-dev',
    projectDir,
    stateFileName: 'expo.state.json',
  });
  const tmpDir = resolveExpoTmpDir({ env, defaultTmpDir: paths.tmpDir, kind: 'expo-dev', projectDir });
  await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir });

  const running = await isStateProcessRunning(paths.statePath);
  const alreadyRunning = Boolean(running.running);
  let desiredApiServerUrl = normalizeApiServerUrl(env.EXPO_PUBLIC_HAPPIER_SERVER_URL || apiServerUrl);
  const cliHomeDir = (baseEnv?.HAPPIER_STACK_CLI_HOME_DIR ?? '').toString().trim();
  const stablePortMode =
    stackMode &&
    ((baseEnv?.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY ?? 'ephemeral').toString().trim() || 'ephemeral') === 'stable';

  // Always publish runtime metadata when we can.
  const publishRuntime = async ({ pid, port, tailscaleForwarderPid = null, tailscaleIp = null, tailscaleEnabled = false }) => {
    if (!stackMode || !runtimeStatePath) return;
    const nPid = Number(pid);
    const nPort = Number(port);
    const nTsPid = Number(tailscaleForwarderPid);
    await recordStackRuntimeUpdate(runtimeStatePath, {
      processes: {
        expoPid: Number.isFinite(nPid) && nPid > 1 ? nPid : null,
        expoTailscaleForwarderPid: Number.isFinite(nTsPid) && nTsPid > 1 ? nTsPid : null,
      },
      expo: {
        port: Number.isFinite(nPort) && nPort > 0 ? nPort : null,
        // For now keep these populated for callers that still expect webPort/mobilePort.
        webPort: wantWeb && Number.isFinite(nPort) && nPort > 0 ? nPort : null,
        mobilePort: wantDevClient && Number.isFinite(nPort) && nPort > 0 ? nPort : null,
        webEnabled: wantWeb,
        devClientEnabled: wantDevClient,
        host: resolveExpoDevHost({ env }),
        scheme: wantDevClient ? scheme : null,
        tailscaleEnabled: Boolean(tailscaleEnabled),
        tailscaleIp: tailscaleIp ?? null,
      },
    }).catch(() => {});
  };

  const runningStateApiServerUrl = normalizeApiServerUrl(running.state?.apiServerUrl);
  const shouldRestartForApiServerMismatch =
    alreadyRunning &&
    !restart &&
    stackMode &&
    wantWeb &&
    desiredApiServerUrl &&
    runningStateApiServerUrl !== desiredApiServerUrl;
  // In stack mode, never adopt "running by port probe only" state. It may belong to a
  // different stack/session and has no reliable owned pid for lifecycle control.
  const shouldRestartForPortFallbackInStackMode =
    alreadyRunning &&
    !restart &&
    stackMode &&
    running.reason === 'port';
  const shouldRestartForTailscaleMismatch =
    alreadyRunning &&
    !restart &&
    wantTailscale &&
    Boolean(expoTailscaleIp) &&
    !Boolean(running.state?.tailscaleEnabled);

  if (
    alreadyRunning &&
    !restart &&
    !shouldRestartForApiServerMismatch &&
    !shouldRestartForPortFallbackInStackMode &&
    !shouldRestartForTailscaleMismatch
  ) {
    const statePid = Number(running.state?.pid);
    const pid = Number.isFinite(statePid) && statePid > 1 && isPidAlive(statePid) ? statePid : null;
    const port = Number(running.state?.port);

    // Capability check: refuse to spawn a second Expo, so if the existing process doesn't match the
    // requested capabilities we fail closed and instruct a restart with the superset.
    const stateWeb = Boolean(running.state?.webEnabled);
    const stateDevClient = Boolean(running.state?.devClientEnabled);
    const stateHasCaps = 'webEnabled' in (running.state ?? {}) || 'devClientEnabled' in (running.state ?? {});
    const missingWeb = wantWeb && stateHasCaps && !stateWeb;
    const missingDevClient = wantDevClient && stateHasCaps && !stateDevClient;
    if (missingWeb || missingDevClient) {
      throw new Error(
        `[expo] Expo already running for stack=${stackName}, but it does not match the requested mode.\n` +
          `- running: ${expoModeLabel({ wantWeb: stateWeb, wantDevClient: stateDevClient })}\n` +
          `- wanted:  ${expoModeLabel({ wantWeb, wantDevClient })}\n` +
          `Fix: re-run with --restart (and include --mobile if you need dev-client).`
      );
    }

    await publishRuntime({
      pid,
      port,
      tailscaleEnabled: Boolean(running.state?.tailscaleEnabled),
      tailscaleForwarderPid: running.state?.tailscaleForwarderPid ?? null,
      tailscaleIp: running.state?.tailscaleIp ?? null,
    });
    return {
      ok: true,
      skipped: true,
      reason: 'already_running',
      pid: Number.isFinite(pid) && pid > 1 ? pid : null,
      port: Number.isFinite(port) ? port : null,
      mode: expoModeLabel({ wantWeb, wantDevClient }),
    };
  }

  if (shouldRestartForApiServerMismatch && !quiet) {
    // eslint-disable-next-line no-console
    console.log(
      `[local] expo: restarting to align API server URL (running=${runningStateApiServerUrl || 'unset'}, wanted=${desiredApiServerUrl}).`
    );
  }
  if (shouldRestartForTailscaleMismatch && !quiet) {
    // eslint-disable-next-line no-console
    console.log('[local] expo: restarting to enable Tailscale dev-client URLs.');
  }

  const reservedMetroPorts = new Set();

  if (restart && running.state?.pid) {
    const prevPid = Number(running.state.pid);
    const prevPort = Number(running.state?.port);
    const prevPidAlive = Number.isFinite(prevPid) && prevPid > 1 && isPidAlive(prevPid);
    if (prevPidAlive) {
      const res = await killProcessGroupOwnedByStack(prevPid, { stackName, envPath, cliHomeDir, label: 'expo', json: true });
      if (!res.killed) {
        const portInUse =
          Number.isFinite(prevPort) && prevPort > 0 ? !(await isTcpPortFree(prevPort, { host: '127.0.0.1' })) : false;
        // eslint-disable-next-line no-console
        console.warn(
          `[local] expo: not stopping existing Expo pid=${prevPid} because it does not look stack-owned.\n` +
            `[local] expo: continuing by starting a new Expo process on a free port.`
        );
        if (portInUse && !stablePortMode) {
          reservedMetroPorts.add(prevPort);
        }
      }
    }
  }

  const forcedPortRaw = (baseEnv?.HAPPIER_STACK_EXPO_DEV_PORT ?? '').toString().trim();
  const forcedPortNum = Number(forcedPortRaw);
  const hasForcedPort = forcedPortRaw && Number.isFinite(forcedPortNum) && forcedPortNum > 0;

  if (stablePortMode && hasForcedPort) {
    if (reservedMetroPorts.has(forcedPortNum)) {
      throw new Error(
        `[expo] stable expo port ${forcedPortNum} is reserved due to an existing process; refusing to bump the expo port.`
      );
    }
    let free = await isTcpPortFree(forcedPortNum, { host: '127.0.0.1' });
    if (!free) {
      const needle = `__UNSAFE_EXPO_HOME_DIRECTORY=${paths.expoHomeDir}`;
      const candidates = await listPidsWithEnvNeedle(needle);
      const selfPgid = await getProcessGroupId(process.pid);
      for (const pid of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const line = await getPsEnvLine(pid);
        if (!line) continue;
        if (stackName && !line.includes(`HAPPIER_STACK_STACK=${stackName}`)) continue;
        // eslint-disable-next-line no-await-in-loop
        const pgid = await getProcessGroupId(pid);
        if (!pgid) continue;
        if (selfPgid && pgid === selfPgid) continue;
        // eslint-disable-next-line no-await-in-loop
        await terminateProcessGroup(pgid, { graceMs: 800, signal: 'SIGTERM' }).catch(() => {});
      }
      free = await isTcpPortFree(forcedPortNum, { host: '127.0.0.1' });
    }
    if (!free) {
      throw new Error(
        `[expo] stable expo port ${forcedPortNum} is already in use; refusing to bump the expo port. ` +
          `Stop the process using it or run with --restart after ensuring the previous stack process is stopped.`
      );
    }
  }

  const metroPort = stablePortMode && hasForcedPort
    ? forcedPortNum
    : await pickExpoDevMetroPort({
        env: baseEnv,
        stackMode,
        stackName,
        reservedPorts: reservedMetroPorts,
      });

  if (stackMode && envPath && hasForcedPort && forcedPortNum !== metroPort) {
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] expo: requested metro port ${forcedPortNum} is not available; using ${metroPort}.\n` +
          `[local] expo: updating ${envPath} so future runs keep stable ports.`
      );
    }
    await ensureEnvFileUpdated({
      envPath,
      updates: [{ key: 'HAPPIER_STACK_EXPO_DEV_PORT', value: String(metroPort) }],
    }).catch(() => {});
  }
  env.RCT_METRO_PORT = String(metroPort);
  env.HAPPIER_STACK_EXPO_DEV_PORT = String(metroPort);
  const host = resolveExpoDevHost({ env });
  const args = buildExpoStartArgs({
    port: metroPort,
    host,
    wantWeb,
    wantDevClient,
    scheme,
    clearCache: wantsExpoClearCache({ env: baseEnv || process.env }),
  });

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] expo: starting Expo (${expoModeLabel({ wantWeb, wantDevClient })}, metro port=${metroPort}, host=${host})`);
  }

  let tailscaleResult = null;
  if (wantTailscale) {
    tailscaleResult = await startExpoTailscaleForwarder({
      metroPort,
      baseEnv,
      stackName,
      children,
      tailscaleStatus,
      expoHost: host,
    });
    if (tailscaleResult.ok && tailscaleResult.proxyUrl) {
      env.EXPO_PACKAGER_PROXY_URL = tailscaleResult.proxyUrl;
      desiredApiServerUrl = normalizeApiServerUrl(env.EXPO_PUBLIC_HAPPIER_SERVER_URL || apiServerUrl);
    } else if (!tailscaleResult.ok && !quiet) {
      // eslint-disable-next-line no-console
      console.warn(`[local] expo: Tailscale forwarder not started: ${tailscaleResult.error}`);
    }
  }

  // Some auth flows historically passed `stdio: ['ignore','ignore','ignore']` which drops Expo output entirely.
  // For reliability, treat that as "use default pipes" so errors remain debuggable (and verbose can stream).
  const normalizedSpawnOptions = { ...(spawnOptions ?? {}) };
  const stdio = normalizedSpawnOptions.stdio;
  if (Array.isArray(stdio) && stdio[1] === 'ignore' && stdio[2] === 'ignore') {
    delete normalizedSpawnOptions.stdio;
  }
  const restartPolicy = resolveExpoRestartPolicy({ env, stackMode });
  const userOnLine = typeof normalizedSpawnOptions.onLine === 'function' ? normalizedSpawnOptions.onLine : null;
  delete normalizedSpawnOptions.onLine;
  const tailscaleEnabled = Boolean(tailscaleResult?.ok && tailscaleResult?.proxyUrl);

  const writeSupervisorLine = (line) => {
    if (quiet) return;
    process.stderr.write(`[expo] ${line}\n`);
  };

  const writeExpoState = async (proc) => {
    await publishRuntime({
      pid: proc.pid,
      port: metroPort,
      tailscaleForwarderPid: tailscaleResult?.pid ?? null,
      tailscaleIp: tailscaleResult?.tailscaleIp ?? null,
      tailscaleEnabled,
    });

    try {
      await writePidState(paths.statePath, {
        pid: proc.pid,
        port: metroPort,
        uiDir,
        projectDir,
        startedAt: new Date().toISOString(),
        webEnabled: wantWeb,
        devClientEnabled: wantDevClient,
        host,
        apiServerUrl: desiredApiServerUrl || null,
        scheme: wantDevClient ? scheme : null,
        tailscaleEnabled,
        tailscaleForwarderPid: tailscaleResult?.pid ?? null,
        tailscaleIp: tailscaleResult?.tailscaleIp ?? null,
      });
    } catch {
      // ignore
    }
  };

  const clearRuntimePidIfCurrent = async (pid) => {
    if (!stackMode || !runtimeStatePath) return;
    const runtimeState = await readStackRuntimeStateFile(runtimeStatePath).catch(() => null);
    if (!runtimeState) return;
    const currentPid = Number(runtimeState?.processes?.expoPid);
    if (!Number.isFinite(currentPid) || currentPid <= 1 || currentPid !== Number(pid)) {
      return;
    }
    await recordStackRuntimeUpdate(runtimeStatePath, {
      processes: {
        expoPid: null,
      },
    }).catch(() => {});
  };

  const trackedProc = createTrackedExpoProcHandle();

  const spawnTrackedExpo = async ({ restartAttempt = 0 } = {}) => {
    const outputTracker = createExpoCrashOutputTracker();
    const proc = await expoSpawn({
      label: 'expo',
      dir: uiDir,
      projectDir,
      args,
      env,
      options: {
        ...normalizedSpawnOptions,
        onLine: (event) => {
          outputTracker.observeLine(event);
          userOnLine?.(event);
        },
      },
      quiet,
    });
    children.push(proc);
    trackedProc.setCurrentProc(proc);
    await writeExpoState(proc);

    proc.once('exit', (code, signal) => {
      void (async () => {
        trackedProc.clearCurrentProc(proc);
        if (isIntentionalExpoTermination({ code, signal })) {
          trackedProc.finalizeExit({ code, signal });
          return;
        }
        await clearRuntimePidIfCurrent(proc.pid);
        if (!restartPolicy.enabled || restartPolicy.maxAttempts <= 0) {
          trackedProc.finalizeExit({ code, signal });
          return;
        }
        const nextAttempt = restartAttempt + 1;
        if (nextAttempt > restartPolicy.maxAttempts) {
          writeSupervisorLine(
            `Expo exited unexpectedly (${describeExpoTermination({ code, signal, outputTracker })}); restart suppressed after ${restartPolicy.maxAttempts} attempts.`
          );
          trackedProc.finalizeExit({ code, signal });
          return;
        }

        const delayMs = computeExpoRestartDelayMs({ attempt: nextAttempt, policy: restartPolicy });
        writeSupervisorLine(
          `Expo exited unexpectedly (${describeExpoTermination({ code, signal, outputTracker })}); restarting in ${Math.ceil(delayMs / 1000)}s (attempt ${nextAttempt}/${restartPolicy.maxAttempts}).`
        );
        const timer = setTimeout(() => {
          trackedProc.setPendingRestartTimer(null);
          if (trackedProc.shouldSuppressRestart()) {
            return;
          }
          void spawnTrackedExpo({ restartAttempt: nextAttempt }).catch((error) => {
            writeSupervisorLine(`Expo restart failed: ${error instanceof Error ? error.message : String(error)}`);
            trackedProc.finalizeExit({ code: null, signal: null });
          });
        }, delayMs);
        trackedProc.setPendingRestartTimer(timer);
        timer.unref?.();
      })();
    });

    return proc;
  };

  // Run the Expo CLI from the runner dir (where deps/bins live), but target the actual Expo project dir.
  await ensureWorkspacePackagesBuiltForExpoProject({ projectDir, env, quiet });
  const proc = await spawnTrackedExpo();

  return {
    ok: true,
    skipped: false,
    get pid() {
      return trackedProc.pid;
    },
    port: metroPort,
    proc: trackedProc,
    mode: expoModeLabel({ wantWeb, wantDevClient }),
    tailscale: tailscaleResult ?? null,
  };
}
