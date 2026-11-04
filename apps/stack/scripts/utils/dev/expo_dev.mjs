import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ensureExpoIsolationEnv,
  getExpoStatePaths,
  isStateProcessRunning,
  resolveExpoTmpDir,
  wantsExpoClearCache,
  writePidState,
  waitForExpoMetroRunning,
  resolveMetroWaitIntervalMsFromEnv,
} from '../expo/expo.mjs';
import { selectExpoDevMetroPort } from '../expo/metro_ports.mjs';
import { ensureEnvFileUpdated } from '../env/env_file.mjs';
import {
  getStackRuntimeProcessInstanceFingerprint,
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeUpdate,
} from '../stack/runtime_state.mjs';
import { killProcessGroupOwnedByStack, listPidsWithEnvNeedle } from '../proc/ownership.mjs';
import { isDependencyRefreshMutationActive, resolveDependencyInstallRoot, withDependencyConsumption } from '../proc/dependency_refresh.mjs';
import {
  ensureExpoWorkspacePrepared,
  expoSpawn,
  hasUsableExpoWorkspaceLastGreen,
  resolveExpoBin,
  withExpoPreparationEnv,
} from '../expo/command.mjs';
import { pathExists } from '../fs/fs.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { ensureDepsInstalled, prepareWorkspaceComponentStartup } from '../proc/pm.mjs';
import { resolveMobileExpoConfig } from '../mobile/config.mjs';
import { resolveMobileReachableServerUrl } from '../server/mobile_api_url.mjs';
import { getTailscaleStatus } from '../tailscale/ip.mjs';
import { isTcpPortFree } from '../net/ports.mjs';
import { resolveExpoTailscaleEnabled, startExpoTailscaleForwarder } from './expo_dev_tailscale.mjs';
import {
  computeExpoRestartDelayMs,
  createExpoCrashOutputTracker,
  describeExpoTermination,
  resolveExpoRestartPolicy,
  EXPO_HEAP_RECYCLE_PREFIX,
} from './expo_dev_supervision.mjs';

export { resolveExpoTailscaleEnabled, startExpoTailscaleForwarder } from './expo_dev_tailscale.mjs';

function normalizeExpoHost(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'localhost' || v === 'lan' || v === 'tunnel') return v;
  return 'lan';
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

export async function resolveMetroConfigFingerprint({ projectDir } = {}) {
  const configPath = join(String(projectDir ?? '').trim(), 'metro.config.js');
  try {
    const contents = await readFile(configPath);
    return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

export async function inspectExpoMetroConfigState({ projectDir, state } = {}) {
  const currentFingerprint = await resolveMetroConfigFingerprint({ projectDir });
  const recordedFingerprint = String(state?.metroConfigFingerprint ?? '').trim();
  return Object.freeze({
    current: recordedFingerprint === currentFingerprint,
    currentFingerprint,
    recordedFingerprint: recordedFingerprint || null,
  });
}

export function resolveExpoSpawnOptions({ autostartBaseDir, spawnOptions } = {}) {
  const options = { ...(spawnOptions ?? {}) };
  const baseDir = String(autostartBaseDir ?? '').trim();
  if (!String(options.teeFile ?? '').trim() && baseDir) {
    options.teeFile = join(baseDir, 'logs', 'expo.log');
  }
  if (!String(options.teeLabel ?? '').trim()) {
    options.teeLabel = 'expo';
  }
  return options;
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

  // Remote Dev Target workers have no display server. Expo uses this supported
  // headless mode to avoid starting its standalone React Native DevTools shell;
  // retain local Stack DevTools by using the remote command owner's exact marker.
  if (env.HAPPIER_DEV_TARGET_EXECUTION === '1') {
    env.EXPO_UNSTABLE_HEADLESS = '1';
  }

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
  env.EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED =
    env.EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED ?? '1';
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
  isShuttingDown = () => false,
  quiet = false,
  prepareExpoWorkspace = ensureExpoWorkspacePrepared,
  hasUsableWorkspaceLastGreen = hasUsableExpoWorkspaceLastGreen,
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
  env.HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS = '1';

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
  env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = join(paths.stateDir, 'plugin-ui', 'inventory.js');
  // Refresh may replace an owned incumbent. Prepare before observing its PID
  // and before acquiring spawn read custody, so both observations stay valid.
  await ensureDepsInstalled(uiDir, 'happier-ui', { env, quiet, waitForPendingStart: true });
  const running = await isStateProcessRunning(paths.statePath);
  const alreadyRunning = Boolean(running.running);
  let metroConfigInspection = null;
  try {
    metroConfigInspection = await inspectExpoMetroConfigState({ projectDir, state: running.state });
  } catch (error) {
    if (!quiet) {
      const detail = error instanceof Error ? error.message : String(error);
      // A config-inspection failure must not make the rest of the Stack unavailable.
      console.warn(`[local] expo: unable to inspect metro.config.js; preserving the current Expo lifecycle.\n${detail}`);
    }
  }

  const prepareWorkspace = async () => {
    await withExpoPreparationEnv(env, async (preparationEnv) => {
      await prepareExpoWorkspace({ projectDir, env: preparationEnv, quiet });
    });
  };
  const prepareWorkspaceForAvailability = async () => await prepareWorkspaceComponentStartup({
    readLastGreen: async () => alreadyRunning || await hasUsableWorkspaceLastGreen({ projectDir, env }) ? { lastGreen: true } : null,
    prepare: prepareWorkspace,
  });
  const restartPolicy = resolveExpoRestartPolicy({ env, stackMode });
  if (restartPolicy.enabled && restartPolicy.maxAttempts > 0) {
    env.HAPPIER_STACK_EXPO_HEAP_GUARD = '1';
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(new URL('./expo_heap_guard_preload.mjs', import.meta.url).href)}`.trim();
  }
  let preparationAttempt = 0;
  for (;; preparationAttempt++) {
    try {
      await prepareWorkspaceForAvailability();
      break;
    } catch (error) {
      const failure = error?.code === 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED' ? error.cause : error;
      // A dependency install can briefly unlink the compiler or an imported
      // package file. Cold preparation belongs to this same Expo lifecycle;
      // it must keep retrying while installed tooling is being repaired.
      const missingWorkspaceFile = ['ENOENT', 'ENOTDIR', 'ERR_MODULE_NOT_FOUND'].includes(failure?.code)
        && /(?:^|[\\/])node_modules[\\/]/.test(String(failure.path ?? failure.message ?? ''));
      if (!missingWorkspaceFile || !restartPolicy.enabled || restartPolicy.maxAttempts <= 0
        || isShuttingDown?.() === true) throw error;
      const nextAttempt = preparationAttempt + 1;
      const delayMs = computeExpoRestartDelayMs({ attempt: nextAttempt, policy: restartPolicy });
      if (!quiet) process.stderr.write(`[expo] Workspace preparation file is missing; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${nextAttempt}).\n`);
      await delay(delayMs);
      if (isShuttingDown?.() === true) throw error;
    }
  }

  // Acquire read custody before stopping an incumbent, and retain it until
  // the replacement is spawned and published. Preparation and failed-spawn
  // backoff stay outside custody so installers can repair missing tooling.
  const startUnderDependencyCustody = async (env, initialAttempt) => {
    if (isShuttingDown?.() === true) throw new DOMException('Expo startup cancelled', 'AbortError');
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
      (wantWeb || wantDevClient) &&
      desiredApiServerUrl &&
      runningStateApiServerUrl !== desiredApiServerUrl;
    const shouldRestartForMetroConfigMismatch =
      alreadyRunning &&
      !restart &&
      metroConfigInspection?.current === false;
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
    const tailscaleForwarderPid = Number(running.state?.tailscaleForwarderPid);
    const hasRecordedTailscaleForwarder =
      Number.isFinite(tailscaleForwarderPid) && tailscaleForwarderPid > 1;
    const shouldRestartForDeadTailscaleForwarder =
      alreadyRunning &&
      !restart &&
      wantTailscale &&
      Boolean(expoTailscaleIp) &&
      Boolean(running.state?.tailscaleEnabled) &&
      (!hasRecordedTailscaleForwarder || !isPidAlive(tailscaleForwarderPid));
    const shouldReplaceRunningExpo =
      restart ||
      shouldRestartForApiServerMismatch ||
      shouldRestartForMetroConfigMismatch ||
      shouldRestartForPortFallbackInStackMode ||
      shouldRestartForTailscaleMismatch ||
      shouldRestartForDeadTailscaleForwarder;

    if (
      alreadyRunning &&
      !shouldReplaceRunningExpo
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
    if (shouldRestartForMetroConfigMismatch && !quiet) {
      // eslint-disable-next-line no-console
      console.log('[local] expo: restarting because metro.config.js changed since the running process was started.');
    }
    if (shouldRestartForTailscaleMismatch && !quiet) {
      // eslint-disable-next-line no-console
      console.log('[local] expo: restarting to enable Tailscale dev-client URLs.');
    }
    if (shouldRestartForDeadTailscaleForwarder && !quiet) {
      // eslint-disable-next-line no-console
      console.log('[local] expo: restarting to recover the Tailscale forwarder.');
    }

    const reservedMetroPorts = new Set();
    const readRecordedExpoProcessInstanceFingerprint = async (pid) => {
      const normalizedPid = Number(pid);
      if (!Number.isFinite(normalizedPid) || normalizedPid <= 1) return null;
      if (Number(running.state?.pid) === normalizedPid) {
        const expoStateFingerprint = String(running.state?.processInstanceFingerprint ?? '').trim();
        if (expoStateFingerprint) return expoStateFingerprint;
      }
      if (!runtimeStatePath) return null;
      const runtimeState = await readStackRuntimeStateFile(runtimeStatePath).catch(() => null);
      return getStackRuntimeProcessInstanceFingerprint(runtimeState, 'expoPid', normalizedPid);
    };

    const expoBin = await resolveExpoBin(uiDir);
    if (!(await pathExists(expoBin))) {
      const error = new Error(`Expo executable is missing: ${expoBin}`);
      error.code = 'ENOENT';
      error.path = expoBin;
      throw error;
    }

    if (shouldReplaceRunningExpo && running.state?.pid) {
      const prevPid = Number(running.state.pid);
      const prevPort = Number(running.state?.port);
      const prevPidAlive = Number.isFinite(prevPid) && prevPid > 1 && isPidAlive(prevPid);
      if (prevPidAlive) {
        const res = await killProcessGroupOwnedByStack(prevPid, {
          stackName,
          envPath,
          cliHomeDir,
          label: 'expo',
          json: true,
          processInstanceFingerprint: await readRecordedExpoProcessInstanceFingerprint(prevPid),
        });
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

    const metroSelection = await selectExpoDevMetroPort({
      env: baseEnv,
      stackMode,
      stackName,
      reservedPorts: reservedMetroPorts,
      onStableOccupied: async ({ observation }) => {
        const needle = `__UNSAFE_EXPO_HOME_DIRECTORY=${paths.expoHomeDir}`;
        const candidates = await listPidsWithEnvNeedle(needle);
        const listenerPids = new Set((observation.pids ?? []).map(Number));
        for (const pid of candidates) {
          if (!listenerPids.has(Number(pid))) continue;
          // eslint-disable-next-line no-await-in-loop
          await killProcessGroupOwnedByStack(pid, {
            stackName,
            envPath,
            cliHomeDir,
            label: 'expo stable-port listener',
            json: true,
            signal: 'SIGTERM',
            graceMs: 800,
            processInstanceFingerprint: await readRecordedExpoProcessInstanceFingerprint(pid),
          });
        }
      },
    });
    const metroPort = metroSelection.port;

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
    const baseClearCache = wantsExpoClearCache({ env: baseEnv || process.env });
    const buildStartArgs = () => buildExpoStartArgs({
      port: metroPort,
      host,
      wantWeb,
      wantDevClient,
      scheme,
      clearCache: baseClearCache,
    });
    const args = buildStartArgs();

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
    const normalizedSpawnOptions = resolveExpoSpawnOptions({
      autostartBaseDir: autostart?.baseDir,
      spawnOptions,
    });
    if (normalizedSpawnOptions.teeFile) {
      await mkdir(dirname(normalizedSpawnOptions.teeFile), { recursive: true });
    }
    const stdio = normalizedSpawnOptions.stdio;
    if (Array.isArray(stdio) && stdio[1] === 'ignore' && stdio[2] === 'ignore') {
      delete normalizedSpawnOptions.stdio;
    }
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
        metroConfigFingerprint: metroConfigInspection?.currentFingerprint ?? null,
        pluginUiInventoryPath: env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY,
        scheme: wantDevClient ? scheme : null,
        tailscaleEnabled,
        tailscaleForwarderPid: tailscaleResult?.pid ?? null,
        tailscaleIp: tailscaleResult?.tailscaleIp ?? null,
        stackName,
        envPath,
        cliHomeDir,
      });
    };

    const clearRuntimeIfCurrent = async (pid) => {
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
          expoTailscaleForwarderPid: null,
        },
        expo: {
          port: null,
          webPort: null,
          mobilePort: null,
          tailscaleEnabled: false,
          tailscaleIp: null,
        },
      }).catch(() => {});
    };

    const requireSpawnedProcess = async (proc) => {
      const pid = Number(proc?.pid);
      if (Number.isFinite(pid) && pid > 1) {
        return proc;
      }
      const completion = await proc?.completion;
      throw completion?.error ?? new Error('Expo process failed to spawn without reporting an error.');
    };

    let closed = false;
    let restartTimer = null;
    const healthObservers = new Set();
    const stopping = () => closed || isShuttingDown?.() === true;
    const scheduleRestart = (restartAttempt) => {
      if (stopping()) return;
      const delayMs = computeExpoRestartDelayMs({ attempt: restartAttempt, policy: restartPolicy });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        runScheduledRestart({ restartAttempt });
      }, delayMs);
      restartTimer.unref?.();
    };

    function runScheduledRestart({ restartAttempt }) {
      if (stopping()) {
        return;
      }
      void spawnTrackedExpo({ restartAttempt }).catch((error) => {
        scheduleRetryAfterSpawnFailure({
          failedAttempt: restartAttempt,
          error,
        });
      });
    }

    function scheduleRetryAfterSpawnFailure({ failedAttempt, error }) {
      if (stopping()) {
        return;
      }
      const nextAttempt = failedAttempt + 1;
      const delayMs = computeExpoRestartDelayMs({ attempt: nextAttempt, policy: restartPolicy });
      writeSupervisorLine(
        `Expo restart failed (${error instanceof Error ? error.message : String(error)}); retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${nextAttempt}).`
      );
      scheduleRestart(nextAttempt);
    }

    const spawnTrackedExpo = async ({ restartAttempt = 0 } = {}) => {
      const outputTracker = createExpoCrashOutputTracker();
      let admissionPublished = false;
      let supervisedProc = null;
      let quietHeapRecycle = false;
      const attachSupervision = (proc) => {
        supervisedProc = proc;
        const runStartedAtMs = Date.now();
        const healthAbort = new AbortController();
        healthObservers.add(healthAbort);
        proc.once('exit', (code, signal) => {
          healthAbort.abort();
          healthObservers.delete(healthAbort);
          const runEndedAtMs = Date.now();
          // Capture before clearing runtime metadata: a quick repair may release
          // its lock during that asynchronous write. Windows tree termination
          // need not report a POSIX signal on the child-process exit event.
          // Before PID publication, this is still our own spawn admission lock;
          // an early child failure must consume the ordinary crash budget.
          const dependencyTransition = admissionPublished
            && isDependencyRefreshMutationActive({ installDir: resolveDependencyInstallRoot(uiDir), env });
          void (async () => {
            await clearRuntimeIfCurrent(proc.pid);
            if (stopping()) {
              return;
            }
            if (!restartPolicy.enabled || restartPolicy.maxAttempts <= 0) {
              return;
            }
            // A replacement that survives the same bounded stability window used by the session-runner
            // supervisor starts a fresh crash cycle. Rapid crash loops still consume one shared budget.
            const attemptBeforeExit =
              runEndedAtMs - runStartedAtMs >= restartPolicy.stabilityWindowMs
                ? 0
                : restartAttempt;
            // An installer-requested replacement is not a crash attempt. Its
            // startup still consumes the existing failure budget if admission
            // fails, and user shutdown remains authoritative above.
            const nextAttempt = dependencyTransition || quietHeapRecycle ? 0 : attemptBeforeExit + 1;
            const delayMs = computeExpoRestartDelayMs({ attempt: nextAttempt, policy: restartPolicy });
            writeSupervisorLine(
              quietHeapRecycle
                ? `Metro quiet heap recycle completed; restarting in ${Math.ceil(delayMs / 1000)}s.`
                : dependencyTransition
                ? `Expo stopped for dependency refresh; restarting after dependency admission in ${Math.ceil(delayMs / 1000)}s.`
                : `Expo exited unexpectedly (${describeExpoTermination({ code, signal, outputTracker })}); restarting in ${Math.ceil(delayMs / 1000)}s (attempt ${nextAttempt}).`
            );
            scheduleRestart(nextAttempt);
          })();
        });
        if (restartPolicy.enabled && restartPolicy.maxAttempts > 0) {
          void (async () => {
            while (!stopping() && !healthAbort.signal.aborted) {
              // Use Metro's existing readiness budget for startup and loss of
              // responsiveness. A bundle error is not a failed /status probe.
              const health = await waitForExpoMetroRunning({ port: metroPort, env,
                signal: healthAbort.signal, continueOnTimeout: false });
              if (stopping() || healthAbort.signal.aborted) return;
              if (!health.ok) {
                writeSupervisorLine(`Metro stopped answering (${health.reason}); replacing owned pid=${proc.pid}.`);
                await killProcessTree(proc, 'SIGTERM');
                return;
              }
              await delay(resolveMetroWaitIntervalMsFromEnv(env), undefined, { signal: healthAbort.signal, ref: false });
            }
          })().catch(error => {
            if (!healthAbort.signal.aborted) writeSupervisorLine(`Metro health observation failed: ${error.message}`);
          });
        }
      };
      const proc = await expoSpawn({
        label: 'expo',
        dir: uiDir,
        projectDir,
        args,
        env,
        workspacePrepared: true,
        onSpawned: async (proc, readiness) => {
          await requireSpawnedProcess(proc);
          attachSupervision(proc);
          children.push(proc);
          await writeExpoState(proc, readiness);
          admissionPublished = true;
        },
        options: {
          ...normalizedSpawnOptions,
          onLine: (event) => {
            outputTracker.observeLine(event);
            if (!quietHeapRecycle && supervisedProc && event.stream === 'stdout'
              && event.line.startsWith(EXPO_HEAP_RECYCLE_PREFIX) && !stopping()) {
              const state = JSON.parse(event.line.slice(EXPO_HEAP_RECYCLE_PREFIX.length));
              quietHeapRecycle = true;
              writeSupervisorLine(`Metro heap ${state.usedHeapBytes} bytes reached watermark ${state.thresholdBytes} of configured limit ${state.heapLimitBytes}; no in-flight HTTP requests, recycling owned pid=${supervisedProc.pid}.`);
              void killProcessTree(supervisedProc, 'SIGTERM').catch(error => writeSupervisorLine(`Metro heap recycle failed: ${error.message}`));
            }
            userOnLine?.(event);
          },
        },
        quiet,
      });
      await requireSpawnedProcess(proc);
      return proc;
    };

    // Run the Expo CLI from the runner dir (where deps/bins live), but target the actual Expo project dir.
    const proc = await spawnTrackedExpo({ restartAttempt: initialAttempt });

    return {
      ok: true,
      skipped: false,
      pid: proc.pid,
      port: metroPort,
      proc,
      mode: expoModeLabel({ wantWeb, wantDevClient }),
      tailscale: tailscaleResult ?? null,
      close: async () => {
        closed = true;
        clearTimeout(restartTimer);
        for (const observer of healthObservers) observer.abort();
        healthObservers.clear();
      },
    };
  };

  let initialAttempt = preparationAttempt;
  for (;;) {
    try {
      return await withDependencyConsumption({ installDir: resolveDependencyInstallRoot(uiDir), env },
        custodyEnv => startUnderDependencyCustody(custodyEnv, initialAttempt));
    } catch (error) {
      if (isShuttingDown?.() === true || !restartPolicy.enabled || restartPolicy.maxAttempts <= 0
        || !['ENOENT', 'ENOTDIR', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)) throw error;
      initialAttempt++;
      const delayMs = computeExpoRestartDelayMs({ attempt: initialAttempt, policy: restartPolicy });
      if (!quiet) process.stderr.write(`[expo] Initial Metro spawn failed (${error.message}); installed tooling can be repaired, retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${initialAttempt}).\n`);
      await delay(delayMs);
      if (isShuttingDown?.() === true) throw error;
    }
  }
}
