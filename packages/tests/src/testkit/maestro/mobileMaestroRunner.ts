import { join as joinPath, resolve as resolvePath } from 'node:path';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { createRunDirs } from '../runDir';
import { resolveExpoDevClientDeepLink } from '../mobile/expoDevClientDeepLink';
import { resolveTerminalConnectDeepLink } from '../mobile/terminalConnectDeepLink';
import { resolveDeviceVisibleBaseUrl } from '../mobile/resolveDeviceHost';
import { resolveMobileAppScheme } from '../mobile/mobileAppScheme';
import { resolveInstalledAndroidDevClientRuntimeVersion } from '../mobile/androidDevClientRuntimeVersion';
import { sleep } from '../timing';
import { parseMaestroArgs as defaultParseMaestroArgs } from '../../../scripts/runMaestroWithHeartbeat.shared.mjs';
import { defaultPrimePlatformAppLaunch } from './primePlatformAppLaunch';

export type StartedServerLike = Readonly<{
  baseUrl: string;
  port?: number;
  dataDir?: string;
  stop?: () => Promise<void>;
}>;

export type StartedDevClientMetroLike = Readonly<{
  baseUrl: string;
  port?: number;
  stdoutPath?: string;
  stop?: () => Promise<void>;
}>;

export type StartedCliTerminalConnectLike = Readonly<{
  connectUrl: string;
  waitForSuccess: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type StartedDaemonLike = Readonly<{
  stop: () => Promise<void>;
}>;

export type MobileMaestroRunResult = Readonly<{
  exitCode: number;
  runDir: string;
  manifestPath: string;
  debugOutputDir: string;
  server: StartedServerLike | null;
  metro: StartedDevClientMetroLike | null;
}>;

export type MobileMaestroDeps = Readonly<{
  startServerLight: (params: { testDir: string; extraEnv?: NodeJS.ProcessEnv }) => Promise<StartedServerLike>;
  startDevClientMetro: (params: {
    testDir: string;
    extraEnv?: NodeJS.ProcessEnv;
    port?: number;
    host?: string;
  }) => Promise<StartedDevClientMetroLike>;
  startCliTerminalConnect: (params: {
    testDir: string;
    cliHomeDir: string;
    serverUrl: string;
    webappUrl: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<StartedCliTerminalConnectLike>;
  startTestDaemon: (params: {
    testDir: string;
    happyHomeDir: string;
    env: NodeJS.ProcessEnv;
    startupTimeoutMs?: number;
  }) => Promise<StartedDaemonLike>;
  runMaestro: (params: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maestroBin: string;
    args: string[];
  }) => Promise<{ exitCode: number }>;
  isAppInstalled: (params: {
    env: NodeJS.ProcessEnv;
    platform: 'android' | 'ios';
    appId: string;
  }) => Promise<boolean>;
  adbReversePorts: (params: {
    env: NodeJS.ProcessEnv;
    platform: string;
    urls: string[];
  }) => Readonly<{ enabled: boolean; reversedPorts: number[] }>;
  primeAppLaunch: (params: {
    env: NodeJS.ProcessEnv;
    platform: 'android' | 'ios';
    appId: string;
  }) => Promise<void>;
  resolveAndroidDevClientRuntimeVersion: (params: {
    appId: string;
    env: NodeJS.ProcessEnv;
    outputDir: string;
  }) => string | null;
  resolveMaestroBin: (env: NodeJS.ProcessEnv) => string;
  parseMaestroArgs: (argv: string[]) => {
    flows: string | null;
    appId: string | null;
    platform: string | null;
    serverUrl: string | null;
    skipAppInstallCheck: boolean;
    passThrough: string[];
  };
}>;

function maestroCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_MAESTRO_BIN ?? '').trim() || 'maestro');
}

function adbCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_ADB_BIN ?? '').trim() || 'adb');
}

function xcrunCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_XCRUN_BIN ?? '').trim() || 'xcrun');
}

function isTruthyEnv(value: unknown): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function extractUrlPort(url: string): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function resolveVisibleHostPatternFromUrl(url: string): string {
  if (!url) return '';
  try {
    return escapeRegExp(new URL(url).host);
  } catch {
    return '';
  }
}

type ConnectedMachineMode = 'cli-terminal-daemon' | null;

const SENSITIVE_MAESTRO_ENV_KEYS = ['HAPPIER_E2E_RESTORE_KEY', 'HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK'] as const;
const RESTORE_KEY_CHUNK_SIZE = 8;
const RESTORE_KEY_CHUNK_COUNT = 32;
const REDACTABLE_MAESTRO_ARTIFACT_EXTENSIONS = new Set(['.html', '.json', '.log', '.txt', '.yaml', '.yml']);
const MAX_REDACTABLE_MAESTRO_ARTIFACT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MOBILE_APP_INSTALL_CHECK_ATTEMPTS = 3;
const DEFAULT_MOBILE_APP_INSTALL_CHECK_RETRY_DELAY_MS = 500;
const DEFAULT_MOBILE_APP_INSTALL_CHECK_TIMEOUT_MS = 15_000;
const ANDROID_LOGCAT_ARTIFACT = 'android-logcat.log';
const DEFAULT_ANDROID_LOGCAT_STOP_TIMEOUT_MS = 2_000;
const IOS_SIMULATOR_LOG_ARTIFACT = 'ios-simulator.log';
const DEFAULT_IOS_SIMULATOR_LOG_STOP_TIMEOUT_MS = 2_000;

type AndroidLogcatCapture = Readonly<{
  logPath: string;
  stop: () => Promise<void>;
}>;

async function stopCapturedLogProcess(params: Readonly<{
  child: ReturnType<typeof spawn>;
  closeSignal: Promise<void>;
  timeoutMs: number;
  isClosed: () => boolean;
}>): Promise<void> {
  if (!params.isClosed()) {
    params.child.kill('SIGTERM');
  }
  await Promise.race([
    params.closeSignal,
    sleep(params.timeoutMs),
  ]);
  if (!params.isClosed()) {
    params.child.kill('SIGKILL');
    await Promise.race([
      params.closeSignal,
      sleep(params.timeoutMs),
    ]);
  }
}

function resolveConnectedMachineMode(env: NodeJS.ProcessEnv): ConnectedMachineMode {
  const mode = String(env.HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE ?? '').trim().toLowerCase();
  return mode === 'cli-terminal-daemon' ? 'cli-terminal-daemon' : null;
}

function resolveConnectedMachineBootstrapFlow(env: NodeJS.ProcessEnv): string {
  const configured = String(env.HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_BOOTSTRAP_FLOW ?? '').trim();
  return configured || 'suites/mobile-e2e/flows/_bootstrap/connectedMachineTerminalAuth.yaml';
}

function getFileExtension(path: string): string {
  const basename = path.split('/').pop()?.split('\\').pop() ?? path;
  const index = basename.lastIndexOf('.');
  return index >= 0 ? basename.slice(index).toLowerCase() : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldCaptureAndroidLogcat(env: NodeJS.ProcessEnv): boolean {
  const configured = env.HAPPIER_E2E_ANDROID_LOGCAT_CAPTURE;
  if (configured !== undefined) return isTruthyEnv(configured);
  return true;
}

function shouldCaptureIosSimulatorLog(env: NodeJS.ProcessEnv): boolean {
  const configured = env.HAPPIER_E2E_IOS_SIMULATOR_LOG_CAPTURE;
  if (configured !== undefined) return isTruthyEnv(configured);
  return true;
}

function startAndroidLogcatCapture(params: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  runDir: string;
}>): AndroidLogcatCapture {
  const logPath = resolvePath(params.runDir, ANDROID_LOGCAT_ARTIFACT);
  const serial = String(params.env.HAPPIER_E2E_ANDROID_SERIAL ?? params.env.ANDROID_SERIAL ?? '').trim();
  const baseArgs = serial ? ['-s', serial] : [];
  const child = spawn(
    adbCommand(params.env),
    [...baseArgs, 'logcat', '-v', 'threadtime'],
    {
      cwd: params.cwd,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logStream = createWriteStream(logPath, { flags: 'a' });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    logStream.write(`[logcat-stderr] ${String(chunk)}`);
  });
  child.on('error', (error) => {
    logStream.write(`[logcat-error] ${error instanceof Error ? error.message : String(error)}\n`);
  });

  let stopped = false;
  let closedState = false;
  const closed = new Promise<void>((resolve) => {
    const markClosed = () => {
      closedState = true;
      resolve();
    };
    child.once('close', markClosed);
    child.once('error', markClosed);
  });

  return {
    logPath,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      const timeoutMs = readPositiveInteger(
        params.env.HAPPIER_E2E_ANDROID_LOGCAT_STOP_TIMEOUT_MS,
        DEFAULT_ANDROID_LOGCAT_STOP_TIMEOUT_MS,
      );
      await stopCapturedLogProcess({
        child,
        closeSignal: closed,
        isClosed: () => closedState,
        timeoutMs,
      });
      child.stdout?.unpipe(logStream);
      await new Promise<void>((resolve) => {
        logStream.end(resolve);
      });
    },
  };
}

function startIosSimulatorLogCapture(params: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  runDir: string;
}>): AndroidLogcatCapture {
  const logPath = resolvePath(params.runDir, IOS_SIMULATOR_LOG_ARTIFACT);
  const child = spawn(
    xcrunCommand(params.env),
    [
      'simctl',
      'spawn',
      'booted',
      'log',
      'stream',
      '--style',
      'compact',
      '--predicate',
      'eventMessage CONTAINS "[sync-perf]" OR eventMessage CONTAINS "ReactNativeJS"',
    ],
    {
      cwd: params.cwd,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logStream = createWriteStream(logPath, { flags: 'a' });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    logStream.write(`[simulator-log-stderr] ${String(chunk)}`);
  });
  child.on('error', (error) => {
    logStream.write(`[simulator-log-error] ${error instanceof Error ? error.message : String(error)}\n`);
  });

  let stopped = false;
  let closedState = false;
  const closed = new Promise<void>((resolve) => {
    const markClosed = () => {
      closedState = true;
      resolve();
    };
    child.once('close', markClosed);
    child.once('error', markClosed);
  });

  return {
    logPath,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      const timeoutMs = readPositiveInteger(
        params.env.HAPPIER_E2E_IOS_SIMULATOR_LOG_STOP_TIMEOUT_MS,
        DEFAULT_IOS_SIMULATOR_LOG_STOP_TIMEOUT_MS,
      );
      await stopCapturedLogProcess({
        child,
        closeSignal: closed,
        isClosed: () => closedState,
        timeoutMs,
      });
      child.stdout?.unpipe(logStream);
      await new Promise<void>((resolve) => {
        logStream.end(resolve);
      });
    },
  };
}

function buildRestoreKeyChunkEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const restoreKey = String(env.HAPPIER_E2E_RESTORE_KEY ?? '').trim();
  if (!restoreKey) return {};
  return Object.fromEntries(
    Array.from({ length: RESTORE_KEY_CHUNK_COUNT }, (_, index) => {
      const chunkNumber = String(index + 1).padStart(2, '0');
      const start = index * RESTORE_KEY_CHUNK_SIZE;
      return [`HAPPIER_E2E_RESTORE_KEY_CHUNK_${chunkNumber}`, restoreKey.slice(start, start + RESTORE_KEY_CHUNK_SIZE)];
    }),
  );
}

function isRestoreKeyChunkEnvKey(key: string): boolean {
  return /^HAPPIER_E2E_RESTORE_KEY_CHUNK_\d+$/.test(key);
}

function deleteRestoreKeyChunkEnvEntries(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (isRestoreKeyChunkEnvKey(key)) {
      delete env[key];
    }
  }
}

function collectSensitiveMaestroEnvEntries(env: NodeJS.ProcessEnv): ReadonlyArray<Readonly<{ key: string; value: string }>> {
  const staticEntries = SENSITIVE_MAESTRO_ENV_KEYS
    .map((key) => ({ key, value: String(env[key] ?? '').trim() }))
    .filter((entry) => entry.value.length > 0);
  const existingRestoreKeyChunkEntries = Object.entries(env)
    .filter(([key]) => isRestoreKeyChunkEnvKey(key))
    .map(([key, value]) => ({ key, value: String(value ?? '').trim() }))
    .filter((entry) => entry.value.length > 0);
  const restoreKeyChunkEntries = Object.entries(buildRestoreKeyChunkEnv(env))
    .map(([key, value]) => ({ key, value }))
    .filter((entry) => entry.value.length > 0);

  return [...staticEntries, ...existingRestoreKeyChunkEntries, ...restoreKeyChunkEntries];
}

function buildSensitiveMaestroEnvArgs(entries: ReadonlyArray<Readonly<{ key: string; value: string }>>): string[] {
  return entries
    .filter((entry) => entry.key !== 'HAPPIER_E2E_RESTORE_KEY')
    .flatMap((entry) => ['-e', `${entry.key}=${entry.value}`]);
}

function buildMaestroProcessEnv(baseEnv: NodeJS.ProcessEnv, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...baseEnv,
  };
  delete next.HAPPIER_E2E_RESTORE_KEY;
  deleteRestoreKeyChunkEnvEntries(next);
  Object.assign(next, buildRestoreKeyChunkEnv(baseEnv), extraEnv ?? {});
  delete next.HAPPIER_E2E_RESTORE_KEY;
  return next;
}

function buildNonSecretOrchestrationProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  delete next.HAPPIER_E2E_RESTORE_KEY;
  delete next.HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK;
  deleteRestoreKeyChunkEnvEntries(next);
  return next;
}

export function redactSensitiveMaestroCommandArgsForLog(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const entries = collectSensitiveMaestroEnvEntries(env);
  return args.map((arg) => {
    let redacted = arg;
    for (const entry of entries) {
      redacted = redacted.replace(new RegExp(escapeRegExp(entry.value), 'g'), `[redacted:${entry.key}]`);
    }
    return redacted;
  });
}

function redactSensitiveMaestroDebugArtifacts(
  rootDir: string,
  entries: ReadonlyArray<Readonly<{ key: string; value: string }>>,
): void {
  if (!rootDir || entries.length === 0 || !existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) {
        stack.push(joinPath(current, child));
      }
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_REDACTABLE_MAESTRO_ARTIFACT_BYTES) continue;
    if (!REDACTABLE_MAESTRO_ARTIFACT_EXTENSIONS.has(getFileExtension(current))) continue;

    let text: string;
    try {
      text = readFileSync(current, 'utf8');
    } catch {
      continue;
    }

    let redacted = text;
    for (const entry of entries) {
      redacted = redacted.replace(new RegExp(escapeRegExp(entry.value), 'g'), `[redacted:${entry.key}]`);
    }
    if (redacted !== text) {
      writeFileSync(current, redacted, 'utf8');
    }
  }
}

function shouldWarmExpoDevClientBundle(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: 'android' | 'ios' | null;
  hasWarmableMetro: boolean;
}>): boolean {
  if (!params.platform || !params.hasWarmableMetro) return false;
  const configured = params.env.HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE;
  if (configured !== undefined) return isTruthyEnv(configured);
  return params.platform === 'android';
}

function resolveWarmExpoDevClientBundleTimeoutMs(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: 'android' | 'ios' | null;
}>): number {
  const explicit = Number.parseInt(params.env.HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return params.platform === 'android' ? 300_000 : 60_000;
}

async function warmExpoDevClientBundle(params: Readonly<{
  platform: 'android' | 'ios';
  hostMetroUrl: string;
  metroStdoutPath?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>): Promise<void> {
  const baseUrl = params.hostMetroUrl.replace(/\/$/, '');
  const manifestUrl = `${baseUrl}/?platform=${params.platform}`;
  const signal = params.signal ?? AbortSignal.timeout(params.timeoutMs);

  const manifestRes = await fetch(manifestUrl, {
    method: 'GET',
    signal,
  });
  if (!manifestRes.ok) {
    throw new Error(`Failed to warm Expo Dev Client bundle: manifest not ok (${manifestRes.status})`);
  }
  const manifest = await manifestRes.json().catch(() => null) as any;
  const launchAssetUrlRaw = manifest?.launchAsset?.url;
  if (typeof launchAssetUrlRaw !== 'string' || !launchAssetUrlRaw.trim()) return;

  const hostBase = new URL(baseUrl);
  const launchAssetUrl = new URL(launchAssetUrlRaw);
  launchAssetUrl.protocol = hostBase.protocol;
  launchAssetUrl.host = hostBase.host;

  const bundleRes = await fetch(launchAssetUrl.toString(), {
    method: 'GET',
    signal,
  });
  if (!bundleRes.ok) {
    throw new Error(`Failed to warm Expo Dev Client bundle: bundle not ok (${bundleRes.status})`);
  }

  try {
    if (params.metroStdoutPath) {
      await waitForMetroBundleLog({
        platform: params.platform,
        stdoutPath: params.metroStdoutPath,
        timeoutMs: params.timeoutMs,
        signal,
      });
    }
  } finally {
    await bundleRes.body?.cancel().catch(() => {});
  }
}

async function waitForMetroBundleLog(params: Readonly<{
  platform: 'android' | 'ios';
  stdoutPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>): Promise<void> {
  const platformLabel = params.platform === 'android' ? 'Android' : 'iOS';
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      throw new Error(`Timed out waiting for Expo Dev Client ${platformLabel} bundle log.`);
    }
    try {
      const log = readFileSync(params.stdoutPath, 'utf8');
      if (log.includes(`${platformLabel} Bundled`)) return;
    } catch {
      // The Metro stdout artifact is created by the managed process; retry until timeout.
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for Expo Dev Client ${platformLabel} bundle log.`);
}

async function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function defaultIsAppInstalled(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: 'android' | 'ios';
  appId: string;
}>): Promise<boolean> {
  const timeoutMs = readPositiveInteger(
    params.env.HAPPIER_E2E_MOBILE_APP_INSTALL_CHECK_TIMEOUT_MS,
    DEFAULT_MOBILE_APP_INSTALL_CHECK_TIMEOUT_MS,
  );
  if (params.platform === 'ios') {
    try {
      const outcome = spawnSync(
        'xcrun',
        ['simctl', 'get_app_container', 'booted', params.appId, 'app'],
        { stdio: 'ignore', timeout: timeoutMs, env: params.env },
      );
      return outcome.status === 0;
    } catch {
      return false;
    }
  }

  if (params.platform === 'android') {
    try {
      const serial = String(params.env.HAPPIER_E2E_ANDROID_SERIAL ?? params.env.ANDROID_SERIAL ?? '').trim();
      const baseArgs = serial ? ['-s', serial] : [];
      const outcome = spawnSync(
        adbCommand(params.env),
        [...baseArgs, 'shell', 'pm', 'path', params.appId],
        { encoding: 'utf8', timeout: timeoutMs, env: params.env },
      );
      if (outcome.status !== 0) return false;
      const stdout = String((outcome.stdout ?? '')).trim();
      return stdout.includes('package:');
    } catch {
      return false;
    }
  }

  return true;
}

function runAdbReverseIfEnabled(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: string;
  urls: string[];
}>): Readonly<{ enabled: boolean; reversedPorts: number[] }> {
  if (params.platform !== 'android') return { enabled: false, reversedPorts: [] };

  const deviceHostOverride = String(params.env.HAPPIER_E2E_MOBILE_DEVICE_HOST ?? '').trim();
  if (deviceHostOverride) return { enabled: false, reversedPorts: [] };

  // Default to `adb reverse` on Android for local reliability.
  //
  // Expo's dev server typically binds to localhost, which is not reachable from
  // the emulator via `10.0.2.2` unless the host is listening on all
  // interfaces. `adb reverse` avoids relying on host network configuration.
  //
  // Allow explicit opt-out with `HAPPIER_E2E_ANDROID_ADB_REVERSE=0`.
  const adbReverseSetting = params.env.HAPPIER_E2E_ANDROID_ADB_REVERSE;
  if (adbReverseSetting !== undefined && !isTruthyEnv(adbReverseSetting)) return { enabled: false, reversedPorts: [] };

  const serial = String(params.env.HAPPIER_E2E_ANDROID_SERIAL ?? params.env.ANDROID_SERIAL ?? '').trim();
  const baseArgs = serial ? ['-s', serial] : [];

  const ports = new Set<number>();
  for (const url of params.urls) {
    const port = extractUrlPort(url);
    if (port) ports.add(port);
  }

  const reversedPorts: number[] = [];
  for (const port of ports) {
    try {
      const outcome = spawnSync(adbCommand(params.env), [...baseArgs, 'reverse', `tcp:${port}`, `tcp:${port}`], {
        stdio: 'ignore',
        timeout: 5000,
        env: params.env,
      });
      if (outcome.status === 0) reversedPorts.push(port);
    } catch {
      // Best-effort: keep going and fall back to non-reverse networking.
    }
  }

  return { enabled: reversedPorts.length > 0, reversedPorts };
}

const defaultDeps: Pick<MobileMaestroDeps, 'resolveMaestroBin' | 'parseMaestroArgs'> = {
  resolveMaestroBin: (env) => (String(env.HAPPIER_E2E_MAESTRO_BIN ?? '').trim() || 'maestro'),
  parseMaestroArgs: (argv) => defaultParseMaestroArgs(argv),
};

export async function runMobileMaestro(
  params: Readonly<{
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }>,
  deps: Partial<MobileMaestroDeps>,
): Promise<MobileMaestroRunResult> {
  const parseMaestroArgs = deps.parseMaestroArgs ?? defaultDeps.parseMaestroArgs;
  const parsed = parseMaestroArgs(params.argv);

  const flows = parsed.flows ? parsed.flows.trim() : 'suites/mobile-e2e/flows';
  const appId =
    (parsed.appId ? parsed.appId.trim() : '') ||
    (String(params.env.HAPPIER_E2E_MOBILE_APP_ID ?? '').trim()) ||
    'dev.happier.app.internaldev';
  const platform = parsed.platform ? parsed.platform.trim() : '';
  const mobilePlatform = platform === 'android' || platform === 'ios' ? platform : null;
  const skipAppInstallCheck =
    parsed.skipAppInstallCheck === true || isTruthyEnv(params.env.HAPPIER_E2E_SKIP_APP_INSTALL_CHECK ?? '0');
  const orchestrationEnv = buildNonSecretOrchestrationProcessEnv(params.env);

  const isAppInstalled = deps.isAppInstalled ?? defaultIsAppInstalled;
  if (mobilePlatform && !skipAppInstallCheck) {
    const installCheckAttempts = readPositiveInteger(
      params.env.HAPPIER_E2E_MOBILE_APP_INSTALL_CHECK_ATTEMPTS,
      DEFAULT_MOBILE_APP_INSTALL_CHECK_ATTEMPTS,
    );
    const installCheckRetryDelayMs = readPositiveInteger(
      params.env.HAPPIER_E2E_MOBILE_APP_INSTALL_CHECK_RETRY_DELAY_MS,
      DEFAULT_MOBILE_APP_INSTALL_CHECK_RETRY_DELAY_MS,
    );
    let installed = false;
    for (let attempt = 1; attempt <= installCheckAttempts; attempt += 1) {
      installed = await isAppInstalled({ env: orchestrationEnv, platform: mobilePlatform, appId });
      if (installed) break;
      if (attempt < installCheckAttempts) await sleep(installCheckRetryDelayMs);
    }
    if (!installed) {
      throw new Error(
        `Mobile e2e cannot run: app "${appId}" is not installed or was not detected on the target ${mobilePlatform} device/simulator after ${installCheckAttempts} install probe attempts. Install a development build first (see packages/tests/suites/mobile-e2e/README.md).`,
      );
    }
  }

  const run = createRunDirs({
    runLabel: 'mobile-maestro',
    logsDir: resolvePath(params.cwd, '.project', 'logs', 'e2e', 'mobile-maestro'),
  });

  const manifestPath = resolvePath(run.runDir, 'manifest.json');
  const debugOutputDir = resolvePath(run.runDir, 'maestro-debug');
  let androidLogcatCapture: AndroidLogcatCapture | null = null;
  let iosSimulatorLogCapture: AndroidLogcatCapture | null = null;

  const manageMetro = isTruthyEnv(params.env.HAPPIER_E2E_MOBILE_MANAGE_METRO ?? '1');
  const explicitHostMetroUrl = String(params.env.HAPPIER_E2E_DEV_CLIENT_METRO_URL ?? '').trim();
  const hostMetroUrlFromEnv = explicitHostMetroUrl || (manageMetro ? '' : 'http://127.0.0.1:8081');

  const explicitServerUrl =
    (parsed.serverUrl ? parsed.serverUrl.trim() : '') ||
    (String(params.env.HAPPIER_E2E_SERVER_URL ?? '').trim()) ||
    '';

  let server: StartedServerLike | null = null;
  let metro: StartedDevClientMetroLike | null = null;
  let androidDevClientRuntimeVersion: string | null = null;

  if (manageMetro && !explicitHostMetroUrl) {
    if (!deps.startDevClientMetro) {
      throw new Error('Missing startDevClientMetro dependency.');
    }
    const metroEnv: NodeJS.ProcessEnv = {
      ...orchestrationEnv,
    };
    metroEnv.HAPPIER_E2E_EXPO_CLEAR ??= '1';
    const shouldPinAndroidRuntime =
      platform === 'android' &&
      !String(metroEnv.HAPPIER_EXPO_RUNTIME_VERSION ?? '').trim() &&
      isTruthyEnv(params.env.HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME ?? '1');
    if (shouldPinAndroidRuntime) {
      const resolveAndroidDevClientRuntimeVersion =
        deps.resolveAndroidDevClientRuntimeVersion ?? resolveInstalledAndroidDevClientRuntimeVersion;
      androidDevClientRuntimeVersion = resolveAndroidDevClientRuntimeVersion({
        appId,
        env: orchestrationEnv,
        outputDir: run.testDir('android-dev-client-runtime'),
      });
      if (androidDevClientRuntimeVersion) {
        metroEnv.HAPPIER_EXPO_RUNTIME_VERSION = androidDevClientRuntimeVersion;
      }
    }
    const metroHost = String(params.env.HAPPIER_E2E_DEV_CLIENT_HOST ?? '').trim() || (platform === 'android' ? 'lan' : 'localhost');
    metro = await deps.startDevClientMetro({
      testDir: run.testDir('expo-metro'),
      extraEnv: metroEnv,
      host: metroHost,
      port: explicitHostMetroUrl ? extractUrlPort(hostMetroUrlFromEnv) ?? undefined : undefined,
    });
  }

  const hostMetroUrl = metro?.baseUrl
    ? metro.baseUrl.replace(/\/$/, '')
    : hostMetroUrlFromEnv || 'http://127.0.0.1:8081';
  if (explicitServerUrl) {
    server = { baseUrl: explicitServerUrl };
  } else {
    if (!deps.startServerLight) {
      throw new Error('Missing startServerLight dependency (required when serverUrl is not provided).');
    }
    const extraEnv: NodeJS.ProcessEnv = {
      ...orchestrationEnv,
    };
    // Prefer the Node `--import` start path to avoid relying on workspace-local `node_modules/.bin` layout.
    extraEnv.HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT ??= '1';
    extraEnv.HAPPY_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT ??= '1';
    server = await deps.startServerLight({
      testDir: run.testDir('server-light'),
      extraEnv,
    });
  }

  androidLogcatCapture = mobilePlatform === 'android' && shouldCaptureAndroidLogcat(params.env)
    ? startAndroidLogcatCapture({ cwd: params.cwd, env: orchestrationEnv, runDir: run.runDir })
    : null;
  iosSimulatorLogCapture = mobilePlatform === 'ios' && shouldCaptureIosSimulatorLog(params.env)
    ? startIosSimulatorLogCapture({ cwd: params.cwd, env: orchestrationEnv, runDir: run.runDir })
    : null;

  const adbReversePorts =
    deps.adbReversePorts
      ? deps.adbReversePorts
      : (reverseParams: Parameters<typeof runAdbReverseIfEnabled>[0]) => runAdbReverseIfEnabled(reverseParams);

  const adbReverse = adbReversePorts({
    env: orchestrationEnv,
    platform,
    urls: [server.baseUrl, hostMetroUrl].filter(Boolean),
  });

  const deviceServerUrlRaw = server.baseUrl && mobilePlatform
    ? resolveDeviceVisibleBaseUrl({ platform: mobilePlatform, baseUrl: server.baseUrl, env: params.env })
    : server.baseUrl;

  const deviceMetroUrlRaw = hostMetroUrl && mobilePlatform
    ? resolveDeviceVisibleBaseUrl({ platform: mobilePlatform, baseUrl: hostMetroUrl, env: params.env })
    : hostMetroUrl;

  const deviceServerUrl = (() => {
    if (platform !== 'android' || !adbReverse.enabled) return deviceServerUrlRaw;
    const port = deviceServerUrlRaw ? extractUrlPort(deviceServerUrlRaw) : null;
    if (!port || !adbReverse.reversedPorts.includes(port)) return deviceServerUrlRaw;
    try {
      const parsed = new URL(deviceServerUrlRaw);
      parsed.hostname = '127.0.0.1';
      parsed.port = String(port);
      return stripTrailingSlash(parsed.toString());
    } catch {
      return deviceServerUrlRaw;
    }
  })();

  const deviceMetroUrl = (() => {
    if (platform !== 'android' || !adbReverse.enabled) return deviceMetroUrlRaw;
    const port = deviceMetroUrlRaw ? extractUrlPort(deviceMetroUrlRaw) : null;
    if (!port || !adbReverse.reversedPorts.includes(port)) return deviceMetroUrlRaw;
    try {
      const parsed = new URL(deviceMetroUrlRaw);
      parsed.hostname = '127.0.0.1';
      parsed.port = String(port);
      return stripTrailingSlash(parsed.toString());
    } catch {
      return deviceMetroUrlRaw;
    }
  })();
  const deviceServerVisibleHostPattern = deviceServerUrl
    ? resolveVisibleHostPatternFromUrl(deviceServerUrl)
    : '';

  const mobileAppScheme = resolveMobileAppScheme(params.env, { appId });
  const devClientScheme = mobilePlatform === 'ios' ? appId : mobileAppScheme;
  const devClientLaunchUrl = deviceMetroUrl
    ? resolveExpoDevClientDeepLink({
        env: params.env,
        metroUrl: deviceMetroUrl,
        scheme: devClientScheme,
      })
    : '';

  const maestroBin = deps.resolveMaestroBin
    ? deps.resolveMaestroBin(params.env)
    : defaultDeps.resolveMaestroBin(params.env);

  const hasWarmableMetro = Boolean(hostMetroUrl && (metro || explicitHostMetroUrl));
  const warmBundleEnabled = shouldWarmExpoDevClientBundle({
    env: params.env,
    platform: mobilePlatform,
    hasWarmableMetro,
  });
  if (warmBundleEnabled && mobilePlatform) {
    // eslint-disable-next-line no-console
    console.log(`[tests] warming Expo Dev Client bundle (${mobilePlatform})`);
    const warmTimeoutMs = resolveWarmExpoDevClientBundleTimeoutMs({
      env: params.env,
      platform: mobilePlatform,
    });
    const abortController = new AbortController();
    const hardTimeoutMs = Math.max(50, warmTimeoutMs + 50);
    const hardTimeoutId = setTimeout(() => abortController.abort(), warmTimeoutMs);
    try {
      await withHardTimeout(
        warmExpoDevClientBundle({
          platform: mobilePlatform,
          hostMetroUrl,
          metroStdoutPath: metro?.stdoutPath,
          timeoutMs: warmTimeoutMs,
          signal: abortController.signal,
        }),
        hardTimeoutMs,
      );
    } catch (err) {
      // Best-effort optimization only: warming reduces Dev Client flake from first-load
      // bundling delays, but failures should not prevent the actual Maestro run.
      // eslint-disable-next-line no-console
      console.warn(
        `[tests] warm Expo Dev Client bundle failed (${mobilePlatform}): ${String((err as any)?.message ?? err)}`,
      );
    } finally {
      clearTimeout(hardTimeoutId);
    }
  }

  const primeAppLaunch = deps.primeAppLaunch ?? defaultPrimePlatformAppLaunch;
  if (
    !skipAppInstallCheck
    && mobilePlatform === 'android'
    && isTruthyEnv(params.env.HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH ?? '1')
  ) {
    await primeAppLaunch({
      env: orchestrationEnv,
      platform: mobilePlatform,
      appId,
    });
  }

  const connectedMachineMode = resolveConnectedMachineMode(params.env);

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        tool: 'maestro',
        runId: run.runId,
        startedAt: new Date().toISOString(),
        flows,
        appId,
        platform: platform || null,
        serverUrlHost: server?.baseUrl ?? null,
        serverUrlDevice: deviceServerUrl ?? null,
        metroUrlHost: hostMetroUrl ?? null,
        metroUrlDevice: deviceMetroUrl ?? null,
        devClientLaunchUrl: devClientLaunchUrl || null,
        connectedMachineMode,
        passThrough: parsed.passThrough ?? [],
        artifacts: {
          ...(androidLogcatCapture ? { androidLogcat: ANDROID_LOGCAT_ARTIFACT } : {}),
          ...(iosSimulatorLogCapture ? { iosSimulatorLog: IOS_SIMULATOR_LOG_ARTIFACT } : {}),
          syncPerformanceLogs: [
            ...(androidLogcatCapture ? [ANDROID_LOGCAT_ARTIFACT] : []),
            ...(iosSimulatorLogCapture ? [IOS_SIMULATOR_LOG_ARTIFACT] : []),
            ...(metro ? [
              'expo-metro/ui.dev-client.metro.stdout.log',
              'expo-metro/ui.dev-client.metro.stderr.log',
            ] : []),
          ],
        },
        env: {
          APP_ENV: params.env.APP_ENV ?? null,
          mobileAppScheme,
          devClientScheme,
          androidAdbReverse: adbReverse.enabled,
          androidAdbReversePorts: adbReverse.reversedPorts,
          androidDevClientRuntimeVersion: androidDevClientRuntimeVersion ?? null,
          manageMetro: manageMetro,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  if (!deps.runMaestro) {
    throw new Error('Missing runMaestro dependency.');
  }

  const buildMaestroEnv = (extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...buildMaestroProcessEnv(params.env, extraEnv),
    // Disable analytics prompts for deterministic local runs.
    MAESTRO_CLI_NO_ANALYTICS: String(params.env.MAESTRO_CLI_NO_ANALYTICS ?? '1'),
    ...(deviceServerUrl ? { HAPPIER_E2E_SERVER_URL: deviceServerUrl } : {}),
    ...(deviceServerVisibleHostPattern ? { HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN: deviceServerVisibleHostPattern } : {}),
    ...(server?.baseUrl ? { HAPPIER_E2E_SERVER_URL_HOST: server.baseUrl } : {}),
    ...(platform ? { HAPPIER_E2E_MOBILE_PLATFORM: platform } : {}),
    ...(devClientLaunchUrl ? { HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL: devClientLaunchUrl } : {}),
    HAPPIER_E2E_MOBILE_APP_SCHEME: mobileAppScheme,
    HAPPIER_E2E_MOBILE_APP_ID: appId,
  });

  const baseSensitiveMaestroEnvEntries = collectSensitiveMaestroEnvEntries(params.env);
  let runtimeLogSensitiveMaestroEnvEntries = baseSensitiveMaestroEnvEntries;

  const buildMaestroArgs = (
    flowPath: string,
    sensitiveMaestroEnvEntries: ReadonlyArray<Readonly<{ key: string; value: string }>>,
    extraArgs?: string[],
  ): string[] => [
    ...(platform ? ['-p', platform] : []),
    'test',
    flowPath,
    '--debug-output',
    debugOutputDir,
    '-e',
    `HAPPIER_E2E_MOBILE_APP_ID=${appId}`,
    ...(deviceServerUrl ? ['-e', `HAPPIER_E2E_SERVER_URL=${deviceServerUrl}`] : []),
    ...(deviceServerVisibleHostPattern ? ['-e', `HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN=${deviceServerVisibleHostPattern}`] : []),
    ...(server?.baseUrl ? ['-e', `HAPPIER_E2E_SERVER_URL_HOST=${server.baseUrl}`] : []),
    ...(platform ? ['-e', `HAPPIER_E2E_MOBILE_PLATFORM=${platform}`] : []),
    '-e',
    `HAPPIER_E2E_MOBILE_APP_SCHEME=${mobileAppScheme}`,
    ...(deviceMetroUrl ? ['-e', `HAPPIER_E2E_DEV_CLIENT_METRO_URL=${deviceMetroUrl}`] : []),
    ...(devClientLaunchUrl ? ['-e', `HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL=${devClientLaunchUrl}`] : []),
    ...buildSensitiveMaestroEnvArgs(sensitiveMaestroEnvEntries),
    ...(extraArgs ?? []),
    ...(parsed.passThrough ?? []),
  ];

  const runMaestroFlow = async (flowPath: string, extraEnv?: NodeJS.ProcessEnv, extraArgs?: string[]) => {
    const maestroEnv = buildMaestroEnv(extraEnv);
    const sensitiveMaestroEnvEntries = collectSensitiveMaestroEnvEntries({ ...params.env, ...(extraEnv ?? {}) });
    runtimeLogSensitiveMaestroEnvEntries = [
      ...runtimeLogSensitiveMaestroEnvEntries,
      ...sensitiveMaestroEnvEntries,
    ];
    try {
      return await deps.runMaestro!({
        cwd: params.cwd,
        env: maestroEnv,
        maestroBin: maestroBin || maestroCommand(params.env),
        args: buildMaestroArgs(flowPath, sensitiveMaestroEnvEntries, extraArgs),
      });
    } finally {
      redactSensitiveMaestroDebugArtifacts(debugOutputDir, sensitiveMaestroEnvEntries);
    }
  };

  let exitCode = 1;
  let startedCliTerminalConnect: StartedCliTerminalConnectLike | null = null;
  let startedDaemon: StartedDaemonLike | null = null;
  try {
    if (connectedMachineMode === 'cli-terminal-daemon') {
      if (!deps.startCliTerminalConnect) {
        throw new Error('Missing startCliTerminalConnect dependency.');
      }
      if (!deps.startTestDaemon) {
        throw new Error('Missing startTestDaemon dependency.');
      }

      const cliHomeDir = run.testDir('cli-home');
      mkdirSync(cliHomeDir, { recursive: true });

      startedCliTerminalConnect = await deps.startCliTerminalConnect({
        testDir: run.testDir('cli-terminal-connect'),
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: server.baseUrl,
        env: orchestrationEnv,
      });

      const terminalConnectDeepLink = resolveTerminalConnectDeepLink(startedCliTerminalConnect.connectUrl, {
        env: params.env,
        serverUrl: deviceServerUrl,
      });
      if (!terminalConnectDeepLink) {
        throw new Error('Failed to build terminal connect deep link from terminal connect URL');
      }

      const bootstrapFlow = resolveConnectedMachineBootstrapFlow(params.env);
      const bootstrapResult = await runMaestroFlow(
        bootstrapFlow,
        { HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK: terminalConnectDeepLink },
      );
      if (bootstrapResult.exitCode !== 0) {
        exitCode = bootstrapResult.exitCode;
      } else {
        await startedCliTerminalConnect.waitForSuccess();
        startedDaemon = await deps.startTestDaemon({
          testDir: run.testDir('daemon'),
          happyHomeDir: cliHomeDir,
          env: {
            ...orchestrationEnv,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: server.baseUrl,
          },
        });
        const result = await runMaestroFlow(
          flows,
          { HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK: terminalConnectDeepLink },
        );
        exitCode = result.exitCode;
      }
    } else {
      const result = await runMaestroFlow(flows);
      exitCode = result.exitCode;
    }
  } finally {
    if (startedDaemon?.stop) {
      await startedDaemon.stop();
    }
    if (startedCliTerminalConnect?.stop) {
      await startedCliTerminalConnect.stop();
    }
    if (androidLogcatCapture) {
      await androidLogcatCapture.stop();
      redactSensitiveMaestroDebugArtifacts(androidLogcatCapture.logPath, runtimeLogSensitiveMaestroEnvEntries);
    }
    if (iosSimulatorLogCapture) {
      await iosSimulatorLogCapture.stop();
      redactSensitiveMaestroDebugArtifacts(iosSimulatorLogCapture.logPath, runtimeLogSensitiveMaestroEnvEntries);
    }
    if (server?.stop) {
      await server.stop();
    }
    if (metro?.stop) {
      await metro.stop();
    }
  }

  return {
    exitCode,
    runDir: run.runDir,
    manifestPath,
    debugOutputDir,
    server,
    metro,
  };
}
