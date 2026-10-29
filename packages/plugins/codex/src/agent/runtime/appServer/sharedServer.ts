import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createSecureTempDirectorySync } from '@happier-dev/plugin-sdk/fs';
import type { LoggerService } from '@happier-dev/plugin-sdk';

import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { parseCodexCliStableVersion } from '../../cli/detect.js';
import {
  buildCodexAppServerArgs,
  buildCodexAppServerEnv,
  createCodexNativeAppServerClient,
  probeCodexRealtimeConversationFeature,
  type DisposableCodexAppServerClient,
} from './client.js';
import { readCodexAppServerStartupRpcTimeoutMs } from './client/timeout.js';
import { withCodexNativeStartupLock } from './nativeStartupLock.js';

type CodexAppServerEnv = Readonly<Record<string, string | undefined>>;
type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;
const SHARED_CONTROL_MIN_MINOR_UNIX = 131;

type StartupFailureReason = 'process_exited' | 'process_observation_failed';
type CodexSharedAppServerProcessStartupFailure = Readonly<{
  phase: 'socket_wait';
  reason: StartupFailureReason;
  terminationKind?: PluginProcessResult['termination']['observed']['kind'];
  terminationRequestedBy?: PluginProcessResult['termination']['requestedBy']['kind'];
  nativeExitCode?: number;
  nativeSignal?: string;
  stderrPresent?: boolean;
  stderrTruncated?: boolean;
}>;
const NATIVE_TRANSPORT_ERROR_CODES = [
  'ENOENT', 'ENAMETOOLONG', 'EINVAL', 'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
] as const;
type NativeTransportErrorCode = typeof NATIVE_TRANSPORT_ERROR_CODES[number];
const NATIVE_TRANSPORT_SYSCALLS = [
  'access', 'connect', 'lstat', 'mkdir', 'open', 'read', 'realpath', 'rename', 'rmdir', 'spawn', 'stat', 'unlink', 'write',
  'unavailable', // The runtime supplied no native syscall.
] as const;
type NativeTransportSyscall = typeof NATIVE_TRANSPORT_SYSCALLS[number];
type CodexSharedAppServerTransportStartupFailure = Readonly<{
  phase: 'native_system_error';
  reason: 'system_error';
  errnoCode: NativeTransportErrorCode;
  syscall?: NativeTransportSyscall;
  transport?: 'unixWebSocket';
  socketPathLengthClass?: 'within_limit' | 'exceeds_limit';
}>;
export type CodexSharedAppServerStartupFailure =
  | CodexSharedAppServerProcessStartupFailure
  | CodexSharedAppServerTransportStartupFailure;

function readOwnValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function readUnixSocketStartupContext(
  value: object,
): Pick<CodexSharedAppServerTransportStartupFailure, 'transport' | 'socketPathLengthClass'> {
  if (readOwnValue(value, 'transport') !== 'unixWebSocket') return {};
  const lengthClass = readOwnValue(value, 'socketPathLengthClass');
  return {
    transport: 'unixWebSocket' as const,
    ...(lengthClass === 'within_limit' || lengthClass === 'exceeds_limit'
      ? { socketPathLengthClass: lengthClass } : {}),
  };
}

/** Extracts only closed Node system-error identity; paths, addresses and prose never cross the boundary. */
export function readCodexNativeTransportStartupFailure(error: unknown): CodexSharedAppServerTransportStartupFailure | null {
  const outer = error instanceof AggregateError ? error.errors[0] : error;
  if (!(outer instanceof Error)) return null;
  const protocolCause = readOwnValue(outer, 'cause');
  const cause = readOwnValue(outer, 'code') === 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR' && protocolCause instanceof Error
    ? protocolCause : outer;
  const code = readOwnValue(cause, 'code');
  if (typeof code !== 'string' || !NATIVE_TRANSPORT_ERROR_CODES.includes(code as NativeTransportErrorCode)) return null;
  const errnoCode = code as NativeTransportErrorCode;
  const rawSyscall = readOwnValue(cause, 'syscall');
  const normalizedSyscall = typeof rawSyscall === 'string' && rawSyscall.startsWith('spawn ')
    ? 'spawn'
    : rawSyscall;
  const syscall = typeof normalizedSyscall === 'string'
    && NATIVE_TRANSPORT_SYSCALLS.includes(normalizedSyscall as NativeTransportSyscall)
    ? normalizedSyscall as NativeTransportSyscall
    : undefined;
  return Object.freeze({
    phase: 'native_system_error', reason: 'system_error', errnoCode,
    ...(syscall ? { syscall } : {}),
    ...readUnixSocketStartupContext(outer),
  });
}

/** Re-admits only closed process facts after an error crosses a bundle/module boundary. */
export function readCodexSharedAppServerStartupFailure(value: unknown): CodexSharedAppServerStartupFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.phase === 'native_system_error' && record.reason === 'system_error') {
    const errnoCode = typeof record.errnoCode === 'string'
      && NATIVE_TRANSPORT_ERROR_CODES.includes(record.errnoCode as NativeTransportErrorCode)
      ? record.errnoCode as NativeTransportErrorCode
      : null;
    if (!errnoCode) return null;
    const syscall = typeof record.syscall === 'string'
      && NATIVE_TRANSPORT_SYSCALLS.includes(record.syscall as NativeTransportSyscall)
      ? record.syscall as NativeTransportSyscall
      : undefined;
    return Object.freeze({
      phase: 'native_system_error', reason: 'system_error', errnoCode,
      ...(syscall ? { syscall } : {}),
      ...readUnixSocketStartupContext(record),
    });
  }
  if (record.phase !== 'socket_wait'
    || (record.reason !== 'process_exited' && record.reason !== 'process_observation_failed')) return null;
  const terminationKind = record.terminationKind === 'exit'
    || record.terminationKind === 'signal' || record.terminationKind === 'failed'
    ? record.terminationKind : undefined;
  const terminationRequestedBy = record.terminationRequestedBy === 'none'
    || record.terminationRequestedBy === 'timeout' || record.terminationRequestedBy === 'abort'
    || record.terminationRequestedBy === 'dispose'
    ? record.terminationRequestedBy : undefined;
  const nativeExitCode = Number.isSafeInteger(record.nativeExitCode) ? record.nativeExitCode as number : undefined;
  const nativeSignal = typeof record.nativeSignal === 'string' && Object.hasOwn(constants.signals, record.nativeSignal)
    ? record.nativeSignal : undefined;
  return Object.freeze({
    phase: 'socket_wait', reason: record.reason,
    ...(terminationKind ? { terminationKind } : {}),
    ...(terminationRequestedBy ? { terminationRequestedBy } : {}),
    ...(nativeExitCode !== undefined ? { nativeExitCode } : {}),
    ...(nativeSignal ? { nativeSignal } : {}),
    ...(typeof record.stderrPresent === 'boolean' ? { stderrPresent: record.stderrPresent } : {}),
    ...(typeof record.stderrTruncated === 'boolean' ? { stderrTruncated: record.stderrTruncated } : {}),
  });
}

function isRetryableNativeTransportStartupFailure(
  failure: CodexSharedAppServerTransportStartupFailure,
): boolean {
  if (failure.syscall === 'connect') {
    return failure.errnoCode === 'ENOENT'
      || failure.errnoCode === 'ECONNREFUSED'
      || failure.errnoCode === 'ECONNRESET'
      || failure.errnoCode === 'ETIMEDOUT';
  }
  return (failure.syscall === 'read' || failure.syscall === 'write')
    && (failure.errnoCode === 'ECONNRESET' || failure.errnoCode === 'EPIPE');
}

async function createInitialClientWhenReady(params: Readonly<{
  createClient: () => Promise<DisposableCodexAppServerClient>;
  process: PluginProcessHandle;
  signal?: AbortSignal;
}>): Promise<DisposableCodexAppServerClient> {
  let result: PluginProcessResult | undefined;
  let observationFailed = false;
  void params.process.wait().then(value => { result = value; }, () => { observationFailed = true; });
  while (true) {
    params.signal?.throwIfAborted();
    if (result) throw new CodexSharedAppServerStartupError('process_exited', result);
    if (observationFailed) throw new CodexSharedAppServerStartupError('process_observation_failed');
    try {
      return await params.createClient();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      const failure = readCodexNativeTransportStartupFailure(error);
      if (!failure || !isRetryableNativeTransportStartupFailure(failure)) throw error;
      await delay(25, undefined, { signal: params.signal });
    }
  }
}

export class CodexSharedAppServerStartupError extends Error {
  readonly code = 'agent_startup_transport_failed';
  readonly startupFailure: CodexSharedAppServerStartupFailure;

  constructor(reason: StartupFailureReason, result?: PluginProcessResult) {
    super('Codex shared app-server did not become ready.');
    this.name = 'CodexSharedAppServerStartupError';
    const observed = result?.termination.observed;
    // Native output can contain credentials or configuration. Retain only
    // closed process facts, never stderr, diagnostic payloads or error prose.
    this.startupFailure = Object.freeze({
      phase: 'socket_wait', reason,
      ...(observed ? { terminationKind: observed.kind } : {}),
      ...(result ? { terminationRequestedBy: result.termination.requestedBy.kind,
        stderrPresent: result.stderr.byteLength > 0, stderrTruncated: result.stderrTruncated } : {}),
      ...(observed?.kind === 'exit' && Number.isSafeInteger(observed.exitCode) ? { nativeExitCode: observed.exitCode } : {}),
      ...(observed?.kind === 'signal' && Object.hasOwn(constants.signals, observed.signal) ? { nativeSignal: observed.signal } : {}),
    });
  }
}

type Dependencies = Readonly<{
  readCodexVersion: (exec: ExecService, env: CodexAppServerEnv, signal?: AbortSignal) => Promise<string>;
  createRuntimeDirectory: () => Promise<string>;
  waitForSocket: (socketPath: string, process: PluginProcessHandle, signal?: AbortSignal) => Promise<void>;
  removeRuntimeDirectory: (directory: string) => Promise<void>;
  createClient: typeof createCodexNativeAppServerClient;
  probeRealtime: typeof probeCodexRealtimeConversationFeature;
}>;

async function readCodexVersion(
  exec: ExecService,
  env: CodexAppServerEnv,
  signal?: AbortSignal,
): Promise<string> {
  const tool = await exec.systemTools.resolve({
    toolId: 'codex-cli',
    purpose: 'Check Codex shared local-control support',
    ...(signal ? { signal } : {}),
  });
  const result = await exec.run({
    executable: tool.executable,
    args: ['--version'],
    cwd: { root: 'workspace', relativePath: '' },
    env: buildCodexAppServerEnv(env),
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
    timeoutMs: readCodexAppServerStartupRpcTimeoutMs(env),
  }, signal ? { signal } : undefined);
  return result.termination.requestedBy.kind === 'none'
    && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && !result.stdoutTruncated && !result.stderrTruncated
    ? new TextDecoder().decode(result.stdout) : '';
}

function supportsSharedControl(versionOutput: string, platform: NodeJS.Platform): boolean {
  // Codex 0.154 added protected Windows AF_UNIX sockets, but Node's IPC path
  // transport connects Windows named pipes only. Fail closed until the host
  // provides an AF_UNIX-capable bridge for the plugin transport.
  if (platform === 'win32') return false;
  const version = parseCodexCliStableVersion(versionOutput);
  return Boolean(version && (version.major > 0 || version.minor >= SHARED_CONTROL_MIN_MINOR_UNIX));
}

async function waitForSocket(
  socketPath: string,
  process: PluginProcessHandle,
  signal?: AbortSignal,
): Promise<void> {
  let result: PluginProcessResult | undefined;
  let observationFailed = false;
  void process.wait().then(value => { result = value; }, () => { observationFailed = true; });
  // A cold native home backfills its history before publishing the socket.
  // That work is not an initialize RPC and can outlast its request budget;
  // killing it leaves Codex's native backfill lease running on the next start.
  // The opening Session owns cancellation; the process owns terminal failure.
  while (true) {
    signal?.throwIfAborted();
    if (result) throw new CodexSharedAppServerStartupError('process_exited', result);
    if (observationFailed) throw new CodexSharedAppServerStartupError('process_observation_failed');
    try {
      await stat(socketPath);
      return;
    } catch {
      await delay(25, undefined, { signal });
    }
  }
}

function defaultDependencies(): Dependencies {
  let temporary: ReturnType<typeof createSecureTempDirectorySync> | undefined;
  return {
    readCodexVersion,
    createRuntimeDirectory: async () => {
      // Shared control is Unix-only. A caller's TMPDIR can exceed AF_UNIX's
      // pathname capacity; retain the SDK's private ownership/cleanup under
      // the short native Unix temp parent instead of changing child-process env.
      temporary = createSecureTempDirectorySync({ prefix: 'codex', tmpDir: '/tmp' });
      return temporary.path;
    },
    waitForSocket,
    removeRuntimeDirectory: async () => temporary?.cleanup(),
    createClient: createCodexNativeAppServerClient,
    probeRealtime: probeCodexRealtimeConversationFeature,
  };
}

export async function createCodexSharedAppServer(params: Readonly<{
  exec: ExecService;
  logger?: Pick<LoggerService, 'debug'>;
  nativeLaunch?: AgentNativeLaunchQualifier;
  processEnv: CodexAppServerEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  dependencies?: Partial<Dependencies>;
}>): Promise<Readonly<{
  endpoint: string;
  createClient: (request: Readonly<{
    cwd: string;
    processEnv: CodexAppServerEnv;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
  }>) => Promise<DisposableCodexAppServerClient>;
  dispose: () => Promise<void>;
}> | null> {
  const dependencies = { ...defaultDependencies(), ...params.dependencies };
  const versionOutput = await dependencies.readCodexVersion(
    params.exec,
    params.processEnv,
    params.signal,
  ).catch(() => '');
  if (!supportsSharedControl(versionOutput, params.platform ?? process.platform)) return null;

  const runtimeDirectory = await dependencies.createRuntimeDirectory();
  // Leave the socket parent absent so Codex creates it with its cross-platform
  // private-directory policy (0700 on Unix, a user-only DACL on Windows).
  const socketPath = join(runtimeDirectory, 'private', 'app-server.sock');
  const endpoint = `unix://${socketPath}`;
  let serverProcess: PluginProcessHandle | null = null;
  let realtimeConversationAdvertised = false;
  let startPromise: Promise<void> | null = null;
  let initialClient: DisposableCodexAppServerClient | null = null;
  let disposed = false;

  const ensureStarted = async (request: Readonly<{
    cwd: string;
    processEnv: CodexAppServerEnv;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
  }>): Promise<void> => {
    startPromise ??= withCodexNativeStartupLock(async configOverrides => {
      try {
        const tool = await params.exec.systemTools.resolve({
          toolId: 'codex-cli',
          purpose: 'Launch the Codex shared app-server',
          ...(params.signal ? { signal: params.signal } : {}),
        });
        realtimeConversationAdvertised = await dependencies.probeRealtime({
          exec: params.exec,
          executable: tool.executable,
          env: request.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        serverProcess = await params.exec.spawn({
          executable: tool.executable,
          args: buildCodexAppServerArgs({
            env: request.processEnv,
            configOverrides,
            disableUserMcpServers: request.disableUserMcpServers,
            enableRealtimeConversation: realtimeConversationAdvertised,
            listenUrl: endpoint,
          }),
          cwd: { root: 'workspace', relativePath: '' },
          env: buildCodexAppServerEnv(request.processEnv),
          maxStdoutBytes: 4_096,
          maxStderrBytes: 16_384,
        }, params.signal || params.nativeLaunch ? {
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.nativeLaunch ? { nativeLaunch: params.nativeLaunch } : {}),
        } : undefined);
        await dependencies.waitForSocket(
          socketPath,
          serverProcess,
          params.signal,
        );
        // A published socket is not native SQLite/skill initialization readiness.
        // Reuse this initialized connection for the first admitted runtime client.
        initialClient = await createInitialClientWhenReady({
          process: serverProcess,
          signal: params.signal,
          createClient: async () => await dependencies.createClient({
            exec: params.exec,
            cwd: request.cwd,
            processEnv: request.processEnv,
            toolRestrictionRequired: request.toolRestrictionRequired,
            toolRestrictionAllowedMcpServerKeys: request.toolRestrictionAllowedMcpServerKeys,
            signal: params.signal,
            transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised },
          }),
        });
      } catch (error) {
        // Initialization failure must finish native shutdown before another
        // process is admitted to shared SQLite/skills startup resources.
        const failures: unknown[] = [error];
        await initialClient?.dispose().catch((cleanupError: unknown) => { failures.push(cleanupError); });
        initialClient = null;
        await serverProcess?.dispose().catch((cleanupError: unknown) => { failures.push(cleanupError); });
        serverProcess = null;
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Codex shared app-server startup and cleanup failed.');
        }
        throw error;
      }
    }, params.signal, params.logger, { processEnv: request.processEnv, configOverrides: request.configOverrides, cwd: request.cwd, versionOutput });
    try {
      await startPromise;
    } catch (error) {
      await dependencies.removeRuntimeDirectory(runtimeDirectory);
      throw error;
    }
  };

  return {
    endpoint,
    createClient: async (request) => {
      await ensureStarted(request);
      if (initialClient) {
        const client = initialClient;
        initialClient = null;
        return client;
      }
      return await dependencies.createClient({
        exec: params.exec,
        cwd: request.cwd,
        processEnv: request.processEnv,
        toolRestrictionRequired: request.toolRestrictionRequired,
        toolRestrictionAllowedMcpServerKeys: request.toolRestrictionAllowedMcpServerKeys,
        signal: params.signal,
        transport: {
          kind: 'unixWebSocket',
          socketPath,
          realtimeConversationAdvertised,
        },
      });
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await initialClient?.dispose().catch(() => undefined);
      initialClient = null;
      await serverProcess?.dispose().catch(() => undefined);
      await dependencies.removeRuntimeDirectory(runtimeDirectory);
    },
  };
}
