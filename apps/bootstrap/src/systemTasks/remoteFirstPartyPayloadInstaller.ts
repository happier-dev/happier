import {
  installRemoteFirstPartyComponent as installRemoteFirstPartyComponentShared,
  normalizeRemoteReleaseArch,
  normalizeRemoteReleaseOs,
  resolveRemoteInstalledFirstPartyBinaryPath,
  type RemoteFirstPartyCommandResult,
  type RemoteFirstPartyInstallDeps,
  type SystemTaskSshConnectionConfig,
} from '@happier-dev/cli-common/systemTasks';

import { buildScpCommand, buildSshCommand, redactSshText } from '../ssh/index.js';
import { parseFirstJsonObject, resolveDefaultKnownHostsPath, runCommandCapture } from './taskRuntime.js';
type SshConnectionConfig = SystemTaskSshConnectionConfig;
type SshConnectionWithPasswordConfig = SshConnectionConfig & Readonly<{ password?: string }>;

export { resolveRemoteInstalledFirstPartyBinaryPath };

function resolveKnownHostsMode(ssh: SshConnectionConfig, knownHostsMode?: 'app' | 'system'): 'app' | 'system' {
  if (knownHostsMode === 'app' || knownHostsMode === 'system') return knownHostsMode;
  return ssh.knownHostsPath ? 'app' : 'system';
}

function resolveKnownHostsConfig(ssh: SshConnectionConfig, knownHostsMode?: 'app' | 'system') {
  const resolvedMode = resolveKnownHostsMode(ssh, knownHostsMode);
  return resolvedMode === 'app'
    ? { mode: 'app' as const, path: ssh.knownHostsPath || resolveDefaultKnownHostsPath() }
    : { mode: 'system' as const };
}

async function runRemoteTextDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  remoteCommand: string;
  knownHostsMode?: 'app' | 'system';
}>): Promise<RemoteFirstPartyCommandResult> {
  const ssh = params.ssh as SshConnectionWithPasswordConfig;
  const invocation = buildSshCommand({
    target: ssh.target,
    port: ssh.port,
    auth: {
      kind: ssh.auth,
      identityFile: ssh.identityFile,
      ...(ssh.auth === 'password' ? { password: ssh.password } : {}),
    },
    knownHosts: resolveKnownHostsConfig(ssh, params.knownHostsMode),
    remoteCommand: params.remoteCommand,
  });
  const result = await runCommandCapture({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
  });
  if (result.status !== 0) {
    throw new Error(redactSshText(result.stderr || result.stdout || `SSH command failed for ${params.ssh.target}.`));
  }
  return result;
}

async function copyLocalDirectoryToRemoteDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  localPath: string;
  remotePath: string;
  knownHostsMode?: 'app' | 'system';
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
  });
  if (result.status !== 0) {
    throw new Error(redactSshText(result.stderr || result.stdout || `SCP command failed for ${params.ssh.target}.`));
  }
}

async function resolveRemoteReleaseTargetDefault(params: Readonly<{
  ssh: SshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
}>): Promise<Readonly<{ os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }>> {
  const preflight = await runRemoteTextDefault({
    ssh: params.ssh,
    knownHostsMode: params.knownHostsMode,
    remoteCommand: [
      "printf '{\"platform\":\"%s\",\"arch\":\"%s\"}\\n'",
      '"$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
      '"$(uname -m | tr \'[:upper:]\' \'[:lower:]\')"',
    ].join(' '),
  });
  const parsed = parseFirstJsonObject(preflight.stdout) as null | Readonly<{
    platform?: unknown;
    arch?: unknown;
  }>;
  return {
    os: normalizeRemoteReleaseOs(parsed?.platform),
    arch: normalizeRemoteReleaseArch(parsed?.arch),
  };
}

export async function installRemoteFirstPartyComponent(params: Readonly<{
  componentId: 'happier-cli' | 'hstack';
  channel?: string;
  ssh: SshConnectionConfig;
  knownHostsMode?: 'app' | 'system';
  installerBinaryPath?: string;
  remoteHomeDir?: string;
}>, deps: Partial<RemoteFirstPartyInstallDeps> = {}): Promise<Readonly<{ binaryPath: string; versionId: string; source: string | null }>> {
  return await installRemoteFirstPartyComponentShared(params, {
    resolveRemoteReleaseTarget: async (innerParams) => await (deps.resolveRemoteReleaseTarget ?? resolveRemoteReleaseTargetDefault)(innerParams),
    runRemoteText: async (innerParams) => await (deps.runRemoteText ?? runRemoteTextDefault)(innerParams),
    copyLocalDirectoryToRemote: async (innerParams) => await (deps.copyLocalDirectoryToRemote ?? copyLocalDirectoryToRemoteDefault)(innerParams),
    ...(deps.preparePayload ? { preparePayload: deps.preparePayload } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
