import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  ensureExpoIsolationEnv,
  commitExpoPidStatePublication,
  getExpoStatePaths,
  isStateProcessRunning,
  readPidState,
  resolveExpoTmpDir,
  restoreExpoPidStatePublication,
  wantsExpoClearCache,
  waitForExpoMetroRunning,
} from '../expo/expo.mjs';
import { selectExpoDevMetroPort } from '../expo/metro_ports.mjs';
import { compareAndSetEnvFileValue } from '../env/env_file.mjs';
import {
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeExpoPublication,
  recordStackRuntimeUpdate,
  restoreStackRuntimeExpoPublication,
} from '../stack/runtime_state.mjs';
import { getProcessGroupId, getPsEnvLine, killProcessGroupOwnedByStack, listPidsWithEnvNeedle } from '../proc/ownership.mjs';
import { terminateProcessGroup } from '../proc/terminate.mjs';
import { expoSpawn } from '../expo/command.mjs';
import { killProcessTree, run } from '../proc/proc.mjs';
import { resolveMobileExpoConfig } from '../mobile/config.mjs';
import { resolveMobileReachableServerUrl } from '../server/mobile_api_url.mjs';
import { getTailscaleStatus } from '../tailscale/ip.mjs';
import { resolveExpoTailscaleEnabled, startExpoTailscaleForwarder } from './expo_dev_tailscale.mjs';
import {
  computeExpoRestartDelayMs,
  createExpoCrashOutputTracker,
  describeExpoTermination,
  isIntentionalExpoTermination,
  resolveNextExpoRestartAttempt,
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
  let generation = 0;
  let lifecycleTail = Promise.resolve();
  let completionSettled = false;
  let resolveCompletion;
  handle.completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  handle.withLifecycleLock = async (fn) => {
    const previous = lifecycleTail;
    let release;
    lifecycleTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

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

  handle.setCurrentProc = (proc) => handle.withLifecycleLock(() => {
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
      pendingRestartTimer = null;
    }
    currentProc = proc ?? null;
    generation += 1;
    exitCode = null;
    signalCode = null;
    stopRequested = false;
    exitEmitted = false;
    return handle.snapshot();
  });

  handle.snapshot = () => ({ generation, proc: currentProc, pid: currentProc?.pid ?? null });
  handle.matches = ({ generation: expectedGeneration, currentProc: expectedProc } = {}) =>
    generation === expectedGeneration && currentProc === expectedProc;

  handle.clearCurrentProc = (proc) => handle.withLifecycleLock(() => {
    if (currentProc !== proc) {
      return false;
    }
    currentProc = null;
    return true;
  });

  handle.finalizeExit = async ({ code = null, signal = null, expectedGeneration = null, completion = null } = {}) => {
    const completionOutcome = completion
      ? await completion.catch((error) => ({ code: null, signal: null, error }))
      : { code: typeof code === 'number' ? code : null, signal: signal ?? null };
    return await handle.withLifecycleLock(() => {
      if (expectedGeneration != null && generation !== expectedGeneration) return false;
      if (pendingRestartTimer) {
        clearTimeout(pendingRestartTimer);
        pendingRestartTimer = null;
      }
      currentProc = null;
      exitCode = typeof code === 'number' ? code : null;
      signalCode = signal ?? null;
      if (exitEmitted) {
        return false;
      }
      exitEmitted = true;
      if (!completionSettled) {
        completionSettled = true;
        resolveCompletion(completionOutcome);
      }
      handle.emit('exit', exitCode, signalCode);
      return true;
    });
  };

  handle.hasPendingRestart = () => Boolean(pendingRestartTimer);

  handle.requestStop = ({ signal = null } = {}) => {
    stopRequested = true;
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
      pendingRestartTimer = null;
    }
    if (!currentProc) {
      void handle.finalizeExit({ code: null, signal });
    }
  };

  handle.shouldSuppressRestart = () => stopRequested;

  handle.setPendingRestartTimer = (timer) => {
    if (pendingRestartTimer) {
      clearTimeout(pendingRestartTimer);
    }
    pendingRestartTimer = timer ?? null;
  };

  handle.kill = async (signal) => {
    handle.requestStop({ signal });
    return await killProcessTree(currentProc, signal);
  };

  return handle;
}

export async function stopExpoProcessTree(proc, {
  graceMs = 2000,
  ownedListenerPids = [],
  platform = process.platform,
  killProcessTreeImpl = killProcessTree,
  killPidImpl = (pid, signal) => process.kill(pid, signal),
  isPidAliveImpl = isPidAlive,
} = {}) {
  if (!proc) return;
  const listenerPids = Array.from(new Set(ownedListenerPids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 1)));
  if (platform === 'win32') {
    for (const pid of listenerPids) {
      try { killPidImpl(pid, 'SIGTERM'); } catch {}
    }
  }
  await killProcessTreeImpl(proc, 'SIGTERM', { graceMs });
  const groupAlive = () => {
    if (platform === 'win32' || !proc.pid) return proc.exitCode === null && proc.signalCode === null;
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + graceMs;
  while (groupAlive() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const exited = !groupAlive();
  if (!exited) {
    await killProcessTreeImpl(proc, 'SIGKILL');
    const killDeadline = Date.now() + 500;
    while (groupAlive() && Date.now() < killDeadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (platform === 'win32') {
    const listenerDeadline = Date.now() + graceMs;
    while (listenerPids.some((pid) => isPidAliveImpl(pid)) && Date.now() < listenerDeadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const pid of listenerPids) {
      if (!isPidAliveImpl(pid)) continue;
      try { killPidImpl(pid, 'SIGKILL'); } catch {}
    }
    const hardDeadline = Date.now() + 500;
    while (listenerPids.some((pid) => isPidAliveImpl(pid)) && Date.now() < hardDeadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const survivors = listenerPids.filter((pid) => isPidAliveImpl(pid));
    if (survivors.length) {
      const error = new Error(`[expo] failed to terminate certified listener pids: ${survivors.join(', ')}`);
      error.code = 'EEXPOCLEANUP';
      throw error;
    }
  }
  if (!proc.__happierClosed) {
    const closed = await Promise.race([
      once(proc, 'close').then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!closed) {
      proc.stdout?.destroy?.();
      proc.stderr?.destroy?.();
      await killProcessTreeImpl(proc, 'SIGKILL');
      const hardClosed = await Promise.race([
        once(proc, 'close').then(() => true).catch(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (!hardClosed && !proc.__happierClosed) {
        const error = new Error('[expo] spawned process stdio did not close after hard cleanup');
        error.code = 'EEXPOCLEANUP';
        throw error;
      }
    }
  }
}

function throwPublicationFailure(originalError, settledResults) {
  const secondaryErrors = settledResults
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (!secondaryErrors.length) throw originalError;
  const aggregate = new AggregateError(
    [originalError, ...secondaryErrors],
    originalError instanceof Error ? originalError.message : String(originalError),
    { cause: originalError },
  );
  if (originalError && typeof originalError === 'object' && 'code' in originalError) {
    aggregate.code = originalError.code;
  }
  throw aggregate;
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
  expoPublicHost = '',
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
  const publicExpoPort = Number(env.HAPPIER_STACK_EXPO_PUBLIC_PORT);
  if (
    wantDevClient
    && !String(env.EXPO_PACKAGER_PROXY_URL ?? '').trim()
    && Number.isInteger(publicExpoPort)
    && publicExpoPort > 0
  ) {
    const localPublicUrl = `http://localhost:${publicExpoPort}`;
    const reachablePublicUrl = resolveMobileReachableServerUrl({
      env,
      serverUrl: localPublicUrl,
      preferredHost: expoPublicHost,
    });
    if (reachablePublicUrl && reachablePublicUrl !== localPublicUrl) {
      env.EXPO_PACKAGER_PROXY_URL = reachablePublicUrl;
    }
  }
  if (stackMode) {
    env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
  }
  env.EXPO_PUBLIC_DEBUG = env.EXPO_PUBLIC_DEBUG ?? '1';
  env.EXPO_UNSTABLE_WEB_MODAL = '1';

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
  publicationBarrier = null,
  getProcessIdentityLine = getPsEnvLine,
  getProcessGroupIdForCleanup = getProcessGroupId,
  killOwnedProcessGroup = killProcessGroupOwnedByStack,
  readStateProcessIdentityLine = null,
  stopTailscaleProcessTree = stopExpoProcessTree,
} = {}) {
  const wantWeb = Boolean(startUi);
  const wantDevClient = Boolean(startMobile);
  if (!wantWeb && !wantDevClient) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  const wantTailscale = resolveExpoTailscaleEnabled({ env: baseEnv, expoTailscale });
  const publicExpoPort = Number(baseEnv?.HAPPIER_STACK_EXPO_PUBLIC_PORT);
  const needsPublicExpoHost = wantDevClient && Number.isInteger(publicExpoPort) && publicExpoPort > 0;
  const tailscaleStatus = wantTailscale || needsPublicExpoHost
    ? await getTailscaleStatus({ env: baseEnv })
    : null;
  const expoTailscaleIp = tailscaleStatus?.available && tailscaleStatus?.ip ? tailscaleStatus.ip : '';

  const env = buildExpoDevEnv({
    baseEnv,
    apiServerUrl,
    wantDevClient,
    wantWeb,
    stackMode,
    stackName,
    expoTailscaleIp,
    expoPublicHost: expoTailscaleIp,
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

  const running = await isStateProcessRunning(
    paths.statePath,
    readStateProcessIdentityLine
      ? { readProcessIdentityLineImpl: readStateProcessIdentityLine }
      : undefined,
  );
  const alreadyRunning = Boolean(running.running);
  let desiredApiServerUrl = normalizeApiServerUrl(env.EXPO_PUBLIC_HAPPIER_SERVER_URL || apiServerUrl);
  const cliHomeDir = (baseEnv?.HAPPIER_STACK_CLI_HOME_DIR ?? '').toString().trim();
  // Always publish runtime metadata when we can.
  const publishRuntime = async ({
    generation,
    publicationToken,
    expectedPreviousToken,
    pid,
    port,
    tailscaleForwarderPid = null,
    tailscaleIp = null,
    tailscaleEnabled = false,
  }) => {
    if (!stackMode || !runtimeStatePath) return;
    const nPid = Number(pid);
    const nPort = Number(port);
    const nTsPid = Number(tailscaleForwarderPid);
    await recordStackRuntimeExpoPublication(runtimeStatePath, {
      generation,
      publicationToken,
      expectedPreviousToken,
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
    });
  };

  const runningStateApiServerUrl = normalizeApiServerUrl(running.state?.apiServerUrl);
  const shouldRestartForApiServerMismatch =
    alreadyRunning &&
    !restart &&
    stackMode &&
    (wantWeb || wantDevClient) &&
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
  const shouldReplaceRunningExpo = Boolean(
    restart ||
    shouldRestartForApiServerMismatch ||
    shouldRestartForPortFallbackInStackMode ||
    shouldRestartForTailscaleMismatch
  );

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

    const currentRuntime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
    const currentPublicationToken = currentRuntime?.expo?.publicationToken ?? null;
    await publishRuntime({
      generation: Number(currentRuntime?.expo?.publicationGeneration ?? 1),
      publicationToken: currentPublicationToken ?? randomUUID(),
      expectedPreviousToken: currentPublicationToken,
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

  // Prepare runtime dependencies before stopping an existing healthy Metro. A failed
  // preparation must leave the currently published development runtime untouched.
  await ensureWorkspacePackagesBuiltForExpoProject({ projectDir, env, quiet });

  if (shouldReplaceRunningExpo && running.state?.pid) {
    const prevPid = Number(running.state.pid);
    const prevPidAlive = Number.isFinite(prevPid) && prevPid > 1 && isPidAlive(prevPid);
    if (prevPidAlive) {
      const res = await killOwnedProcessGroup(prevPid, { stackName, envPath, cliHomeDir, label: 'expo', json: true });
      if (!res.killed) {
        // eslint-disable-next-line no-console
        console.warn(
          `[local] expo: not stopping existing Expo pid=${prevPid} because it does not look stack-owned.\n` +
            `[local] expo: continuing by starting a new Expo process on a free port.`
        );
      }
    }
  }

  const host = resolveExpoDevHost({ env });
  const cleanupOwnedStablePort = async ({ observation } = {}) => {
      const needle = `__UNSAFE_EXPO_HOME_DIRECTORY=${paths.expoHomeDir}`;
      const listenerPids = Array.isArray(observation?.pids) ? observation.pids : [];
      const scannedPids = await listPidsWithEnvNeedle(needle);
      const candidates = Array.from(new Set([...listenerPids, ...scannedPids].map(Number).filter((pid) => pid > 1)));
      const selfPgid = await getProcessGroupIdForCleanup(process.pid);
      for (const pid of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const line = await getProcessIdentityLine(pid);
        if (!line?.includes(needle)) continue;
        if (stackName && !line.includes(`HAPPIER_STACK_STACK=${stackName}`)) continue;
        // eslint-disable-next-line no-await-in-loop
        const pgid = await getProcessGroupIdForCleanup(pid);
        if (!pgid) continue;
        if (selfPgid && pgid === selfPgid) continue;
        // eslint-disable-next-line no-await-in-loop
        await terminateProcessGroup(pgid, { graceMs: 3000, signal: 'SIGTERM' }).catch(() => {});
      }
  };

  const rejectedEphemeralPorts = new Set();
  let metroSelection = await selectExpoDevMetroPort({
    env: baseEnv,
    stackMode,
    stackName,
    reservedPorts: rejectedEphemeralPorts,
    onStableOccupied: cleanupOwnedStablePort,
  });
  let metroPort = metroSelection.port;

  const applyMetroPortToEnv = () => {
    env.RCT_METRO_PORT = String(metroPort);
    env.HAPPIER_STACK_EXPO_DEV_PORT = String(metroPort);
    if (wantTailscale && tailscaleStatus?.available && tailscaleStatus?.ip) {
      env.EXPO_PACKAGER_PROXY_URL = `http://${tailscaleStatus.ip}:${metroPort}`;
    }
  };
  applyMetroPortToEnv();
  const baseClearCache = wantsExpoClearCache({ env: baseEnv || process.env });
  const buildStartArgs = ({ forceClearCache = false } = {}) => buildExpoStartArgs({
    port: metroPort,
    host,
    wantWeb,
    wantDevClient,
    scheme,
    clearCache: baseClearCache || forceClearCache,
  });

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] expo: starting Expo (${expoModeLabel({ wantWeb, wantDevClient })}, metro port=${metroPort}, host=${host})`);
  }

  let tailscaleResult = null;
  if (wantTailscale && tailscaleStatus?.available && tailscaleStatus?.ip) {
    desiredApiServerUrl = normalizeApiServerUrl(env.EXPO_PUBLIC_HAPPIER_SERVER_URL || apiServerUrl);
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
  let tailscaleEnabled = false;

  const writeSupervisorLine = (line) => {
    if (quiet) return;
    process.stderr.write(`[expo] ${line}\n`);
  };

  const assertCurrentCertificate = (certificate) => {
    if (!certificate || certificate.controller !== trackedProc || !trackedProc.matches(certificate)) {
      const error = new Error('[expo] readiness certificate was superseded before publication');
      error.code = 'EEXPOREADINESSSUPERSEDED';
      throw error;
    }
    if (certificate.port !== metroPort || certificate.currentProc?.pid !== certificate.ownerPid) {
      const error = new Error('[expo] readiness certificate owner/port no longer matches the active command');
      error.code = 'EEXPOREADINESSSTALE';
      throw error;
    }
    if (certificate.currentProc.exitCode !== null || certificate.currentProc.signalCode !== null) {
      const error = new Error('[expo] certified process exited before publication committed');
      error.code = 'EEXPOREADINESSSTALE';
      throw error;
    }
  };

  const runPublicationBarrier = async (phase, certificate) => {
    if (typeof publicationBarrier !== 'function') return;
    await publicationBarrier({ phase, certificate });
    assertCurrentCertificate(certificate);
  };

  const writeExpoState = async (
    certificate,
    { expectedRuntimeToken = null, expectedPidToken = null } = {},
  ) => {
    assertCurrentCertificate(certificate);
    await runPublicationBarrier('runtime', certificate);
    const proc = certificate.currentProc;
    await publishRuntime({
      generation: certificate.generation,
      publicationToken: certificate.publicationToken,
      expectedPreviousToken: expectedRuntimeToken,
      pid: proc.pid,
      port: metroPort,
      tailscaleForwarderPid: tailscaleResult?.pid ?? null,
      tailscaleIp: tailscaleResult?.tailscaleIp ?? null,
      tailscaleEnabled,
    });
    assertCurrentCertificate(certificate);

    await runPublicationBarrier('pid', certificate);
    await commitExpoPidStatePublication(paths.statePath, {
      publicationToken: certificate.publicationToken,
      expectedPreviousToken: expectedPidToken,
      generation: certificate.generation,
      state: {
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
      },
    });
    assertCurrentCertificate(certificate);
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
  let startupCertified = false;

  const spawnTrackedExpo = async ({ restartAttempt = 0, forceClearCache = false } = {}) => {
    const outputTracker = createExpoCrashOutputTracker();
    const proc = await expoSpawn({
      label: 'expo',
      dir: uiDir,
      projectDir,
      args: buildStartArgs({ forceClearCache }),
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
    const trackedSnapshot = await trackedProc.setCurrentProc(proc);
    const trackedSpawn = { ...trackedSnapshot, currentProc: proc, certifiedAtMs: null };

    proc.once('exit', (code, signal) => {
      void (async () => {
        await trackedProc.clearCurrentProc(proc);
        const finalizeCurrentExit = () => trackedProc.finalizeExit({
          code,
          signal,
          expectedGeneration: trackedSnapshot.generation,
          completion: proc.completion,
        });
        if (isIntentionalExpoTermination({ code, signal })) {
          await finalizeCurrentExit();
          return;
        }
        await clearRuntimePidIfCurrent(proc.pid);
        if (!startupCertified) {
          await finalizeCurrentExit();
          return;
        }
        if (!restartPolicy.enabled || restartPolicy.maxAttempts <= 0) {
          await finalizeCurrentExit();
          return;
        }
        const nextAttempt = resolveNextExpoRestartAttempt({
          restartAttempt,
          certifiedAtMs: trackedSpawn.certifiedAtMs,
          exitedAtMs: Date.now(),
          policy: restartPolicy,
        });
        if (nextAttempt > restartPolicy.maxAttempts) {
          writeSupervisorLine(
            `Expo exited unexpectedly (${describeExpoTermination({ code, signal, outputTracker })}); restart suppressed after ${restartPolicy.maxAttempts} attempts.`
          );
          await finalizeCurrentExit();
          return;
        }

        const delayMs = computeExpoRestartDelayMs({ attempt: nextAttempt, policy: restartPolicy });
        const forceClearCacheOnRestart = outputTracker.sawHeapOutOfMemory?.() === true;
        writeSupervisorLine(
          `Expo exited unexpectedly (${describeExpoTermination({ code, signal, outputTracker })}); restarting in ${Math.ceil(delayMs / 1000)}s (attempt ${nextAttempt}/${restartPolicy.maxAttempts})${forceClearCacheOnRestart && !baseClearCache ? ' with cleared Metro cache' : ''}.`
        );
        const timer = setTimeout(() => {
          trackedProc.setPendingRestartTimer(null);
          if (trackedProc.shouldSuppressRestart()) {
            return;
          }
          void spawnTrackedExpo({ restartAttempt: nextAttempt, forceClearCache: forceClearCacheOnRestart }).then(async (restarted) => {
            try {
              const certificate = await certifyTrackedSpawn(restarted);
              await trackedProc.withLifecycleLock(async () => {
              const priorRuntime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath).catch(() => null) : null;
              const priorPidState = await readPidState(paths.statePath);
              try {
                await writeExpoState(certificate, {
                  expectedRuntimeToken: priorRuntime?.expo?.publicationToken ?? null,
                  expectedPidToken: priorPidState?.publicationToken ?? null,
                });
                assertCurrentCertificate(certificate);
              } catch (error) {
                const rollbackResults = await Promise.allSettled([
                  ...(runtimeStatePath ? [restoreStackRuntimeExpoPublication(runtimeStatePath, {
                    publicationToken: certificate.publicationToken,
                    priorExpo: priorRuntime?.expo ?? null,
                    priorProcesses: priorRuntime?.processes ?? null,
                  })] : []),
                  restoreExpoPidStatePublication(paths.statePath, {
                    publicationToken: certificate.publicationToken,
                    priorState: priorPidState,
                  }),
                ]);
                throwPublicationFailure(error, rollbackResults);
              }
              });
            } catch (error) {
              if (error && typeof error === 'object') error.expectedGeneration = restarted.generation;
              throw error;
            }
          }).catch(async (error) => {
            writeSupervisorLine(`Expo restart failed: ${error instanceof Error ? error.message : String(error)}`);
            await trackedProc.finalizeExit({
              code: null,
              signal: null,
              expectedGeneration: error?.expectedGeneration ?? null,
            });
          });
        }, delayMs);
        trackedProc.setPendingRestartTimer(timer);
        timer.unref?.();
      })();
    });

    return trackedSpawn;
  };

  const certifyTrackedSpawn = async (trackedSpawn) => {
    const ready = await waitForExpoMetroRunning({
      port: metroPort,
      ownerPid: trackedSpawn.pid,
      ownerProc: trackedSpawn.currentProc,
      env,
    });
    if (!ready.ok) {
      await stopExpoProcessTree(trackedSpawn.currentProc, { ownedListenerPids: ready.ownedListenerPids });
      const error = new Error(`[expo] owned Metro did not become ready on port ${metroPort}: ${ready.reason}`);
      error.code = 'EEXPOMETRONOTREADY';
      error.reason = ready.reason;
      throw error;
    }
    const certificate = Object.freeze({
      generation: trackedSpawn.generation,
      publicationToken: randomUUID(),
      controller: trackedProc,
      currentProc: trackedSpawn.currentProc,
      ownerPid: ready.ownerPid,
      listenerPid: ready.listenerPid,
      ownedListenerPids: ready.ownedListenerPids,
      port: ready.port,
    });
    assertCurrentCertificate(certificate);
    trackedSpawn.certifiedAtMs = Date.now();
    return certificate;
  };

  const stableStrategy = stackMode &&
    ((baseEnv?.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY ?? 'ephemeral').toString().trim() || 'ephemeral') === 'stable';
  const maxSpawnAttemptsRaw = Number(baseEnv?.HAPPIER_STACK_EXPO_EPHEMERAL_SPAWN_ATTEMPTS ?? 20);
  const maxSpawnAttempts = Number.isFinite(maxSpawnAttemptsRaw) && maxSpawnAttemptsRaw > 0
    ? Math.min(50, Math.floor(maxSpawnAttemptsRaw))
    : 20;
  const startupDeadline = Date.now() + 60_000;
  let certificate = null;
  let lastStartupError = null;
  for (let attempt = 1; attempt <= maxSpawnAttempts && Date.now() < startupDeadline; attempt += 1) {
    const trackedSpawn = await spawnTrackedExpo();
    try {
      certificate = await certifyTrackedSpawn(trackedSpawn);
      break;
    } catch (error) {
      lastStartupError = error;
      const retryable = !stableStrategy && [
        'listener_not_owned',
        'competing_listener',
        'listener_not_observed',
        'owner_process_exited',
        'owner_process_missing',
      ].includes(error?.reason);
      if (!retryable) throw error;
      rejectedEphemeralPorts.add(metroPort);
      if (attempt === 1) {
        const processOffset = 1 + (process.pid % 149);
        for (let port = 8081; port < 8081 + processOffset; port += 1) {
          rejectedEphemeralPorts.add(port);
        }
      } else {
        rejectedEphemeralPorts.add(metroPort + 1);
      }
      metroSelection = await selectExpoDevMetroPort({
        env: baseEnv,
        stackMode,
        stackName,
        reservedPorts: rejectedEphemeralPorts,
        onStableOccupied: cleanupOwnedStablePort,
      });
      metroPort = metroSelection.port;
      applyMetroPortToEnv();
    }
  }
  if (!certificate) {
    throw lastStartupError ?? new Error('[expo] unable to start owned Metro before the startup deadline');
  }
  startupCertified = true;
  try {
    await trackedProc.withLifecycleLock(async () => {
      assertCurrentCertificate(certificate);
      const priorRuntime = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath).catch(() => null) : null;
      const priorPidState = await readPidState(paths.statePath);
      const priorEnvRaw = envPath ? await readFile(envPath, 'utf-8').catch(() => null) : null;
      const priorPin = String(priorEnvRaw ?? '').split('\n').find((line) => line.trim().startsWith('HAPPIER_STACK_EXPO_DEV_PORT='));
      const priorPinValue = priorPin?.slice(priorPin.indexOf('=') + 1) ?? null;
      let envCommitted = false;
      try {
        if (stackMode && envPath && metroSelection.persistPin) {
          if (!quiet) {
            // eslint-disable-next-line no-console
            console.warn(`[local] expo: persisting first stable metro port ${metroPort} in ${envPath}.`);
          }
          await runPublicationBarrier('env', certificate);
          const committed = await compareAndSetEnvFileValue({
            envPath,
            key: 'HAPPIER_STACK_EXPO_DEV_PORT',
            expectedValue: priorPinValue,
            nextValue: String(metroPort),
          });
          if (!committed) {
            const publicationError = new Error('[expo] environment port publication was superseded');
            publicationError.code = 'EEXPOENVGENERATION';
            throw publicationError;
          }
          envCommitted = true;
          assertCurrentCertificate(certificate);
        }
        if (wantTailscale) {
          await runPublicationBarrier('tailscale', certificate);
          tailscaleResult = await startExpoTailscaleForwarder({
            metroPort,
            baseEnv,
            stackName,
            children,
            tailscaleStatus,
            expoHost: host,
          });
          tailscaleEnabled = Boolean(tailscaleResult.ok && tailscaleResult.proxyUrl);
          assertCurrentCertificate(certificate);
          if (!tailscaleResult.ok && !quiet) {
            // eslint-disable-next-line no-console
            console.warn(`[local] expo: Tailscale forwarder not started: ${tailscaleResult.error}`);
          }
        }
        await writeExpoState(certificate, {
          expectedRuntimeToken: priorRuntime?.expo?.publicationToken ?? null,
          expectedPidToken: priorPidState?.publicationToken ?? null,
        });
        assertCurrentCertificate(certificate);
      } catch (error) {
        const rollbackResults = await Promise.allSettled([
          ...(runtimeStatePath ? [restoreStackRuntimeExpoPublication(runtimeStatePath, {
            publicationToken: certificate.publicationToken,
            priorExpo: priorRuntime?.expo ?? null,
            priorProcesses: priorRuntime?.processes ?? null,
          })] : []),
          restoreExpoPidStatePublication(paths.statePath, {
            publicationToken: certificate.publicationToken,
            priorState: priorPidState,
          }),
          ...(envPath && envCommitted ? [compareAndSetEnvFileValue({
            envPath,
            key: 'HAPPIER_STACK_EXPO_DEV_PORT',
            expectedValue: String(metroPort),
            nextValue: priorPinValue,
          })] : []),
        ]);
        const cleanupResults = await Promise.allSettled([
          stopTailscaleProcessTree(tailscaleResult?.proc),
        ]);
        throwPublicationFailure(error, [...rollbackResults, ...cleanupResults]);
      }
    });
  } catch (error) {
    const activeProc = trackedProc.snapshot().proc;
    trackedProc.requestStop({ signal: 'SIGTERM' });
    const cleanupResults = await Promise.allSettled([
      stopExpoProcessTree(activeProc, { ownedListenerPids: certificate.ownedListenerPids }),
    ]);
    throwPublicationFailure(error, cleanupResults);
  }

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
