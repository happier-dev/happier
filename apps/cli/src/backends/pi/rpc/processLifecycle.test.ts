import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPiRpcProcess, type PiRpcProcessLifecycleContext } from './processLifecycle';
import type { PiRpcStreamReader } from './streamReaders';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Pi RPC process lifecycle', () => {
  let workDir: string | null = null;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('does not surface a session_error when a clean process exit follows scheduled turn completion', async () => {
    workDir = makeTempDir('happier-pi-rpc-process-lifecycle-');
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    let stdoutLineReader: PiRpcStreamReader | null = null;
    let stderrLineReader: PiRpcStreamReader | null = null;
    let observeExit: () => void = () => {};
    const exitObserved = new Promise<void>((resolve) => {
      observeExit = resolve;
    });
    const resolvePendingTurn = vi.fn();
    const rejectPendingTurn = vi.fn();
    const surfacePrimarySessionRuntimeIssue = vi.fn();

    const context: PiRpcProcessLifecycleContext = {
      options: {
        cwd: workDir,
        command: process.execPath,
        args: [],
        env: {},
      },
      getProcess: () => childProcess,
      setProcess: (nextProcess) => {
        childProcess = nextProcess;
        if (!nextProcess) observeExit();
      },
      getStdoutLineReader: () => stdoutLineReader,
      setStdoutLineReader: (reader) => {
        stdoutLineReader = reader;
      },
      getStderrLineReader: () => stderrLineReader,
      setStderrLineReader: (reader) => {
        stderrLineReader = reader;
      },
      getSessionId: () => 'pi-session-process-lifecycle',
      setSessionId: vi.fn(),
      getSessionFile: () => null,
      setSessionFile: vi.fn(),
      isDisposed: () => false,
      hasPendingTurn: () => true,
      hasPendingTurnCompletionScheduled: () => true,
      hasPendingCompactionResumeScheduled: () => false,
      getLastAuthJsonMtimeMs: () => null,
      setLastAuthJsonMtimeMs: vi.fn(),
      getAuthRestartPendingMtimeMs: () => null,
      setAuthRestartPendingMtimeMs: vi.fn(),
      getAuthRestartInFlight: () => null,
      setAuthRestartInFlight: vi.fn(),
      emitMessage: vi.fn(),
      rejectAllPending: vi.fn(),
      rejectPendingTurn,
      resolvePendingTurn,
      resolvePendingTurnAsCompactionPaused: vi.fn(),
      surfacePrimarySessionRuntimeIssue,
      handleStdoutLine: vi.fn(),
      handleStderrLine: vi.fn(),
      getState: vi.fn(async () => ({})),
      publishRuntimeState: vi.fn(async () => {}),
    };

    spawnPiRpcProcess(context, { args: ['-e', 'setTimeout(() => process.exit(0), 10);'] });

    await exitObserved;

    expect(resolvePendingTurn).toHaveBeenCalledOnce();
    expect(rejectPendingTurn).not.toHaveBeenCalled();
    expect(surfacePrimarySessionRuntimeIssue).not.toHaveBeenCalled();
  });

  it('does not surface a session_error when Pi exits cleanly between turns', async () => {
    workDir = makeTempDir('happier-pi-rpc-process-clean-exit-');
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    let stdoutLineReader: PiRpcStreamReader | null = null;
    let stderrLineReader: PiRpcStreamReader | null = null;
    let observeExit: () => void = () => {};
    const exitObserved = new Promise<void>((resolve) => {
      observeExit = resolve;
    });
    const resolvePendingTurn = vi.fn();
    const rejectPendingTurn = vi.fn();
    const surfacePrimarySessionRuntimeIssue = vi.fn();

    const context: PiRpcProcessLifecycleContext = {
      options: {
        cwd: workDir,
        command: process.execPath,
        args: [],
        env: {},
      },
      getProcess: () => childProcess,
      setProcess: (nextProcess) => {
        childProcess = nextProcess;
        if (!nextProcess) observeExit();
      },
      getStdoutLineReader: () => stdoutLineReader,
      setStdoutLineReader: (reader) => {
        stdoutLineReader = reader;
      },
      getStderrLineReader: () => stderrLineReader,
      setStderrLineReader: (reader) => {
        stderrLineReader = reader;
      },
      getSessionId: () => 'pi-session-process-lifecycle',
      setSessionId: vi.fn(),
      getSessionFile: () => null,
      setSessionFile: vi.fn(),
      isDisposed: () => false,
      hasPendingTurn: () => false,
      hasPendingTurnCompletionScheduled: () => false,
      hasPendingCompactionResumeScheduled: () => false,
      getLastAuthJsonMtimeMs: () => null,
      setLastAuthJsonMtimeMs: vi.fn(),
      getAuthRestartPendingMtimeMs: () => null,
      setAuthRestartPendingMtimeMs: vi.fn(),
      getAuthRestartInFlight: () => null,
      setAuthRestartInFlight: vi.fn(),
      emitMessage: vi.fn(),
      rejectAllPending: vi.fn(),
      rejectPendingTurn,
      resolvePendingTurn,
      resolvePendingTurnAsCompactionPaused: vi.fn(),
      surfacePrimarySessionRuntimeIssue,
      handleStdoutLine: vi.fn(),
      handleStderrLine: vi.fn(),
      getState: vi.fn(async () => ({})),
      publishRuntimeState: vi.fn(async () => {}),
    };

    spawnPiRpcProcess(context, { args: ['-e', 'setTimeout(() => process.exit(0), 10);'] });

    await exitObserved;

    expect(resolvePendingTurn).not.toHaveBeenCalled();
    expect(rejectPendingTurn).toHaveBeenCalledOnce();
    expect(surfacePrimarySessionRuntimeIssue).not.toHaveBeenCalled();
  });

  it('does not deliver a trailing stdout fragment as a JSONL record', async () => {
    workDir = makeTempDir('happier-pi-rpc-process-partial-stdout-');
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    let stdoutLineReader: PiRpcStreamReader | null = null;
    let stderrLineReader: PiRpcStreamReader | null = null;
    let observeExit: () => void = () => {};
    const exitObserved = new Promise<void>((resolve) => {
      observeExit = resolve;
    });
    const handleStdoutLine = vi.fn();

    const context: PiRpcProcessLifecycleContext = {
      options: {
        cwd: workDir,
        command: process.execPath,
        args: [],
        env: {},
      },
      getProcess: () => childProcess,
      setProcess: (nextProcess) => {
        childProcess = nextProcess;
        if (!nextProcess) observeExit();
      },
      getStdoutLineReader: () => stdoutLineReader,
      setStdoutLineReader: (reader) => {
        stdoutLineReader = reader;
      },
      getStderrLineReader: () => stderrLineReader,
      setStderrLineReader: (reader) => {
        stderrLineReader = reader;
      },
      getSessionId: () => 'pi-session-partial-stdout',
      setSessionId: vi.fn(),
      getSessionFile: () => null,
      setSessionFile: vi.fn(),
      isDisposed: () => false,
      hasPendingTurn: () => false,
      hasPendingTurnCompletionScheduled: () => false,
      hasPendingCompactionResumeScheduled: () => false,
      getLastAuthJsonMtimeMs: () => null,
      setLastAuthJsonMtimeMs: vi.fn(),
      getAuthRestartPendingMtimeMs: () => null,
      setAuthRestartPendingMtimeMs: vi.fn(),
      getAuthRestartInFlight: () => null,
      setAuthRestartInFlight: vi.fn(),
      emitMessage: vi.fn(),
      rejectAllPending: vi.fn(),
      rejectPendingTurn: vi.fn(),
      resolvePendingTurn: vi.fn(),
      resolvePendingTurnAsCompactionPaused: vi.fn(),
      surfacePrimarySessionRuntimeIssue: vi.fn(),
      handleStdoutLine,
      handleStderrLine: vi.fn(),
      getState: vi.fn(async () => ({})),
      publishRuntimeState: vi.fn(async () => {}),
    };

    spawnPiRpcProcess(context, {
      args: ['-e', 'process.stdout.write("{\\"type\\":\\"event\\"}"); process.exit(0);'],
    });

    await exitObserved;

    expect(handleStdoutLine).not.toHaveBeenCalled();
  });

  it('O2: emits structured exit context for non-zero Pi process exit', async () => {
    workDir = makeTempDir('happier-pi-rpc-process-nonzero-exit-');
    let childProcess: ChildProcessWithoutNullStreams | null = null;
    let stdoutLineReader: PiRpcStreamReader | null = null;
    let stderrLineReader: PiRpcStreamReader | null = null;
    let observeExit: () => void = () => {};
    const exitObserved = new Promise<void>((resolve) => {
      observeExit = resolve;
    });
    const emitMessage = vi.fn();

    const context: PiRpcProcessLifecycleContext = {
      options: {
        cwd: workDir,
        command: process.execPath,
        args: [],
        env: {
          PI_CODING_AGENT_DIR: '/tmp/pi-agent-dir',
          HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: '/tmp/materialized',
        },
      },
      getProcess: () => childProcess,
      setProcess: (nextProcess) => {
        childProcess = nextProcess;
        if (!nextProcess) observeExit();
      },
      getStdoutLineReader: () => stdoutLineReader,
      setStdoutLineReader: (reader) => {
        stdoutLineReader = reader;
      },
      getStderrLineReader: () => stderrLineReader,
      setStderrLineReader: (reader) => {
        stderrLineReader = reader;
      },
      getSessionId: () => 'pi-session-o2-test',
      setSessionId: vi.fn(),
      getSessionFile: () => null,
      setSessionFile: vi.fn(),
      isDisposed: () => false,
      hasPendingTurn: () => false,
      hasPendingTurnCompletionScheduled: () => false,
      hasPendingCompactionResumeScheduled: () => false,
      getLastAuthJsonMtimeMs: () => null,
      setLastAuthJsonMtimeMs: vi.fn(),
      getAuthRestartPendingMtimeMs: () => null,
      setAuthRestartPendingMtimeMs: vi.fn(),
      getAuthRestartInFlight: () => null,
      setAuthRestartInFlight: vi.fn(),
      emitMessage,
      rejectAllPending: vi.fn(),
      rejectPendingTurn: vi.fn(),
      resolvePendingTurn: vi.fn(),
      resolvePendingTurnAsCompactionPaused: vi.fn(),
      surfacePrimarySessionRuntimeIssue: vi.fn(),
      handleStdoutLine: vi.fn(),
      handleStderrLine: vi.fn(),
      getState: vi.fn(async () => ({})),
      publishRuntimeState: vi.fn(async () => {}),
    };

    // Spawn a process that writes to stderr then exits non-zero.
    spawnPiRpcProcess(context, {
      args: ['-e', 'process.stderr.write("pi-error-line\\n"); process.exit(1);'],
    });

    await exitObserved;

    const statusCall = emitMessage.mock.calls.find(
      ([msg]) => msg.type === 'status' && msg.status === 'error',
    );
    expect(statusCall).toBeTruthy();
    const detail: string = statusCall![0].detail;
    // Structured fields — assert on structure, not exact copy
    expect(detail).toContain('code=1');
    expect(detail).toContain('vendorResumeId=pi-session-o2-test');
    expect(detail).toContain('agentDir=/tmp/pi-agent-dir');
    expect(detail).toContain('materializationRoot=/tmp/materialized');
    expect(detail).toContain('stderrTail=');
    // Must NOT be the bare old format
    expect(detail).not.toBe('Pi process exited (code=1, signal=null)');
  });
});
