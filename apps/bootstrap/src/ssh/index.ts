export interface SshAuthConfig {
  kind: 'agent' | 'keyfile';
  identityFile?: string;
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
}

function quoteForRemoteBash(command: string): string {
  const raw = String(command ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function resolveCommonSshArgs(params: Readonly<{
  port?: number;
  auth: SshAuthConfig;
  knownHosts: SshKnownHostsConfig;
  connectTimeoutSeconds?: number;
  portFlag: '-p' | '-P';
}>): string[] {
  const auth = params.auth ?? { kind: 'agent' };
  if (auth.kind === 'keyfile' && !String(auth.identityFile ?? '').trim()) {
    throw new Error('identityFile is required for keyfile auth');
  }

  const timeoutSeconds = Number.isFinite(params.connectTimeoutSeconds)
    ? Math.max(1, Math.floor(params.connectTimeoutSeconds as number))
    : 10;

  const args = [
    ...(params.port ? [params.portFlag, String(Math.floor(params.port))] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    `ConnectTimeout=${timeoutSeconds}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];

  if (params.knownHosts.mode === 'app') {
    const knownHostsPath = String(params.knownHosts.path ?? '').trim();
    if (!knownHostsPath) {
      throw new Error('known hosts path is required when using app-managed known hosts');
    }
    args.push(
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `UserKnownHostsFile=${knownHostsPath}`,
    );
  }

  args.push(
    '-o',
    'StrictHostKeyChecking=yes',
  );

  if (auth.kind === 'keyfile') {
    args.push('-i', String(auth.identityFile));
  }

  return args;
}

export function buildSshCommand(params: BuildSshCommandParams): SshCommandInvocation {
  const target = String(params.target ?? '').trim();
  if (!target) {
    throw new Error('ssh target is required');
  }
  const args = resolveCommonSshArgs({
    port: params.port,
    auth: params.auth,
    knownHosts: params.knownHosts,
    connectTimeoutSeconds: params.connectTimeoutSeconds,
    portFlag: '-p',
  });

  args.push(target, 'bash', '-lc', quoteForRemoteBash(String(params.remoteCommand ?? '')));

  return {
    command: 'ssh',
    args,
  };
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

  const args = resolveCommonSshArgs({
    port: params.port,
    auth: params.auth,
    knownHosts: params.knownHosts,
    connectTimeoutSeconds: params.connectTimeoutSeconds,
    portFlag: '-P',
  });
  args.push('-r', localPath, `${target}:${remotePath}`);

  return {
    command: 'scp',
    args,
  };
}

export function redactSshText(text: string): string {
  return String(text ?? '')
    .replace(/Identity file\s+\S+/gi, 'Identity file [redacted-path]')
    .replace(/password:\s*[^\s]+/gi, 'password: [redacted-secret]');
}
