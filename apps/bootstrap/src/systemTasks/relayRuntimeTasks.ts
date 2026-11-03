import {
  createRelayHostEngine,
  installRemoteFirstPartyComponent as installRemoteFirstPartyComponentShared,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  type RelayHostEngineDeps,
  type RelayHostEngine,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type PersonalHomeSystemTaskOperations,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';
import {
  listInstalledVersionIdsNewestFirst,
  type PersonalHomeRelocationDestinationOwner,
  type PersonalHomeOperations,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  checkLocalRelayRuntimeReachability,
  createLocalPersonalHomeHost,
} from '@happier-dev/cli-common/relayHost';
import { runOpenSshRemoteCommand, safeBashSingleQuote } from '@happier-dev/cli-common/ssh';

import { buildScpCommand, redactSshText } from '../ssh/index.js';
import {
  ensureLocalFirstPartyComponentCommand,
} from '@happier-dev/cli-common/systemTasks';
import { normalizeBootstrapChannel, parseFirstJsonObject, runCommandCapture, type CommandExecutionResult } from './taskRuntime.js';
import { loadOrganizationPolicy } from '@happier-dev/cli-common/organizationPolicy/readOrganizationPolicyFile';

const organizationPolicy = loadOrganizationPolicy();

export type SshConnectionConfig = SystemTaskSshConnectionConfig;
type SshConnectionWithPasswordConfig = SshConnectionConfig & Readonly<{ password?: string }>;

export function createBootstrapRelayHostEngine(): ReturnType<typeof createRelayHostEngine> {
  return createRelayHostEngine(buildRelayHostEngineDeps());
}

export type BootstrapLocalPersonalHomeTarget = Readonly<{
  /** Defaults to the bootstrap engine; tests and callers may supply their own. */
  engine?: RelayHostEngine;
  homeDir?: string;
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
}>;

/**
 * Local Personal Home host adapter. hsetup owns only its SSH-capable relay
 * engine and home directory; the shared cli-common composition owns every
 * Personal Home dependency and policy so the CLI and hsetup hosts cannot drift.
 */
function createBootstrapLocalPersonalHomeHost(params: BootstrapLocalPersonalHomeTarget) {
  return createLocalPersonalHomeHost({
    engine: params.engine ?? createBootstrapRelayHostEngine(),
    channel: params.channel,
    mode: params.mode,
    ...(params.homeDir ? { homeDir: params.homeDir } : {}),
  });
}

export async function createBootstrapPersonalHomeSystemTaskOperations(
  params: BootstrapLocalPersonalHomeTarget,
): Promise<PersonalHomeSystemTaskOperations> {
  return await createBootstrapLocalPersonalHomeHost(params).createSystemTaskOperations();
}

export async function createBootstrapPersonalHomeOperations(
  params: BootstrapLocalPersonalHomeTarget,
): Promise<PersonalHomeOperations> {
  return await createBootstrapLocalPersonalHomeHost(params).createOperations();
}

export async function createBootstrapPersonalHomeRelocationDestinationOwner(
  params: BootstrapLocalPersonalHomeTarget,
): Promise<PersonalHomeRelocationDestinationOwner> {
  return await createBootstrapLocalPersonalHomeHost(params).createRelocationDestinationOwner();
}

export async function readRelayRuntimeStatusDefault(
  params: RelayRuntimeTaskParams,
): Promise<RelayRuntimeStatusSnapshot> {
  const engine = createRelayHostEngine(buildRelayHostEngineDeps());
  return await engine.readStatus(params);
}

export async function checkRelayRuntimeHealthDefault(params: Readonly<{ baseUrl: string }>): Promise<boolean> {
  return await checkLocalRelayRuntimeReachability(params);
}

export async function installOrUpdateRelayRuntimeDefault(
  params: RelayRuntimeTaskParams,
  options: Readonly<{
    ensureRemoteCliInstalled?: boolean;
    runLocalServiceCommands?: boolean;
    skipLocalHealthCheck?: boolean;
  }> = {},
  deps: Readonly<{
    installRemoteFirstPartyComponent?: (params: Readonly<{
      componentId: 'happier-cli' | 'happier-server';
      channel?: string;
      ssh: SshConnectionConfig;
      knownHostsMode?: 'app' | 'system';
      installerBinaryPath?: string;
      remoteHomeDir?: string;
      signal?: AbortSignal;
    }>) => Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>>;
  }> = {},
): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  const mode = params.mode === 'system' ? 'system' : 'user';
  const bootstrapChannel = normalizeBootstrapChannel(params.channel);
  const releaseRing = bootstrapChannel.releaseChannel;

  const engine = createRelayHostEngine(buildRelayHostEngineDeps({
    installRemoteFirstPartyComponent: deps.installRemoteFirstPartyComponent,
    localInstallPolicy: {
      runServiceCommands: options.runLocalServiceCommands !== false,
      skipHealthCheck: options.skipLocalHealthCheck === true,
    },
    resolveLocalInstallVersion: async () => {
      if (params.selfHostRelayBinaryOverride) {
        return null;
      }
      return (await listInstalledVersionIdsNewestFirst({
        componentId: 'happier-server',
        processEnv: process.env,
        releaseRing,
      })).at(0) ?? null;
    },
  }));

  if (params.target.kind === 'ssh') {
    return await engine.installOrUpdate({
      ...params,
      mode,
      channel: releaseRing === 'publicdev' ? 'dev' : releaseRing,
    });
  }

  const serverBinaryPath = params.selfHostRelayBinaryOverride
    ? params.selfHostRelayBinaryOverride
    : await ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-server',
        processEnv: process.env,
        envVarNames: ['HAPPIER_BOOTSTRAP_SELF_HOST_SERVER_PATH'],
        releaseRing,
      });

  return await engine.installOrUpdate({
    ...params,
    mode,
    channel: releaseRing === 'publicdev' ? 'dev' : releaseRing,
    selfHostRelayBinaryOverride: serverBinaryPath,
  });
}

export async function controlRelayRuntimeDefault(
  params: RelayRuntimeTaskParams & Readonly<{ action: 'start' | 'stop' | 'restart' | 'uninstall' }>,
): Promise<void> {
  const engine = createRelayHostEngine(buildRelayHostEngineDeps());
  await engine.control(params);
}

function resolveKnownHostsConfig(ssh: SshConnectionConfig, knownHostsMode?: 'app' | 'system') {
  const mode = knownHostsMode === 'app' || knownHostsMode === 'system'
    ? knownHostsMode
    : ssh.knownHostsPath
      ? 'app'
      : 'system';
  return mode === 'app'
    ? { mode: 'app' as const, path: ssh.knownHostsPath ?? '' }
    : { mode: 'system' as const };
}

async function runRemoteTextCapture(
  ssh: SshConnectionConfig,
  remoteCommand: string,
  knownHostsMode?: 'app' | 'system',
  signal?: AbortSignal,
): Promise<CommandExecutionResult> {
  const sshWithPassword = ssh as SshConnectionWithPasswordConfig;
  const knownHosts = resolveKnownHostsConfig(sshWithPassword, knownHostsMode);
  return await runOpenSshRemoteCommand({
    target: sshWithPassword.target,
    port: sshWithPassword.port,
    sshConfigFile: sshWithPassword.sshConfigFile,
    auth: sshWithPassword.auth === 'keyfile'
      ? { mode: 'keyFile', privateKeyPath: String(sshWithPassword.identityFile ?? '') }
      : sshWithPassword.auth === 'password'
        ? { mode: 'password', password: String(sshWithPassword.password ?? '') }
        : { mode: 'agent' },
    knownHostsMode: knownHosts.mode,
    knownHostsPath: knownHosts.mode === 'app' ? knownHosts.path : undefined,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(remoteCommand)],
    ...(signal ? { signal } : {}),
    rejectOnNonZero: false,
    errorPrefix: `SSH command failed for ${sshWithPassword.target}`,
  });
}

async function copyLocalDirectoryToRemoteCapture(params: Readonly<{
  ssh: SshConnectionConfig;
  localPath: string;
  remotePath: string;
  knownHostsMode?: 'app' | 'system';
  signal?: AbortSignal;
}>): Promise<void> {
  const ssh = params.ssh as SshConnectionWithPasswordConfig;
  const invocation = buildScpCommand({
    target: ssh.target,
    remotePath: params.remotePath,
    localPath: params.localPath,
    port: ssh.port,
    auth: {
      kind: ssh.auth,
      identityFile: ssh.identityFile,
      ...(ssh.auth === 'password' ? { password: ssh.password } : {}),
    },
    knownHosts: resolveKnownHostsConfig(ssh, params.knownHostsMode),
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.status !== 0) {
    throw new Error(redactSshText(result.stderr || result.stdout || `SCP command failed for ${params.ssh.target}.`));
  }
}

function buildRelayHostEngineDeps(params: Readonly<{
  installRemoteFirstPartyComponent?: (params: Readonly<{
    componentId: 'happier-cli' | 'happier-server';
    channel?: string;
    ssh: SshConnectionConfig;
    knownHostsMode?: 'app' | 'system';
    installerBinaryPath?: string;
    remoteHomeDir?: string;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>>;
  localInstallPolicy?: RelayHostEngineDeps['localInstallPolicy'];
  resolveLocalInstallVersion?: RelayHostEngineDeps['resolveLocalInstallVersion'];
}> = {}): RelayHostEngineDeps {
  const installRemoteFirstPartyComponent = params.installRemoteFirstPartyComponent
    ?? (async (installParams) => await installRemoteFirstPartyComponentShared(installParams, {
      resolveRemoteReleaseTarget: async ({ ssh, knownHostsMode, signal }) => {
        const preflight = await runRemoteTextCapture(
          ssh,
          [
            "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
            '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
            '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
          ].join(' '),
          knownHostsMode,
          signal,
        );
        if (preflight.status !== 0) {
          throw new Error(redactSshText(preflight.stderr || preflight.stdout || `SSH command failed for ${ssh.target}.`));
        }
        const parsed = parseFirstJsonObject(preflight.stdout) as null | Readonly<{ platform?: unknown; arch?: unknown }>;
        return {
          os: normalizeRemoteReleaseOs(parsed?.platform),
          arch: normalizeRemoteReleaseArch(parsed?.arch),
        };
      },
      runRemoteText: async ({ ssh, remoteCommand, knownHostsMode, signal }) => {
        const result = await runRemoteTextCapture(ssh, remoteCommand, knownHostsMode, signal);
        return result;
      },
      copyLocalDirectoryToRemote: async ({ ssh, localPath, remotePath, knownHostsMode, signal }) => {
        await copyLocalDirectoryToRemoteCapture({ ssh, localPath, remotePath, knownHostsMode, signal });
      },
    }));

  return {
    resolveRemoteReleaseTarget: async ({ ssh, knownHostsMode, signal }) => {
      const preflight = await runRemoteTextCapture(
        ssh,
        [
          "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
          '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
          '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
        ].join(' '),
        knownHostsMode,
        signal,
      );
      if (preflight.status !== 0) {
        throw new Error(redactSshText(preflight.stderr || preflight.stdout || `SSH command failed for ${ssh.target}.`));
      }
      const parsed = parseFirstJsonObject(preflight.stdout) as null | Readonly<{ platform?: unknown; arch?: unknown }>;
      return {
        os: normalizeRemoteReleaseOs(parsed?.platform),
        arch: normalizeRemoteReleaseArch(parsed?.arch),
      };
    },
    runRemoteText: async ({ ssh, remoteCommand, knownHostsMode, signal }) => await runRemoteTextCapture(ssh, remoteCommand, knownHostsMode, signal),
    copyLocalDirectoryToRemote: async ({ ssh, localPath, remotePath, knownHostsMode, signal }) => await copyLocalDirectoryToRemoteCapture({ ssh, localPath, remotePath, knownHostsMode, signal }),
    installRemoteComponent: async ({ componentId, channel, ssh, knownHostsMode, installerBinaryPath, remoteHomeDir, signal }) => {
      const result = await installRemoteFirstPartyComponent({
        componentId,
        channel,
        ssh,
        knownHostsMode,
        installerBinaryPath,
        remoteHomeDir,
        ...(signal ? { signal } : {}),
      });
      return {
        binaryPath: result.binaryPath,
        versionId: result.versionId,
      };
    },
    localInstallPolicy: { ...params.localInstallPolicy, organizationPolicy },
    ...(params.resolveLocalInstallVersion ? { resolveLocalInstallVersion: params.resolveLocalInstallVersion } : {}),
  };
}
