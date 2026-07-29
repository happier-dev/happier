import { Buffer } from 'node:buffer';
import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  resolveWindowsCommandInvocation,
  type CommandInvocation,
} from '@happier-dev/cli-common/process';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';

import { createUtf8StreamDecoder } from './decode';
import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from './provider';

type NodeRelaySpawnProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: 'pipe';
    windowsHide: true;
    windowsVerbatimArguments?: boolean;
  }>,
) => ChildProcessWithoutNullStreams;

const relayWriteFramePrefix = '\u001eHAPPIER_PTY_WRITE ';
const relayKillFallbackMs = 2_000;

function normalizeArgs(args: string[] | string): string[] {
  return Array.isArray(args) ? [...args] : [String(args)];
}

function resolveArgsKind(args: string[] | string): 'array' | 'string' {
  return Array.isArray(args) ? 'array' : 'string';
}

function normalizeDimensionEnvValue(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 1
    ? String(Math.trunc(value))
    : undefined;
}

function encodeRelayWriteFrame(data: string): string {
  return `${relayWriteFramePrefix}${Buffer.from(data, 'utf8').toString('base64')}\n`;
}

function isRelayInputClosed(child: ChildProcessWithoutNullStreams, relayInputClosed: boolean): boolean {
  const stdin = child.stdin;
  return relayInputClosed ||
    stdin.destroyed === true ||
    stdin.writableEnded === true;
}

function assertRelayInputWritable(child: ChildProcessWithoutNullStreams, relayInputClosed: boolean): void {
  if (isRelayInputClosed(child, relayInputClosed)) {
    throw new Error('terminal_pty_input_closed');
  }
}

// UX-8: cap the pre-listener stdout/stderr buffer so a child that emits forever before any
// consumer attaches cannot grow memory without bound. Early output is banner/prompt bytes, so a
// modest budget is ample; once exceeded we stop appending (the live listener still receives new
// output once attached).
const earlyOutputBufferMaxBytes = 256 * 1024;

function childToPtyProcess(child: ChildProcessWithoutNullStreams): PtyProcess {
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let completedExit: PtyExitEvent | null = null;
  let relayInputClosed = false;
  let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // UX-8: stdout/stderr can emit before the first `onData`/`onDataBytes` listener is attached
  // (early banner/prompt bytes). Buffer raw chunks from spawn and replay them, in arrival order,
  // to the first listener so those bytes are never race-dropped. After the first drain the buffer
  // is inert and live chunks flow straight to the attached listener.
  const earlyChunks: Array<string | Buffer> = [];
  let earlyBufferActive = true;
  let earlyBufferBytes = 0;
  const bufferEarlyChunk = (chunk: string | Buffer) => {
    if (!earlyBufferActive) return;
    const normalized = typeof chunk === 'string' ? chunk : Buffer.from(chunk);
    const size = typeof normalized === 'string' ? Buffer.byteLength(normalized, 'utf8') : normalized.length;
    if (earlyBufferBytes + size > earlyOutputBufferMaxBytes) return;
    earlyBufferBytes += size;
    earlyChunks.push(normalized);
  };
  child.stdout.on('data', bufferEarlyChunk);
  child.stderr.on('data', bufferEarlyChunk);
  const drainEarlyBuffer = (handleChunk: (chunk: string | Buffer) => void) => {
    if (!earlyBufferActive) return;
    earlyBufferActive = false;
    child.stdout.off('data', bufferEarlyChunk);
    child.stderr.off('data', bufferEarlyChunk);
    const pending = earlyChunks.splice(0, earlyChunks.length);
    earlyBufferBytes = 0;
    for (const chunk of pending) handleChunk(chunk);
  };

  const emitExit = (event: PtyExitEvent) => {
    if (completedExit) return;
    completedExit = event;
    if (killFallbackTimer) {
      clearTimeout(killFallbackTimer);
      killFallbackTimer = null;
    }
    for (const listener of exitListeners) {
      listener(event);
    }
  };

  const killRelayProcess = (signal?: string) => {
    if (typeof signal === 'string' && signal.length > 0) {
      child.kill(signal as NodeJS.Signals);
      return;
    }
    child.kill();
  };

  const requestRelayTermination = (signal?: string) => {
    relayInputClosed = true;
    if (child.stdin.destroyed === true || child.stdin.writableEnded === true) {
      killRelayProcess(signal);
      return;
    }
    try {
      child.stdin.end();
    } catch {
      killRelayProcess(signal);
      return;
    }
    if (!killFallbackTimer) {
      killFallbackTimer = setTimeout(() => {
        if (!completedExit) {
          child.kill('SIGKILL');
        }
      }, relayKillFallbackMs);
      killFallbackTimer.unref?.();
    }
  };

  child.once('error', () => {
    emitExit({ exitCode: -1 });
  });
  child.stdin.on('error', () => {
    relayInputClosed = true;
  });
  child.once('exit', () => {
    relayInputClosed = true;
  });
  child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
    const numericSignal = typeof signal === 'string' ? null : signal;
    emitExit({
      exitCode: typeof exitCode === 'number' ? exitCode : -1,
      ...(typeof numericSignal === 'number' ? { signal: numericSignal } : {}),
    } satisfies PtyExitEvent);
  });

  return {
    pid: typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0 ? child.pid : 0,
    write: (data) => {
      assertRelayInputWritable(child, relayInputClosed);
      child.stdin.write(encodeRelayWriteFrame(data));
    },
    resize: () => {
      throw new Error('terminal_resize_unavailable');
    },
    kill: requestRelayTermination,
    onData: (listener) => {
      const stdoutDecoder = createUtf8StreamDecoder();
      const stderrDecoder = createUtf8StreamDecoder();
      const onStdout = (chunk: string | Buffer) => {
        const decoded = stdoutDecoder.decode(chunk);
        if (decoded) listener(decoded);
      };
      const onStderr = (chunk: string | Buffer) => {
        const decoded = stderrDecoder.decode(chunk);
        if (decoded) listener(decoded);
      };
      // UX-8: replay any pre-listener output through this first listener (decoded) before live data.
      drainEarlyBuffer(onStdout);
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      return {
        dispose: () => {
          child.stdout.off('data', onStdout);
          child.stderr.off('data', onStderr);
        },
      } satisfies Disposable;
    },
    onDataBytes: (listener) => {
      const onStdout = (chunk: string | Buffer) => listener(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      const onStderr = (chunk: string | Buffer) => listener(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      // UX-8: replay any pre-listener output (raw bytes) through this first listener before live data.
      drainEarlyBuffer(onStdout);
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      return {
        dispose: () => {
          child.stdout.off('data', onStdout);
          child.stderr.off('data', onStderr);
        },
      } satisfies Disposable;
    },
    onExit: (listener) => {
      if (completedExit) {
        listener(completedExit);
        return { dispose: () => {} } satisfies Disposable;
      }
      exitListeners.add(listener);
      return {
        dispose: () => {
          exitListeners.delete(listener);
        },
      } satisfies Disposable;
    },
  };
}

export function buildNodePtyRelaySpawnCommand(params: Readonly<{
  nodeExecutable: string;
  relayScriptPath: string;
  file: string;
  args: string[] | string;
}>): Readonly<{ command: string; args: readonly string[] }> {
  const argsKind = resolveArgsKind(params.args);
  return {
    command: params.nodeExecutable,
    args: [params.relayScriptPath, '--args-kind', argsKind, '--', params.file, ...normalizeArgs(params.args)],
  };
}

export function createNodePtyRelayProvider(params?: Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  currentExecPath?: string | null;
  relayScriptPath?: string | null;
  resolveNodeExecutable?: () => string | null;
  spawnProcess?: NodeRelaySpawnProcess;
  resolveCommandInvocation?: typeof resolveWindowsCommandInvocation;
}>): PtyProvider | null {
  const platform = params?.platform ?? process.platform;
  if (platform !== 'win32') return null;

  const env = params?.env ?? process.env;
  const nodeExecutable =
    'resolveNodeExecutable' in (params ?? {})
      ? (params?.resolveNodeExecutable?.() ?? null)
      : resolveJavaScriptRuntimeExecutable({
        isBunRuntime: true,
        processEnv: env,
        currentExecPath: params?.currentExecPath ?? process.execPath,
      });
  if (!nodeExecutable) return null;

  const relayScriptPath =
    typeof params?.relayScriptPath === 'string' && params.relayScriptPath.trim().length > 0
      ? params.relayScriptPath
      : resolveCliRuntimeAssetPath('scripts', 'node_pty_relay.cjs');
  const spawnProcess = params?.spawnProcess ?? ((command, args, options) =>
    spawnChildProcess(command, [...args], options));
  const resolveCommandInvocation = params?.resolveCommandInvocation ?? resolveWindowsCommandInvocation;

  return {
    spawn: (spawnParams: PtySpawnParams) => {
      const relayInvocation = buildNodePtyRelaySpawnCommand({
        nodeExecutable,
        relayScriptPath,
        file: spawnParams.file,
        args: spawnParams.args,
      });
      const invocation: CommandInvocation = resolveCommandInvocation({
        command: relayInvocation.command,
        args: relayInvocation.args,
        env: spawnParams.options.env,
      });
      const relayEnv: NodeJS.ProcessEnv = {
        ...(spawnParams.options.env ?? env),
        HAPPIER_NODE_PTY_RELAY_COLS: normalizeDimensionEnvValue(spawnParams.options.cols),
        HAPPIER_NODE_PTY_RELAY_ROWS: normalizeDimensionEnvValue(spawnParams.options.rows),
      };
      const child = spawnProcess(invocation.command, invocation.args, {
        cwd: spawnParams.options.cwd,
        env: relayEnv,
        stdio: 'pipe',
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      return childToPtyProcess(child);
    },
  };
}
