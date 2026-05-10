import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOpenSshCommand,
  redactSshText,
  type OpenSshAuth,
  type OpenSshKnownHostsMode,
} from './openSshTransport.js';

export type OpenSshLocalPortForwardRequest = Readonly<{
  sshBin?: string;
  target: string;
  port?: number;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  localPort: number;
  remoteHost?: string;
  remotePort: number;
  controlDir?: string;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
}>;

export type CloseOpenSshLocalPortForwardRequest = Readonly<{
  sshBin?: string;
  target: string;
  port?: number;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  controlPath: string;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
}>;

export type OpenSshLocalPortForwardHandle = Readonly<{
  localPort: number;
  remoteHost: string;
  remotePort: number;
  controlPath: string;
  close: () => Promise<void> | void;
}>;

export type OpenSshLocalPortForwardDeps = Readonly<{
  spawnSync?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
  mkdirSync?: (path: string, options: Readonly<{ recursive: true; mode: number }>) => unknown;
  now?: () => number;
  pid?: number;
}>;

function resolveDefaultControlDir(): string {
  return process.platform === 'win32'
    ? join(tmpdir(), 'happier-ssh-control')
    : '/tmp/happier-ssh-control';
}

function insertArgsBeforeTarget(
  args: readonly string[],
  target: string,
  insertedArgs: readonly string[],
): string[] {
  const nextArgs = [...args];
  const resolvedTargetIndex = nextArgs.lastIndexOf(target);
  const targetIndex = resolvedTargetIndex >= 0
    ? resolvedTargetIndex
    : Math.max(0, nextArgs.length - 1);
  nextArgs.splice(targetIndex, 0, ...insertedArgs);
  return nextArgs;
}

function assertSuccessfulSshResult(
  result: SpawnSyncReturns<string>,
  errorPrefix: string,
): void {
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) === 0) {
    return;
  }

  const stderr = String(result.stderr ?? '').trim();
  const stdout = String(result.stdout ?? '').trim();
  const detail = stderr || stdout;
  const redactedDetail = detail ? redactSshText(detail).trim() : '';
  throw new Error(redactedDetail ? `${errorPrefix}: ${redactedDetail}` : errorPrefix);
}

function buildLocalPortForwardControlPath(
  request: OpenSshLocalPortForwardRequest,
  deps: OpenSshLocalPortForwardDeps,
): Readonly<{ controlDir: string; controlPath: string }> {
  const controlDir = String(request.controlDir ?? '').trim() || resolveDefaultControlDir();
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  return {
    controlDir,
    controlPath: join(controlDir, `tunnel-${pid}-${now()}-${request.localPort}.sock`),
  };
}

type OpenSshLocalPortForwardInvocationRequest = Readonly<{
  sshBin?: string;
  target: string;
  port?: number;
  sshConfigFile?: string;
  knownHostsPath?: string;
  knownHostsMode?: OpenSshKnownHostsMode;
  auth: OpenSshAuth;
  connectTimeoutSec?: number;
  serverAliveIntervalSec?: number;
  serverAliveCountMax?: number;
}>;

function buildLocalPortForwardBaseInvocation(request: OpenSshLocalPortForwardInvocationRequest) {
  return buildOpenSshCommand({
    sshBin: request.sshBin ?? 'ssh',
    target: request.target,
    port: request.port,
    sshConfigFile: request.sshConfigFile,
    remoteCommand: [],
    knownHostsPath: request.knownHostsPath,
    knownHostsMode: request.knownHostsMode ?? (request.knownHostsPath ? 'app' : 'system'),
    auth: request.auth,
    connectTimeoutSec: request.connectTimeoutSec,
    serverAliveIntervalSec: request.serverAliveIntervalSec,
    serverAliveCountMax: request.serverAliveCountMax,
  });
}

export function closeOpenSshLocalPortForward(
  request: CloseOpenSshLocalPortForwardRequest,
  deps: OpenSshLocalPortForwardDeps = {},
): void {
  const spawn = deps.spawnSync ?? (
    (command, args, options) => spawnSync(command, [...args], options)
  );
  const closeInvocation = buildLocalPortForwardBaseInvocation(request);
  const closeArgs = insertArgsBeforeTarget(closeInvocation.args, request.target, [
    '-o', `ControlPath=${request.controlPath}`,
    '-O',
    'exit',
  ]);
  assertSuccessfulSshResult(spawn(closeInvocation.command, closeArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...(closeInvocation.env ? { env: closeInvocation.env } : {}),
  }), 'SSH tunnel close failed');
}

export function openSshLocalPortForward(
  request: OpenSshLocalPortForwardRequest,
  deps: OpenSshLocalPortForwardDeps = {},
): OpenSshLocalPortForwardHandle {
  const spawn = deps.spawnSync ?? (
    (command, args, options) => spawnSync(command, [...args], options)
  );
  const makeDir = deps.mkdirSync ?? mkdirSync;
  const remoteHost = String(request.remoteHost ?? '').trim() || '127.0.0.1';
  const { controlDir, controlPath } = buildLocalPortForwardControlPath(request, deps);
  makeDir(controlDir, { recursive: true, mode: 0o700 });

  const openInvocation = buildLocalPortForwardBaseInvocation(request);
  const openArgs = insertArgsBeforeTarget(openInvocation.args, request.target, [
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ControlMaster=yes',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'ControlPersist=60',
    '-f',
    '-N',
    '-L', `${request.localPort}:${remoteHost}:${request.remotePort}`,
  ]);
  assertSuccessfulSshResult(spawn(openInvocation.command, openArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...(openInvocation.env ? { env: openInvocation.env } : {}),
  }), 'SSH tunnel failed');

  const close = () => {
    closeOpenSshLocalPortForward({ ...request, controlPath }, { ...deps, spawnSync: spawn });
  };

  return {
    localPort: request.localPort,
    remoteHost,
    remotePort: request.remotePort,
    controlPath,
    close,
  };
}

export async function withOpenSshLocalPortForward<T>(
  request: OpenSshLocalPortForwardRequest,
  fn: (handle: OpenSshLocalPortForwardHandle) => Promise<T>,
  deps?: OpenSshLocalPortForwardDeps,
): Promise<T> {
  const handle = openSshLocalPortForward(request, deps);
  let operationFailed = false;
  try {
    return await fn(handle);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (!operationFailed) {
        throw closeError;
      }
    }
  }
}
