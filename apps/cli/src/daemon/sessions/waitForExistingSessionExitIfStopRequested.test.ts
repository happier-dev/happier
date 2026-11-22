import { describe, expect, it, vi } from 'vitest';
import { Console } from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';
import type { ProcessRunState } from '../processRunState';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { createOnChildExited } from './onChildExited';

describe('waitForExistingSessionExitIfStopRequested', () => {
  it('separately records physical exit and settled exit lifecycle without terminal output', async () => {
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [999999991, { pid: 999999991, startedBy: 'terminal', happySessionId: 'sess-diagnostic', stopRequestedAtMs: 123,
        processCommand: 'private-launch-credential' }],
    ]);
    let releaseMarker!: () => void;
    let markerStarted!: () => void;
    const markerPending = new Promise<void>((resolve) => { releaseMarker = resolve; });
    const markerObserved = new Promise<void>((resolve) => { markerStarted = resolve; });
    const onExitObserved = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      // Filesystem boundary: hold marker removal to observe the real exit lifecycle while pending.
      removeSessionMarkerFn: async () => { markerStarted(); await markerPending; },
    });
    logger.flushSync();
    const previousLogLength = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const nodeConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    const readDiagnostic = () => {
      logger.flushSync();
      return existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').slice(previousLogLength) : '';
    };
    const wait = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-diagnostic', pidToTrackedSession, timeoutMs: 1_000, pollIntervalMs: 50,
      // Only the OS state boundary is replaced; the physical-exit owner remains real.
      readRunState: async () => 'dead',
      onExitObserved,
    });
    try {
      await markerObserved;
      expect(readDiagnostic()).toContain('[DAEMON STOP] Tracked runner physical exit observed');
      expect(readDiagnostic()).not.toContain('[DAEMON STOP] Tracked runner exit lifecycle completed');
      releaseMarker();
      await wait;
      expect(pidToTrackedSession.size).toBe(0);
      const diagnostic = readDiagnostic();
      expect(diagnostic).toContain('[DAEMON STOP] Tracked runner exit lifecycle completed');
      expect(diagnostic).toContain('[DAEMON STOP] Runner exit durable staging completed');
      expect(diagnostic).toContain('[DAEMON STOP] Runner exit resources completed');
      expect(diagnostic).not.toContain('private-launch-credential');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      releaseMarker();
      await wait;
      consoleLog.mockRestore();
      stdout.mockRestore();
    }
  });

  it('does nothing when no tracked session has a stopRequestedAtMs marker for the session id', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const readRunState = vi.fn(async () => 'servable' as const);
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, { pid: 1, startedBy: 'terminal', happySessionId: 'sess-1' }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      readRunState,
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(readRunState).not.toHaveBeenCalled();
  });

  it('waits for the runner to exit when the session has an in-flight stop marker', async () => {
    vi.useFakeTimers();
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const runStates: ProcessRunState[] = ['servable', 'servable', 'dead'];
    const readRunState = vi.fn(async () => runStates.shift() ?? 'dead');
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, { pid: 1, startedBy: 'terminal', happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    const promise = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      readRunState,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(readRunState).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('notifies the caller when a stopped tracked runner is no longer active', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const readRunState = vi.fn(async () => 'dead' as const);
    const onExitObserved = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, { pid: 1, startedBy: 'terminal', happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      readRunState,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      onExitObserved,
    });

    expect(onExitObserved).toHaveBeenCalledWith(1, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });

  it('does not complete the stop observation before the exit lifecycle obligation settles', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');
    let resolveExit = (): void => {
      throw new Error('Exit resolver was not installed');
    };
    let markExitObserved = (): void => {
      throw new Error('Exit observation resolver was not installed');
    };
    const exitObserved = new Promise<void>((resolve) => {
      markExitObserved = resolve;
    });
    const onExitObserved = vi.fn(() => new Promise<void>((resolve) => {
      markExitObserved();
      resolveExit = resolve;
    }));
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [1, { pid: 1, startedBy: 'terminal', happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);
    let completed = false;

    const wait = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      readRunState: async () => 'dead',
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      onExitObserved,
    }).then(() => {
      completed = true;
    });

    await exitObserved;
    await Promise.resolve();
    expect(completed).toBe(false);

    resolveExit();
    await wait;
    expect(completed).toBe(true);
  });

  it('can observe explicit tracked pids even when no stopRequestedAtMs marker exists', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const readRunState = vi.fn(async () => 'dead' as const);
    const onExitObserved = vi.fn();
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [6480, { pid: 6480, startedBy: 'terminal', happySessionId: 'sess-reattached' }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-reattached',
      pidToTrackedSession,
      readRunState,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      trackedPids: [6480],
      onExitObserved,
    });

    expect(onExitObserved).toHaveBeenCalledWith(6480, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });
});
