import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import {
  ensureExpoIsolationEnv,
  getExpoStatePaths,
  isStateProcessRunning,
  wantsExpoClearCache,
  writePidState,
} from '../expo/expo.mjs';
import { pickExpoDevMetroPort } from '../expo/metro_ports.mjs';
import { recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { expoSpawn } from '../expo/command.mjs';
import { resolveMobileExpoConfig } from '../mobile/config.mjs';
import { resolveMobileReachableServerUrl } from '../server/mobile_api_url.mjs';
import { getTailscaleStatus } from '../tailscale/ip.mjs';
import { pickLanIpv4 } from '../net/lan_ip.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function normalizeExpoHost(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'localhost' || v === 'lan' || v === 'tunnel') return v;
  return 'lan';
}

/**
 * Resolve whether Tailscale forwarding for Expo is enabled.
 *
 * Can be enabled via:
 * - --expo-tailscale flag (passed as expoTailscale option)
 * - HAPPIER_STACK_EXPO_TAILSCALE=1 env var
 */
export function resolveExpoTailscaleEnabled({ env = process.env, expoTailscale = false } = {}) {
  if (expoTailscale) return true;
  const envVal = (env.HAPPIER_STACK_EXPO_TAILSCALE ?? '').toString().trim();
  return envVal === '1' || envVal.toLowerCase() === 'true';
}

/**
 * Start a TCP forwarder process for Expo Tailscale access.
 *
 * Forwards from Tailscale IP:port to the LAN IP:port where Expo actually binds.
 *
 * @param {Object} options
 * @param {number} options.metroPort - The Metro bundler port
 * @param {Object} options.baseEnv - Base environment variables
 * @param {string} options.stackName - Stack name for logging
 * @param {Array} options.children - Array to track child processes
 * @returns {Promise<{ ok: boolean, pid?: number, tailscaleIp?: string, lanIp?: string, error?: string }>}
 */
export async function startExpoTailscaleForwarder({ metroPort, baseEnv, stackName, children }) {
  const ts = await getTailscaleStatus();
  if (!ts.available || !ts.ip) {
    // Common case: Tailscale app installed but toggle is off / not connected.
    // This must never fail stack startup; just skip with a clear message.
    return { ok: false, error: ts.error || 'Tailscale is not connected' };
  }
  const tailscaleIp = ts.ip;

  // Some platforms / Tailscale variants report an IP but do not allow binding to it (EADDRNOTAVAIL).
  // If we can't bind *at all*, don't spawn the forwarder process (it will just error noisily).
  const canBind = await new Promise((resolve) => {
    const srv = net.createServer();
    const done = (ok, err) => {
      try {
        srv.close(() => resolve({ ok, err }));
      } catch {
        resolve({ ok, err });
      }
    };
    srv.once('error', (err) => done(false, err));
    srv.listen(0, tailscaleIp, () => done(true, null));
  });
  if (!canBind.ok) {
    const code = canBind.err && typeof canBind.err === 'object' ? canBind.err.code : '';
    const msg = canBind.err instanceof Error ? canBind.err.message : String(canBind.err ?? '');
    const hint =
      code === 'EADDRNOTAVAIL'
        ? `Tailscale IP ${tailscaleIp} is not bindable on this machine (EADDRNOTAVAIL).`
        : `Tailscale IP ${tailscaleIp} is not bindable (${code || 'error'}).`;
    return { ok: false, error: `${hint}${msg ? ` ${msg}` : ''}`.trim() };
  }

  // Determine where Expo binds (LAN IP when host=lan, localhost otherwise)
  const host = resolveExpoDevHost({ env: baseEnv });
  let targetHost = '127.0.0.1';
  if (host === 'lan') {
    const lanIp = pickLanIpv4();
    if (lanIp) targetHost = lanIp;
  }

  const label = `expo-ts-fwd${stackName ? `-${stackName}` : ''}`;
  const forwarderScript = join(__dirname, '..', 'net', 'tcp_forward.mjs');

  // Fork the forwarder as a child process
  // Note: fork() requires 'ipc' in stdio array
  const forwarderProc = fork(forwarderScript, [
    `--listen-host=${tailscaleIp}`,
    `--listen-port=${metroPort}`,
    `--target-host=${targetHost}`,
    `--target-port=${metroPort}`,
    `--label=${label}`,
  ], {
    env: { ...baseEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
  });

  // Prefix forwarder output
  const outPrefix = `[${label}] `;
  forwarderProc.stdout?.on('data', (d) => process.stdout.write(outPrefix + d.toString()));
  forwarderProc.stderr?.on('data', (d) => process.stderr.write(outPrefix + d.toString()));

  // Wait until the forwarder actually starts listening (or fails) before declaring success.
  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'forwarder startup timed out' }), 2000);
    const done = (res) => {
      clearTimeout(t);
      resolve(res);
    };
    forwarderProc.once('message', (m) => {
      if (m && typeof m === 'object' && m.type === 'ready') {
        done({ ok: true });
      } else if (m && typeof m === 'object' && m.type === 'error') {
        done({ ok: false, error: m.message ? String(m.message) : 'failed to start' });
      }
    });
    forwarderProc.once('exit', (code, sig) => {
      done({ ok: false, error: `exited (code=${code}, sig=${sig})` });
    });
    forwarderProc.once('error', (e) => {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });

  if (!ready.ok) {
    try {
      forwarderProc.kill('SIGKILL');
    } catch {
      // ignore
    }
    return { ok: false, error: ready.error || 'failed to start forwarder' };
  }

  children.push(forwarderProc);

  // eslint-disable-next-line no-console
  console.log(`[local] expo: Tailscale forwarder started (${tailscaleIp}:${metroPort} -> ${targetHost}:${metroPort})`);

  return {
    ok: true,
    pid: forwarderProc.pid,
    tailscaleIp,
    lanIp: targetHost,
    proc: forwarderProc,
  };
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
      })
    : apiServerUrl;
  env.EXPO_PUBLIC_HAPPY_SERVER_URL = effectiveApiServerUrl;
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
  await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir: paths.tmpDir });

  const running = await isStateProcessRunning(paths.statePath);
  const alreadyRunning = Boolean(running.running);

  // Resolve Tailscale forwarding preference
  const wantTailscale = resolveExpoTailscaleEnabled({ env: baseEnv, expoTailscale });

  // Always publish runtime metadata when we can.
  const publishRuntime = async ({ pid, port, tailscaleForwarderPid = null, tailscaleIp = null }) => {
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
        tailscaleEnabled: wantTailscale,
        tailscaleIp: tailscaleIp ?? null,
      },
    }).catch(() => {});
  };

  if (alreadyRunning && !restart) {
    const pid = Number(running.state?.pid);
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

    await publishRuntime({ pid, port });
    return {
      ok: true,
      skipped: true,
      reason: 'already_running',
      pid: Number.isFinite(pid) ? pid : null,
      port: Number.isFinite(port) ? port : null,
      mode: expoModeLabel({ wantWeb, wantDevClient }),
    };
  }

  const metroPort = await pickExpoDevMetroPort({ env: baseEnv, stackMode, stackName });
  env.RCT_METRO_PORT = String(metroPort);
  const host = resolveExpoDevHost({ env });
  const args = buildExpoStartArgs({
    port: metroPort,
    host,
    wantWeb,
    wantDevClient,
    scheme,
    clearCache: wantsExpoClearCache({ env: baseEnv || process.env }),
  });

  if (restart && running.state?.pid) {
    const prevPid = Number(running.state.pid);
    const res = await killProcessGroupOwnedByStack(prevPid, { stackName, envPath, label: 'expo', json: true });
    if (!res.killed) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] expo: not stopping existing Expo pid=${prevPid} because it does not look stack-owned.\n` +
          `[local] expo: continuing by starting a new Expo process on a free port.`
      );
    }
  }

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] expo: starting Expo (${expoModeLabel({ wantWeb, wantDevClient })}, metro port=${metroPort}, host=${host})`);
  }
  // Run the Expo CLI from the runner dir (where deps/bins live), but target the actual Expo project dir.
  const proc = await expoSpawn({ label: 'expo', dir: uiDir, projectDir, args, env, options: spawnOptions, quiet });
  children.push(proc);

  // Start Tailscale forwarder if enabled
  let tailscaleResult = null;
  if (wantTailscale) {
    tailscaleResult = await startExpoTailscaleForwarder({
      metroPort,
      baseEnv,
      stackName,
      children,
    });
    if (!tailscaleResult.ok && !quiet) {
      // eslint-disable-next-line no-console
      console.warn(`[local] expo: Tailscale forwarder not started: ${tailscaleResult.error}`);
    }
  }

  await publishRuntime({
    pid: proc.pid,
    port: metroPort,
    tailscaleForwarderPid: tailscaleResult?.pid ?? null,
    tailscaleIp: tailscaleResult?.tailscaleIp ?? null,
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
      scheme: wantDevClient ? scheme : null,
      tailscaleEnabled: wantTailscale,
      tailscaleForwarderPid: tailscaleResult?.pid ?? null,
      tailscaleIp: tailscaleResult?.tailscaleIp ?? null,
    });
  } catch {
    // ignore
  }

  return {
    ok: true,
    skipped: false,
    pid: proc.pid,
    port: metroPort,
    proc,
    mode: expoModeLabel({ wantWeb, wantDevClient }),
    tailscale: tailscaleResult ?? null,
  };
}
