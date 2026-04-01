import {
  buildOpenScpCommand,
  buildOpenSshCommand,
  parseJsonLinesBestEffort,
  safeBashSingleQuote,
  SshKnownHostsStore,
  type OpenSshAuth,
} from '@happier-dev/cli-common/ssh';

export type SshAuth = OpenSshAuth;

export { safeBashSingleQuote, parseJsonLinesBestEffort, SshKnownHostsStore };

export function buildSshCommand(params: Readonly<{
  sshBin: string;
  target: string;
  remoteCommand: readonly string[];
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  auth: SshAuth;
  port?: number;
  connectTimeoutSec: number;
  serverAliveIntervalSec: number;
  serverAliveCountMax: number;
}>): Readonly<{
  command: string;
  args: string[];
  redactedLabel: string;
  env?: NodeJS.ProcessEnv;
}> {
  const invocation = buildOpenSshCommand({
    sshBin: params.sshBin,
    target: params.target,
    remoteCommand: params.remoteCommand,
    sshConfigFile: params.sshConfigFile,
    knownHostsMode: params.knownHostsMode,
    knownHostsPath: params.knownHostsPath,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
  });

  return invocation;
}

export function buildScpCommand(params: Readonly<{
  scpBin: string;
  target: string;
  localPath: string;
  remotePath: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: 'app' | 'system';
  auth: SshAuth;
  port?: number;
  connectTimeoutSec: number;
  serverAliveIntervalSec: number;
  serverAliveCountMax: number;
}>): Readonly<{
  command: string;
  args: string[];
  redactedLabel: string;
  env?: NodeJS.ProcessEnv;
}> {
  return buildOpenScpCommand({
    scpBin: params.scpBin,
    target: params.target,
    localPath: params.localPath,
    remotePath: params.remotePath,
    sshConfigFile: params.sshConfigFile,
    knownHostsMode: params.knownHostsMode,
    knownHostsPath: params.knownHostsPath,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
  });
}

export function redactRemoteBootstrapPayload<T extends Record<string, unknown>>(params: T): Omit<T, 'claimSecret' | 'stateFile'> {
  const next = { ...params };
  delete (next as { claimSecret?: unknown }).claimSecret;
  delete (next as { stateFile?: unknown }).stateFile;
  return next;
}
