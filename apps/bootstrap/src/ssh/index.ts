import {
  buildOpenScpCommand,
  buildOpenSshCommand,
  redactSshText,
  safeBashSingleQuote,
  type OpenSshAuth,
  type OpenSshKnownHostsMode,
} from '@happier-dev/cli-common/ssh';

export interface SshAuthConfig {
  kind: 'agent' | 'keyfile' | 'password';
  identityFile?: string;
  password?: string;
}

export interface SshKnownHostsConfig {
  mode: 'app' | 'system';
  path?: string;
}

export interface BuildSshCommandParams {
  target: string;
  port?: number;
  auth: SshAuthConfig;
  knownHosts: SshKnownHostsConfig;
  remoteCommand: string;
  connectTimeoutSeconds?: number;
}

export interface SshCommandInvocation {
  command: 'ssh';
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface BuildScpCommandParams {
  target: string;
  remotePath: string;
  localPath: string;
  port?: number;
  auth: SshAuthConfig;
  knownHosts: SshKnownHostsConfig;
  connectTimeoutSeconds?: number;
}

export interface ScpCommandInvocation {
  command: 'scp';
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function resolveAuth(params: Readonly<{ auth: SshAuthConfig }>): OpenSshAuth {
  const auth = params.auth ?? { kind: 'agent' };
  if (auth.kind === 'agent') return { mode: 'agent' };
  if (auth.kind === 'keyfile') {
    return { mode: 'keyFile', privateKeyPath: String(auth.identityFile ?? '') };
  }
  return { mode: 'password', password: String(auth.password ?? '') };
}

function resolveKnownHosts(params: Readonly<{ knownHosts: SshKnownHostsConfig }>): Readonly<{
  knownHostsMode: OpenSshKnownHostsMode;
  knownHostsPath?: string;
}> {
  if (params.knownHosts.mode === 'system') {
    return { knownHostsMode: 'system' };
  }
  return {
    knownHostsMode: 'app',
    knownHostsPath: String(params.knownHosts.path ?? ''),
  };
}

function normalizeScpRemotePath(remotePath: string): string {
  const trimmed = String(remotePath ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('$HOME/')) {
    return trimmed.slice('$HOME/'.length);
  }
  if (trimmed === '$HOME') {
    return '.';
  }
  return trimmed;
}

export function buildSshCommand(params: BuildSshCommandParams): SshCommandInvocation {
  const target = String(params.target ?? '').trim();
  if (!target) {
    throw new Error('ssh target is required');
  }
  const auth = resolveAuth({ auth: params.auth });
  const knownHosts = resolveKnownHosts({ knownHosts: params.knownHosts });
  const invocation = buildOpenSshCommand({
    sshBin: 'ssh',
    target,
    port: params.port,
    auth,
    ...knownHosts,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(String(params.remoteCommand ?? ''))],
    connectTimeoutSec: params.connectTimeoutSeconds,
    serverAliveIntervalSec: 15,
    serverAliveCountMax: 3,
  });

  return {
    command: 'ssh',
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
  } satisfies SshCommandInvocation;
}

export function buildScpCommand(params: BuildScpCommandParams): ScpCommandInvocation {
  const target = String(params.target ?? '').trim();
  const remotePath = String(params.remotePath ?? '').trim();
  const localPath = String(params.localPath ?? '').trim();
  if (!target) {
    throw new Error('ssh target is required');
  }
  if (!remotePath) {
    throw new Error('remote path is required');
  }
  if (!localPath) {
    throw new Error('local path is required');
  }
  const auth = resolveAuth({ auth: params.auth });
  const knownHosts = resolveKnownHosts({ knownHosts: params.knownHosts });
  const invocation = buildOpenScpCommand({
    scpBin: 'scp',
    target,
    port: params.port,
    auth,
    ...knownHosts,
    localPath,
    remotePath: normalizeScpRemotePath(remotePath),
    connectTimeoutSec: params.connectTimeoutSeconds,
    serverAliveIntervalSec: 15,
    serverAliveCountMax: 3,
  });

  return {
    command: 'scp',
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
  } satisfies ScpCommandInvocation;
}

export { redactSshText };
