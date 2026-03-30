import { createHash } from 'node:crypto';

export type SshAuth =
  | Readonly<{ mode: 'agent' }>
  | Readonly<{ mode: 'keyFile'; privateKeyPath: string }>
  | Readonly<{ mode: 'passwordPrompt' }>
  | Readonly<{ mode: 'password'; password: string }>;

type SshKnownHostStatus = 'added' | 'unchanged' | 'mismatch';

type SshKnownHostRememberResult = Readonly<{
  status: SshKnownHostStatus;
  fingerprint: string;
  existingFingerprint?: string;
}>;

type KnownHostEntry = Readonly<{
  host: string;
  keyType: string;
  key: string;
}>;

export function safeBashSingleQuote(value: string): string {
  const raw = String(value ?? '');
  if (raw === '') return "''";
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
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

function computeSshFingerprint(key: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(String(key ?? '').trim(), 'base64'))
    .digest('base64')
    .replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

function parseKnownHosts(text: string): KnownHostEntry[] {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [host, keyType, key] = line.split(/\s+/u);
      if (!host || !keyType || !key) return [];
      return [{ host, keyType, key }];
    });
}

function renderKnownHosts(entries: readonly KnownHostEntry[]): string {
  return entries.map((entry) => `${entry.host} ${entry.keyType} ${entry.key}`).join('\n');
}

function buildSshTransportArgs(params: Readonly<{
  knownHostsPath?: string;
  sshConfigFile?: string;
  knownHostsMode?: 'app' | 'system';
  auth: SshAuth;
  port?: number;
  connectTimeoutSec: number;
  serverAliveIntervalSec: number;
  serverAliveCountMax: number;
  portFlag: '-p' | '-P';
}>): string[] {
  const args: string[] = [];
  if (params.sshConfigFile) {
    args.unshift('-F', params.sshConfigFile);
  }
  args.push(
    '-o', `BatchMode=${params.auth.mode === 'password' ? 'no' : 'yes'}`,
    '-o', 'StrictHostKeyChecking=yes',
  );

  if ((params.knownHostsMode ?? 'app') === 'app') {
    args.push(
      '-o', `UserKnownHostsFile=${params.knownHostsPath ?? ''}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
    );
  }

  args.push(
    '-o', `ConnectTimeout=${params.connectTimeoutSec}`,
    '-o', `ServerAliveInterval=${params.serverAliveIntervalSec}`,
    '-o', `ServerAliveCountMax=${params.serverAliveCountMax}`,
    '-o', 'LogLevel=ERROR',
  );

  if (params.auth.mode === 'keyFile') {
    args.push('-i', params.auth.privateKeyPath);
  }
  if (params.auth.mode === 'password') {
    args.push('-o', 'NumberOfPasswordPrompts=1');
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive');
  }
  if (typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0) {
    args.push(params.portFlag, String(Math.floor(params.port)));
  }

  return args;
}

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
}> {
  const args = buildSshTransportArgs({
    knownHostsPath: params.knownHostsPath,
    sshConfigFile: params.sshConfigFile,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    portFlag: '-p',
  });

  args.push(params.target, ...params.remoteCommand);

  const commandLabel = params.remoteCommand.length >= 2
    ? `${params.remoteCommand[0]} ${params.remoteCommand[1]} …`
    : `${params.remoteCommand[0] ?? 'remote'} …`;

  return {
    command: params.sshBin,
    args,
    redactedLabel: `${params.sshBin} ${params.target} ${commandLabel}`,
  };
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
}> {
  const args = buildSshTransportArgs({
    knownHostsPath: params.knownHostsPath,
    sshConfigFile: params.sshConfigFile,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    portFlag: '-P',
  });

  args.push('-r', params.localPath, `${params.target}:${params.remotePath}`);

  return {
    command: params.scpBin,
    args,
    redactedLabel: `${params.scpBin} ${params.localPath} ${params.target}:…`,
  };
}

export function redactRemoteBootstrapPayload<T extends Record<string, unknown>>(params: T): Omit<T, 'claimSecret' | 'stateFile'> {
  const next = { ...params };
  delete (next as { claimSecret?: unknown }).claimSecret;
  delete (next as { stateFile?: unknown }).stateFile;
  return next;
}

export class SshKnownHostsStore {
  private entries: KnownHostEntry[];

  constructor(params: Readonly<{ initialText?: string }> = {}) {
    this.entries = parseKnownHosts(params.initialText ?? '');
  }

  remember(params: Readonly<{
    host: string;
    keyType: string;
    key: string;
  }>): SshKnownHostRememberResult {
    const entry: KnownHostEntry = {
      host: String(params.host ?? '').trim(),
      keyType: String(params.keyType ?? '').trim(),
      key: String(params.key ?? '').trim(),
    };
    const fingerprint = computeSshFingerprint(entry.key);
    const existing = this.entries.find((candidate) => candidate.host === entry.host && candidate.keyType === entry.keyType);
    if (!existing) {
      this.entries.push(entry);
      return { status: 'added', fingerprint };
    }

    const existingFingerprint = computeSshFingerprint(existing.key);
    if (existing.key === entry.key) {
      return { status: 'unchanged', fingerprint };
    }

    return {
      status: 'mismatch',
      fingerprint,
      existingFingerprint,
    };
  }

  forget(host: string): void {
    const normalizedHost = String(host ?? '').trim();
    this.entries = this.entries.filter((entry) => entry.host !== normalizedHost);
  }

  toString(): string {
    return renderKnownHosts(this.entries);
  }
}
