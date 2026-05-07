import { createHash } from 'node:crypto';
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
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildServiceDefinition,
  parseWindowsScheduledTaskStatusPowerShellJson,
  planServiceAction,
  resolveServiceBackend,
  type ServiceBackend,
  type ServiceSpec,
} from '../service/index.js';
import { buildLaunchdPlistXml } from '../service/launchd.js';
import { renderSystemdServiceUnit } from '../service/systemd.js';
import { checkRelayRuntimeHealth, resolveRelayRuntimeDefaults, type RelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';
import {
  installOrUpdateRelayRuntimeLocal,
  shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot,
} from '../firstPartyRuntime/relayRuntimeInstall.js';
import { resolveNonCollidingRelayPort } from '../firstPartyRuntime/resolveNonCollidingRelayPort.js';
import {
  mergeSelfHostServerEnvText,
  parseEnvText,
  resolveSelfHostSqliteAutoMigrateValue,
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
  timeoutMs: number;
}>): Promise<boolean> {
  const parsedUrl = new URL(params.baseUrl);
  const port = Number.parseInt(parsedUrl.port, 10);
  const result = await checkRelayRuntimeHealth({
    host: parsedUrl.hostname,
    port: Number.isInteger(port) && port > 0 ? port : 80,
    path: params.healthPath,
    timeoutMs: params.timeoutMs,
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
  const existingEnvText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';

  // Resolve the port we'll advertise for this channel. When there's no
  // existing server.env for this channel AND the user didn't explicitly pass
  // a PORT override, avoid colliding with another channel's relay on the
  // same machine: each channel stores independent data, so two relays on
  // the same URL would share a profile id and cross-wire daemon state.
  const existingPortRaw = existingEnvText ? String(parseEnvText(existingEnvText).PORT ?? '').trim() : '';
  const overridePortRaw = String((params.envOverrides ?? {}).PORT ?? '').trim();
  const configuredPortRaw = overridePortRaw || existingPortRaw;
  const configuredPort = configuredPortRaw && Number.isInteger(Number.parseInt(configuredPortRaw, 10))
    ? Number.parseInt(configuredPortRaw, 10)
    : null;
  const resolvedPort = await resolveNonCollidingRelayPort({
    platform: process.platform,
    mode: params.mode,
    channel: params.channel,
    homeDir: homedir(),
    defaultPort: defaults.serverPort,
    configuredPort,
  });

  const baseEnvText = renderSelfHostServerEnvTextFromResolvedValues({
    port: resolvedPort,
    host: defaults.serverHost,
    dataDir: defaults.dataDir,
    filesDir: join(defaults.dataDir, 'files'),
    dbDir: join(defaults.dataDir, 'pglite'),
    databaseUrl: `file:${join(defaults.dataDir, 'happier-server-light.sqlite')}`,
    sqliteAutoMigrate: resolveSelfHostSqliteAutoMigrateValue(),
    sqliteMigrationsDir: join(defaults.dataDir, 'migrations', 'sqlite'),
  });
  const envText = mergeSelfHostServerEnvText({
    baseEnvText,
    existingEnvText,
    overrides: params.envOverrides,
  });
  return resolveConfiguredSelfHostBaseUrl({
    fallbackBaseUrl: `http://${defaults.serverHost}:${resolvedPort}`,
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
    sqliteAutoMigrate: resolveSelfHostSqliteAutoMigrateValue(),
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
    sqliteAutoMigrate: resolveSelfHostSqliteAutoMigrateValue(),
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

function parseSystemctlShowOutput(stdout: string): Readonly<{ unitFileState: string; activeState: string; subState: string; loadState: string }> {
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
  const loadState = map.get('loadstate') ?? '';
  return { unitFileState, activeState, subState, loadState };
}

function normalizeComparablePathKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim().replace(/[\\/]+$/, '');
  return trimmed || null;
}

function resolveSystemdUnitDefinitionPath(params: Readonly<{
  backend: 'systemd-user' | 'systemd-system';
  unitName: string;
  homeDir: string;
}>): string {
  const filename = `${params.unitName}.service`;
  if (params.backend === 'systemd-system') {
    return join('/etc/systemd/system', filename);
  }
  return join(params.homeDir, '.config', 'systemd', 'user', filename);
}

function resolveLaunchdPlistDefinitionPath(params: Readonly<{
  backend: 'launchd-user' | 'launchd-system';
  label: string;
  homeDir: string;
}>): string {
  const filename = `${params.label}.plist`;
  if (params.backend === 'launchd-system') {
    return join('/Library/LaunchDaemons', filename);
  }
  return join(params.homeDir, 'Library', 'LaunchAgents', filename);
}

function resolveWindowsWrapperDefinitionPath(params: Readonly<{
  backend: 'schtasks-user' | 'schtasks-system';
  label: string;
  homeDir: string;
}>): string {
  if (params.backend === 'schtasks-system') {
    return `C:\\ProgramData\\happier\\services\\${params.label}.ps1`;
  }
  return `${params.homeDir}\\.happier\\services\\${params.label}.ps1`;
}

function parseSystemdUnitWorkingDirectory(unitText: string): string | null {
  const lines = String(unitText ?? '').split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (!trimmed.toLowerCase().startsWith('workingdirectory=')) continue;
    const value = trimmed.slice('WorkingDirectory='.length).trim();
    return value || null;
  }
  return null;
}

function parseSystemdUnitEnvironmentText(unitText: string): string {
  const entries: string[] = [];
  for (const line of String(unitText ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    if (!trimmed.toLowerCase().startsWith('environment=')) continue;
    const raw = trimmed.slice('Environment='.length).trim();
    if (!raw) continue;
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(unquoted)) continue;
    entries.push(unquoted);
  }
  return entries.join('\n');
}

function xmlUnescape(value: string): string {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function parseLaunchdPlistWorkingDirectory(plistText: string): string | null {
  const match = String(plistText ?? '').match(/<key>\s*WorkingDirectory\s*<\/key>\s*<string>([\s\S]*?)<\/string>/iu);
  const value = match?.[1]?.trim();
  return value ? xmlUnescape(value) : null;
}

function parseWindowsWrapperWorkingDirectory(wrapperText: string): string | null {
  const match = String(wrapperText ?? '').match(/Set-Location\s+-LiteralPath\s+"((?:`.|[^"])*)"/iu);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  return raw.replace(/`(["`])/gu, '$1') || null;
}

function parseServiceDefinitionWorkingDirectory(params: Readonly<{
  backend: ServiceBackend;
  definitionText: string;
}>): string | null {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    return parseSystemdUnitWorkingDirectory(params.definitionText);
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    return parseLaunchdPlistWorkingDirectory(params.definitionText);
  }
  if (params.backend === 'schtasks-user' || params.backend === 'schtasks-system') {
    return parseWindowsWrapperWorkingDirectory(params.definitionText);
  }
  return null;
}

function resolveServiceDefinitionBaseUrl(params: Readonly<{
  backend: ServiceBackend;
  definitionText: string;
  fallbackBaseUrl: string;
}>): string | null {
  if (params.backend !== 'systemd-user' && params.backend !== 'systemd-system') {
    return null;
  }
  const envText = parseSystemdUnitEnvironmentText(params.definitionText);
  if (!envText.trim()) return null;
  return resolveConfiguredSelfHostBaseUrl({
    fallbackBaseUrl: params.fallbackBaseUrl,
    envText,
  });
}

type LocalRelayStrandedLegacyState = Readonly<{
  legacyInstallRoot: string;
  currentInstallRoot: string;
}>;

async function readComparableFileHash(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const contents = await readFile(path).catch(() => null);
  if (!contents) return null;
  return createHash('sha256').update(contents).digest('hex');
}

function renderLocalRelayStrandedLegacyStateMessage(params: Readonly<{
  channel: PublicReleaseRingId;
  legacyInstallRoot: string;
  currentInstallRoot: string;
}>): string {
  return `Detected older ${formatRelayChannelLabel(params.channel)} relay state at ${params.legacyInstallRoot} beside the current relay root ${params.currentInstallRoot}. `
    + 'The two roots use different data secrets, so auth/session data may be split between them. '
    + 'Automatic recovery is unsafe once both roots exist; inspect or restore the older root before reinstalling or reauthenticating this relay.';
}

function relayRuntimeStateMatchesRequestedLane(params: Readonly<{
  state: Record<string, unknown>;
  channel: PublicReleaseRingId;
  mode: 'user' | 'system';
}>): boolean {
  const stateChannel = String(params.state.channel ?? '').trim();
  const stateMode = String(params.state.mode ?? '').trim();
  const channelMatches = stateChannel === params.channel
    || (params.channel === 'publicdev' && stateChannel === 'dev');
  const modeMatches = !stateMode || stateMode === params.mode;
  return channelMatches && modeMatches;
}

async function detectLocalRelayStrandedLegacyState(params: Readonly<{
  backend: ServiceBackend;
  channel: PublicReleaseRingId;
  defaults: RelayRuntimeDefaults;
  currentBaseUrl: string;
}>): Promise<LocalRelayStrandedLegacyState | null> {
  if (params.channel === 'stable') return null;
  if (params.backend !== 'systemd-user' && params.backend !== 'systemd-system') return null;

  const legacyDefinitionPath = resolveSystemdUnitDefinitionPath({
    backend: params.backend,
    unitName: 'happier-server',
    homeDir: homedir(),
  });
  if (!existsSync(legacyDefinitionPath)) return null;

  const legacyText = await readFile(legacyDefinitionPath, 'utf8').catch(() => '');
  if (!legacyText.trim()) return null;

  const legacyInstallRoot = parseSystemdUnitWorkingDirectory(legacyText);
  const legacyKey = normalizeComparablePathKey(legacyInstallRoot);
  const currentKey = normalizeComparablePathKey(params.defaults.installRoot);
  if (!legacyKey || !currentKey || legacyKey === currentKey) return null;
  const resolvedLegacyInstallRoot = legacyKey;

  const legacyBaseUrl = resolveServiceDefinitionBaseUrl({
    backend: params.backend,
    definitionText: legacyText,
    fallbackBaseUrl: params.currentBaseUrl,
  });
  if (legacyBaseUrl !== params.currentBaseUrl) return null;

  const legacyStatePath = join(resolvedLegacyInstallRoot, 'self-host-state.json');
  if (existsSync(legacyStatePath)) {
    const legacyStateText = await readFile(legacyStatePath, 'utf8').catch(() => '');
    const legacyState = tryParseJsonObject(legacyStateText);
    if (legacyState && !relayRuntimeStateMatchesRequestedLane({
      state: legacyState,
      channel: params.channel,
      mode: params.defaults.mode,
    })) {
      return null;
    }
  }

  const legacyDbPath = join(resolvedLegacyInstallRoot, 'data', 'happier-server-light.sqlite');
  const currentDbPath = join(params.defaults.dataDir, 'happier-server-light.sqlite');
  if (!existsSync(legacyDbPath) || !existsSync(currentDbPath)) return null;

  const legacySecretHash = await readComparableFileHash(join(resolvedLegacyInstallRoot, 'data', 'handy-master-secret.txt'));
  const currentSecretHash = await readComparableFileHash(join(params.defaults.dataDir, 'handy-master-secret.txt'));
  if (!legacySecretHash || !currentSecretHash || legacySecretHash === currentSecretHash) return null;

  return {
    legacyInstallRoot: resolvedLegacyInstallRoot,
    currentInstallRoot: params.defaults.installRoot,
  };
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

function buildRemoteRelayRuntimeShutdownWaitCommand(params: Readonly<{
  baseUrl: string;
  path: string;
  maxAttempts: number;
  sleepSeconds: number;
}>): string {
  const probeCommand = buildRelayRuntimeHealthProbeCommand({
    baseUrl: params.baseUrl,
    path: params.path,
    maxAttempts: 1,
    sleepSeconds: 0,
  });
  const maxAttempts = Number.isFinite(params.maxAttempts) && params.maxAttempts > 0
    ? Math.floor(params.maxAttempts)
    : 1;
  const sleepSeconds = Number.isFinite(params.sleepSeconds) && params.sleepSeconds >= 0
    ? Math.floor(params.sleepSeconds)
    : 1;

  return [
    'set -eu',
    'i=0',
    `MAX=${maxAttempts}`,
    'while [ "$i" -lt "$MAX" ]; do',
    '  if ! (',
    ...probeCommand.split('\n').map((line) => `    ${line}`),
    '  ); then',
    '    exit 0',
    '  fi',
    '  i=$((i+1))',
    `  sleep ${sleepSeconds}`,
    'done',
    'exit 1',
  ].join('\n');
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
  legacySystemdServiceNameToRemove?: string;
  legacySystemdDefinitionPathToRemove?: string;
  legacyLaunchdServiceNameToRemove?: string;
  legacyLaunchdDefinitionPathToRemove?: string;
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
  const parsedBaseUrl = resolveServiceDefinitionBaseUrl({
    backend: params.backend,
    definitionText: params.definitionContents,
    fallbackBaseUrl: 'http://127.0.0.1:3005',
  }) ?? 'http://127.0.0.1:3005';
  const shutdownWaitCommand = buildRemoteRelayRuntimeShutdownWaitCommand({
    baseUrl: parsedBaseUrl,
    path: '/v1/version',
    maxAttempts: 120,
    sleepSeconds: 1,
  });
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
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const prefix = params.backend === 'systemd-user' ? '--user ' : '';
    installCommands.push(`${privilegedPrefix}systemctl ${prefix}stop ${quoteRemoteShellArg(`${params.serviceName}.service`)}`);
    installCommands.push(shutdownWaitCommand);
  } else if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const plistPath = quoteRemoteShellArg(remoteDefinitionPath);
    installCommands.push(`${privilegedPrefix}launchctl unload -w ${plistPath} 2>/dev/null || true`);
    installCommands.push(shutdownWaitCommand);
  }
  installCommands.push(`${privilegedPrefix}cp ${quoteRemoteShellArg(remoteStagedDefinitionPath)} ${quoteRemoteShellArg(remoteDefinitionPath)}`);

  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const prefix = params.backend === 'systemd-user' ? '--user ' : '';
    const legacyServiceName = String(params.legacySystemdServiceNameToRemove ?? '').trim();
    const legacyDefinitionPath = String(params.legacySystemdDefinitionPathToRemove ?? '').trim();
    if (legacyServiceName && legacyDefinitionPath) {
      const legacySvc = `${legacyServiceName}.service`;
      if (params.backend === 'systemd-user') {
        installCommands.push(`${wrapRemoteSystemdUserCommand(`systemctl --user disable --now ${quoteRemoteShellArg(legacySvc)}`)} 2>/dev/null || true`);
        installCommands.push(`rm -f ${quoteRemoteShellArg(legacyDefinitionPath)} 2>/dev/null || true`);
      } else {
        installCommands.push(`${privilegedPrefix}systemctl disable --now ${quoteRemoteShellArg(legacySvc)} 2>/dev/null || true`);
        installCommands.push(`${privilegedPrefix}rm -f ${quoteRemoteShellArg(legacyDefinitionPath)} 2>/dev/null || true`);
      }
    }
    if (params.backend === 'systemd-user') {
      installCommands.push(wrapRemoteSystemdUserCommand(`systemctl --user daemon-reload`));
      installCommands.push(wrapRemoteSystemdUserCommand(`systemctl --user enable ${quoteRemoteShellArg(`${params.serviceName}.service`)}`));
      installCommands.push(wrapRemoteSystemdUserCommand(`systemctl --user start ${quoteRemoteShellArg(`${params.serviceName}.service`)}`));
    } else {
      installCommands.push(`${privilegedPrefix}systemctl ${prefix}daemon-reload`);
      installCommands.push(`${privilegedPrefix}systemctl ${prefix}enable ${quoteRemoteShellArg(`${params.serviceName}.service`)}`);
      installCommands.push(`${privilegedPrefix}systemctl ${prefix}start ${quoteRemoteShellArg(`${params.serviceName}.service`)}`);
    }
  } else if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const legacyServiceName = String(params.legacyLaunchdServiceNameToRemove ?? '').trim();
    const legacyDefinitionPath = String(params.legacyLaunchdDefinitionPathToRemove ?? '').trim();
    if (legacyServiceName && legacyDefinitionPath) {
      const legacyPlist = quoteRemoteShellArg(legacyDefinitionPath);
      installCommands.push(`${privilegedPrefix}launchctl unload -w ${legacyPlist} 2>/dev/null || true`);
      installCommands.push(`${privilegedPrefix}launchctl remove ${quoteRemoteShellArg(legacyServiceName)} 2>/dev/null || true`);
      installCommands.push(`${privilegedPrefix}rm -f ${legacyPlist} 2>/dev/null || true`);
    }
    const plist = quoteRemoteShellArg(remoteDefinitionPath);
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
    throw mapRelayRuntimeServiceControlError({
      backend: params.backend,
      stderr: result.stderr,
      fallbackMessage: 'Failed to install relay service',
    });
  }
}

function mapRelayRuntimeServiceControlError(params: Readonly<{
  backend: ServiceBackend;
  stderr: string | null | undefined;
  fallbackMessage: string;
}>): Error {
  const stderr = String(params.stderr ?? '').trim();
  if (params.backend === 'systemd-user' && /failed to connect to bus/i.test(stderr)) {
    return new Error('Systemd user service is unavailable. Ensure the host has a user systemd session (e.g. enable lingering) or use system mode.');
  }
  return new Error(stderr || params.fallbackMessage);
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

  const resolveSystemdUnitExists = (params: Readonly<{
    backend: ServiceBackend;
    unitName: string;
  }>): boolean => {
    if (params.backend !== 'systemd-user' && params.backend !== 'systemd-system') {
      return false;
    }
    const prefix = params.backend === 'systemd-user' ? ['--user'] : [];
    const result = runLocalText('systemctl', [...prefix, 'show', `${params.unitName}.service`, '--property=LoadState']);
    if (result.status !== 0) {
      return false;
    }
    const loadState = parseSystemctlShowOutput(result.stdout).loadState.trim().toLowerCase();
    return Boolean(loadState && loadState !== 'not-found');
  };

  const resolveLocalSystemdUnitOwnedByInstallRoot = async (params: Readonly<{
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const unitPath = resolveSystemdUnitDefinitionPath({
      backend: params.backend,
      unitName: params.unitName,
      homeDir: homedir(),
    });
    const unitText = existsSync(unitPath) ? await readFile(unitPath, 'utf8').catch(() => '') : '';
    const workingDir = parseSystemdUnitWorkingDirectory(unitText);
    const workingDirKey = normalizeComparablePathKey(workingDir);
    const installRootKey = normalizeComparablePathKey(params.installRoot);
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const resolveLocalLaunchdPlistOwnedByInstallRoot = async (params: Readonly<{
    backend: 'launchd-user' | 'launchd-system';
    label: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const plistPath = resolveLaunchdPlistDefinitionPath({
      backend: params.backend,
      label: params.label,
      homeDir: homedir(),
    });
    const plistText = existsSync(plistPath) ? await readFile(plistPath, 'utf8').catch(() => '') : '';
    const workingDir = parseLaunchdPlistWorkingDirectory(plistText);
    const workingDirKey = normalizeComparablePathKey(workingDir);
    const installRootKey = normalizeComparablePathKey(params.installRoot);
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const resolveLocalSystemdUnitState = (params: Readonly<{
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
  }>): Readonly<{ loadState: string; activeState: string; enabledState: string }> => {
    const prefix = params.backend === 'systemd-user' ? ['--user'] : [];
    const result = runLocalText('systemctl', [
      ...prefix,
      'show',
      `${params.unitName}.service`,
      '--property=UnitFileState,ActiveState,SubState,LoadState',
    ]);
    if (result.status !== 0) {
      return { loadState: 'not-found', activeState: '', enabledState: '' };
    }
    const parsed = parseSystemctlShowOutput(result.stdout);
    return {
      loadState: parsed.loadState.trim().toLowerCase() || 'not-found',
      activeState: parsed.activeState.trim().toLowerCase(),
      enabledState: parsed.unitFileState.trim().toLowerCase(),
    };
  };

  const resolveLocalLaunchdServiceState = (params: Readonly<{
    backend: 'launchd-user' | 'launchd-system';
    label: string;
  }>): Readonly<{ loadState: string; activeState: string; enabledState: string }> => {
    const result = runLocalText('launchctl', ['list', params.label]);
    return result.status === 0
      ? { loadState: 'loaded', activeState: 'active', enabledState: 'enabled' }
      : { loadState: 'not-found', activeState: '', enabledState: '' };
  };

  const resolveLocalWindowsScheduledTaskState = (params: Readonly<{
    label: string;
  }>): Readonly<{ loadState: string; activeState: string; enabledState: string }> => {
    const result = runLocalText('schtasks', ['/Query', '/TN', `Happier\\${params.label}`, '/FO', 'LIST', '/V']);
    const powerShellStatus = runLocalText('powershell.exe', [
      '-NoProfile',
      '-Command',
      buildReadWindowsScheduledTaskStatusPowerShellCommand({
        taskName: params.label,
      }),
    ]);
    const parsedPowerShellStatus = powerShellStatus.status === 0
      ? parseWindowsScheduledTaskStatusPowerShellJson(powerShellStatus.stdout)
      : null;
    if (parsedPowerShellStatus) {
      return parsedPowerShellStatus.exists
        ? {
            loadState: 'loaded',
            activeState: parsedPowerShellStatus.active ? 'active' : 'inactive',
            enabledState: parsedPowerShellStatus.enabled ? 'enabled' : 'disabled',
          }
        : { loadState: 'not-found', activeState: '', enabledState: '' };
    }
    if (result.status !== 0) {
      return { loadState: 'not-found', activeState: '', enabledState: '' };
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      loadState: 'loaded',
      activeState: /Status:\s*Running/i.test(output) ? 'active' : 'inactive',
      enabledState: /Scheduled Task State:\s*Enabled/i.test(output) ? 'enabled' : 'disabled',
    };
  };

  const resolveLocalServiceOwnedByInstallRoot = async (params: Readonly<{
    backend: ServiceBackend;
    label: string;
    installRoot: string;
  }>): Promise<boolean> => {
    if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
      return resolveLocalSystemdUnitOwnedByInstallRoot({
        backend: params.backend,
        unitName: params.label,
        installRoot: params.installRoot,
      });
    }
    if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
      return resolveLocalLaunchdPlistOwnedByInstallRoot({
        backend: params.backend,
        label: params.label,
        installRoot: params.installRoot,
      });
    }
    if (params.backend === 'schtasks-user' || params.backend === 'schtasks-system') {
      const definitionPath = resolveWindowsWrapperDefinitionPath({
        backend: params.backend,
        label: params.label,
        homeDir: homedir(),
      });
      const definitionText = existsSync(definitionPath) ? await readFile(definitionPath, 'utf8').catch(() => '') : '';
      const workingDir = parseWindowsWrapperWorkingDirectory(definitionText);
      const workingDirKey = normalizeComparablePathKey(workingDir);
      const installRootKey = normalizeComparablePathKey(params.installRoot);
      return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
    }
    return false;
  };

  const resolveLocalEffectiveServiceName = async (params: Readonly<{
    backend: ServiceBackend;
    channel: PublicReleaseRingId;
    defaults: RelayRuntimeDefaults;
  }>): Promise<string> => {
    if (params.channel === 'stable') {
      return params.defaults.serviceName;
    }
    if (
      params.backend !== 'systemd-user'
      && params.backend !== 'systemd-system'
      && params.backend !== 'launchd-user'
      && params.backend !== 'launchd-system'
      && params.backend !== 'schtasks-user'
      && params.backend !== 'schtasks-system'
    ) {
      return params.defaults.serviceName;
    }

    const legacyUnitName = 'happier-server';
    const legacyOwnedByInstallRoot = await resolveLocalServiceOwnedByInstallRoot({
      backend: params.backend,
      label: legacyUnitName,
      installRoot: params.defaults.installRoot,
    }).catch(() => false);
    if (!legacyOwnedByInstallRoot) {
      return params.defaults.serviceName;
    }

    const readState = (label: string) => {
      if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
        return resolveLocalSystemdUnitState({
          backend: params.backend,
          unitName: label,
        });
      }
      if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
        return resolveLocalLaunchdServiceState({
          backend: params.backend,
          label,
        });
      }
      return resolveLocalWindowsScheduledTaskState({ label });
    };

    const canonicalState = readState(params.defaults.serviceName);
    if (canonicalState.loadState === 'not-found') {
      return legacyUnitName;
    }

    const canonicalOwnedByInstallRoot = await resolveLocalServiceOwnedByInstallRoot({
      backend: params.backend,
      label: params.defaults.serviceName,
      installRoot: params.defaults.installRoot,
    }).catch(() => false);
    if (!canonicalOwnedByInstallRoot) {
      return legacyUnitName;
    }

    const legacyState = readState(legacyUnitName);
    const canonicalActive = canonicalState.activeState === 'active';
    const legacyActive = legacyState.activeState === 'active';
    if (canonicalActive !== legacyActive) {
      return legacyActive ? legacyUnitName : params.defaults.serviceName;
    }

    return params.defaults.serviceName;
  };

  const materializeRemoteHomeDir = (remoteHomeDir: string, value: string): string => {
    const raw = String(value ?? '');
    if (!raw) return raw;
    if (remoteHomeDir.startsWith('/') && raw.includes('$HOME')) {
      return raw.replaceAll('$HOME', remoteHomeDir);
    }
    return raw;
  };

  const resolveRemoteSystemdUnitState = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
  }>): Promise<Readonly<{ loadState: string; activeState: string }>> => {
    const svc = `${params.unitName}.service`;
    const remoteCommand = params.backend === 'systemd-user'
      ? wrapRemoteSystemdUserCommand(`systemctl --user show ${quoteRemoteShellArg(svc)} --property=LoadState,ActiveState`)
      : `systemctl show ${quoteRemoteShellArg(svc)} --property=LoadState,ActiveState`;
    const result = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand,
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    if (result.status !== 0) return { loadState: 'not-found', activeState: '' };
    const parsed = parseSystemctlShowOutput(String(result.stdout ?? ''));
    const loadState = parsed.loadState.trim().toLowerCase();
    const activeState = parsed.activeState.trim().toLowerCase();
    return { loadState: loadState || 'not-found', activeState };
  };

  const resolveRemoteSystemdUnitLoadState = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'systemd-user' | 'systemd-system';
    unitName: string;
  }>): Promise<string> => {
    return (await resolveRemoteSystemdUnitState(params)).loadState;
  };

	  const resolveRemoteSystemdUnitOwnedByInstallRoot = async (params: Readonly<{
	    ssh: SystemTaskSshConnectionConfig;
	    knownHostsMode: 'app' | 'system';
	    backend: 'systemd-user' | 'systemd-system';
	    unitName: string;
	    remoteHomeDir: string;
	    installRoot: string;
	  }>): Promise<boolean> => {
	    const unitPath = resolveRemoteServiceDefinitionPath({
	      backend: params.backend,
	      label: params.unitName,
	      remoteHomeDir: params.remoteHomeDir,
	    });
	    const privilegedPrefix = params.backend === 'systemd-system' ? 'sudo -n ' : '';
	    const unitText = await deps.runRemoteText({
	      ssh: params.ssh,
	      knownHostsMode: params.knownHostsMode,
	      remoteCommand: buildRemoteReadTextFileCommand({ path: unitPath, privilegedPrefix }),
	    }).then((result) => String(result.stdout ?? '')).catch(() => '');
	    const workingDir = parseSystemdUnitWorkingDirectory(unitText);
	    const workingDirKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, String(workingDir ?? '')));
	    const installRootKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, params.installRoot));
		    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
		  };

  const resolveRemoteLaunchdServiceState = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'launchd-user' | 'launchd-system';
    label: string;
  }>): Promise<Readonly<{ loadState: string; activeState: string }>> => {
    const sudoSetup = params.backend === 'launchd-system'
      ? "SUDO_PREFIX=''; if [ \"$(id -u)\" -ne 0 ]; then SUDO_PREFIX=\"sudo -n \"; fi; "
      : '';
    const privilegedPrefix = params.backend === 'launchd-system' ? '${SUDO_PREFIX}' : '';
    const result = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: `${sudoSetup}${privilegedPrefix}launchctl list ${quoteRemoteShellArg(params.label)}`,
    }).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    return result.status === 0
      ? { loadState: 'loaded', activeState: 'active' }
      : { loadState: 'not-found', activeState: '' };
  };

  const resolveRemoteLaunchdPlistOwnedByInstallRoot = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: 'launchd-user' | 'launchd-system';
    label: string;
    remoteHomeDir: string;
    installRoot: string;
  }>): Promise<boolean> => {
    const plistPath = resolveRemoteServiceDefinitionPath({
      backend: params.backend,
      label: params.label,
      remoteHomeDir: params.remoteHomeDir,
    });
    const privilegedPrefix = params.backend === 'launchd-system' ? 'sudo -n ' : '';
    const plistText = await deps.runRemoteText({
      ssh: params.ssh,
      knownHostsMode: params.knownHostsMode,
      remoteCommand: buildRemoteReadTextFileCommand({ path: plistPath, privilegedPrefix }),
    }).then((result) => String(result.stdout ?? '')).catch(() => '');
    const workingDir = parseLaunchdPlistWorkingDirectory(plistText);
    const workingDirKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, String(workingDir ?? '')));
    const installRootKey = normalizeComparablePathKey(materializeRemoteHomeDir(params.remoteHomeDir, params.installRoot));
    return Boolean(workingDirKey && installRootKey && workingDirKey === installRootKey);
  };

  const resolveRemoteEffectiveServiceName = async (params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode: 'app' | 'system';
    backend: ServiceBackend;
    channel: PublicReleaseRingId;
    remoteHomeDir: string;
    defaults: RelayRuntimeDefaults;
  }>): Promise<string> => {
    if (
      params.backend !== 'systemd-user'
      && params.backend !== 'systemd-system'
      && params.backend !== 'launchd-user'
      && params.backend !== 'launchd-system'
    ) {
      return params.defaults.serviceName;
    }
    if (params.channel === 'stable') {
      return params.defaults.serviceName;
    }

    const legacyUnitName = 'happier-server';
    const legacyOwnedByInstallRoot = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: legacyUnitName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false)
      : await resolveRemoteLaunchdPlistOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: legacyUnitName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false);
    if (!legacyOwnedByInstallRoot) {
      return params.defaults.serviceName;
    }

    const canonicalState = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: params.defaults.serviceName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }))
      : await resolveRemoteLaunchdServiceState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: params.defaults.serviceName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }));
    if (canonicalState.loadState === 'not-found') {
      return legacyUnitName;
    }

    const canonicalOwnedByInstallRoot = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: params.defaults.serviceName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false)
      : await resolveRemoteLaunchdPlistOwnedByInstallRoot({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: params.defaults.serviceName,
        remoteHomeDir: params.remoteHomeDir,
        installRoot: params.defaults.installRoot,
      }).catch(() => false);
    if (!canonicalOwnedByInstallRoot) {
      return legacyUnitName;
    }

    const legacyState = params.backend === 'systemd-user' || params.backend === 'systemd-system'
      ? await resolveRemoteSystemdUnitState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        unitName: legacyUnitName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }))
      : await resolveRemoteLaunchdServiceState({
        ssh: params.ssh,
        knownHostsMode: params.knownHostsMode,
        backend: params.backend,
        label: legacyUnitName,
      }).catch(() => ({ loadState: 'not-found', activeState: '' }));
    const canonicalActive = canonicalState.activeState === 'active';
    const legacyActive = legacyState.activeState === 'active';
    if (canonicalActive !== legacyActive) {
      return legacyActive ? legacyUnitName : params.defaults.serviceName;
    }

    return params.defaults.serviceName;
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

    const effectiveServiceName = await resolveLocalEffectiveServiceName({
      backend,
      channel,
      defaults,
    });

    const service = await (async () => {
      if (backend === 'systemd-user' || backend === 'systemd-system') {
        const snapshot = resolveLocalSystemdUnitState({
          backend,
          unitName: effectiveServiceName,
        });
        if (snapshot.loadState === 'not-found') return { enabled: null, active: null };
        return {
          enabled: snapshot.enabledState === 'enabled',
          active: snapshot.activeState === 'active',
        };
      }
      if (backend === 'launchd-user' || backend === 'launchd-system') {
        const snapshot = resolveLocalLaunchdServiceState({
          backend,
          label: effectiveServiceName,
        });
        if (snapshot.loadState === 'not-found') {
          return { enabled: null, active: null };
        }
        return { enabled: true, active: true };
      }
      const snapshot = resolveLocalWindowsScheduledTaskState({
        label: effectiveServiceName,
      });
      if (snapshot.loadState === 'not-found') {
        return { enabled: null, active: null };
      }
      return {
        enabled: snapshot.enabledState === 'enabled',
        active: snapshot.activeState === 'active',
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
        timeoutMs: 1_500,
      }).catch(() => false)
      : service.active === null
        ? null
        : false;
    const strandedLegacyState = await detectLocalRelayStrandedLegacyState({
      backend,
      channel,
      defaults,
      currentBaseUrl: baseUrl,
    });

    return {
      installed,
      version,
      service,
      baseUrl,
      healthy,
      ...(strandedLegacyState ? {
        warnings: [renderLocalRelayStrandedLegacyStateMessage({
          channel,
          legacyInstallRoot: strandedLegacyState.legacyInstallRoot,
          currentInstallRoot: strandedLegacyState.currentInstallRoot,
        })],
      } : {}),
    };
  }

  async function installLocal(parsed: RelayRuntimeTaskParams): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
    const defaults = resolveRelayRuntimeDefaults({
      platform: process.platform,
      mode,
      channel,
      homeDir: homedir(),
    });
    const backend = resolveServiceBackend({ platform: process.platform, mode }) as ServiceBackend;
    const desiredRelayUrl = await resolveLocalDesiredRelayUrl({
      mode,
      channel,
      envOverrides: parsed.env,
    });

    // Surface port reassignment so users aren't surprised that dev landed on
    // an ephemeral port instead of the default 3005. The reassignment happens
    // transparently in resolveLocalDesiredRelayUrl when another channel
    // already owns the default port. Writes to stderr so it doesn't pollute
    // the JSON output envelope.
    try {
      const desiredPort = Number.parseInt(new URL(desiredRelayUrl).port, 10);
      if (Number.isInteger(desiredPort) && desiredPort !== defaults.serverPort) {
        const configuredEnvPath = join(defaults.configDir, 'server.env');
        const hadExistingEnv = existsSync(configuredEnvPath);
        const hadPortOverride = Boolean(String((parsed.env ?? {}).PORT ?? '').trim());
        if (!hadExistingEnv && !hadPortOverride) {
          process.stderr.write(
            `[relay-host] Port ${defaults.serverPort} is already used by another channel's relay; `
            + `installing ${formatRelayChannelLabel(channel)} on port ${desiredPort} (data is independent per channel).\n`,
          );
        }
      }
    } catch {
      // Best-effort notice; don't block install on URL parsing.
    }

    const shouldTreatStableLaneAsLegacyUnsuffixedInstall = await (async () => {
      return await shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot({
        platform: process.platform,
        mode,
        channel,
        homeDir: homedir(),
      });
    })();

    const ignoreStableLaneConflict = await (async () => {
      if (channel === 'stable') return false;
      const legacyUnitName = 'happier-server';
      const legacyDefinitionPath =
        backend === 'systemd-user' || backend === 'systemd-system'
          ? resolveSystemdUnitDefinitionPath({ backend, unitName: legacyUnitName, homeDir: homedir() })
          : backend === 'launchd-user' || backend === 'launchd-system'
            ? resolveLaunchdPlistDefinitionPath({ backend, label: legacyUnitName, homeDir: homedir() })
            : backend === 'schtasks-user' || backend === 'schtasks-system'
              ? resolveWindowsWrapperDefinitionPath({ backend, label: legacyUnitName, homeDir: homedir() })
              : '';
      if (!legacyDefinitionPath) return false;
      const legacyText = existsSync(legacyDefinitionPath) ? await readFile(legacyDefinitionPath, 'utf8').catch(() => '') : '';
      if (!legacyText.trim()) return false;
      const legacyWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: legacyText });
      const legacyKey = normalizeComparablePathKey(legacyWorkingDir);
      const installRootKey = normalizeComparablePathKey(defaults.installRoot);
      return Boolean(legacyKey && installRootKey && legacyKey === installRootKey);
    })();

    let legacyInstallRootToMigrate: string | undefined;
    await (async () => {
      if (channel === 'stable') return;
      if (backend !== 'systemd-user' && backend !== 'systemd-system') return;
      const legacyUnitName = 'happier-server';
      const legacyDefinitionPath = resolveSystemdUnitDefinitionPath({
        backend,
        unitName: legacyUnitName,
        homeDir: homedir(),
      });
      if (!existsSync(legacyDefinitionPath)) return;
      const legacyText = await readFile(legacyDefinitionPath, 'utf8').catch(() => '');
      if (!legacyText.trim()) return;

      const legacyWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: legacyText });
      const legacyKey = normalizeComparablePathKey(legacyWorkingDir);
      const installRootKey = normalizeComparablePathKey(defaults.installRoot);
      if (legacyKey && installRootKey && legacyKey === installRootKey) return;

      const prefix = backend === 'systemd-user' ? ['--user'] : [];
      const legacyShow = runLocalText('systemctl', [
        ...prefix,
        'show',
        `${legacyUnitName}.service`,
        '--property=ActiveState,SubState,LoadState',
      ]);
      const legacyState = legacyShow.status === 0
        ? parseSystemctlShowOutput(legacyShow.stdout)
        : null;
      const legacyLoaded = legacyState?.loadState.trim().toLowerCase() === 'loaded';
      const legacyActive = legacyState?.activeState.trim().toLowerCase() === 'active';
      if (!legacyLoaded || !legacyActive) return;

      const legacyBaseUrl = resolveServiceDefinitionBaseUrl({
        backend,
        definitionText: legacyText,
        fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      });
      if (legacyBaseUrl !== desiredRelayUrl) return;
      if (!legacyWorkingDir) {
        throw new Error(
          `An active legacy happier-server.service is already using ${desiredRelayUrl} from an unknown root. `
          + `Stop or uninstall that legacy service before installing the ${formatRelayChannelLabel(channel)} relay.`,
        );
      }
      legacyInstallRootToMigrate = legacyWorkingDir;
    })();
    await (async () => {
      if (channel === 'stable') return;
      if (legacyInstallRootToMigrate) return;

      const canonicalDefinitionPath =
        backend === 'systemd-user' || backend === 'systemd-system'
          ? resolveSystemdUnitDefinitionPath({ backend, unitName: defaults.serviceName, homeDir: homedir() })
          : backend === 'launchd-user' || backend === 'launchd-system'
            ? resolveLaunchdPlistDefinitionPath({ backend, label: defaults.serviceName, homeDir: homedir() })
            : backend === 'schtasks-user' || backend === 'schtasks-system'
              ? resolveWindowsWrapperDefinitionPath({ backend, label: defaults.serviceName, homeDir: homedir() })
              : '';
      if (!canonicalDefinitionPath || !existsSync(canonicalDefinitionPath)) return;

      const canonicalText = await readFile(canonicalDefinitionPath, 'utf8').catch(() => '');
      if (!canonicalText.trim()) return;

      const canonicalBaseUrl = resolveServiceDefinitionBaseUrl({
        backend,
        definitionText: canonicalText,
        fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      });
      if (canonicalBaseUrl !== desiredRelayUrl) return;

      const canonicalWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: canonicalText });
      if (!canonicalWorkingDir) {
        throw new Error(
          `An installed ${defaults.serviceName} service is already using ${desiredRelayUrl} from an unknown root. `
          + `Stop or uninstall that service before reinstalling the ${formatRelayChannelLabel(channel)} relay.`,
        );
      }

      const canonicalKey = normalizeComparablePathKey(canonicalWorkingDir);
      const installRootKey = normalizeComparablePathKey(defaults.installRoot);
      if (canonicalKey && installRootKey && canonicalKey === installRootKey) return;

      const shouldMigrateCanonicalCustomRoot = await shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot({
        platform: process.platform,
        mode,
        channel,
        homeDir: homedir(),
        legacyInstallRoot: canonicalWorkingDir,
      });
      if (!shouldMigrateCanonicalCustomRoot) return;

      legacyInstallRootToMigrate = canonicalWorkingDir;
    })();
    const strandedLegacyState = await detectLocalRelayStrandedLegacyState({
      backend,
      channel,
      defaults,
      currentBaseUrl: desiredRelayUrl,
    });
    if (strandedLegacyState) {
      throw new Error(renderLocalRelayStrandedLegacyStateMessage({
        channel,
        legacyInstallRoot: strandedLegacyState.legacyInstallRoot,
        currentInstallRoot: strandedLegacyState.currentInstallRoot,
      }));
    }

    for (const otherChannel of listOtherRelayChannels(channel)) {
      if (
        otherChannel === 'stable'
        && (
          shouldTreatStableLaneAsLegacyUnsuffixedInstall
          || ignoreStableLaneConflict
          || Boolean(legacyInstallRootToMigrate)
        )
      ) {
        continue;
      }
      const otherStatus = await readLocalStatus({
        ...parsed,
        channel: formatRelayChannelLabel(otherChannel),
      });
      const otherLaneOccupiesDesiredUrl =
        otherStatus.baseUrl === desiredRelayUrl
        && (
          otherStatus.installed
          || otherStatus.service.active === true
          || otherStatus.service.enabled === true
        );
      if (otherLaneOccupiesDesiredUrl) {
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

    await (async () => {
      if (channel === 'stable') return undefined;
      const legacyUnitName = 'happier-server';
      const legacyDefinitionPath =
        backend === 'systemd-user' || backend === 'systemd-system'
          ? resolveSystemdUnitDefinitionPath({ backend, unitName: legacyUnitName, homeDir: homedir() })
          : backend === 'launchd-user' || backend === 'launchd-system'
            ? resolveLaunchdPlistDefinitionPath({ backend, label: legacyUnitName, homeDir: homedir() })
            : backend === 'schtasks-user' || backend === 'schtasks-system'
              ? resolveWindowsWrapperDefinitionPath({ backend, label: legacyUnitName, homeDir: homedir() })
              : '';
      if (!legacyDefinitionPath) return undefined;
      if (!existsSync(legacyDefinitionPath)) return undefined;

      const legacyText = await readFile(legacyDefinitionPath, 'utf8').catch(() => '');
      const legacyWorkingDir = parseServiceDefinitionWorkingDirectory({ backend, definitionText: legacyText });
      const legacyOwnedByInstallRoot =
        normalizeComparablePathKey(legacyWorkingDir) !== null
        && normalizeComparablePathKey(legacyWorkingDir) === normalizeComparablePathKey(defaults.installRoot);
      if (!legacyOwnedByInstallRoot) return undefined;

      if (backend === 'systemd-user' || backend === 'systemd-system') {
        const prefix = backend === 'systemd-user' ? ['--user'] : [];
        if (policy.runServiceCommands !== false) {
          runLocalText('systemctl', [...prefix, 'disable', '--now', `${legacyUnitName}.service`]);
        }
        await rm(legacyDefinitionPath, { force: true }).catch(() => undefined);
        if (policy.runServiceCommands !== false) {
          runLocalText('systemctl', [...prefix, 'daemon-reload']);
        }
        return undefined;
      }

      if (backend === 'schtasks-user' || backend === 'schtasks-system') {
        if (policy.runServiceCommands !== false) {
          runLocalText('schtasks', ['/End', '/TN', `Happier\\${legacyUnitName}`]);
          runLocalText('schtasks', ['/Delete', '/F', '/TN', `Happier\\${legacyUnitName}`]);
        }
        await rm(legacyDefinitionPath, { force: true }).catch(() => undefined);
        return undefined;
      }

      if (policy.runServiceCommands !== false) {
        runLocalText('launchctl', ['unload', '-w', legacyDefinitionPath]);
        runLocalText('launchctl', ['remove', legacyUnitName]);
      }
      await rm(legacyDefinitionPath, { force: true }).catch(() => undefined);
      return undefined;
    })();

    // Propagate the resolved port (from `desiredRelayUrl`) into the env we
    // pass to the lower-level installer. Otherwise the installer would call
    // its own port-resolution helper with no configured port and might pick a
    // different ephemeral port, causing the advertised URL (desiredRelayUrl)
    // to disagree with what we actually wrote to the plist/unit file.
    const resolvedPortFromDesiredUrl = (() => {
      try {
        const parsedUrl = new URL(desiredRelayUrl);
        const value = Number.parseInt(parsedUrl.port, 10);
        return Number.isInteger(value) && value > 0 && value <= 65_535 ? String(value) : null;
      } catch {
        return null;
      }
    })();
    const envForInstaller: Record<string, string> = {
      ...(parsed.env ?? {}),
      ...(resolvedPortFromDesiredUrl && !(parsed.env ?? {}).PORT ? { PORT: resolvedPortFromDesiredUrl } : {}),
    };

    const local = await installOrUpdateRelayRuntimeLocal({
      serverBinaryPath,
      channel,
      mode,
      env: envForInstaller,
      legacyInstallRoot: legacyInstallRootToMigrate,
      version,
      runServiceCommands: policy.runServiceCommands !== false,
      skipHealthCheck: policy.skipHealthCheck === true,
    });

    return {
      relayUrl: String(local.baseUrl ?? '').trim() || `http://127.0.0.1:${defaults.serverPort}`,
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
    const backend = resolveServiceBackend({ platform: process.platform, mode }) as ServiceBackend;
    const effectiveServiceName = await resolveLocalEffectiveServiceName({
      backend,
      channel,
      defaults,
    });
    const serviceSpec = buildRelayRuntimeServiceSpec({
      label: effectiveServiceName,
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
	    const remoteHomeDir = await resolveRemoteUserHomeDir(deps, { ssh: params.ssh, knownHostsMode })
	      ?? resolveRemoteHomeDirForRuntime();
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
			    const serviceName = await resolveRemoteEffectiveServiceName({
			      ssh: params.ssh,
			      knownHostsMode,
			      backend,
			      channel,
			      remoteHomeDir,
			      defaults,
			    });
	    const serviceResult = await deps.runRemoteText({
	      ssh: params.ssh,
	      knownHostsMode,
	      remoteCommand: buildRemoteServiceStatusCommand({ backend, serviceName }),
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
		    const legacyServiceNameToRemove = await (async (): Promise<string | undefined> => {
		      if (channel === 'stable') return undefined;
		      if (
		        backend !== 'systemd-user'
		        && backend !== 'systemd-system'
		        && backend !== 'launchd-user'
		        && backend !== 'launchd-system'
		      ) return undefined;
		      const legacyUnitName = 'happier-server';
		      const legacyOwnedByInstallRoot = backend === 'systemd-user' || backend === 'systemd-system'
		        ? await resolveRemoteSystemdUnitOwnedByInstallRoot({
		          ssh: params.ssh,
		          knownHostsMode,
		          backend,
		          unitName: legacyUnitName,
		          remoteHomeDir,
		          installRoot: defaults.installRoot,
		        }).catch(() => false)
		        : await resolveRemoteLaunchdPlistOwnedByInstallRoot({
		          ssh: params.ssh,
		          knownHostsMode,
		          backend,
		          label: legacyUnitName,
		          remoteHomeDir,
		          installRoot: defaults.installRoot,
		        }).catch(() => false);
		      return legacyOwnedByInstallRoot ? legacyUnitName : undefined;
		    })();
		    const ignoreStableLaneConflict =
		      channel !== 'stable'
		      && (
		        backend === 'systemd-user'
		        || backend === 'systemd-system'
		        || backend === 'launchd-user'
		        || backend === 'launchd-system'
		      )
		      && legacyServiceNameToRemove === 'happier-server';

	    for (const otherChannel of listOtherRelayChannels(channel)) {
	      if (otherChannel === 'stable' && ignoreStableLaneConflict) continue;
	      const otherStatus = await readRemoteStatus({
	        parsed: {
          ...params.parsed,
          channel: formatRelayChannelLabel(otherChannel),
        },
        ssh: params.ssh,
      });
      const otherLaneOccupiesDesiredUrl =
        otherStatus.baseUrl === desiredRelayUrl
        && (
          otherStatus.installed
          || otherStatus.service.active === true
          || otherStatus.service.enabled === true
        );
      if (otherLaneOccupiesDesiredUrl) {
        throw createRelayLaneConflictError({
          requestedChannel: channel,
          conflictingChannel: otherChannel,
          relayUrl: desiredRelayUrl,
        });
	      }
	    }

		    const effectiveServiceName = defaults.serviceName;
		    const legacySystemdServiceNameToRemove = legacyServiceNameToRemove && (backend === 'systemd-user' || backend === 'systemd-system')
		      ? legacyServiceNameToRemove
		      : undefined;
		    const legacySystemdDefinitionPathToRemove = legacySystemdServiceNameToRemove
		      ? resolveRemoteServiceDefinitionPath({
		        backend,
		        label: legacySystemdServiceNameToRemove,
		        remoteHomeDir,
		      })
		      : undefined;
		    const legacyLaunchdServiceNameToRemove = legacyServiceNameToRemove && (backend === 'launchd-user' || backend === 'launchd-system')
		      ? legacyServiceNameToRemove
		      : undefined;
		    const legacyLaunchdDefinitionPathToRemove = legacyLaunchdServiceNameToRemove
		      ? resolveRemoteServiceDefinitionPath({
		        backend,
		        label: legacyLaunchdServiceNameToRemove,
		        remoteHomeDir,
		      })
		      : undefined;

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
		      label: effectiveServiceName,
		      description: `Happier Relay Runtime (${effectiveServiceName})`,
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
      serviceName: effectiveServiceName,
      legacySystemdServiceNameToRemove,
      legacySystemdDefinitionPathToRemove,
      legacyLaunchdServiceNameToRemove,
      legacyLaunchdDefinitionPathToRemove,
    });

    const relayUrl = resolveConfiguredSelfHostBaseUrl({
      fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      envText: renderedEnv.envText,
    });

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
		    const effectiveServiceName = await resolveRemoteEffectiveServiceName({
		      ssh: params.ssh,
		      knownHostsMode,
		      backend,
		      channel,
		      remoteHomeDir,
		      defaults,
		    });
	    const serviceSpec = buildRelayRuntimeServiceSpec({
	      label: effectiveServiceName,
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
	        serviceName: effectiveServiceName,
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
          const resolveRelayStartHealthcheckTimeoutMs = (): number => {
            const raw = process.env.HAPPIER_RELAY_HOST_LOCAL_HEALTHCHECK_TIMEOUT_MS;
            if (typeof raw !== 'string' || raw.trim().length === 0) return 120_000;
            const parsedTimeout = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsedTimeout)) return 120_000;
            return Math.max(1, Math.min(120_000, Math.floor(parsedTimeout)));
          };
          const envPath = join(defaults.configDir, 'server.env');
          const envText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
          const baseUrl = resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
            envText,
          });
          const healthy = await resolveLocalRelayHealth({
            baseUrl,
            healthPath: defaults.healthPath,
            timeoutMs: resolveRelayStartHealthcheckTimeoutMs(),
          }).catch(() => false);
          if (!healthy) {
            throw new Error(`Local relay runtime did not become healthy at ${baseUrl}.`);
          }
        };

        const effectiveServiceName = await resolveLocalEffectiveServiceName({
          backend,
          channel,
          defaults,
        });

        if (backend === 'systemd-user' || backend === 'systemd-system') {
          const prefix = backend === 'systemd-user' ? ['--user'] : [];
          const result = runLocalText('systemctl', [...prefix, parsed.action, `${effectiveServiceName}.service`]);
          if (result.status !== 0) {
            throw mapRelayRuntimeServiceControlError({
              backend,
              stderr: result.stderr,
              fallbackMessage: `Failed to ${parsed.action} relay runtime.`,
            });
          }
          await ensureLocalRelayHealthy();
          return;
        }

        if (backend === 'launchd-user' || backend === 'launchd-system') {
          const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
          const domain = backend === 'launchd-system' ? `system/${effectiveServiceName}` : `gui/${uid}/${effectiveServiceName}`;
          const plistPath = backend === 'launchd-system'
            ? `/Library/LaunchDaemons/${effectiveServiceName}.plist`
            : join(homedir(), 'Library', 'LaunchAgents', `${effectiveServiceName}.plist`);
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
        const taskName = `Happier\\${effectiveServiceName}`;
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
      if (parsed.target.kind !== 'ssh') {
        throw new Error('Remote relay runtime control requires an ssh target.');
      }
      const ssh = parsed.target.ssh;
      const knownHostsMode: 'app' | 'system' = ssh.knownHostsPath ? 'app' : 'system';
      const target = await resolveRemoteTarget(ssh, knownHostsMode);
	      const platform = resolveRemotePlatform({ target });
	      const mode = normalizeMode(parsed.mode);
	      const channel = normalizeChannel(parsed.channel);
	      const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
      const remoteHomeDir = await resolveRemoteUserHomeDir(deps, { ssh, knownHostsMode }) ?? resolveRemoteHomeDirForRuntime();
	      const backend = resolveServiceBackend({ platform, mode });
	      if (parsed.action === 'uninstall') {
        await uninstallRemote({ parsed, ssh });
        return;
      }
		      const effectiveServiceName = await resolveRemoteEffectiveServiceName({
		        ssh,
		        knownHostsMode,
		        backend,
		        channel,
		        remoteHomeDir,
		        defaults,
		      });
      const result = await deps.runRemoteText({
        ssh,
        knownHostsMode,
        remoteCommand: buildRemoteControlCommand({
          backend,
          serviceName: effectiveServiceName,
          action: parsed.action,
	        }),
	      });
      if (result.status !== 0) {
        throw mapRelayRuntimeServiceControlError({
          backend,
          stderr: result.stderr,
          fallbackMessage: `Failed to ${parsed.action} relay runtime.`,
        });
      }
      if (parsed.action === 'start' || parsed.action === 'restart') {
        const status = await readRemoteStatus({ parsed, ssh });
        await assertRemoteRelayRuntimeHealthy({
          deps,
          ssh,
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
