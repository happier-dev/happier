import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function quoteForRemoteBash(command: string): string {
  const raw = String(command ?? '');
  if (!raw) return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

const ASKPASS_SCRIPT_PATH = join(tmpdir(), 'happier-ssh-askpass.sh');

function ensureAskpassScriptPath(): string {
  const directory = join(tmpdir(), 'happier');
  mkdirSync(directory, { recursive: true });
  if (!existsSync(ASKPASS_SCRIPT_PATH)) {
    writeFileSync(
      ASKPASS_SCRIPT_PATH,
      '#!/bin/sh\nprintf "%s\\n" "$HAPPIER_SSH_PASSWORD"\n',
      {
        encoding: 'utf8',
        mode: 0o700,
      },
    );
  }
  try {
    chmodSync(ASKPASS_SCRIPT_PATH, 0o700);
  } catch {
    // best effort
  }
  return ASKPASS_SCRIPT_PATH;
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
  if (auth.kind === 'password' && !String(auth.password ?? '').trim()) {
    throw new Error('password is required for password auth');
  }

  const timeoutSeconds = Number.isFinite(params.connectTimeoutSeconds)
    ? Math.max(1, Math.floor(params.connectTimeoutSeconds as number))
    : 10;

  const args = [
    ...(params.port ? [params.portFlag, String(Math.floor(params.port))] : []),
    '-o',
    auth.kind === 'password' ? 'BatchMode=no' : 'BatchMode=yes',
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
  if (auth.kind === 'password') {
    args.push(
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
    );
  }

  return args;
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
  const args = resolveCommonSshArgs({
    port: params.port,
    auth: params.auth,
    knownHosts: params.knownHosts,
    connectTimeoutSeconds: params.connectTimeoutSeconds,
    portFlag: '-p',
  });

  const env = params.auth.kind === 'password'
    ? {
        ...process.env,
        HAPPIER_SSH_PASSWORD: String(params.auth.password ?? ''),
        SSH_ASKPASS: ensureAskpassScriptPath(),
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY ?? ':0',
      }
    : undefined;

  args.push(target, 'bash', '-lc', quoteForRemoteBash(String(params.remoteCommand ?? '')));

  return {
    command: 'ssh',
    args,
    ...(env ? { env } : {}),
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
  args.push('-r', localPath, `${target}:${normalizeScpRemotePath(remotePath)}`);

  const env = params.auth.kind === 'password'
    ? {
        ...process.env,
        HAPPIER_SSH_PASSWORD: String(params.auth.password ?? ''),
        SSH_ASKPASS: ensureAskpassScriptPath(),
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY ?? ':0',
      }
    : undefined;

  return {
    command: 'scp',
    args,
    ...(env ? { env } : {}),
  };
}

export function redactSshText(text: string): string {
  return String(text ?? '')
    .replace(/Identity file\s+\S+/gi, 'Identity file [redacted-path]')
    .replace(/password:\s*[^\s]+/gi, 'password: [redacted-secret]');
}
