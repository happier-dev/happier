import { spawn, spawnSync } from 'node:child_process';

import {
  buildOpenScpCommand,
  buildOpenSshCommand,
  buildSshKeyscanInvocation,
  redactSshText,
  type OpenSshAuth,
  type OpenSshKnownHostsMode,
} from './openSshTransport.js';

export type OpenSshCommandResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

export type OpenSshExecutionErrorCode =
  | 'aborted'
  | 'timed_out'
  | 'input_limit_exceeded'
  | 'output_limit_exceeded'
  | 'spawn_failed'
  | 'command_failed';

export class OpenSshExecutionError extends Error {
  readonly code: OpenSshExecutionErrorCode;
  readonly status?: number;

  constructor(
    code: OpenSshExecutionErrorCode,
    message: string,
    options: Readonly<{ status?: number; cause?: unknown }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenSshExecutionError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

const DEFAULT_OPEN_SSH_TIMEOUT_MS = 60_000;
const DEFAULT_OPEN_SSH_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_OPEN_SSH_INPUT_LIMIT_BYTES = 64 * 1024;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

async function runCommand(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** `null` explicitly disables the process timeout after irreversible-operation admission. */
  timeoutMs?: number | null;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  rejectOnNonZero?: boolean;
  errorPrefix: string;
  redactedLabel?: string;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  input?: string;
  maxInputBytes?: number;
}>): Promise<OpenSshCommandResult> {
  const timeoutMs = params.timeoutMs === null
    ? null
    : normalizePositiveInteger(params.timeoutMs, DEFAULT_OPEN_SSH_TIMEOUT_MS);
  const maxStdoutBytes = normalizePositiveInteger(params.maxStdoutBytes, DEFAULT_OPEN_SSH_OUTPUT_LIMIT_BYTES);
  const maxStderrBytes = normalizePositiveInteger(params.maxStderrBytes, DEFAULT_OPEN_SSH_OUTPUT_LIMIT_BYTES);
  const maxInputBytes = normalizePositiveInteger(params.maxInputBytes, DEFAULT_OPEN_SSH_INPUT_LIMIT_BYTES);

  if (params.input !== undefined && Buffer.byteLength(params.input, 'utf8') > maxInputBytes) {
    throw new OpenSshExecutionError(
      'input_limit_exceeded',
      `${params.errorPrefix}: stdin exceeded the ${maxInputBytes}-byte input limit.`,
    );
  }

  if (params.signal?.aborted) {
    throw new OpenSshExecutionError('aborted', `${params.errorPrefix}: cancelled.`);
  }

  return await new Promise<OpenSshCommandResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(params.command, [...params.args], {
        stdio: [params.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(params.env ? { env: params.env } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rejectPromise(new OpenSshExecutionError(
        'spawn_failed',
        `${params.errorPrefix}: ${redactSshText(detail || params.redactedLabel || params.command)}`,
      ));
      return;
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      params.signal?.removeEventListener('abort', onAbort);
    };
    const kill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The process may already have exited. The terminal event remains authoritative.
      }
    };
    const rejectOnce = (error: OpenSshExecutionError) => {
      if (settled) return;
      settled = true;
      cleanup();
      kill();
      rejectPromise(error);
    };
    const onAbort = () => {
      rejectOnce(new OpenSshExecutionError('aborted', `${params.errorPrefix}: cancelled.`));
    };
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === 'stdout') {
        stdoutBytes += bytes.length;
        if (stdoutBytes > maxStdoutBytes) {
          rejectOnce(new OpenSshExecutionError(
            'output_limit_exceeded',
            `${params.errorPrefix}: stdout exceeded the ${maxStdoutBytes}-byte capture limit.`,
          ));
          return;
        }
        stdoutChunks.push(bytes);
        params.onStdoutChunk?.(bytes.toString('utf8'));
        return;
      }
      stderrBytes += bytes.length;
      if (stderrBytes > maxStderrBytes) {
        rejectOnce(new OpenSshExecutionError(
          'output_limit_exceeded',
          `${params.errorPrefix}: stderr exceeded the ${maxStderrBytes}-byte capture limit.`,
        ));
        return;
      }
      stderrChunks.push(bytes);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => capture('stderr', chunk));
    child.stdin?.on('error', () => {
      // An early remote exit may close the authenticated pipe before bounded
      // input is fully flushed. The child exit/error event remains the command
      // result authority; suppress only the Writable's otherwise-unhandled EPIPE.
    });
    if (params.input !== undefined) {
      child.stdin?.end(params.input);
    }
    child.once('error', (error) => {
      rejectOnce(new OpenSshExecutionError(
        'spawn_failed',
        `${params.errorPrefix}: ${redactSshText(error.message || params.redactedLabel || params.command)}`,
      ));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof code !== 'number') {
        rejectPromise(new OpenSshExecutionError(
          'command_failed',
          `${params.errorPrefix}: process terminated${signal ? ` (${signal})` : ' without an exit status'}.`,
        ));
        return;
      }
      const status = code;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (status !== 0 && params.rejectOnNonZero !== false) {
        const detail = stderr.trim() || (params.includeStdoutInError === false ? '' : stdout.trim());
        const redactedDetail = detail ? redactSshText(detail).trim() : '';
        rejectPromise(new OpenSshExecutionError(
          'command_failed',
          redactedDetail
            ? `${params.errorPrefix}: ${redactedDetail}`
            : `${params.errorPrefix}: ${params.redactedLabel ?? params.command}`,
          { status },
        ));
        return;
      }
      if (status !== 0) {
        resolvePromise({
          status,
          stdout: redactSshText(stdout),
          stderr: redactSshText(stderr),
        });
        return;
      }
      resolvePromise({ status, stdout, stderr });
    });

    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        rejectOnce(new OpenSshExecutionError(
          'timed_out',
          `${params.errorPrefix}: timed out after ${timeoutMs} ms.`,
        ));
      }, timeoutMs);
    }
  });
}

export async function runOpenSshRemoteCommand(params: Readonly<{
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
  signal?: AbortSignal;
  /** `null` explicitly disables the process timeout after irreversible-operation admission. */
  timeoutMs?: number | null;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  rejectOnNonZero?: boolean;
  errorPrefix?: string;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  input?: string;
  maxInputBytes?: number;
}>): Promise<OpenSshCommandResult> {
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

  return await runCommand({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    maxStdoutBytes: params.maxStdoutBytes,
    maxStderrBytes: params.maxStderrBytes,
    rejectOnNonZero: params.rejectOnNonZero,
    errorPrefix: params.errorPrefix ?? 'SSH command failed',
    redactedLabel: invocation.redactedLabel,
    onStdoutChunk: params.onStdoutChunk,
    includeStdoutInError: params.includeStdoutInError,
    input: params.input,
    maxInputBytes: params.maxInputBytes,
  });
}

export async function transferOpenSshFile(params: Readonly<{
  scpBin?: string;
  direction: 'upload' | 'download';
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
  recursive?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<void> {
  const invocation = buildOpenScpCommand({
    scpBin: params.scpBin ?? 'scp',
    target: params.target,
    localPath: params.localPath,
    remotePath: params.remotePath,
    direction: params.direction,
    recursive: params.recursive ?? false,
    sshConfigFile: params.sshConfigFile,
    knownHostsPath: params.knownHostsPath,
    knownHostsMode: params.knownHostsMode,
    auth: params.auth,
    port: params.port,
    connectTimeoutSec: params.connectTimeoutSec,
    serverAliveIntervalSec: params.serverAliveIntervalSec,
    serverAliveCountMax: params.serverAliveCountMax,
  });
  await runCommand({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    errorPrefix: 'SCP transfer failed',
    redactedLabel: invocation.redactedLabel,
  });
}

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
