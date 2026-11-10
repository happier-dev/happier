import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { redactBugReportSensitiveText, type LoggerService } from '@happier-dev/plugin-sdk';
import { SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionNativeHomeService } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';

import { parseCodexCliStableVersion } from '../../cli/detect.js';
import { assertCodexToolRestrictionRuntimeSupported } from './client/toolRestriction.js';
import {
  buildCodexAppServerArgs,
  buildCodexAppServerEnv,
  createCodexNativeAppServerClient,
  probeCodexRealtimeConversationFeature,
  verifyCodexNativeAppServerClient,
  type DisposableCodexAppServerClient,
} from './client.js';
import { readCodexAppServerStartupRpcTimeoutMs } from './client/timeout.js';
import { withCodexNativeStartupLock } from './nativeStartupLock.js';
import { readCodexAppServerProbeFailureCode } from './startupFailure.js';

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
  createClient: (signal: AbortSignal) => Promise<DisposableCodexAppServerClient>;
  process: PluginProcessHandle;
  signal?: AbortSignal;
}>): Promise<DisposableCodexAppServerClient> {
  const controller = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
  let active = true;
  let processFailure: CodexSharedAppServerStartupError | undefined;
  const fail = (reason: StartupFailureReason, result?: Pick<PluginProcessResult, 'termination'>, cause?: unknown) => {
    if (!active) return;
    processFailure = new CodexSharedAppServerStartupError(reason, result, cause);
    controller.abort(processFailure);
  };
  void params.process.waitForExit().then(
    termination => fail('process_exited', { termination }),
    error => fail('process_observation_failed', undefined, error),
  );
  try {
    while (true) {
      if (processFailure) throw processFailure;
      signal.throwIfAborted();
      try {
        return await params.createClient(signal);
      } catch (error) {
        if (processFailure) throw processFailure;
        if (signal.aborted) throw error;
        const failure = readCodexNativeTransportStartupFailure(error);
        if (!failure || !isRetryableNativeTransportStartupFailure(failure)) throw error;
        await delay(25, undefined, { signal }).catch(error => { throw processFailure ?? error; });
      }
    }
  } finally {
    active = false;
  }
}

export class CodexSharedAppServerStartupError extends Error {
  readonly code = 'agent_startup_transport_failed';
  readonly startupFailure: CodexSharedAppServerStartupFailure;
  readonly stderrPreview?: string;

  constructor(reason: StartupFailureReason, result?: Pick<PluginProcessResult, 'termination'> & Partial<PluginProcessResult>, cause?: unknown) {
    super('Codex shared app-server did not become ready.', { cause });
    this.name = 'CodexSharedAppServerStartupError';
    const observed = result?.termination.observed;
    // Exec sanitizes native output at its boundary; redact again before this
    // retained error can cross the public Session diagnostic boundary.
    this.stderrPreview = result?.stderr ? redactBugReportSensitiveText(new TextDecoder().decode(result.stderr))
      .trim().slice(0, SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH) || undefined : undefined;
    this.startupFailure = Object.freeze({
      phase: 'socket_wait', reason,
      ...(observed ? { terminationKind: observed.kind } : {}),
      ...(result ? { terminationRequestedBy: result.termination.requestedBy.kind } : {}),
      ...(result?.stderr ? { stderrPresent: result.stderr.byteLength > 0, stderrTruncated: result.stderrTruncated } : {}),
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
  // Shared control currently admits Unix hosts only. Consolidating the host
  // transport does not expand that supported platform set.
  if (platform === 'win32') return false;
  const version = parseCodexCliStableVersion(versionOutput);
  return Boolean(version && (version.major > 0 || version.minor >= SHARED_CONTROL_MIN_MINOR_UNIX));
}

async function waitForSocket(
  socketPath: string,
  process: PluginProcessHandle,
  signal?: AbortSignal,
): Promise<void> {
  let result: Pick<PluginProcessResult, 'termination'> & Partial<PluginProcessResult> | undefined;
  let observationFailure: CodexSharedAppServerStartupError | undefined;
  // Retain captured stderr when output has settled, without delaying the root
  // exit on a descendant that still holds an output pipe open.
  void process.wait().then(completed => { result = completed; }, () => undefined);
  void process.waitForExit().then(termination => { result ??= { termination }; }, error => {
    observationFailure = new CodexSharedAppServerStartupError('process_observation_failed', undefined, error);
  });
  // A cold native home backfills its history before publishing the socket.
  // That work is not an initialize RPC and can outlast its request budget;
  // killing it leaves Codex's native backfill lease running on the next start.
  // The opening Session owns cancellation; the process owns terminal failure.
  while (true) {
    signal?.throwIfAborted();
    if (result) throw new CodexSharedAppServerStartupError('process_exited', result);
    if (observationFailure) throw observationFailure;
    try {
      const publication = await lstat(socketPath);
      if (publication.isSymbolicLink() || publication.isSocket()) return;
    } catch { /* Native publication has not appeared yet. */ }
    await delay(25, undefined, { signal });
  }
}

function defaultDependencies(prepareDirectory: () => ReturnType<ExecService['prepareNativeSocketDirectory']>): Dependencies {
  let temporary: Awaited<ReturnType<ExecService['prepareNativeSocketDirectory']>> | undefined;
  return {
    readCodexVersion,
    createRuntimeDirectory: async () => {
      temporary = await prepareDirectory();
      return temporary.path;
    },
    waitForSocket,
    removeRuntimeDirectory: async () => temporary?.dispose(),
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
  onStartupWaiting?: (waiting: boolean) => void;
}>): Promise<Readonly<{
  endpoint: string;
  createClient: (request: Readonly<{
    cwd: string;
    processEnv: CodexAppServerEnv;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
    nativeHome?: AgentSessionNativeHomeService;
  }>) => Promise<DisposableCodexAppServerClient>;
  dispose: () => Promise<void>;
}> | null> {
  let nativeDirectory: Awaited<ReturnType<ExecService['prepareNativeSocketDirectory']>> | undefined;
  const defaults = defaultDependencies(async () => {
    nativeDirectory = await params.exec.prepareNativeSocketDirectory(params.nativeLaunch ? { nativeLaunch: params.nativeLaunch } : undefined);
    return nativeDirectory;
  });
  const dependencies = { ...defaults, ...params.dependencies };
  const versionStartedAt = Date.now();
  const versionOutput = await dependencies.readCodexVersion(
    params.exec,
    params.processEnv,
    params.signal,
  ).catch(error => {
    if (params.signal?.aborted || readCodexAppServerProbeFailureCode(error)) throw error;
    return '';
  });
  params.logger?.debug('Codex startup phase', { phase: 'version_probe', elapsedMs: Date.now() - versionStartedAt });
  if (!supportsSharedControl(versionOutput, params.platform ?? process.platform)) return null;

  const runtimeDirectory = await dependencies.createRuntimeDirectory();
  const transport = { kind: 'unixWebSocket' as const, socketPath: join(runtimeDirectory, 'private', 'app-server.sock'),
    ...(nativeDirectory?.nativeProxy ? { nativeProxy: true as const } : {}) };
  // Leave the socket parent absent so Codex creates it with its cross-platform
  // private-directory policy (0700 on Unix, a user-only DACL on Windows).
  const socketPath = join(runtimeDirectory, 'private', 'app-server.sock');
  const endpoint = `unix://${socketPath}`;
  let serverProcess: PluginProcessHandle | null = null;
  let realtimeConversationAdvertised = false;
  let startPromise: Promise<ManagedExecutableRef> | null = null;
  let initialClient: DisposableCodexAppServerClient | null = null;
  let disposed = false;

  const ensureStarted = async (request: Readonly<{
    cwd: string;
    processEnv: CodexAppServerEnv;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
    nativeHome?: AgentSessionNativeHomeService;
  }>): Promise<ManagedExecutableRef> => {
    if (request.toolRestrictionRequired) {
      assertCodexToolRestrictionRuntimeSupported(parseCodexCliStableVersion(versionOutput)?.value);
    }
    startPromise ??= (async () => {
      const toolStartedAt = Date.now();
      const tool = await params.exec.systemTools.resolve({
        toolId: 'codex-cli',
        purpose: 'Launch the Codex shared app-server',
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.logger?.debug('Codex startup phase', { phase: 'tool_resolve', elapsedMs: Date.now() - toolStartedAt });
      // Only native initialization needs exclusion; feature discovery can
      // settle independently without holding every other cold start behind it.
      const probeStartedAt = Date.now();
      realtimeConversationAdvertised = await dependencies.probeRealtime({
        exec: params.exec,
        executable: tool.executable,
        env: request.processEnv,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.logger?.debug('Codex startup phase', { phase: 'feature_probe', elapsedMs: Date.now() - probeStartedAt });
      const lockStartedAt = Date.now();
      await withCodexNativeStartupLock(async (configOverrides, admit) => {
        params.logger?.debug('Codex startup phase', { phase: 'native_startup_admission', elapsedMs: Date.now() - lockStartedAt });
        try {
          const spawnStartedAt = Date.now();
          serverProcess = await params.exec.withSpawnAdmission(admit, async exec => await exec.spawn({
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
            ...(nativeDirectory?.nativeLaunch || params.nativeLaunch ? { nativeLaunch: nativeDirectory?.nativeLaunch ?? params.nativeLaunch } : {}),
          } : undefined));
          params.logger?.debug('Codex startup phase', { phase: 'app_server_spawn', elapsedMs: Date.now() - spawnStartedAt });
          const socketStartedAt = Date.now();
          await dependencies.waitForSocket(
            socketPath,
            serverProcess,
            params.signal,
          );
          params.logger?.debug('Codex startup phase', { phase: 'socket_ready', elapsedMs: Date.now() - socketStartedAt });
          // A published socket is not native SQLite/skill initialization readiness.
          // Reuse this initialized connection for the first admitted runtime client.
          const clientStartedAt = Date.now();
          initialClient = await createInitialClientWhenReady({
            process: serverProcess,
            signal: params.signal,
            createClient: async signal => await dependencies.createClient({
              exec: params.exec,
              logger: params.logger,
              cwd: request.cwd,
              processEnv: request.processEnv,
              configOverrides: request.configOverrides,
              toolRestrictionAllowedMcpServerKeys: request.toolRestrictionAllowedMcpServerKeys,
              signal,
              ...(params.nativeLaunch ? { nativeLaunch: params.nativeLaunch } : {}),
              transport: { ...transport, realtimeConversationAdvertised },
            }),
          });
          params.logger?.debug('Codex startup phase', { phase: 'initial_client_ready', elapsedMs: Date.now() - clientStartedAt });
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
      }, params.signal, params.logger, {
        // The separated UID's shim publishes its selected CODEX_HOME. Native
        // SQLite must default to that home: a host-side sqlite_home argument
        // would override the shim with the custodian's private credential path.
        // Unresolved native roots retain the existing OS-user startup lock.
        processEnv: nativeDirectory?.nativeProxy
          ? { ...request.processEnv, CODEX_SQLITE_HOME: undefined }
          : request.processEnv,
        configOverrides: request.configOverrides, cwd: request.cwd, versionOutput, deferUntilSpawn: true,
      }, params.onStartupWaiting);
      return tool.executable;
    })();
    try {
      return await startPromise;
    } catch (error) {
      await dependencies.removeRuntimeDirectory(runtimeDirectory).catch(() => undefined);
      throw error;
    }
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await initialClient?.dispose().catch(() => undefined);
    initialClient = null;
    await serverProcess?.dispose().catch(() => undefined);
    await dependencies.removeRuntimeDirectory(runtimeDirectory);
  };

  return {
    endpoint,
    createClient: async (request) => {
      const executable = await ensureStarted(request);
      if (initialClient) {
        const client = initialClient;
        initialClient = null;
        // Native readiness ends admission; Account/config/model verification
        // must still succeed before the caller receives its restricted client.
        try {
          return await verifyCodexNativeAppServerClient({ ...request, exec: params.exec, signal: params.signal,
            transport: { ...transport, realtimeConversationAdvertised } }, client, executable);
        } catch (error) {
          await dispose().catch(() => undefined);
          throw error;
        }
      }
      return await dependencies.createClient({
        exec: params.exec,
        logger: params.logger,
        cwd: request.cwd,
        processEnv: request.processEnv,
        toolRestrictionRequired: request.toolRestrictionRequired,
        toolRestrictionAllowedMcpServerKeys: request.toolRestrictionAllowedMcpServerKeys,
        nativeHome: request.nativeHome,
        configOverrides: request.configOverrides,
        signal: params.signal,
        ...(params.nativeLaunch ? { nativeLaunch: params.nativeLaunch } : {}),
        transport: {
          ...transport,
          realtimeConversationAdvertised,
        },
      });
    },
    dispose,
  };
}
