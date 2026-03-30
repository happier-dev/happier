import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import net from 'node:net';

import { commandExistsOnPath } from '@happier-dev/cli-common/process';
import {
  applyServicePlan,
  buildServiceDefinition,
  planServiceAction,
  resolveServiceBackend,
  type ServiceMode,
  type ServiceSpec,
} from '@happier-dev/cli-common/service';
import {
  checkRelayRuntimeHealth,
  extractReleasePayloadRootFromArchive,
  resolveRelayRuntimeDefaults,
  type RelayRuntimeHealthResult,
  type RelayRuntimeNormalizedStatus,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';

type RelayRuntimeTaskParams = Readonly<{
  platform?: NodeJS.Platform;
  mode?: 'user' | 'system';
  channel?: string;
  homeDir?: string;
}>;

type RelayRuntimeConfig = Readonly<{
  platform: NodeJS.Platform;
  mode: ServiceMode;
  channel: string;
  installRoot: string;
  versionsDir: string;
  currentPath: string;
  previousPath: string;
  statePath: string;
  configDir: string;
  configEnvPath: string;
  dataDir: string;
  filesDir: string;
  dbDir: string;
  logDir: string;
  serverBinaryName: string;
  serverBinaryPath: string;
  serviceName: string;
  serverHost: string;
  serverPort: number;
  githubRepo: string;
}>;

type RelayRuntimeState = Readonly<{
  version?: string;
  previousVersionId?: string | null;
  source?: string | null;
}>;

type ServiceStatusResult = Readonly<{
  backend:
    | 'systemd-user'
    | 'systemd-system'
    | 'launchd-user'
    | 'launchd-system'
    | 'schtasks-user'
    | 'schtasks-system';
  raw:
    | Readonly<{
        unitFileState?: string | null;
        activeState?: string | null;
        subState?: string | null;
      }>
    | Readonly<{
        exists?: boolean | null;
        enabled?: boolean | null;
        active?: boolean | null;
        stateLabel?: string | null;
      }>
    | Readonly<{
        loaded?: boolean | null;
        pid?: number | null;
        lastExitStatus?: number | null;
      }>;
}>;

function normalizePlatform(platform?: NodeJS.Platform): NodeJS.Platform {
  return (String(platform ?? process.platform).trim() || process.platform) as NodeJS.Platform;
}

function normalizeMode(mode?: 'user' | 'system'): ServiceMode {
  return mode === 'system' ? 'system' : 'user';
}

function normalizeOs(platform: NodeJS.Platform): 'linux' | 'darwin' | 'windows' {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'windows';
  throw new Error(`Unsupported relay runtime platform: ${platform}`);
}

function normalizeArch(): 'x64' | 'arm64' {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported relay runtime architecture: ${process.arch}`);
}

function resolveReleaseTag(channel: string): string {
  if (channel === 'preview') return 'server-preview';
  if (channel === 'publicdev') return 'server-dev';
  return 'server-stable';
}

function parsePort(raw: unknown, fallback: number): number {
  const parsed = Number(String(raw ?? '').trim());
  if (!Number.isFinite(parsed)) return fallback;
  const port = Math.floor(parsed);
  return port > 0 && port <= 65_535 ? port : fallback;
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const splitAt = trimmed.indexOf('=');
    if (splitAt <= 0) continue;
    env[trimmed.slice(0, splitAt).trim()] = trimmed.slice(splitAt + 1);
  }
  return env;
}

function renderEnvText(env: Record<string, string>): string {
  return `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function resolveRelayRuntimeConfig(params: RelayRuntimeTaskParams): RelayRuntimeConfig {
  const platform = normalizePlatform(params.platform);
  const defaults = resolveRelayRuntimeDefaults({
    platform,
    mode: params.mode,
    channel: params.channel as never,
    homeDir: params.homeDir ?? homedir(),
  });
  const installRoot = String(process.env.HAPPIER_SELF_HOST_INSTALL_ROOT ?? defaults.installRoot).trim() || defaults.installRoot;
  const configDir = String(process.env.HAPPIER_SELF_HOST_CONFIG_DIR ?? defaults.configDir).trim() || defaults.configDir;
  const dataDir = String(process.env.HAPPIER_SELF_HOST_DATA_DIR ?? defaults.dataDir).trim() || defaults.dataDir;
  const logDir = String(process.env.HAPPIER_SELF_HOST_LOG_DIR ?? defaults.logDir).trim() || defaults.logDir;
  const serviceName = String(process.env.HAPPIER_SELF_HOST_SERVICE_NAME ?? defaults.serviceName).trim() || defaults.serviceName;
  const serverHost = String(process.env.HAPPIER_SERVER_HOST ?? defaults.serverHost).trim() || defaults.serverHost;
  const serverPort = parsePort(process.env.HAPPIER_SERVER_PORT, defaults.serverPort);
  const githubRepo = String(process.env.HAPPIER_GITHUB_REPO ?? 'happier-dev/happier').trim() || 'happier-dev/happier';
  const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';

  return {
    platform,
    mode: normalizeMode(params.mode),
    channel: defaults.channel,
    installRoot,
    versionsDir: join(installRoot, 'versions'),
    currentPath: join(installRoot, 'current'),
    previousPath: join(installRoot, 'previous'),
    statePath: join(installRoot, 'relay-runtime-state.json'),
    configDir,
    configEnvPath: join(configDir, 'server.env'),
    dataDir,
    filesDir: join(dataDir, 'files'),
    dbDir: join(dataDir, 'pglite'),
    logDir,
    serverBinaryName,
    serverBinaryPath: join(installRoot, 'current', serverBinaryName),
    serviceName,
    serverHost,
    serverPort,
    githubRepo,
  };
}

function buildDatabaseUrl(params: Readonly<{ dbFilePath: string; platform: NodeJS.Platform }>): string {
  if (params.platform !== 'win32') {
    return `file:${params.dbFilePath}`;
  }
  const normalized = params.dbFilePath.replaceAll('\\', '/');
  if (/^[a-zA-Z]:\//u.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith('//')) return `file:${normalized}`;
  return `file:///${normalized}`;
}

function renderRelayRuntimeEnv(config: RelayRuntimeConfig, existingEnvText: string): string {
  const defaults: Record<string, string> = {
    PORT: String(config.serverPort),
    HAPPIER_SERVER_HOST: config.serverHost,
    METRICS_ENABLED: 'false',
    HAPPIER_DB_PROVIDER: 'sqlite',
    DATABASE_URL: buildDatabaseUrl({
      dbFilePath: config.platform === 'win32'
        ? join(config.dataDir, 'happier-server-light.sqlite')
        : `${config.dataDir}/happier-server-light.sqlite`,
      platform: config.platform,
    }),
    HAPPIER_FILES_BACKEND: 'local',
    HAPPIER_SQLITE_AUTO_MIGRATE: '1',
    HAPPIER_SQLITE_MIGRATIONS_DIR: join(config.currentPath, 'prisma', 'sqlite', 'migrations'),
    HAPPIER_SERVER_LIGHT_DATA_DIR: config.dataDir,
    HAPPIER_SERVER_LIGHT_FILES_DIR: config.filesDir,
    HAPPIER_SERVER_LIGHT_DB_DIR: config.dbDir,
    NODE_PATH: join(config.currentPath, 'node_modules'),
  };

  const existing = parseEnvText(existingEnvText);
  return renderEnvText({
    ...defaults,
    ...existing,
  });
}

function buildRelayRuntimeServiceSpec(config: RelayRuntimeConfig, envText: string): ServiceSpec {
  return {
    label: config.serviceName,
    description: `Happier Relay Runtime (${config.serviceName})`,
    programArgs: [config.serverBinaryPath],
    workingDirectory: config.currentPath,
    env: parseEnvText(envText),
    stdoutPath: join(config.logDir, 'server.out.log'),
    stderrPath: join(config.logDir, 'server.err.log'),
  };
}

async function readRelayRuntimeState(statePath: string): Promise<RelayRuntimeState> {
  if (!existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as RelayRuntimeState;
    return typeof parsed === 'object' && parsed != null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRelayRuntimeState(config: RelayRuntimeConfig, patch: RelayRuntimeState): Promise<void> {
  const current = await readRelayRuntimeState(config.statePath);
  await mkdir(dirname(config.statePath), { recursive: true });
  await writeFile(
    config.statePath,
    `${JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

async function syncPointerDirectory(params: Readonly<{
  installRoot: string;
  pointerPath: string;
  targetPath: string | null;
}>): Promise<void> {
  await rm(params.pointerPath, { recursive: true, force: true });
  if (!params.targetPath) return;

  if (process.platform === 'win32') {
    await cp(params.targetPath, params.pointerPath, { recursive: true });
    return;
  }

  await symlink(relative(params.installRoot, params.targetPath), params.pointerPath, 'dir');
}

async function waitForHealthyRelay(config: RelayRuntimeConfig): Promise<RelayRuntimeHealthResult> {
  const timeoutMsRaw = Number(process.env.HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS ?? '');
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 10_000 ? Math.floor(timeoutMsRaw) : 90_000;
  const startedAt = Date.now();
  let latest: RelayRuntimeHealthResult = {
    reachable: false,
    portOpen: false,
    pingOk: false,
    url: `http://${config.serverHost}:${config.serverPort}/v1/version`,
    statusCode: null,
    version: null,
  };

  while (Date.now() - startedAt < timeoutMs) {
    latest = await checkRelayRuntimeHealth({
      host: config.serverHost,
      port: config.serverPort,
      timeoutMs: 5_000,
      probePortOpen: async ({ host, port, timeoutMs: connectTimeoutMs }) => await probePortOpen(host, port, connectTimeoutMs),
      fetchJson: async ({ url, timeoutMs: requestTimeoutMs }) => await fetchJson(url, requestTimeoutMs),
    });
    if (latest.reachable) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return latest;
}

async function probePortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const onDone = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => onDone(true));
    socket.once('timeout', () => onDone(false));
    socket.once('error', () => onDone(false));
  });
}

async function fetchJson(url: string, timeoutMs: number): Promise<Readonly<{ ok: boolean; status: number; body: unknown }>> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function runCommand(command: string, args: readonly string[]): Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: process.env,
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

async function readServiceStatus(config: RelayRuntimeConfig): Promise<ServiceStatusResult> {
  const backend = resolveServiceBackend({ platform: config.platform, mode: config.mode });
  if (backend.startsWith('systemd') && commandExistsOnPath('systemctl', { path: process.env.PATH })) {
    const prefix = backend === 'systemd-user' ? ['--user'] : [];
    const show = runCommand('systemctl', [...prefix, 'show', `${config.serviceName}.service`, '--property=UnitFileState,ActiveState,SubState']);
    const raw = parseEnvText(show.stdout.replaceAll('\r', ''));
    return {
      backend,
      raw: {
        unitFileState: raw.UnitFileState ?? '',
        activeState: raw.ActiveState ?? '',
        subState: raw.SubState ?? '',
      },
    };
  }

  if (backend.startsWith('launchd') && commandExistsOnPath('launchctl', { path: process.env.PATH })) {
    const result = runCommand('launchctl', ['list', config.serviceName]);
    const output = `${result.stdout}\n${result.stderr}`;
    const pidMatch = /"PID"\s*=\s*(\d+)/u.exec(output) ?? /pid\s*=\s*(\d+)/iu.exec(output);
    const exitMatch = /"LastExitStatus"\s*=\s*(-?\d+)/u.exec(output) ?? /last exit code\s*=\s*(-?\d+)/iu.exec(output);
    return {
      backend,
      raw: {
        loaded: result.status === 0,
        pid: pidMatch ? Number(pidMatch[1]) : null,
        lastExitStatus: exitMatch ? Number(exitMatch[1]) : null,
      },
    };
  }

  if (backend.startsWith('schtasks') && commandExistsOnPath('schtasks', { path: process.env.PATH })) {
    const result = runCommand('schtasks', ['/Query', '/TN', `Happier\\${config.serviceName}`, '/FO', 'LIST', '/V']);
    const output = result.stdout;
    return {
      backend,
      raw: {
        exists: result.status === 0,
        enabled: /Scheduled Task State:\s*Enabled/iu.test(output),
        active: /Status:\s*Running/iu.test(output),
        stateLabel: /Status:\s*(.+)$/imu.exec(output)?.[1]?.trim() ?? '',
      },
    };
  }

  return { backend, raw: {} };
}

async function performServiceAction(config: RelayRuntimeConfig, action: 'install' | 'start' | 'stop'): Promise<void> {
  const existingEnvText = existsSync(config.configEnvPath) ? await readFile(config.configEnvPath, 'utf8').catch(() => '') : '';
  const envText = renderRelayRuntimeEnv(config, existingEnvText);
  await mkdir(config.configDir, { recursive: true });
  await writeFile(config.configEnvPath, envText, 'utf8');

  const spec = buildRelayRuntimeServiceSpec(config, envText);
  const backend = resolveServiceBackend({ platform: config.platform, mode: config.mode });
  const definition = buildServiceDefinition({ backend, homeDir: paramsHomeDir(config), spec });
  const taskName = backend.startsWith('schtasks') ? `Happier\\${config.serviceName}` : '';
  const plan = planServiceAction({
    backend,
    action,
    label: config.serviceName,
    definitionPath: definition.path,
    definitionContents: definition.contents,
    taskName,
    persistent: true,
  });
  await applyServicePlan(plan);
}

function paramsHomeDir(config: RelayRuntimeConfig): string {
  if (config.platform === 'win32') {
    return process.env.USERPROFILE ?? homedir();
  }
  return process.env.HOME ?? homedir();
}

async function promoteExtractedPayload(config: RelayRuntimeConfig, versionId: string, payloadRoot: string, currentVersionId: string | null): Promise<void> {
  const versionPath = join(config.versionsDir, versionId);
  await mkdir(config.versionsDir, { recursive: true });
  await rm(versionPath, { recursive: true, force: true });
  await cp(payloadRoot, versionPath, { recursive: true });

  const previousTarget = currentVersionId ? join(config.versionsDir, currentVersionId) : null;
  if (previousTarget && existsSync(previousTarget) && currentVersionId !== versionId) {
    await syncPointerDirectory({
      installRoot: config.installRoot,
      pointerPath: config.previousPath,
      targetPath: previousTarget,
    });
  } else if (!previousTarget || !existsSync(previousTarget)) {
    await rm(config.previousPath, { recursive: true, force: true });
  }

  await syncPointerDirectory({
    installRoot: config.installRoot,
    pointerPath: config.currentPath,
    targetPath: versionPath,
  });
}

function assertSystemModeAllowed(config: RelayRuntimeConfig): void {
  if (config.mode !== 'system' || config.platform === 'win32') {
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Relay runtime system mode requires root privileges');
  }
}

export async function readRelayRuntimeStatus(params: RelayRuntimeTaskParams): Promise<RelayRuntimeNormalizedStatus> {
  const config = resolveRelayRuntimeConfig(params);
  const state = await readRelayRuntimeState(config.statePath);
  const existingEnvText = existsSync(config.configEnvPath) ? await readFile(config.configEnvPath, 'utf8').catch(() => '') : '';
  const env = parseEnvText(existingEnvText);
  const health = await checkRelayRuntimeHealth({
    host: config.serverHost,
    port: parsePort(env.PORT, config.serverPort),
    timeoutMs: 5_000,
    probePortOpen: async ({ host, port, timeoutMs }) => {
      try {
        return await probePortOpen(host, port, timeoutMs);
      } catch {
        return false;
      }
    },
    fetchJson: async ({ url, timeoutMs }) => {
      const response = await fetchJson(url, timeoutMs).catch(() => ({
        ok: false,
        status: 503,
        body: {},
      }));
      return response;
    },
  });

  return {
    installed: typeof state.version === 'string' && state.version.trim().length > 0,
    version: typeof state.version === 'string' && state.version.trim().length > 0 ? state.version : null,
    service: {
      ...(await (async () => {
        const service = await readServiceStatus(config);
        if (service.backend.startsWith('systemd')) {
          const raw = service.raw as { unitFileState?: string; activeState?: string; subState?: string };
          return {
            backend: service.backend,
            installed: Boolean(raw.unitFileState || raw.activeState || raw.subState),
            enabled: raw.unitFileState === 'enabled',
            active: raw.activeState === 'active',
            stateLabel: raw.subState || raw.activeState || 'not_installed',
          };
        }
        if (service.backend.startsWith('launchd')) {
          const raw = service.raw as { loaded?: boolean; pid?: number | null; lastExitStatus?: number | null };
          const active = raw.loaded === true && Number(raw.pid ?? 0) > 0;
          return {
            backend: service.backend,
            installed: raw.loaded === true || typeof raw.lastExitStatus === 'number',
            enabled: raw.loaded === true,
            active,
            stateLabel: active ? 'running' : raw.loaded === true ? 'loaded' : 'not_loaded',
          };
        }
        const raw = service.raw as { exists?: boolean; enabled?: boolean; active?: boolean; stateLabel?: string };
        return {
          backend: service.backend,
          installed: raw.exists === true,
          enabled: raw.enabled === true,
          active: raw.active === true,
          stateLabel: raw.stateLabel || (raw.exists ? 'ready' : 'not_installed'),
        };
      })()),
    },
    health: {
      reachable: health.reachable,
      portOpen: health.portOpen,
      pingOk: health.pingOk,
      url: health.url,
    },
  };
}

export async function readLiveRelayRuntimeInstalledVersion(params: RelayRuntimeTaskParams): Promise<string | null> {
  return (await readRelayRuntimeStatus(params)).version;
}

export async function readLiveRelayRuntimeServiceStatus(params: RelayRuntimeTaskParams): Promise<ServiceStatusResult> {
  const config = resolveRelayRuntimeConfig(params);
  return await readServiceStatus(config);
}

export async function readLiveRelayRuntimeHealth(params: RelayRuntimeTaskParams): Promise<RelayRuntimeHealthResult> {
  const config = resolveRelayRuntimeConfig(params);
  const existingEnvText = existsSync(config.configEnvPath) ? await readFile(config.configEnvPath, 'utf8').catch(() => '') : '';
  const env = parseEnvText(existingEnvText);
  return await checkRelayRuntimeHealth({
    host: config.serverHost,
    port: parsePort(env.PORT, config.serverPort),
    timeoutMs: 5_000,
    probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen(host, port, timeoutMs),
    fetchJson: async ({ url, timeoutMs }) => await fetchJson(url, timeoutMs),
  });
}

export async function startRelayRuntime(params: RelayRuntimeTaskParams): Promise<void> {
  const config = resolveRelayRuntimeConfig(params);
  assertSystemModeAllowed(config);
  await performServiceAction(config, 'start');
}

export async function stopRelayRuntime(params: RelayRuntimeTaskParams): Promise<void> {
  const config = resolveRelayRuntimeConfig(params);
  assertSystemModeAllowed(config);
  await performServiceAction(config, 'stop');
}

export async function installOrUpdateRelayRuntime(params: RelayRuntimeTaskParams): Promise<Readonly<{
  version: string | null;
  source: string | null;
  binaryPath: string;
  serviceInstalled: boolean;
}>> {
  const config = resolveRelayRuntimeConfig(params);
  assertSystemModeAllowed(config);

  const tempDir = join(tmpdir(), `happier-relay-runtime-${process.pid}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    const state = await readRelayRuntimeState(config.statePath);
    const explicitBinaryPath = String(process.env.HAPPIER_SELF_HOST_SERVER_BINARY ?? '').trim();
    const previousVersionId =
      typeof state.version === 'string' && state.version.trim().length > 0
        ? state.version
        : null;

    let version = '';
    let source: string | null = null;
    let extractedRoot = '';

    if (explicitBinaryPath) {
      const info = await stat(explicitBinaryPath).catch(() => null);
      if (!info?.isFile()) {
        throw new Error(`Relay runtime override binary not found: ${explicitBinaryPath}`);
      }
      version = `local-${Date.now()}`;
      extractedRoot = dirname(explicitBinaryPath);
      source = 'local';
    } else {
      const release = await fetchGitHubReleaseByTag({
        githubRepo: config.githubRepo,
        tag: resolveReleaseTag(config.channel),
        userAgent: 'happier-system-tasks',
        githubToken: String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''),
      });
      const bundle = resolveReleaseAssetBundle({
        assets: (release as { assets?: unknown }).assets,
        product: 'happier-server',
        os: normalizeOs(config.platform),
        arch: normalizeArch(),
        preferZipOnWindows: true,
      });
      version = bundle.version;
      const downloaded = await downloadVerifiedReleaseAssetBundle({
        bundle,
        destDir: tempDir,
        pubkeyFile: DEFAULT_MINISIGN_PUBLIC_KEY,
        userAgent: 'happier-system-tasks',
      });
      extractedRoot = await extractReleasePayloadRootFromArchive({
        archivePath: downloaded.archivePath,
        archiveName: downloaded.archiveName,
        extractDir: join(tempDir, 'extract'),
      });
      source = bundle.archive.url;
    }

    await promoteExtractedPayload(config, version, extractedRoot, previousVersionId);
    await performServiceAction(config, 'install');
    const health = await waitForHealthyRelay(config);
    if (!health.reachable) {
      if (previousVersionId && existsSync(join(config.versionsDir, previousVersionId))) {
        await syncPointerDirectory({
          installRoot: config.installRoot,
          pointerPath: config.currentPath,
          targetPath: join(config.versionsDir, previousVersionId),
        });
        await performServiceAction(config, 'install');
      }
      throw new Error('Relay runtime failed health checks after install/update');
    }

    await writeRelayRuntimeState(config, {
      version,
      previousVersionId,
      source,
    });

    return {
      version,
      source,
      binaryPath: config.serverBinaryPath,
      serviceInstalled: true,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export const readLiveRelayRuntimeStatus = readRelayRuntimeStatus;
export const startLiveRelayRuntime = startRelayRuntime;
export const stopLiveRelayRuntime = stopRelayRuntime;
export const installOrUpdateLiveRelayRuntime = installOrUpdateRelayRuntime;
