import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix as posixPath } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  resolveServiceBackend,
  type ServiceBackend,
  type ServiceSpec,
} from '../service/index.js';
import { buildLaunchdPlistXml } from '../service/launchd.js';
import { renderSystemdServiceUnit } from '../service/systemd.js';
import { resolveRelayRuntimeDefaults, type RelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from '../firstPartyRuntime/relayRuntimeInstall.js';
import { applyEnvOverridesToEnvText, parseEnvText } from '../firstPartyRuntime/selfHostServerEnv.js';

import type {
  RelayRuntimeStatusSnapshot,
  RelayRuntimeTaskParams,
  SystemTaskSshConnectionConfig,
} from '../systemTasks/kinds/relayRuntimeKinds.js';

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
  control: (params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' }>) => Promise<void>;
}>;

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
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (normalized === 'preview') return 'preview';
  if (normalized === 'dev' || normalized === 'publicdev') return 'publicdev';
  return 'stable';
}

function normalizeMode(raw: unknown): 'user' | 'system' {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function resolveRemoteHomeDirForRuntime(): string {
  return '$HOME';
}

function resolveRemoteHomeDirForComponents(): string {
  return '$HOME/.happier';
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

function buildRemoteInstallBinaryShimCommand(params: Readonly<{ sourcePath: string; destPath: string }>): string {
  const source = quoteRemoteShellArg(params.sourcePath);
  const dest = quoteRemoteShellArg(params.destPath);
  return [
    'set -eu',
    `rm -f ${dest}`,
    `(ln -s ${source} ${dest} 2>/dev/null || cp ${source} ${dest})`,
    `chmod +x ${dest} 2>/dev/null || true`,
  ].join('; ');
}

function buildRemoteProbeExistsCommand(params: Readonly<{ path: string; kind: 'file' | 'dir' }>): string {
  const testFlag = params.kind === 'dir' ? '-d' : '-f';
  return `if [ ${testFlag} ${quoteRemoteShellArg(params.path)} ]; then echo yes; fi`;
}

function resolveRemotePrismaEngineCandidates(params: Readonly<{
  platform: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  serverBinDir: string;
}>): readonly string[] {
  if (params.platform === 'darwin' && params.arch === 'arm64') {
    return [
      posixPath.join(params.serverBinDir, 'node_modules', '.prisma', 'client', 'libquery_engine-darwin-arm64.dylib.node'),
      posixPath.join(params.serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-darwin-arm64.dylib.node'),
    ];
  }
  if (params.platform === 'linux' && params.arch === 'arm64') {
    return [
      posixPath.join(params.serverBinDir, 'node_modules', '.prisma', 'client', 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'),
      posixPath.join(params.serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'),
    ];
  }
  if (params.platform === 'linux' && params.arch === 'x64') {
    return [
      posixPath.join(params.serverBinDir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'),
      posixPath.join(params.serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-debian-openssl-3.0.x.so.node'),
    ];
  }
  return [];
}

async function resolveFirstRemoteExistingPath(
  deps: Pick<RemoteDeps, 'runRemoteText'>,
  params: Readonly<{
    ssh: SystemTaskSshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
    candidates: readonly string[];
  }>,
): Promise<string> {
  if (params.candidates.length === 0) return '';
  const chain = params.candidates
    .map((candidate) => `if [ -f ${quoteRemoteShellArg(candidate)} ]; then echo ${quoteRemoteShellArg(candidate)}; exit 0; fi`)
    .join('; ');
  const cmd = ['set -eu', chain, 'echo ""'].join('; ');
  const result = await deps.runRemoteText({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: cmd,
  });
  return String(result.stdout ?? '').trim();
}

function buildRemoteRelayRuntimeEnvText(params: Readonly<{
  platform: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  defaults: RelayRuntimeDefaults;
  envOverrides?: Record<string, string>;
  serverBinDir: string;
  prismaEnginePath?: string;
  nodeModulesPath?: string;
}>): Readonly<{ envText: string; parsed: Record<string, string> }> {
  const normalizedDataDir = String(params.defaults.dataDir ?? '').replace(/\/+$/, '') || String(params.defaults.dataDir ?? '');
  const migrationsDir = `${normalizedDataDir}/migrations/sqlite`;
  const dbPath = `${normalizedDataDir}/happier-server-light.sqlite`;
  const databaseUrl = `file:${dbPath}`;
  const filesDir = `${params.defaults.dataDir}/files`;
  const dbDir = `${params.defaults.dataDir}/pglite`;

  const baseLines = [
    `PORT=${params.defaults.serverPort}`,
    `HAPPIER_SERVER_HOST=${params.defaults.serverHost}`,
    'METRICS_ENABLED=false',
    'HAPPIER_DB_PROVIDER=sqlite',
    `DATABASE_URL=${databaseUrl}`,
    'HAPPIER_FILES_BACKEND=local',
    ...(params.nodeModulesPath ? [`NODE_PATH=${params.nodeModulesPath}`] : []),
    ...(params.prismaEnginePath
      ? [
          'PRISMA_CLIENT_ENGINE_TYPE=library',
          `PRISMA_QUERY_ENGINE_LIBRARY=${params.prismaEnginePath}`,
        ]
      : []),
    `HAPPIER_SQLITE_AUTO_MIGRATE=${params.platform === 'darwin' ? '0' : '1'}`,
    `HAPPIER_SQLITE_MIGRATIONS_DIR=${migrationsDir}`,
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${params.defaults.dataDir}`,
    `HAPPIER_SERVER_LIGHT_FILES_DIR=${filesDir}`,
    `HAPPIER_SERVER_LIGHT_DB_DIR=${dbDir}`,
    '',
  ];

  const baseText = `${baseLines.join('\n')}\n`;
  const envText = params.envOverrides && Object.keys(params.envOverrides).length > 0
    ? applyEnvOverridesToEnvText(baseText, params.envOverrides)
    : baseText;
  return {
    envText,
    parsed: parseEnvText(envText),
  };
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
      remotePath: stageParent,
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
    return `systemctl --user show ${quoteRemoteShellArg(svc)} --property=UnitFileState,ActiveState,SubState --value`;
  }
  if (params.backend === 'systemd-system') {
    return `systemctl show ${quoteRemoteShellArg(svc)} --property=UnitFileState,ActiveState,SubState --value`;
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    return `launchctl list ${quoteRemoteShellArg(params.serviceName)}`;
  }
  throw new Error(`Unsupported remote backend: ${params.backend}`);
}

function normalizeRemoteServiceSnapshot(params: Readonly<{
  backend: ServiceBackend;
  commandResult: RelayHostRemoteCommandResult;
}>): RelayRuntimeStatusSnapshot['service'] {
  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const [unitFileState = '', activeState = '', subState = ''] = String(params.commandResult.stdout ?? '').split(/\r?\n/u);
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

function buildRemoteControlCommand(params: Readonly<{ backend: ServiceBackend; serviceName: string; action: 'start' | 'stop' | 'restart' }>): string {
  const svc = `${params.serviceName}.service`;
  if (params.backend === 'systemd-user') {
    return `systemctl --user ${params.action} ${quoteRemoteShellArg(svc)}`;
  }
  if (params.backend === 'systemd-system') {
    return `systemctl ${params.action} ${quoteRemoteShellArg(svc)}`;
  }
  if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    if (params.action === 'stop') {
      return `launchctl unload -w ${quoteRemoteShellArg(resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system'))}`;
    }
    if (params.action === 'restart') {
      const plistPath = resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system');
      return `launchctl unload -w ${quoteRemoteShellArg(plistPath)} 2>/dev/null || true; launchctl load -w ${quoteRemoteShellArg(plistPath)}`;
    }
    return `launchctl load -w ${quoteRemoteShellArg(resolveLaunchdPlistPath(params.serviceName, params.backend === 'launchd-system'))}`;
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
    return renderSystemdServiceUnit({
      description: params.spec.description ?? params.spec.label,
      execStart: params.spec.programArgs,
      workingDirectory: params.spec.workingDirectory,
      env,
      restart: 'always',
      runAsUser: params.spec.runAsUser,
      stdoutPath: params.spec.stdoutPath,
      stderrPath: params.spec.stderrPath,
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
  installCommands.push('set -eu');
  installCommands.push(`mkdir -p ${quoteRemoteShellArg(dirname(remoteDefinitionPath))}`);
  installCommands.push(`cp ${quoteRemoteShellArg(remoteStagedDefinitionPath)} ${quoteRemoteShellArg(remoteDefinitionPath)}`);

  if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
    const prefix = params.backend === 'systemd-user' ? '--user ' : '';
    installCommands.push(`systemctl ${prefix}daemon-reload`);
    installCommands.push(`systemctl ${prefix}enable --now ${quoteRemoteShellArg(`${params.serviceName}.service`)}`);
  } else if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
    const plist = quoteRemoteShellArg(remoteDefinitionPath);
    installCommands.push(`launchctl unload -w ${plist} 2>/dev/null || true`);
    installCommands.push(`launchctl load -w ${plist}`);
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
    throw new Error(result.stderr.trim() || 'Failed to install relay service');
  }
}

export function createRelayHostEngine(deps: RelayHostEngineDeps): RelayHostEngine {
  const now = deps.now ?? (() => Date.now());

  const runLocalText = (cmd: string, args: readonly string[]) => {
    const res = spawnSync(cmd, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
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
        const result = runLocalText('systemctl', [...prefix, 'show', `${defaults.serviceName}.service`, '--property=UnitFileState,ActiveState,SubState', '--value']);
        if (result.status !== 0) {
          return { enabled: null, active: null };
        }
        const [unitFileState = '', activeState = ''] = String(result.stdout ?? '').split(/\r?\n/u);
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

    return {
      installed,
      version,
      service,
      baseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      healthy: service.active === true,
    };
  }

  async function installLocal(parsed: RelayRuntimeTaskParams): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
    const mode = normalizeMode(parsed.mode);
    const channel = normalizeChannel(parsed.channel);
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

    return {
      installed: Boolean(version) || binaryExists,
      version,
      service,
      baseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      healthy: service.active === true,
    };
  }

  async function installRemote(params: Readonly<{ parsed: RelayRuntimeTaskParams; ssh: SystemTaskSshConnectionConfig }>): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
    const knownHostsMode: 'app' | 'system' = params.ssh.knownHostsPath ? 'app' : 'system';
    const target = await resolveRemoteTarget(params.ssh, knownHostsMode);
    const platform = resolveRemotePlatform({ target });
    const mode = normalizeMode(params.parsed.mode);
    const channel = normalizeChannel(params.parsed.channel);
    const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
    const remoteHomeDir = resolveRemoteHomeDirForRuntime();
    const remoteComponentHomeDir = resolveRemoteHomeDirForComponents();

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
    const remoteServer = remoteServerOverride
      ? { binaryPath: remoteServerOverride, versionId: '' }
      : await deps.installRemoteComponent({
          componentId: 'happier-server',
          channel,
          ssh: params.ssh,
          knownHostsMode,
          remoteHomeDir: remoteComponentHomeDir,
          installerBinaryPath: remoteCli.binaryPath,
        });

    const installServerBinaryPath = `${defaults.installRoot}/bin/happier-server`;
    const shimPath = `${defaults.binDir}/happier-server`;
    const stdoutPath = `${defaults.logDir}/server.out.log`;
    const stderrPath = `${defaults.logDir}/server.err.log`;
    const configEnvPath = `${defaults.configDir}/server.env`;
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

    const prismaEnginePath = await resolveFirstRemoteExistingPath(
      deps,
      {
        ssh: params.ssh,
        knownHostsMode,
        candidates: resolveRemotePrismaEngineCandidates({
          platform,
          arch: target.arch,
          serverBinDir,
        }),
      },
    );

    const renderedEnv = buildRemoteRelayRuntimeEnvText({
      platform,
      arch: target.arch,
      defaults,
      envOverrides: params.parsed.env,
      serverBinDir,
      nodeModulesPath: nodeModulesPath || undefined,
      prismaEnginePath: prismaEnginePath || undefined,
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
    const backend = resolveServiceBackend({ platform, mode });
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
        { relativePath: 'server.env', contents: renderedEnv.envText },
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

    const setupCommands = [
      'set -eu',
      `mkdir -p ${quoteRemoteShellArg(defaults.installRoot)}`,
      `mkdir -p ${quoteRemoteShellArg(defaults.configDir)}`,
      `mkdir -p ${quoteRemoteShellArg(defaults.dataDir)}`,
      `mkdir -p ${quoteRemoteShellArg(filesDir)}`,
      `mkdir -p ${quoteRemoteShellArg(dbDir)}`,
      `mkdir -p ${quoteRemoteShellArg(defaults.logDir)}`,
      `mkdir -p ${quoteRemoteShellArg(`${defaults.installRoot}/bin`)}`,
      buildRemoteInstallBinaryShimCommand({ sourcePath: remoteServer.binaryPath, destPath: installServerBinaryPath }),
      buildRemoteInstallBinaryShimCommand({ sourcePath: installServerBinaryPath, destPath: shimPath }),
      `cp ${quoteRemoteShellArg(remoteEnvPath)} ${quoteRemoteShellArg(configEnvPath)}`,
      `cp ${quoteRemoteShellArg(remoteStatePath)} ${quoteRemoteShellArg(statePath)}`,
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

    return {
      relayUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
      mode,
    };
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
        if (backend === 'systemd-user' || backend === 'systemd-system') {
          const prefix = backend === 'systemd-user' ? ['--user'] : [];
          const result = runLocalText('systemctl', [...prefix, parsed.action, `${serviceName}.service`]);
          if (result.status !== 0) {
            throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
          }
          return;
        }
        if (backend === 'launchd-user' || backend === 'launchd-system') {
          const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
          const domain = backend === 'launchd-system' ? `system/${serviceName}` : `gui/${uid}/${serviceName}`;
          const args = parsed.action === 'stop'
            ? ['bootout', domain]
            : ['kickstart', '-k', domain];
          const result = runLocalText('launchctl', args);
          if (result.status !== 0) {
            throw new Error(result.stderr.trim() || `Failed to ${parsed.action} relay runtime.`);
          }
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
        return;
      }
      const knownHostsMode: 'app' | 'system' = parsed.target.ssh.knownHostsPath ? 'app' : 'system';
      const target = await resolveRemoteTarget(parsed.target.ssh, knownHostsMode);
      const platform = resolveRemotePlatform({ target });
      const mode = normalizeMode(parsed.mode);
      const channel = normalizeChannel(parsed.channel);
      const defaults = resolveRelayDefaultsForRemote({ platform, channel, mode });
      const backend = resolveServiceBackend({ platform, mode });
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
    },
  };
}
