import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type readline from 'node:readline';
import { createInterface } from 'node:readline';

import spawn from 'cross-spawn';

import type { AgentMessage } from '@/agent/core';

import { logger } from '@/ui/logger';
import {
  readPiAuthJsonMtimeMs,
  resolvePiAuthJsonPath,
  resolvePiSessionFileForSessionId,
  stopPiRpcProcess,
} from './sessionRecovery';
import { asError, asNonEmptyString } from './rpcSupport';
import type { PiRpcStateData } from './types';

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
  getStdoutLineReader: () => readline.Interface | null;
  setStdoutLineReader: (reader: readline.Interface | null) => void;
  getStderrLineReader: () => readline.Interface | null;
  setStderrLineReader: (reader: readline.Interface | null) => void;
  getSessionId: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  getSessionFile: () => string | null;
  setSessionFile: (sessionFile: string | null) => void;
  isDisposed: () => boolean;
  hasPendingTurn: () => boolean;
  getLastAuthJsonMtimeMs: () => number | null;
  setLastAuthJsonMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartPendingMtimeMs: () => number | null;
  setAuthRestartPendingMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartInFlight: () => Promise<void> | null;
  setAuthRestartInFlight: (restart: Promise<void> | null) => void;
  emitMessage: (message: AgentMessage) => void;
  rejectAllPending: (error: Error) => void;
  rejectPendingTurn: (error: Error) => void;
  handleStdoutLine: (line: string) => void;
  handleStderrLine: (line: string) => void;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
}>;

function resolveAuthJsonPath(context: PiRpcProcessLifecycleContext): string | null {
  return resolvePiAuthJsonPath(context.options.env);
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
  const stdoutLineReader = createInterface({ input: child.stdout });
  stdoutLineReader.on('line', (line) => context.handleStdoutLine(line));
  context.setStdoutLineReader(stdoutLineReader);

  const stderrLineReader = createInterface({ input: child.stderr });
  stderrLineReader.on('line', (line) => context.handleStderrLine(line));
  context.setStderrLineReader(stderrLineReader);

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
  };

  child.stdin.on('error', handleIoError);
  child.stdout.on('error', handleIoError);
  child.stderr.on('error', handleIoError);

  child.on('error', (error) => {
    context.emitMessage({
      type: 'status',
      status: 'error',
      detail: `Pi process error: ${error instanceof Error ? error.message : String(error)}`,
    });
    context.rejectAllPending(new Error(`Pi process error: ${error instanceof Error ? error.message : String(error)}`));
    context.rejectPendingTurn(new Error('Pi process terminated'));
  });

  child.on('exit', (code, signal) => {
    if (!context.isDisposed()) {
      const detail = `Pi process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      context.emitMessage({
        type: 'status',
        status: code === 0 ? 'stopped' : 'error',
        detail,
      });
    }
    context.rejectAllPending(new Error('Pi process exited'));
    context.rejectPendingTurn(new Error('Pi process exited'));
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
  if (!sessionFile) {
    throw new Error(`Pi process is not running (unable to resolve session file for session id '${expectedSessionId}')`);
  }
  spawnPiRpcProcess(context, { args: [...context.options.args, '--session', sessionFile] });

  const state = await context.getState();
  const nextSessionId = asNonEmptyString(state.sessionId);
  if (!nextSessionId) {
    throw new Error('Pi did not return a session id after --session');
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
