import { spawnSync } from 'node:child_process';

import { safeBashSingleQuote } from './shellQuote.js';
import {
  buildOpenScpCommand,
  buildOpenSshCommand,
  buildSshKeyscanInvocation,
  parseJsonLinesBestEffort,
  redactSshText,
  type OpenSshAuth,
  type OpenSshKnownHostsMode,
} from './openSshTransport.js';

export type OpenSshCommandResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

function runCommandSync(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  errorPrefix: string;
  redactedLabel?: string;
}>): OpenSshCommandResult {
  const result = spawnSync(params.command, [...params.args], {
    encoding: 'utf8',
    windowsHide: true,
    ...(params.env ? { env: params.env } : {}),
  });

  if (result.error) {
    throw result.error;
  }

  const status = result.status ?? 1;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');

  if (status !== 0) {
    const detail = (stderr.trim() || stdout.trim());
    const redactedDetail = detail ? redactSshText(detail).trim() : '';
    throw new Error(
      redactedDetail
        ? `${params.errorPrefix}: ${redactedDetail}`
        : `${params.errorPrefix}: ${params.redactedLabel ?? params.command}`,
    );
  }

  return { status, stdout, stderr };
}

export function runOpenSshRemoteCommandSync(params: Readonly<{
  sshBin?: string;
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
  errorPrefix?: string;
}>): OpenSshCommandResult {
  const invocation = buildOpenSshCommand({
    sshBin: params.sshBin ?? 'ssh',
    target: params.target,
    remoteCommand: params.remoteCommand,
    sshConfigFile: params.sshConfigFile,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
  });

  return runCommandSync({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
    errorPrefix: params.errorPrefix ?? 'SSH command failed',
    redactedLabel: invocation.redactedLabel,
  });
}

export function runOpenSshPosixShellCommandSync<TParsed = unknown>(params: Readonly<{
  sshBin?: string;
  target: string;
  shellCommand: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  parseJson?: boolean;
  errorPrefix?: string;
}>): Readonly<{
  result: OpenSshCommandResult;
  parsed: TParsed | null;
}> {
  const result = runOpenSshRemoteCommandSync({
    sshBin: params.sshBin,
    target: params.target,
    sshConfigFile: params.sshConfigFile,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    errorPrefix: params.errorPrefix,
    remoteCommand: ['bash', '-lc', safeBashSingleQuote(params.shellCommand)],
  });

  const parsed = params.parseJson
    ? parseJsonLinesBestEffort<TParsed>(result.stdout)
    : null;

  return { result, parsed };
}

export function runRemoteTextSync(params: Readonly<{
  sshBin?: string;
  target: string;
  remoteCommand: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  errorPrefix?: string;
}>): OpenSshCommandResult {
  return runOpenSshPosixShellCommandSync({
    sshBin: params.sshBin,
    target: params.target,
    shellCommand: params.remoteCommand,
    sshConfigFile: params.sshConfigFile,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    errorPrefix: params.errorPrefix,
    parseJson: false,
  }).result;
}

export function runRemoteJsonSync<TParsed>(params: Readonly<{
  sshBin?: string;
  target: string;
  remoteCommand: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  errorPrefix?: string;
}>): TParsed {
  const { parsed } = runOpenSshPosixShellCommandSync<TParsed>({
    sshBin: params.sshBin,
    target: params.target,
    shellCommand: params.remoteCommand,
    sshConfigFile: params.sshConfigFile,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
    errorPrefix: params.errorPrefix,
    parseJson: true,
  });

  if (parsed) {
    return parsed;
  }

  throw new Error('Remote command did not return valid JSON');
}

export function copyLocalDirectoryToRemoteSync(params: Readonly<{
  scpBin?: string;
  target: string;
  localPath: string;
  remotePath: string;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  port?: number;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
  errorPrefix?: string;
}>): void {
  const invocation = buildOpenScpCommand({
    scpBin: params.scpBin ?? 'scp',
    target: params.target,
    localPath: params.localPath,
    remotePath: params.remotePath,
    sshConfigFile: params.sshConfigFile,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
  });

  runCommandSync({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
    errorPrefix: params.errorPrefix ?? 'SCP command failed',
    redactedLabel: invocation.redactedLabel,
  });
}

export function sshKeyscanSync(params: Readonly<{
  host: string;
  port?: number;
  timeoutSec?: number;
  keyType?: string;
  errorPrefix?: string;
}>): string {
  const invocation = buildSshKeyscanInvocation({
    host: params.host,
    port: params.port,
    timeoutSec: params.timeoutSec,
    keyType: params.keyType,
  });

  const result = runCommandSync({
    command: invocation.command,
    args: invocation.args,
    errorPrefix: params.errorPrefix ?? 'ssh-keyscan failed',
  });

  return result.stdout;
}
