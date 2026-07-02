import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import spawn from 'cross-spawn';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';
import { isBarePiSessionId } from '@happier-dev/plugins-pi/agent/sessionFiles';

import type { AgentMessage } from '@/agent/core';
import { attachJsonlLineReader } from '@/agent/runtime/jsonl/attachJsonlLineReader';
import type { SurfacePrimarySessionRuntimeIssueInput } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { logger } from '@/ui/logger';
import {
  createPiSessionNotMaterializedError,
  readPiAuthJsonMtimeMs,
  resolvePiAuthJsonPath,
  resolvePiSessionFileForSessionId,
  stopPiRpcProcess,
} from './sessionRecovery';
import type { PiRpcStreamReader } from './streamReaders';
import { asError, asNonEmptyString } from './rpcSupport';
import type { PiRpcStateData } from './types';

/** How many trailing stderr lines to retain for the non-zero process-exit context (O2). */
const PI_RPC_STDERR_TAIL_MAX_LINES = 10;

/**
 * O2: build a structured, debuggable detail for a non-zero Pi process exit. Instead of a bare
 * "Pi process exited", surface the load-bearing context an operator needs to diagnose a failed
 * resume — exit code/signal, the vendor resume id, the cwd, the materialized agent dir +
 * connected-service materialization root, and a redacted tail of stderr.
 */
function buildPiProcessExitContextDetail(params: Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  cwd: string;
  env: Record<string, string>;
  sessionId: string | null;
  recentStderrLines: readonly string[];
}>): string {
  const fields: string[] = [
    `code=${params.code ?? 'null'}`,
    `signal=${params.signal ?? 'null'}`,
    `cwd=${params.cwd}`,
    `vendorResumeId=${params.sessionId ?? 'null'}`,
  ];
  const agentDir = asNonEmptyString(params.env.PI_CODING_AGENT_DIR);
  if (agentDir) fields.push(`agentDir=${agentDir}`);
  const materializationRoot = asNonEmptyString(
    params.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY],
  );
  if (materializationRoot) fields.push(`materializationRoot=${materializationRoot}`);
  const stderrTail = params.recentStderrLines.slice(-PI_RPC_STDERR_TAIL_MAX_LINES).join(' | ');
  if (stderrTail) fields.push(`stderrTail=${redactBugReportSensitiveText(stderrTail)}`);
  return `Pi process exited (${fields.join(', ')})`;
}

type PiRpcLaunchOptions = Readonly<{
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}>;

export type PiRpcProcessLifecycleContext = Readonly<{
  options: PiRpcLaunchOptions;
  getProcess: () => ChildProcessWithoutNullStreams | null;
  setProcess: (process: ChildProcessWithoutNullStreams | null) => void;
  getStdoutLineReader: () => PiRpcStreamReader | null;
  setStdoutLineReader: (reader: PiRpcStreamReader | null) => void;
  getStderrLineReader: () => PiRpcStreamReader | null;
  setStderrLineReader: (reader: PiRpcStreamReader | null) => void;
  getSessionId: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  getSessionFile: () => string | null;
  setSessionFile: (sessionFile: string | null) => void;
  isDisposed: () => boolean;
  hasPendingTurn: () => boolean;
  hasPendingTurnCompletionScheduled: () => boolean;
  hasPendingCompactionResumeScheduled: () => boolean;
  getLastAuthJsonMtimeMs: () => number | null;
  setLastAuthJsonMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartPendingMtimeMs: () => number | null;
  setAuthRestartPendingMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartInFlight: () => Promise<void> | null;
  setAuthRestartInFlight: (restart: Promise<void> | null) => void;
  emitMessage: (message: AgentMessage) => void;
  rejectAllPending: (error: Error) => void;
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
  resolvePendingTurnAsCompactionPaused: () => void;
  surfacePrimarySessionRuntimeIssue?: (input: SurfacePrimarySessionRuntimeIssueInput) => void | Promise<void>;
  handleStdoutLine: (line: string) => void;
  handleStderrLine: (line: string) => void;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
}>;

function resolveAuthJsonPath(context: PiRpcProcessLifecycleContext): string | null {
  return resolvePiAuthJsonPath(context.options.env);
}

function attachPiRpcStreamReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError: (error: unknown) => void,
): PiRpcStreamReader {
  const detach = attachJsonlLineReader(stream, onLine, {
    onError,
  });
  return {
    close: detach,
  };
}

export async function capturePiRpcAuthJsonSnapshot(
  context: PiRpcProcessLifecycleContext,
): Promise<void> {
  const authPath = resolveAuthJsonPath(context);
  if (!authPath) return;
  context.setLastAuthJsonMtimeMs(await readPiAuthJsonMtimeMs(authPath));
}

export async function stopPiRpcProcessForRestart(
  context: PiRpcProcessLifecycleContext,
): Promise<void> {
  context.rejectAllPending(new Error('Pi restarting'));
  context.rejectPendingTurn(new Error('Pi restarting'));
  const stdoutLineReader = context.getStdoutLineReader();
  const stderrLineReader = context.getStderrLineReader();
  const child = context.getProcess();
  context.setStdoutLineReader(null);
  context.setStderrLineReader(null);
  context.setProcess(null);
  await stopPiRpcProcess({
    process: child,
    stdoutLineReader,
    stderrLineReader,
  });
}

export function spawnPiRpcProcess(
  context: PiRpcProcessLifecycleContext,
  params: Readonly<{ args: string[] }>,
): void {
  const child = spawn(context.options.command, params.args, {
    cwd: context.options.cwd,
    env: {
      ...process.env,
      ...context.options.env,
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('Failed to start Pi RPC process with piped stdio');
  }

  context.setProcess(child as ChildProcessWithoutNullStreams);

  const handleIoError = (error: unknown) => {
    const resolved = asError(error);
    if (!context.isDisposed()) {
      context.emitMessage({
        type: 'status',
        status: 'error',
        detail: `Pi IO error: ${resolved.message}`,
      });
    }
    context.rejectAllPending(new Error(`Pi IO error: ${resolved.message}`));
    context.rejectPendingTurn(new Error('Pi process terminated'));
    void context.surfacePrimarySessionRuntimeIssue?.({
      provider: 'pi',
      cause: 'stream_error',
      error: resolved,
    });
  };

  // O2: local stderr tail buffer; capped at PI_RPC_STDERR_TAIL_MAX_LINES so we can surface
  // structured exit context without the context type requiring a shared buffer accessor.
  const recentStderrLines: string[] = [];

  const stdoutLineReader = attachPiRpcStreamReader(
    child.stdout,
    (line) => context.handleStdoutLine(line),
    handleIoError,
  );
  context.setStdoutLineReader(stdoutLineReader);

  const stderrLineReader = attachPiRpcStreamReader(
    child.stderr,
    (line) => {
      recentStderrLines.push(line);
      if (recentStderrLines.length > PI_RPC_STDERR_TAIL_MAX_LINES * 2) {
        recentStderrLines.splice(0, recentStderrLines.length - PI_RPC_STDERR_TAIL_MAX_LINES);
      }
      context.handleStderrLine(line);
    },
    handleIoError,
  );
  context.setStderrLineReader(stderrLineReader);

  child.stdin.on('error', handleIoError);

  child.on('error', (error) => {
    context.emitMessage({
      type: 'status',
      status: 'error',
      detail: `Pi process error: ${error instanceof Error ? error.message : String(error)}`,
    });
    context.rejectAllPending(new Error(`Pi process error: ${error instanceof Error ? error.message : String(error)}`));
    context.rejectPendingTurn(new Error('Pi process terminated'));
    void context.surfacePrimarySessionRuntimeIssue?.({
      provider: 'pi',
      cause: 'process_exit',
      error,
    });
  });

  child.on('exit', (code, signal) => {
    // O2: surface structured exit context for non-zero exits so operators can diagnose resume
    // misses without grepping raw daemon logs — exit code/signal, vendor resume id, cwd,
    // agent dir, materialization root, and a redacted stderr tail (same fields as remote-dev).
    const detail = code === 0
      ? `Pi process exited (code=0, signal=${signal ?? 'null'})`
      : buildPiProcessExitContextDetail({
          code,
          signal,
          cwd: context.options.cwd,
          env: context.options.env,
          sessionId: context.getSessionId(),
          recentStderrLines,
        });
    if (!context.isDisposed()) {
      context.emitMessage({
        type: 'status',
        status: code === 0 ? 'stopped' : 'error',
        detail,
      });
    }
    context.rejectAllPending(new Error('Pi process exited'));
    const completedScheduledTurn = code === 0 && context.hasPendingTurnCompletionScheduled();
    const completedCompactionPause = code === 0 && context.hasPendingCompactionResumeScheduled();
    if (completedScheduledTurn) {
      context.resolvePendingTurn();
    } else if (completedCompactionPause) {
      context.resolvePendingTurnAsCompactionPaused();
    } else {
      context.rejectPendingTurn(new Error('Pi process exited'));
    }
    if (!completedScheduledTurn && !completedCompactionPause && code !== 0) {
      void context.surfacePrimarySessionRuntimeIssue?.({
        provider: 'pi',
        cause: 'process_exit',
        error: detail,
      });
    }
    context.setProcess(null);
  });
}

export async function restartPiRpcProcessAndContinue(
  context: PiRpcProcessLifecycleContext,
): Promise<void> {
  const expectedSessionId = context.getSessionId();
  if (!expectedSessionId) return;
  if (context.hasPendingTurn()) {
    throw new Error('Cannot restart Pi while a turn is in-flight');
  }

  await stopPiRpcProcessForRestart(context);
  const sessionFile = context.getSessionFile() ?? (await resolvePiSessionFileForSessionId({
    expectedSessionId,
    env: context.options.env,
    sessionFile: context.getSessionFile(),
  }));
  if (!sessionFile && !isBarePiSessionId(expectedSessionId)) {
    throw new Error('Pi restart requires a bare Pi session id when no session file is available');
  }
  const sessionArg = sessionFile ?? expectedSessionId;
  spawnPiRpcProcess(context, { args: [...context.options.args, '--session', sessionArg] });

  const state = await context.getState();
  const nextSessionId = asNonEmptyString(state.sessionId);
  if (!nextSessionId) {
    throw createPiSessionNotMaterializedError(expectedSessionId);
  }
  if (nextSessionId !== expectedSessionId) {
    throw new Error(`Pi session mismatch after --session (expected ${expectedSessionId}, got ${nextSessionId})`);
  }
  context.setSessionFile(asNonEmptyString(state.sessionFile) ?? sessionFile);
  await context.publishRuntimeState(state);
  context.emitMessage({ type: 'status', status: 'idle' });
}

export async function ensurePiRpcProcess(
  context: PiRpcProcessLifecycleContext,
): Promise<void> {
  if (context.isDisposed()) {
    throw new Error('Pi backend is disposed');
  }
  if (context.getProcess()) return;
  if (context.getSessionId()) {
    await restartPiRpcProcessAndContinue(context);
    return;
  }

  spawnPiRpcProcess(context, { args: context.options.args });
}

export function maybeRestartPiRpcProcessForUpdatedAuthJson(
  context: PiRpcProcessLifecycleContext,
): Promise<void> | void {
  if (context.isDisposed()) return;
  if (!context.getSessionId()) return;
  if (!context.getProcess()) return;

  const authPath = resolveAuthJsonPath(context);
  if (!authPath) return;

  return (async () => {
    if (context.getAuthRestartInFlight()) {
      if (context.hasPendingTurn()) return;
      try {
        await context.getAuthRestartInFlight();
      } catch {
        // best-effort
      }
      return;
    }

    if (context.hasPendingTurn() && context.getAuthRestartPendingMtimeMs() !== null) {
      return;
    }

    const nextMtimeMs = await readPiAuthJsonMtimeMs(authPath);
    if (nextMtimeMs === null) {
      return;
    }

    if (context.getLastAuthJsonMtimeMs() === null) {
      context.setLastAuthJsonMtimeMs(nextMtimeMs);
      return;
    }
    if (nextMtimeMs === context.getLastAuthJsonMtimeMs()) return;

    if (context.hasPendingTurn()) {
      context.setAuthRestartPendingMtimeMs(nextMtimeMs);
      return;
    }

    const restartInFlight = (async () => {
      try {
        await restartPiRpcProcessAndContinue(context);
        context.setLastAuthJsonMtimeMs(nextMtimeMs);
        context.setAuthRestartPendingMtimeMs(null);
        await capturePiRpcAuthJsonSnapshot(context);
      } catch (error) {
        context.setAuthRestartPendingMtimeMs(nextMtimeMs);
        logger.debug('[pi] Failed to restart after auth.json update (non-fatal)', error);
      } finally {
        context.setAuthRestartInFlight(null);
      }
    })();

    context.setAuthRestartInFlight(restartInFlight);
    await restartInFlight;
  })();
}
