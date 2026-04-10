import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix as posixPath } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  applyServicePlan,
  buildServiceCommandEnv,
  buildServiceDefinition,
  resolveServiceBackend,
  planServiceAction,
  type ServiceBackend,
  type ServiceSpec,
} from '../service/index.js';
import { buildLaunchdPlistXml } from '../service/launchd.js';
import { renderSystemdServiceUnit } from '../service/systemd.js';
import {
  checkRelayRuntimeHealth,
  resolveRelayRuntimeDefaults,
  type RelayRuntimeDefaults,
} from '../firstPartyRuntime/relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from '../firstPartyRuntime/relayRuntimeInstall.js';
import {
    mergeSelfHostServerEnvText,
    parseEnvText,
    renderSelfHostServerEnvTextFromResolvedValues,
    resolveConfiguredSelfHostBaseUrl,
} from '../firstPartyRuntime/selfHostServerEnv.js';

import { buildRelayRuntimeHealthProbeCommand, RELAY_RUNTIME_HEALTH_OK_TOKEN } from './buildRelayRuntimeHealthProbeCommand.js';

import type {
  RelayRuntimeStatusSnapshot,
  RelayRuntimeTaskParams,
  SystemTaskSshConnectionConfig,
} from '../systemTasks/kinds/relayRuntimeKinds.js';
import { normalizeScpRemotePath } from '../systemTasks/ssh/scpRemotePath.js';

export type RelayHostRemoteCommandResult = Readonly<{ status: number; stdout: string; stderr: string }>;

type RemoteReleaseTarget = Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>;

type RemoteDeps = Readonly<{
  resolveRemoteReleaseTarget: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<RemoteReleaseTarget>;
  runRemoteText: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    remoteCommand: string;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<RelayHostRemoteCommandResult>;
  copyLocalDirectoryToRemote: (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    localPath: string;
    remotePath: string;
    knownHostsMode?: 'app' | 'system';
  }>) => Promise<void>;
}>;

type RemoteInstaller = (params: Readonly<{
  componentId: 'happier-cli' | 'happier-server';
  channel?: string;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  localBinaryPath?: string;
  remoteHomeDir?: string;
}>) => Promise<Readonly<{ binaryPath: string; versionId: string }>>;

export type RelayHostEngineDeps = Readonly<{
  installRemoteComponent: RemoteInstaller;
  localInstallPolicy?: Readonly<{
    runServiceCommands?: boolean;
    skipHealthCheck?: boolean;
  }>;
  resolveLocalInstallVersion?: (params: Readonly<{
    channel: PublicReleaseRingId;
    mode: 'user' | 'system';
    serverBinaryPath: string;
  }>) => Promise<string | null>;
  now?: () => number;
} & RemoteDeps>;

export type RelayHostEngine = Readonly<{
  readStatus: (params: RelayRuntimeTaskParams) => Promise<RelayRuntimeStatusSnapshot>;
  installOrUpdate: (params: RelayRuntimeTaskParams) => Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>>;
  control: (params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' | 'uninstall' }>) => Promise<void>;
}>;

const LOCAL_RELAY_STATUS_HEALTH_TIMEOUT_MS = 1_000;
const LOCAL_RELAY_CONTROL_HEALTH_TIMEOUT_MS = 30_000;
const RELAY_RUNTIME_CHANNELS: readonly PublicReleaseRingId[] = ['stable', 'preview', 'publicdev'];

function quoteRemoteShellArg(value: string): string {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('$HOME')
    && /^[A-Za-z0-9$._/-]+$/u.test(trimmed)
  ) {
    return trimmed;
  }
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function sanitizeRemotePathSegment(value: string): string {
  const sanitized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return sanitized || 'payload';
}

async function readRecentLocalRelayStderr(stderrPath: string): Promise<string> {
  const text = await readFile(stderrPath, 'utf8').catch(() => '');
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(-80).join('\n');
}

async function assertLocalRelayRuntimeHealthy(params: Readonly<{
  relayUrl: string;
  healthPath: string;
  stderrPath: string;
}>): Promise<void> {
  const healthy = await resolveLocalRelayHealth({
    baseUrl: params.relayUrl,
    healthPath: params.healthPath,
    timeoutMs: LOCAL_RELAY_CONTROL_HEALTH_TIMEOUT_MS,
  }).catch(() => false);
  if (healthy) {
    return;
  }

  const tailText = await readRecentLocalRelayStderr(params.stderrPath);
  const message = [
    `Local relay runtime did not become healthy at ${params.relayUrl}.`,
    tailText ? `Recent stderr:\n${tailText}` : '',
  ].filter(Boolean).join('\n');
  throw new Error(message);
}

function normalizeChannel(raw: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(raw) || 'stable';
}

function normalizeMode(raw: unknown): 'user' | 'system' {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function formatRelayChannelLabel(channel: PublicReleaseRingId): 'stable' | 'preview' | 'dev' {
  return channel === 'publicdev' ? 'dev' : channel;
}

function listOtherRelayChannels(channel: PublicReleaseRingId): readonly PublicReleaseRingId[] {
  return RELAY_RUNTIME_CHANNELS.filter((candidate) => candidate !== channel);
}

function resolveRemoteHomeDirForRuntime(): string {
  return '$HOME';
}

function resolveRemoteHomeDirForComponents(): string {
  return '$HOME/.happier';
}

function buildRelayRuntimeServiceSpec(params: Readonly<{
  label: string;
  installRoot: string;
  serverBinaryPath: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}>): ServiceSpec {
  return {
    label: params.label,
    description: `Happier Relay Runtime (${params.label})`,
    programArgs: [params.serverBinaryPath],
    workingDirectory: params.installRoot,
    env: params.env,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
  };
}

async function resolveRemoteUserHomeDir(
  deps: Pick<RemoteDeps, 'runRemoteText'>,
  params: Readonly<{ ssh: SystemTaskSshConnectionConfig; knownHostsMode?: 'app' | 'system' }>,
): Promise<string | null> {
  const result = await deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: `printf '%s\\n' \"$HOME\"`,
  }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
  const candidate = result.status === 0 ? String(result.stdout ?? '').trim() : '';
  return candidate.startsWith('/') ? candidate : null;
}

function resolveRemotePlatform(params: Readonly<{ target: RemoteReleaseTarget }>): 'linux' | 'darwin' {
  return params.target.os;
}

function resolveRelayDefaultsForRemote(params: Readonly<{
  platform: 'linux' | 'darwin';
  channel: PublicReleaseRingId;
  mode: 'user' | 'system';
}>): RelayRuntimeDefaults {
  const homeDir = params.mode === 'system' ? '' : resolveRemoteHomeDirForRuntime();
  return resolveRelayRuntimeDefaults({
    platform: params.platform,
    channel: params.channel,
    mode: params.mode,
    homeDir,
  });
}

async function probeLocalPortOpen(params: Readonly<{ host: string; port: number; timeoutMs: number }>): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({
      host: params.host,
      port: params.port,
    });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(params.timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function fetchLocalJson(params: Readonly<{ url: string; timeoutMs: number }>): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveLocalRelayHealth(params: Readonly<{
  baseUrl: string;
  healthPath: string;
  timeoutMs?: number;
}>): Promise<boolean> {
  const parsedUrl = new URL(params.baseUrl);
  const port = Number.parseInt(parsedUrl.port, 10);
  const result = await checkRelayRuntimeHealth({
    host: parsedUrl.hostname,
    port: Number.isInteger(port) && port > 0 ? port : 80,
    path: params.healthPath,
    timeoutMs: params.timeoutMs ?? LOCAL_RELAY_STATUS_HEALTH_TIMEOUT_MS,
    probePortOpen: async ({ host, port: localPort, timeoutMs }) => await probeLocalPortOpen({ host, port: localPort, timeoutMs }),
    fetchJson: async ({ url, timeoutMs }) => await fetchLocalJson({ url, timeoutMs }),
  });
  return result.reachable;
}

async function resolveLocalDesiredRelayUrl(params: Readonly<{
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  envOverrides?: Record<string, string>;
}>): Promise<string> {
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode: params.mode,
    channel: params.channel,
    homeDir: homedir(),
  });
  const envPath = join(defaults.configDir, 'server.env');
  const baseEnvText = renderSelfHostServerEnvTextFromResolvedValues({
    port: defaults.serverPort,
    host: defaults.serverHost,
    dataDir: defaults.dataDir,
    filesDir: join(defaults.dataDir, 'files'),
    dbDir: join(defaults.dataDir, 'pglite'),
    databaseUrl: `file:${join(defaults.dataDir, 'happier-server-light.sqlite')}`,
    sqliteAutoMigrate: process.platform === 'darwin' ? '0' : '1',
    sqliteMigrationsDir: join(defaults.dataDir, 'migrations', 'sqlite'),
  });
  const existingEnvText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
  const envText = mergeSelfHostServerEnvText({
    baseEnvText,
    existingEnvText,
    overrides: params.envOverrides,
  });
  return resolveConfiguredSelfHostBaseUrl({
    fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
    envText,
  });
}

function resolveRemoteDesiredRelayUrl(params: Readonly<{
  platform: 'linux' | 'darwin';
  mode: 'user' | 'system';
  channel: PublicReleaseRingId;
  existingEnvText?: string;
  envOverrides?: Record<string, string>;
}>): string {
  const defaults = resolveRelayDefaultsForRemote({
    platform: params.platform,
    channel: params.channel,
    mode: params.mode,
  });
  const baseEnvText = renderSelfHostServerEnvTextFromResolvedValues({
    port: defaults.serverPort,
    host: defaults.serverHost,
    dataDir: defaults.dataDir,
    filesDir: `${defaults.dataDir}/files`,
    dbDir: `${defaults.dataDir}/pglite`,
    databaseUrl: `file:${defaults.dataDir}/happier-server-light.sqlite`,
    sqliteAutoMigrate: params.platform === 'darwin' ? '0' : '1',
    sqliteMigrationsDir: `${defaults.dataDir}/migrations/sqlite`,
  });
  const envText = mergeSelfHostServerEnvText({
    baseEnvText,
    existingEnvText: params.existingEnvText,
    overrides: params.envOverrides,
  });
  return resolveConfiguredSelfHostBaseUrl({
    fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
    envText,
  });
}

function createRelayLaneConflictError(params: Readonly<{
  requestedChannel: PublicReleaseRingId;
  conflictingChannel: PublicReleaseRingId;
  relayUrl: string;
}>): Error {
  return new Error(
    `A ${formatRelayChannelLabel(params.conflictingChannel)} relay is already installed at ${params.relayUrl}. `
    + 'Relay lanes keep separate data and are not replaced automatically. '
    + `Use --channel ${formatRelayChannelLabel(params.conflictingChannel)} to manage that relay, choose a different PORT, or uninstall it before installing ${formatRelayChannelLabel(params.requestedChannel)}.`,
  );
}

async function resolveRemoteRelayHealth(params: Readonly<{
  deps: RelayHostEngineDeps;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode: 'app' | 'system';
  relayUrl: string;
  healthPath: string;
}>): Promise<boolean> {
  const probeResult = await params.deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: buildRelayRuntimeHealthProbeCommand({
      baseUrl: params.relayUrl,
      path: params.healthPath,
      maxAttempts: 1,
      sleepSeconds: 0,
    }),
  }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
  const probeStdout = String(probeResult.stdout ?? '');
  return probeResult.status === 0 || probeStdout.includes(RELAY_RUNTIME_HEALTH_OK_TOKEN);
}

function buildRemoteInstallBinaryShimCommand(params: Readonly<{ sourcePath: string; destPath: string; privilegedPrefix?: string }>): string {
  const source = quoteRemoteShellArg(params.sourcePath);
  const dest = quoteRemoteShellArg(params.destPath);
  const privilegedPrefix = params.privilegedPrefix ?? '';
  return [
    'set -eu',
    `${privilegedPrefix}rm -f ${dest}`,
    `(${privilegedPrefix}ln -s ${source} ${dest} 2>/dev/null || ${privilegedPrefix}cp ${source} ${dest})`,
    `${privilegedPrefix}chmod +x ${dest} 2>/dev/null || true`,
  ].join('; ');
}

function buildRemoteProbeExistsCommand(params: Readonly<{ path: string; kind: 'file' | 'dir' }>): string {
  const testFlag = params.kind === 'dir' ? '-d' : '-f';
  return `if [ ${testFlag} ${quoteRemoteShellArg(params.path)} ]; then echo yes; fi`;
}

function buildRemoteRelayRuntimeEnvText(params: Readonly<{
  platform: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  defaults: RelayRuntimeDefaults;
  envOverrides?: Record<string, string>;
  existingEnvText?: string;
  serverBinDir: string;
  nodeModulesPath?: string;
}>): Readonly<{ envText: string; parsed: Record<string, string> }> {
  const normalizedDataDir = String(params.defaults.dataDir ?? '').replace(/\/+$/, '') || String(params.defaults.dataDir ?? '');
  const migrationsDir = posixPath.join(params.serverBinDir, 'prisma', 'sqlite', 'migrations');
  const dbPath = `${normalizedDataDir}/happier-server-light.sqlite`;
  const databaseUrl = `file:${dbPath}`;
  const filesDir = `${params.defaults.dataDir}/files`;
  const dbDir = `${params.defaults.dataDir}/pglite`;

  const baseText = renderSelfHostServerEnvTextFromResolvedValues({
    port: params.defaults.serverPort,
    host: params.defaults.serverHost,
    dataDir: params.defaults.dataDir,
    filesDir,
    dbDir,
    databaseUrl,
    nodeModulesPath: params.nodeModulesPath,
    sqliteAutoMigrate: params.platform === 'darwin' ? '0' : '1',
    sqliteMigrationsDir: migrationsDir,
  });
  const envText = mergeSelfHostServerEnvText({
    baseEnvText: baseText,
    existingEnvText: params.existingEnvText,
    overrides: params.envOverrides,
  });
  return {
    envText,
    parsed: parseEnvText(envText),
  };
}

function resolveRemoteEnvTextForConfigFile(params: Readonly<{ envText: string; remoteHomeDir: string }>): string {
  const remoteHomeDir = String(params.remoteHomeDir ?? '').trim().replace(/\/+$/, '');
  if (!remoteHomeDir) return params.envText;
  return String(params.envText ?? '').replaceAll('$HOME', remoteHomeDir);
}

async function writeRemoteFilesViaScp(params: Readonly<{
  deps: Pick<RemoteDeps, 'copyLocalDirectoryToRemote' | 'runRemoteText'>;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  remoteStageParent: string;
  files: readonly Readonly<{ relativePath: string; contents: string }>[];
}>): Promise<Readonly<{ remoteRoot: string; cleanupRemoteCommand: string }>> {
  const stageParent = String(params.remoteStageParent ?? '').trim();
  if (!stageParent) {
    throw new Error('remoteStageParent is required');
  }
  const stageParentForScp = normalizeScpRemotePath(stageParent);

  const localRoot = await mkdtemp(join(tmpdir(), 'happier-relayhost-stage-'));
  try {
    for (const file of params.files) {
      const rel = String(file.relativePath ?? '').trim().replace(/^\/+/u, '');
      const target = join(localRoot, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, 'utf8');
    }

    await params.deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: `mkdir -p ${quoteRemoteShellArg(stageParent)}`,
    });

    await params.deps.copyLocalDirectoryToRemote({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      localPath: localRoot,
      remotePath: stageParentForScp,
    });

    const remoteRoot = `${stageParent}/${sanitizeRemotePathSegment(basename(localRoot))}`;
    return {
      remoteRoot,
      cleanupRemoteCommand: `rm -rf ${quoteRemoteShellArg(stageParent)}`,
    };
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
}

function buildRemoteReadJsonFileCommand(path: string): string {
  const quoted = quoteRemoteShellArg(path);
  return `if [ -f ${quoted} ]; then cat ${quoted}; else echo ''; fi`;
}

function buildRemoteReadTextFileCommand(params: Readonly<{ path: string; privilegedPrefix?: string }>): string {
  const quoted = quoteRemoteShellArg(params.path);
  const prefix = String(params.privilegedPrefix ?? '').trim();
  const cat = prefix ? `${prefix}cat` : 'cat';
  return `if [ -f ${quoted} ]; then ${cat} ${quoted} 2>/dev/null || true; else echo ''; fi`;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildRemoteServiceStatusCommand(params: Readonly<{ backend: ServiceBackend; serviceName: string }>): string {
  const svc = `${params.serviceName}.service`;
  if (params.backend === 'systemd-user') {
    return wrapRemoteSystemdUserCommand(`systemctl --user show ${quoteRemoteShellArg(svc)} --property=UnitFileState,ActiveState,SubState`);
  }
  if (params.backend === 'systemd-system') {
    return `systemctl show ${quoteRemoteShellArg(svc)} --property=UnitFileState,ActiveState,SubState`;
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    return `launchctl list ${quoteRemoteShellArg(params.serviceName)}`;
  }
  throw new Error(`Unsupported remote backend: ${params.backend}`);
}

function wrapRemoteSystemdUserCommand(command: string): string {
  return `XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=\${XDG_RUNTIME_DIR}/bus}" ${command}`;
}

function parseSystemctlShowOutput(stdout: string): Readonly<{ unitFileState: string; activeState: string; subState: string }> {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const map = new Map<string, string>();
  const rawValues: string[] = [];

  for (const line of lines) {
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      const key = line.slice(0, eqIndex).trim().toLowerCase();
      const value = line.slice(eqIndex + 1).trim();
      if (key) {
        map.set(key, value);
      }
      continue;
    }
    rawValues.push(line);
  }

  const unitFileState = map.get('unitfilestate') ?? rawValues[0] ?? '';
  const activeState = map.get('activestate') ?? rawValues[1] ?? '';
  const subState = map.get('substate') ?? rawValues[2] ?? '';
  return { unitFileState, activeState, subState };
}

function normalizeRemoteServiceSnapshot(params: Readonly<{
  backend: ServiceBackend;
  commandResult: RelayHostRemoteCommandResult;
}>): RelayRuntimeStatusSnapshot['service'] {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    if (params.commandResult.status !== 0) {
      return { enabled: null, active: null };
    }
    const { unitFileState, activeState } = parseSystemctlShowOutput(params.commandResult.stdout);
    return {
      enabled: unitFileState.trim().toLowerCase() === 'enabled',
      active: activeState.trim().toLowerCase() === 'active',
      // no "installed" field in snapshot shape
    };
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const loaded = params.commandResult.status === 0;
    return {
      enabled: loaded,
      active: loaded,
    };
  }
  return { enabled: null, active: null };
}

function buildRemoteControlCommand(params: Readonly<{ backend: ServiceBackend; serviceName: string; action: 'start' | 'stop' | 'restart' | 'uninstall' }>): string {
  const svc = `${params.serviceName}.service`;
  if (params.backend === 'systemd-user') {
    if (params.action === 'uninstall') {
      return `${wrapRemoteSystemdUserCommand(`systemctl --user disable --now ${quoteRemoteShellArg(svc)}`)} 2>/dev/null || true; ${wrapRemoteSystemdUserCommand('systemctl --user daemon-reload')}`;
    }
    return wrapRemoteSystemdUserCommand(`systemctl --user ${params.action} ${quoteRemoteShellArg(svc)}`);
  }
  if (params.backend === 'systemd-system') {
    const sudoSetup = "SUDO_PREFIX=''; if [ \"$(id -u)\" -ne 0 ]; then SUDO_PREFIX=\"sudo -n \"; fi; ";
    if (params.action === 'uninstall') {
      return `${sudoSetup}${'${SUDO_PREFIX}'}systemctl disable --now ${quoteRemoteShellArg(svc)} 2>/dev/null || true; ${'${SUDO_PREFIX}'}systemctl daemon-reload`;
    }
    return `${sudoSetup}${'${SUDO_PREFIX}'}systemctl ${params.action} ${quoteRemoteShellArg(svc)}`;
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const sudoSetup = params.backend === 'launchd-system'
      ? "SUDO_PREFIX=''; if [ \"$(id -u)\" -ne 0 ]; then SUDO_PREFIX=\"sudo -n \"; fi; "
      : '';
    const privilegedPrefix = params.backend === 'launchd-system' ? '${SUDO_PREFIX}' : '';
    if (params.action === 'uninstall') {
      return `${sudoSetup}${privilegedPrefix}launchctl unload -w ${quoteRemoteShellArg(resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system'))} 2>/dev/null || true; ${privilegedPrefix}launchctl remove ${quoteRemoteShellArg(params.serviceName)} 2>/dev/null || true`;
    }
    if (params.action === 'stop') {
      return `${sudoSetup}${privilegedPrefix}launchctl unload -w ${quoteRemoteShellArg(resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system'))}`;
    }
    const plistPath = resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system');
    const launchdDomain = params.backend === 'launchd-system' ? 'system' : 'gui/$(id -u)';
    const serviceDomain = `${launchdDomain}/${params.serviceName}`;
    return `${sudoSetup}${privilegedPrefix}launchctl bootout -w ${quoteRemoteShellArg(plistPath)} 2>/dev/null || true; ${privilegedPrefix}launchctl bootstrap ${launchdDomain} ${quoteRemoteShellArg(plistPath)}; ${privilegedPrefix}launchctl enable ${quoteRemoteShellArg(serviceDomain)}; ${privilegedPrefix}launchctl kickstart -k ${quoteRemoteShellArg(serviceDomain)}`;
  }
  throw new Error(`Unsupported remote backend: ${params.backend}`);
}

function resolveLaunchdPlistPath(label: string, system: boolean): string {
  return system
    ? `/Library/LaunchDaemons/${label}.plist`
    : `${resolveRemoteHomeDirForRuntime()}/Library/LaunchAgents/${label}.plist`;
}

function resolveRemoteServiceDefinitionPath(params: Readonly<{
  backend: ServiceBackend;
  label: string;
  remoteHomeDir: string;
}>): string {
  if (params.backend === 'systemd-system') {
    return `/etc/systemd/system/${params.label}.service`;
  }
  if (params.backend === 'systemd-user') {
    return `${params.remoteHomeDir}/.config/systemd/user/${params.label}.service`;
  }
  if (params.backend === 'launchd-system') {
    return `/Library/LaunchDaemons/${params.label}.plist`;
  }
  if (params.backend === 'launchd-user') {
    return `${params.remoteHomeDir}/Library/LaunchAgents/${params.label}.plist`;
  }
  throw new Error(`Unsupported backend: ${params.backend}`);
}

function resolveRemoteServiceDefinitionContents(params: Readonly<{
  backend: ServiceBackend;
  remoteHomeDir: string;
  spec: ServiceSpec;
  defaultPathEnv: string;
}>): string {
  const env = {
    ...(params.spec.env ?? {}),
    ...(params.defaultPathEnv ? { PATH: params.defaultPathEnv } : {}),
  };

	  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
	    const wantedBy = params.backend === 'systemd-system' ? 'multi-user.target' : 'default.target';
	    const resolvedHomeDir = String(params.remoteHomeDir ?? '').trim();
	    const materializeHome = (value: string): string => value.replaceAll('$HOME', resolvedHomeDir);
	    const workingDirectoryCandidate = params.spec.workingDirectory;
	    const workingDirectory = resolvedHomeDir.startsWith('/')
	      ? (workingDirectoryCandidate ? materializeHome(workingDirectoryCandidate) : undefined)
	      : workingDirectoryCandidate;
	    const execStart = resolvedHomeDir.startsWith('/')
	      ? params.spec.programArgs.map((arg) => materializeHome(String(arg)))
	      : params.spec.programArgs;
    const stdoutPath = resolvedHomeDir.startsWith('/') && params.spec.stdoutPath
      ? materializeHome(params.spec.stdoutPath)
      : params.spec.stdoutPath;
    const stderrPath = resolvedHomeDir.startsWith('/') && params.spec.stderrPath
      ? materializeHome(params.spec.stderrPath)
      : params.spec.stderrPath;
    const envMaterialized = resolvedHomeDir.startsWith('/')
      ? Object.fromEntries(Object.entries(env).map(([key, value]) => [key, materializeHome(String(value))]))
      : env;
    return renderSystemdServiceUnit({
      description: params.spec.description ?? params.spec.label,
      execStart,
      workingDirectory,
      env: envMaterialized,
      restart: 'always',
      runAsUser: params.spec.runAsUser,
      stdoutPath,
      stderrPath,
      wantedBy,
    });
  }

  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const stdoutPath = params.spec.stdoutPath
      ? params.spec.stdoutPath
      : params.backend === 'launchd-system'
        ? `/var/log/${params.spec.label}.out.log`
        : `${params.remoteHomeDir}/.happier/logs/${params.spec.label}.out.log`;
    const stderrPath = params.spec.stderrPath
      ? params.spec.stderrPath
      : params.backend === 'launchd-system'
        ? `/var/log/${params.spec.label}.err.log`
        : `${params.remoteHomeDir}/.happier/logs/${params.spec.label}.err.log`;
    return buildLaunchdPlistXml({
      label: params.spec.label,
      programArgs: [...params.spec.programArgs],
      env,
      stdoutPath,
      stderrPath,
      workingDirectory: params.spec.workingDirectory,
      keepAliveOnFailure: true,
    });
  }

  throw new Error(`Unsupported backend: ${params.backend}`);
}

function buildRemoteRelayRuntimeCleanupCommand(params: Readonly<{
  definitionPath: string;
  installRoot: string;
  binDir: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  useSudo?: boolean;
}>): string {
  const privilegedPrefix = params.useSudo ? '${SUDO_PREFIX}' : '';
  return [
    'set -eu',
    ...(params.useSudo
      ? [
          "SUDO_PREFIX=''",
          'if [ "$(id -u)" -ne 0 ]; then SUDO_PREFIX="sudo -n "; fi',
        ]
      : []),
    `${privilegedPrefix}rm -f ${quoteRemoteShellArg(params.definitionPath)}`,
    `${privilegedPrefix}rm -f ${quoteRemoteShellArg(posixPath.join(params.binDir, 'happier-server'))}`,
    `${privilegedPrefix}rm -rf ${quoteRemoteShellArg(params.installRoot)}`,
    `${privilegedPrefix}rm -rf ${quoteRemoteShellArg(params.configDir)}`,
    `${privilegedPrefix}rm -rf ${quoteRemoteShellArg(params.dataDir)}`,
    `${privilegedPrefix}rm -rf ${quoteRemoteShellArg(params.logDir)}`,
  ].join('; ');
}

async function resolveRemotePathEnv(
  deps: Pick<RemoteDeps, 'runRemoteText'>,
  params: Readonly<{ ssh: SystemTaskSshConnectionConfig; knownHostsMode?: 'app' | 'system' }>,
): Promise<string> {
  const result = await deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: `printf '%s\\n' \"$PATH\"`,
  }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

async function installRemoteService(params: Readonly<{
  deps: Pick<RemoteDeps, 'runRemoteText' | 'copyLocalDirectoryToRemote'>;
  ssh: SystemTaskSshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  backend: ServiceBackend;
  definitionPath: string;
  definitionContents: string;
  serviceName: string;
}>): Promise<void> {
  const stageParent = `${resolveRemoteHomeDirForComponents()}/bootstrap-staging/relay-service-${Date.now()}`;
  const staged = await writeRemoteFilesViaScp({
    deps: params.deps,
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteStageParent: stageParent,
    files: [
      { relativePath: 'service-definition', contents: params.definitionContents },
    ],
  });

  const remoteDefinitionPath = params.definitionPath;
  const remoteStagedDefinitionPath = `${staged.remoteRoot}/service-definition`;
  const installCommands: string[] = [];
  const privilegedPrefix = params.backend === 'systemd-system' || params.backend === 'launchd-system'
    ? '${SUDO_PREFIX}'
    : '';
  installCommands.push('set -eu');
  if (privilegedPrefix) {
    installCommands.push("SUDO_PREFIX=''");
    installCommands.push('if [ "$(id -u)" -ne 0 ]; then SUDO_PREFIX="sudo -n "; fi');
  }
  installCommands.push(`${privilegedPrefix}mkdir -p ${quoteRemoteShellArg(dirname(remoteDefinitionPath))}`);
  installCommands.push(`${privilegedPrefix}cp ${quoteRemoteShellArg(remoteStagedDefinitionPath)} ${quoteRemoteShellArg(remoteDefinitionPath)}`);

  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const prefix = params.backend === 'systemd-user' ? '--user ' : '';
    if (params.backend === 'systemd-user') {
      installCommands.push(wrapRemoteSystemdUserCommand('systemctl --user daemon-reload'));
      installCommands.push(wrapRemoteSystemdUserCommand(`systemctl --user enable ${quoteRemoteShellArg(`${params.serviceName}.service`)}`));
      installCommands.push(wrapRemoteSystemdUserCommand(`systemctl --user restart ${quoteRemoteShellArg(`${params.serviceName}.service`)}`));
    } else {
      installCommands.push(`${privilegedPrefix}systemctl ${prefix}daemon-reload`);
      // Restart after install so updated unit/env changes take effect even when the service is already running.
      // `systemctl enable --now` does not restart existing services.
      installCommands.push(`${privilegedPrefix}systemctl ${prefix}enable ${quoteRemoteShellArg(`${params.serviceName}.service`)}`);
      installCommands.push(`${privilegedPrefix}systemctl ${prefix}restart ${quoteRemoteShellArg(`${params.serviceName}.service`)}`);
    }
  } else if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const plist = quoteRemoteShellArg(remoteDefinitionPath);
    installCommands.push(`${privilegedPrefix}launchctl unload -w ${plist} 2>/dev/null || true`);
    installCommands.push(`${privilegedPrefix}launchctl load -w ${plist}`);
  } else {
    throw new Error(`Unsupported remote backend: ${params.backend}`);
  }

  installCommands.push(staged.cleanupRemoteCommand);

  const result = await params.deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: installCommands.join('; '),
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    if ((params.backend === 'systemd-user') && /failed to connect to bus/i.test(stderr)) {
      throw new Error('Systemd user service is unavailable. Ensure the host has a user systemd session (e.g. enable lingering) or use system mode.');
    }
    throw new Error(result.stderr.trim() || 'Failed to install relay service');
  }
}

export function createRelayHostEngine(deps: RelayHostEngineDeps): RelayHostEngine {
  const now = deps.now ?? (() => Date.now());

  const runLocalText = (cmd: string, args: readonly string[]) => {
    const res = spawnSync(cmd, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildServiceCommandEnv({ cmd, args, env: process.env }),
    });
    return {
      status: typeof res.status === 'number' ? res.status : 1,
      stdout: String(res.stdout ?? ''),
      stderr: `${String(res.stderr ?? '')}${res.error instanceof Error ? `\n${res.error.message}` : ''}`.trim(),
    };
  };

  async function readLocalStatus(parsed: RelayRuntimeTaskParams): Promise<RelayRuntimeStatusSnapshot> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const serverBinaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const installBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const stateText = existsSync(statePath) ? await readFile(statePath, 'utf8').catch(() => '') : '';
    const state = stateText.trim() ? tryParseJsonObject(stateText) : null;
    const version = typeof state?.version === 'string' ? state.version : null;

    const backend = resolveServiceBackend({
      platform: process.platform,
      mode,
    }) as ServiceBackend;

    const service = (() => {
      if (backend === 'systemd-user' || backend === 'systemd-system') {
        const prefix = backend === 'systemd-user' ? ['--user'] : [];
        const result = runLocalText('systemctl', [...prefix, 'show', `${defaults.serviceName}.service`, '--property=UnitFileState,ActiveState,SubState']);
        if (result.status !== 0) {
          return { enabled: null, active: null };
        }
        const { unitFileState, activeState } = parseSystemctlShowOutput(result.stdout);
        return {
          enabled: unitFileState.trim().toLowerCase() === 'enabled',
          active: activeState.trim().toLowerCase() === 'active',
        };
      }
      if (backend === 'launchd-user' || backend === 'launchd-system') {
        const result = runLocalText('launchctl', ['list', defaults.serviceName]);
        if (result.status !== 0) {
          return { enabled: null, active: null };
        }
        return { enabled: true, active: true };
      }
      const result = runLocalText('schtasks', ['/Query', '/TN', `Happier\\${defaults.serviceName}`, '/FO', 'LIST', '/V']);
      if (result.status !== 0) {
        return { enabled: null, active: null };
      }
      const output = `${result.stdout}\n${result.stderr}`;
      return {
        enabled: /Scheduled Task State:\s*Enabled/i.test(output),
        active: /Status:\s*Running/i.test(output),
      };
    })();
    const installed = Boolean(version) || existsSync(installBinaryPath);
    const envPath = join(defaults.configDir, 'server.env');
    const envText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
    const baseUrl = resolveConfiguredSelfHostBaseUrl({
      fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      envText,
    });
    const healthy = service.active === true
      ? await resolveLocalRelayHealth({
        baseUrl,
        healthPath: defaults.healthPath,
        timeoutMs: LOCAL_RELAY_STATUS_HEALTH_TIMEOUT_MS,
      }).catch(() => false)
      : service.active === null
        ? null
        : false;

    return {
      installed,
      version,
      service,
      baseUrl,
      healthy,
    };
  }

  async function installLocal(parsed: RelayRuntimeTaskParams): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const desiredRelayUrl = await resolveLocalDesiredRelayUrl({
      mode,
      channel,
      envOverrides: parsed.env,
    });
    for (const otherChannel of listOtherRelayChannels(channel)) {
      const otherStatus = await readLocalStatus({
        ...parsed,
        channel: formatRelayChannelLabel(otherChannel),
      });
      if (otherStatus.installed && otherStatus.baseUrl === desiredRelayUrl) {
        throw createRelayLaneConflictError({
          requestedChannel: channel,
          conflictingChannel: otherChannel,
          relayUrl: desiredRelayUrl,
        });
      }
    }
    const serverBinaryPath = typeof parsed.selfHostRelayBinaryOverride === 'string'
      ? parsed.selfHostRelayBinaryOverride.trim()
      : '';
    if (!serverBinaryPath) {
      throw new Error('Local relay runtime install requires selfHostRelayBinaryOverride.');
    }
    const version = deps.resolveLocalInstallVersion
      ? await deps.resolveLocalInstallVersion({ channel, mode, serverBinaryPath })
      : null;
    const policy = deps.localInstallPolicy ?? {};

    const local = await installOrUpdateRelayRuntimeLocal({
      serverBinaryPath,
      channel,
      mode,
      env: parsed.env,
      version,
      runServiceCommands: policy.runServiceCommands !== false,
      skipHealthCheck: policy.skipHealthCheck === true,
    });

    return {
      relayUrl: String(local.baseUrl ?? '').trim() || `http://127.0.0.1:${resolveRelayRuntimeDefaults({ mode, channel, homeDir: homedir() }).serverPort}`,
      mode,
    };
  }

  async function uninstallLocal(parsed: RelayRuntimeTaskParams): Promise<void> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const serverBinaryName = process.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const installServerBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const stdoutPath = join(defaults.logDir, 'server.out.log');
    const stderrPath = join(defaults.logDir, 'server.err.log');
    const backend = resolveServiceBackend({ platform: process.platform, mode });
    const serviceSpec = buildRelayRuntimeServiceSpec({
      label: defaults.serviceName,
      installRoot: defaults.installRoot,
      serverBinaryPath: installServerBinaryPath,
      env: {},
      stdoutPath,
      stderrPath,
    });
    const definition = buildServiceDefinition({
      backend,
      homeDir: homedir(),
      spec: serviceSpec,
    });
    const plan = planServiceAction({
      backend,
      action: 'uninstall',
      label: serviceSpec.label,
      definitionPath: definition.path,
      persistent: true,
    });

    await applyServicePlan(plan, {
      runCommands: true,
    });

    const cleanupTargets = [
      definition.path,
      statePath,
      installServerBinaryPath,
      join(defaults.binDir, serverBinaryName),
      defaults.installRoot,
      defaults.configDir,
      defaults.dataDir,
      defaults.logDir,
    ];

    for (const path of cleanupTargets) {
      await rm(path, { force: true, recursive: true }).catch(() => undefined);
    }

    if (existsSync(defaults.installRoot)) {
      await rm(defaults.installRoot, { force: true, recursive: true }).catch(() => undefined);
    }

    if (existsSync(statePath)) {
      throw new Error('Failed to remove relay runtime state file.');
    }
  }

  async function resolveRemoteTarget(ssh: SystemTaskSshConnectionConfig, knownHostsMode?: 'app' | 'system'): Promise<RemoteReleaseTarget> {
    return await deps.resolveRemoteReleaseTarget({ ssh, knownHostsMode });
  }

  async function readRemoteStatus(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<RelayRuntimeStatusSnapshot> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const target = await resolveRemoteTarget(params.ssh, knownHostsMode);
    const platform = resolveRemotePlatform({ target });
    const mode = normalizeMode(params.parsed.mode);
    const channel = normalizeChannel(params.parsed.channel);
    const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
    const statePath = `${defaults.installRoot}/self-host-state.json`;
    const envPath = `${defaults.configDir}/server.env`;

    const stateResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteReadJsonFileCommand(statePath),
    });
    const state = tryParseJsonObject(stateResult.stdout);
    const version = typeof state?.version === 'string' ? state.version : null;

    const backend = resolveServiceBackend({ platform, mode });
    const serviceResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteServiceStatusCommand({ backend, serviceName: defaults.serviceName }),
    }).catch((error: unknown) => ({
      status: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'failed to read remote service status',
    }));

    const service = normalizeRemoteServiceSnapshot({
      backend,
      commandResult: serviceResult,
    });

    const installBinaryPath = `${defaults.installRoot}/bin/happier-server`;
    const binaryExists = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteProbeExistsCommand({ path: installBinaryPath, kind: 'file' }),
    }).then((result) => String(result.stdout ?? '').trim() === 'yes').catch(() => false);

    const privilegedPrefix = backend === 'systemd-system' || backend === 'launchd-system'
      ? 'sudo -n '
      : '';
    const envText = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteReadTextFileCommand({ path: envPath, privilegedPrefix }),
    }).then((result) => String(result.stdout ?? '')).catch(() => '');
    const baseUrl = resolveConfiguredSelfHostBaseUrl({
      fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      envText,
    });
    const healthy = service.active === true
      ? await resolveRemoteRelayHealth({
        deps,
        ssh: params.ssh,
        knownHostsMode,
        relayUrl: baseUrl,
        healthPath: defaults.healthPath,
      })
      : service.active === null
        ? null
        : false;

    return {
      installed: Boolean(version) || binaryExists,
      version,
      service,
      baseUrl,
      healthy,
    };
  }

  async function installRemote(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const target = await resolveRemoteTarget(params.ssh, knownHostsMode);
    const platform = resolveRemotePlatform({ target });
    const mode = normalizeMode(params.parsed.mode);
    const channel = normalizeChannel(params.parsed.channel);
    const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
    const remoteHomeDir = await resolveRemoteUserHomeDir(deps, { ssh: params.ssh, knownHostsMode })
      ?? resolveRemoteHomeDirForRuntime();
    const remoteComponentHomeDir = resolveRemoteHomeDirForComponents();
    const backend = resolveServiceBackend({ platform, mode });
    const privilegedPrefix = backend === 'systemd-system' || backend === 'launchd-system'
      ? 'sudo -n '
      : '';
    const configEnvPath = `${defaults.configDir}/server.env`;
    const existingEnvText = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteReadTextFileCommand({ path: configEnvPath, privilegedPrefix }),
    }).then((result) => String(result.stdout ?? '')).catch(() => '');
    const desiredRelayUrl = resolveRemoteDesiredRelayUrl({
      platform,
      mode,
      channel,
      existingEnvText,
      envOverrides: params.parsed.env,
    });
    for (const otherChannel of listOtherRelayChannels(channel)) {
      const otherStatus = await readRemoteStatus({
        parsed: {
          ...params.parsed,
          channel: formatRelayChannelLabel(otherChannel),
        },
        ssh: params.ssh,
      });
      if (otherStatus.installed && otherStatus.baseUrl === desiredRelayUrl) {
        throw createRelayLaneConflictError({
          requestedChannel: channel,
          conflictingChannel: otherChannel,
          relayUrl: desiredRelayUrl,
        });
      }
    }

    const remoteCli = await deps.installRemoteComponent({
      componentId: 'happier-cli',
      channel,
      ssh: params.ssh,
      knownHostsMode,
      remoteHomeDir: remoteComponentHomeDir,
    });

    const remoteServerOverride = typeof params.parsed.selfHostRelayBinaryOverride === 'string'
      ? params.parsed.selfHostRelayBinaryOverride.trim()
      : '';
    const remoteServer = await deps.installRemoteComponent({
      componentId: 'happier-server',
      channel,
      ssh: params.ssh,
      knownHostsMode,
      remoteHomeDir: remoteComponentHomeDir,
      ...(remoteServerOverride ? { localBinaryPath: remoteServerOverride } : {}),
      ...(!remoteServerOverride ? { installerBinaryPath: remoteCli.binaryPath } : {}),
    });

    const installServerBinaryPath = `${defaults.installRoot}/bin/happier-server`;
    const shimPath = `${defaults.binDir}/happier-server`;
    const stdoutPath = `${defaults.logDir}/server.out.log`;
    const stderrPath = `${defaults.logDir}/server.err.log`;
    const statePath = `${defaults.installRoot}/self-host-state.json`;
    const filesDir = `${defaults.dataDir}/files`;
    const dbDir = `${defaults.dataDir}/pglite`;
    const serverBinDir = posixPath.dirname(remoteServer.binaryPath);

    const nodeModulesPath = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteProbeExistsCommand({ path: `${serverBinDir}/node_modules`, kind: 'dir' }),
    }).then((result) => String(result.stdout ?? '').trim() === 'yes'
      ? `${serverBinDir}/node_modules`
      : '').catch(() => '');

    const renderedEnv = buildRemoteRelayRuntimeEnvText({
      platform,
      arch: target.arch,
      defaults,
      envOverrides: params.parsed.env,
      existingEnvText,
      serverBinDir,
      nodeModulesPath: nodeModulesPath || undefined,
    });

    const serviceSpec: ServiceSpec = {
      label: defaults.serviceName,
      description: `Happier Relay Runtime (${defaults.serviceName})`,
      programArgs: [installServerBinaryPath],
      workingDirectory: defaults.installRoot,
      env: renderedEnv.parsed,
      stdoutPath,
      stderrPath,
    };
    const remotePathEnv = await resolveRemotePathEnv(deps, { ssh: params.ssh, knownHostsMode });
    const definitionPath = resolveRemoteServiceDefinitionPath({
      backend,
      label: serviceSpec.label,
      remoteHomeDir,
    });
    const definitionContents = resolveRemoteServiceDefinitionContents({
      backend,
      remoteHomeDir,
      spec: serviceSpec,
      defaultPathEnv: remotePathEnv,
    });

    const stageParent = `${remoteComponentHomeDir}/bootstrap-staging/relay-runtime-${now()}`;
    const staged = await writeRemoteFilesViaScp({
      deps,
      ssh: params.ssh,
      knownHostsMode,
      remoteStageParent: stageParent,
      files: [
        { relativePath: 'server.env', contents: resolveRemoteEnvTextForConfigFile({ envText: renderedEnv.envText, remoteHomeDir }) },
        { relativePath: 'self-host-state.json', contents: `${JSON.stringify({
          channel,
          mode,
          version: remoteServer.versionId || null,
          updatedAt: new Date(now()).toISOString(),
        }, null, 2)}\n` },
      ],
    });

    const remoteEnvPath = `${staged.remoteRoot}/server.env`;
    const remoteStatePath = `${staged.remoteRoot}/self-host-state.json`;

    const setupPrivilegedPrefix = backend === 'systemd-system' || backend === 'launchd-system'
      ? '${SUDO_PREFIX}'
      : '';

    const setupCommands = [
      'set -eu',
      ...(setupPrivilegedPrefix
        ? [
            "SUDO_PREFIX=''",
            'if [ "$(id -u)" -ne 0 ]; then SUDO_PREFIX="sudo -n "; fi',
          ]
        : []),
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(defaults.installRoot)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(defaults.binDir)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(defaults.configDir)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(defaults.dataDir)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(filesDir)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(dbDir)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(defaults.logDir)}`,
      `${setupPrivilegedPrefix}mkdir -p ${quoteRemoteShellArg(`${defaults.installRoot}/bin`)}`,
      buildRemoteInstallBinaryShimCommand({ sourcePath: remoteServer.binaryPath, destPath: installServerBinaryPath, privilegedPrefix: setupPrivilegedPrefix }),
      buildRemoteInstallBinaryShimCommand({ sourcePath: installServerBinaryPath, destPath: shimPath, privilegedPrefix: setupPrivilegedPrefix }),
      `${setupPrivilegedPrefix}cp ${quoteRemoteShellArg(remoteEnvPath)} ${quoteRemoteShellArg(configEnvPath)}`,
      `${setupPrivilegedPrefix}cp ${quoteRemoteShellArg(remoteStatePath)} ${quoteRemoteShellArg(statePath)}`,
      staged.cleanupRemoteCommand,
    ].join('; ');

    const setupResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: setupCommands,
    });
    if (setupResult.status !== 0) {
      throw new Error(setupResult.stderr.trim() || 'Failed to install relay runtime files');
    }

    await installRemoteService({
      deps,
      ssh: params.ssh,
      knownHostsMode,
      backend,
      definitionPath,
      definitionContents,
      serviceName: defaults.serviceName,
    });

    const portRaw = renderedEnv.parsed.PORT;
    const parsedPort = typeof portRaw === 'string' ? Number.parseInt(portRaw.trim(), 10) : Number.NaN;
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : defaults.serverPort;

    const relayUrl = `http://127.0.0.1:${port}`;
    await assertRemoteRelayRuntimeHealthy({
      deps,
      ssh: params.ssh,
      knownHostsMode,
      backend,
      relayUrl,
      healthPath: defaults.healthPath,
      stderrPath,
    });

    return {
      relayUrl,
      mode,
    };
  }

  async function assertRemoteRelayRuntimeHealthy(params: Readonly<{
    deps: RelayHostEngineDeps;
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: ServiceBackend;
    relayUrl: string;
    healthPath: string;
    stderrPath: string;
  }>): Promise<void> {
    const privilegedPrefix = params.backend === 'systemd-system' || params.backend === 'launchd-system'
      ? 'sudo -n '
      : '';
    const probeCommand = buildRelayRuntimeHealthProbeCommand({
      baseUrl: params.relayUrl,
      path: params.healthPath,
      maxAttempts: 120,
      sleepSeconds: 1,
    });

    const probeResult = await params.deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: probeCommand,
    });
    const probeStdout = String(probeResult.stdout ?? '');
    if (probeResult.status === 0 || probeStdout.includes(RELAY_RUNTIME_HEALTH_OK_TOKEN)) {
      return;
    }

    const tailResult = await params.deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: `${privilegedPrefix}tail -n 80 ${quoteRemoteShellArg(params.stderrPath)} 2>/dev/null || true`,
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    const tailText = String(tailResult.stdout ?? '').trim();
    const stderrDetail = probeResult.stderr.trim();
    const message = [
      `Remote relay runtime did not become healthy at ${params.relayUrl}.`,
      probeResult.status === 3 ? 'Missing curl/wget on the remote host (required for health checks).' : '',
      `Exit status: ${probeResult.status}`,
      stderrDetail ? `Probe error: ${stderrDetail}` : '',
      tailText ? `Recent stderr:\n${tailText}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(message);
  }

  async function uninstallRemote(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<void> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const target = await resolveRemoteTarget(params.ssh, knownHostsMode);
    const platform = resolveRemotePlatform({ target });
    const mode = normalizeMode(params.parsed.mode);
    const channel = normalizeChannel(params.parsed.channel);
    const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
    const remoteHomeDir = await resolveRemoteUserHomeDir(deps, { ssh: params.ssh, knownHostsMode }) ?? resolveRemoteHomeDirForRuntime();
    const backend = resolveServiceBackend({ platform, mode });
    const serviceSpec = buildRelayRuntimeServiceSpec({
      label: defaults.serviceName,
      installRoot: defaults.installRoot,
      serverBinaryPath: `${defaults.installRoot}/bin/happier-server`,
      env: {},
      stdoutPath: `${defaults.logDir}/server.out.log`,
      stderrPath: `${defaults.logDir}/server.err.log`,
    });
    const definitionPath = resolveRemoteServiceDefinitionPath({
      backend,
      label: serviceSpec.label,
      remoteHomeDir,
    });

    const controlResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: buildRemoteControlCommand({
        backend,
        serviceName: defaults.serviceName,
        action: 'uninstall',
      }),
    });
    if (controlResult.status !== 0) {
      throw new Error(controlResult.stderr.trim() || 'Failed to uninstall relay runtime service');
    }

    const cleanupCommand = buildRemoteRelayRuntimeCleanupCommand({
      definitionPath,
      installRoot: defaults.installRoot,
      binDir: defaults.binDir,
      configDir: defaults.configDir,
      dataDir: defaults.dataDir,
      logDir: defaults.logDir,
      useSudo: backend === 'systemd-system' || backend === 'launchd-system',
    });
    const cleanupResult = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode,
      remoteCommand: cleanupCommand,
    });
    if (cleanupResult.status !== 0) {
      throw new Error(cleanupResult.stderr.trim() || 'Failed to remove relay runtime files');
    }
  }

  return {
    async readStatus(params) {
      const parsed = params;
      if (parsed.target.kind === 'ssh') {
        return await readRemoteStatus({ parsed, ssh: parsed.target.ssh });
      }
      return await readLocalStatus(parsed);
    },
    async installOrUpdate(params) {
      const parsed = params;
      if (parsed.target.kind === 'ssh') {
        return await installRemote({ parsed, ssh: parsed.target.ssh });
      }
      return await installLocal(parsed);
    },
    async control(params) {
      const parsed = params;
      if (parsed.target.kind !== 'ssh') {
        if (parsed.action === 'uninstall') {
          await uninstallLocal(parsed);
          return;
        }
        const mode = normalizeMode(parsed.mode);
        const channel = normalizeChannel(parsed.channel);
        const defaults = resolveRelayRuntimeDefaults({
          platform: process.platform,
          mode,
          channel,
          homeDir: homedir(),
        });
        const backend = resolveServiceBackend({ platform: process.platform, mode });
        const serviceName = defaults.serviceName;
        const ensureLocalRelayHealthy = async (): Promise<void> => {
          if (parsed.action !== 'start' && parsed.action !== 'restart') {
            return;
          }
          const envPath = join(defaults.configDir, 'server.env');
          const envText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
          const baseUrl = resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
            envText,
          });
          await assertLocalRelayRuntimeHealthy({
            relayUrl: baseUrl,
            healthPath: defaults.healthPath,
            stderrPath: join(defaults.logDir, 'server.err.log'),
          });
        };

        if (backend === 'systemd-user' || backend === 'systemd-system') {
          const prefix = backend === 'systemd-user' ? ['--user'] : [];
          const result = runLocalText('systemctl', [...prefix, parsed.action, `${serviceName}.service`]);
          if (result.status !== 0) {
            throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
          }
          await ensureLocalRelayHealthy();
          return;
        }

        if (backend === 'launchd-user' || backend === 'launchd-system') {
          const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
          const domain = backend === 'launchd-system' ? `system/${serviceName}` : `gui/${uid}/${serviceName}`;
          const plistPath = backend === 'launchd-system'
            ? `/Library/LaunchDaemons/${serviceName}.plist`
            : join(homedir(), 'Library', 'LaunchAgents', `${serviceName}.plist`);

          const runLaunchctl = (args: readonly string[], options: Readonly<{ allowFail?: boolean }> = {}) => {
            const result = runLocalText('launchctl', args);
            if (result.status !== 0 && options.allowFail !== true) {
              throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
            }
            return result;
          };

          if (parsed.action === 'stop') {
            runLaunchctl(['bootout', domain], { allowFail: true });
            return;
          }

          if (parsed.action === 'restart') {
            const kickstartResult = runLaunchctl(['kickstart', '-k', domain], { allowFail: true });
            if (kickstartResult.status === 0) {
              await ensureLocalRelayHealthy();
              return;
            }
          }

          if (backend === 'launchd-user' && uid > 0) {
            runLaunchctl(['bootout', domain], { allowFail: true });
            runLaunchctl(['bootstrap', `gui/${uid}`, plistPath]);
            runLaunchctl(['enable', domain]);
            runLaunchctl(['kickstart', '-k', domain]);
            await ensureLocalRelayHealthy();
            return;
          }

          if (backend === 'launchd-system') {
            runLaunchctl(['bootout', domain], { allowFail: true });
            runLaunchctl(['bootstrap', 'system', plistPath]);
            runLaunchctl(['enable', domain]);
            runLaunchctl(['kickstart', '-k', domain]);
            await ensureLocalRelayHealthy();
            return;
          }

          runLaunchctl(['kickstart', '-k', domain]);
          await ensureLocalRelayHealthy();
          return;
        }

        const taskName = `Happier\\${serviceName}`;
        const args = parsed.action === 'stop'
          ? ['/End', '/TN', taskName]
          : ['/Run', '/TN', taskName];
        const result = runLocalText('schtasks', args);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
        }
        await ensureLocalRelayHealthy();
        return;
      }
      const knownHostsMode: 'app' | 'system' = parsed.target.ssh.knownHostsPath ? 'app' : 'system';
      const target = await resolveRemoteTarget(parsed.target.ssh, knownHostsMode);
      const platform = resolveRemotePlatform({ target });
      const mode = normalizeMode(parsed.mode);
      const channel = normalizeChannel(parsed.channel);
      const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
      const backend = resolveServiceBackend({ platform, mode });
      if (parsed.action === 'uninstall') {
        await uninstallRemote({ parsed, ssh: parsed.target.ssh });
        return;
      }
      const result = await deps.runRemoteText({
        ssh: parsed.target.ssh,
        knownHostsMode,
        remoteCommand: buildRemoteControlCommand({
          backend,
          serviceName: defaults.serviceName,
          action: parsed.action,
        }),
      });
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
      }
      if (parsed.action === 'start' || parsed.action === 'restart') {
        const status = await readRemoteStatus({ parsed, ssh: parsed.target.ssh });
        await assertRemoteRelayRuntimeHealthy({
          deps,
          ssh: parsed.target.ssh,
          knownHostsMode,
          backend,
          relayUrl: status.baseUrl,
          healthPath: defaults.healthPath,
          stderrPath: `${defaults.logDir}/server.err.log`,
        });
      }
    },
  };
}
