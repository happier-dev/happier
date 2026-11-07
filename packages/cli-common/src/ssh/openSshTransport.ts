import { parseTimeoutSeconds } from './keyscanInvocation.js';
import { buildSshAskpassEnv } from './sshAskpass.js';

export type OpenSshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'passwordPrompt' }>
  | Readonly<{ mode: 'password'; password: string }>;

export type OpenSshKnownHostsMode = 'app' | 'system';

function validateOpenSshTarget(target: string): string {
  const normalized = String(target ?? '').trim();
  if (!normalized) {
    throw new Error('target is required');
  }
  if (normalized.startsWith('-')) {
    throw new Error('target must not start with "-"');
  }
  if (/\s/u.test(normalized)) {
    throw new Error('target must not contain whitespace');
  }
  return normalized;
}

function buildOpenSshTransportArgs(params: Readonly<{
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  tty?: boolean;
  portFlag: '-p' | '-P';
}>): Readonly<{ args: string[]; env?: NodeJS.ProcessEnv }> {
  if (params.auth.mode === 'keyFile' && !String(params.auth.privateKeyPath ?? '').trim()) {
    throw new Error('privateKeyPath is required for keyFile auth');
  }
  if (params.auth.mode === 'password' && !String(params.auth.password ?? '').trim()) {
    throw new Error('password is required for password auth');
  }

  const args: string[] = [];
  if (params.sshConfigFile) {
    args.push('-F', params.sshConfigFile);
  }

  if (typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0) {
    args.push(params.portFlag, String(Math.floor(params.port)));
  }

  args.push(
    '-o',
    `BatchMode=${params.auth.mode === 'password' || params.auth.mode === 'passwordPrompt' ? 'no' : 'yes'}`,
    '-o',
    'LogLevel=ERROR',
    '-o',
    `ConnectTimeout=${parseTimeoutSeconds(params.connectTimeoutSec, 10)}`,
    '-o',
    `ServerAliveInterval=${parseTimeoutSeconds(params.serverAliveIntervalSec, 15)}`,
    '-o',
    `ServerAliveCountMax=${parseTimeoutSeconds(params.serverAliveCountMax, 3)}`,
  );

  if ((params.knownHostsMode ?? 'app') === 'app') {
    const knownHostsPath = String(params.knownHostsPath ?? '').trim();
    if (!knownHostsPath) {
      throw new Error('knownHostsPath is required when using app-managed known hosts');
    }
    args.push(
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `UserKnownHostsFile=${knownHostsPath}`,
    );
  }

  args.push('-o', 'StrictHostKeyChecking=yes');

  if (params.auth.mode === 'keyFile') {
    args.push('-i', params.auth.privateKeyPath);
  }

  const shouldEnablePasswordOptions = params.auth.mode === 'password' || params.auth.mode === 'passwordPrompt';
  const env = params.auth.mode === 'password'
    ? buildSshAskpassEnv(params.auth.password)
    : undefined;

  if (shouldEnablePasswordOptions) {
    args.push(
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
    );
  }

  return { args, ...(env ? { env } : {}) };
}

export function buildOpenSshCommand(params: Readonly<{
  sshBin: string;
  target: string;
  remoteCommand: readonly string[];
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  tty?: boolean;
}>): Readonly<{
  command: string;
  args: string[];
  redactedLabel: string;
  env?: NodeJS.ProcessEnv;
}> {
  const target = validateOpenSshTarget(params.target);
  const { args, env } = buildOpenSshTransportArgs({
    sshConfigFile: params.sshConfigFile,
    knownHostsMode: params.knownHostsMode,
    knownHostsPath: params.knownHostsPath,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    portFlag: '-p',
  });

  const nextArgs = [...args, ...(params.tty ? ['-t'] : []), target, ...params.remoteCommand];
  const commandLabel = params.remoteCommand.length >= 2
    ? `${params.remoteCommand[0]} ${params.remoteCommand[1]} …`
    : `${params.remoteCommand[0] ?? 'remote'} …`;

  return {
    command: params.sshBin,
    args: nextArgs,
    redactedLabel: `${params.sshBin} ${target} ${commandLabel}`,
    ...(env ? { env } : {}),
  };
}

export function buildOpenScpCommand(params: Readonly<{
  scpBin: string;
  target: string;
  localPath: string;
  remotePath: string;
  direction?: 'upload' | 'download';
  recursive?: boolean;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
}>): Readonly<{
  command: string;
  args: string[];
  redactedLabel: string;
  env?: NodeJS.ProcessEnv;
}> {
  const target = validateOpenSshTarget(params.target);
  const { args, env } = buildOpenSshTransportArgs({
    sshConfigFile: params.sshConfigFile,
    knownHostsMode: params.knownHostsMode,
    knownHostsPath: params.knownHostsPath,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    portFlag: '-P',
  });

  const direction = params.direction ?? 'upload';
  const endpoints = direction === 'upload'
    ? [params.localPath, `${target}:${params.remotePath}`]
    : [`${target}:${params.remotePath}`, params.localPath];
  return {
    command: params.scpBin,
    args: [...args, ...(params.recursive === false ? [] : ['-r']), ...endpoints],
    ...(env ? { env } : {}),
    redactedLabel: `${params.scpBin} ${direction === 'upload' ? '… ' + target + ':…' : target + ':… …'}`,
  };
}

export function parseJsonLinesBestEffort<T>(stdout: string): T | null {
  const lines = String(stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      return JSON.parse(line) as T;
    } catch {
      // continue
    }
  }

  return null;
}

export { buildSshKeyscanInvocation } from './keyscanInvocation.js';

export function redactSshText(text: string): string {
  return String(text ?? '')
    .replace(/("(?:claimSecret|pairingSecret|secretKey|masterSecret|approvalSecret|secretB64Url|token)"\s*:\s*")[^"]*(")/giu, '$1[redacted-secret]$2')
    .replace(/("stateFile"\s*:\s*")[^"]*(")/giu, '$1[redacted-path]$2')
    .replace(/(Bearer\s+)[^\s"']+/giu, '$1[redacted-secret]')
    .replace(/(--(?:api-token|claim-secret|pairing-secret)(?:=|\s+))[^\s"']+/giu, '$1[redacted-secret]')
    .replace(/Identity file\s+\S+/gi, 'Identity file [redacted-path]')
    .replace(/password:\s*[^\s]+/gi, 'password: [redacted-secret]')
    .replace(/HAPPIER_SSH_PASSWORD=\S+/gi, 'HAPPIER_SSH_PASSWORD=[redacted-secret]');
}
