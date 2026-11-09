import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Console } from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { readProcessRunState } from '../processRunState';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { isSessionRunnerActive } from './isSessionRunnerActive';

import { observePlannedRunnerRetirement, waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';

describe('waitForTrackedRunnerProcessesExit', () => {
  it.skipIf(process.platform === 'win32')('preserves custody for a real paused live child', async () => {
    // Development-only owned child; the product runtime is not spawned through system Node.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const pid = child.pid!;
    const exited = once(child, 'exit');
    const tracked = new Map<number, TrackedSession>([
      [pid, { pid, startedBy: 'terminal', happySessionId: `PID-${pid}`, stopRequestedAtMs: 123 }],
    ]);
    const onExitObserved = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      // Marker files are an external persistence boundary; no marker belongs to this synthetic child.
      removeSessionMarkerFn: async () => {},
    });
    try {
      expect(child.kill('SIGSTOP')).toBe(true);
      expect(await readProcessRunState(pid)).toBe('stopped');
      const request = { runners: [{ pid }], timeoutMs: 0, pollIntervalMs: 0, onExitObserved };
      expect(await waitForTrackedRunnerProcessesExit(request)).toBe(false);
      // Freeze only the clock boundary so a zero-budget old while loop cannot accidentally skip its probe.
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(await isSessionRunnerActive({ sessionId: `PID-${pid}`, trackedSessions: tracked.values() })).toBe(false);
      await waitForExistingSessionExitIfStopRequested({
        sessionId: `PID-${pid}`, pidToTrackedSession: tracked, timeoutMs: 0, pollIntervalMs: 0,
        onExitObserved,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(tracked.has(pid)).toBe(true);
      expect(await readProcessRunState(pid)).toBe('stopped');
    } finally {
      vi.useRealTimers();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

  it.each([0, 1_000])('joins real exit custody beyond the %i ms physical-exit grace without requiring another Stop', async (timeoutMs) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'spawn');
    const pid = child.pid!;
    await once(child, 'exit');
    const tracked = new Map<number, TrackedSession>([
      [pid, { pid, startedBy: 'terminal', happySessionId: `PID-${pid}`, stopRequestedAtMs: 123,
        processCommand: 'private-launch-credential' }],
    ]);
    let releaseMarker!: () => void;
    let markerStarted!: () => void;
    const markerPending = new Promise<void>((resolve) => { releaseMarker = resolve; });
    const markerObserved = new Promise<void>((resolve) => { markerStarted = resolve; });
    let markerRetirementAttempts = 0;
    const onExitObserved = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: async () => { markerRetirementAttempts += 1; markerStarted(); await markerPending; },
    });
    logger.flushSync();
    const previousLogLength = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const nodeConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    let completed = false;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const request = { runners: [{ pid }], timeoutMs, pollIntervalMs: 0, onExitObserved };
    const waiting = waitForTrackedRunnerProcessesExit(request).then((result) => { completed = true; return result; });
    try {
      await Promise.race([markerObserved, waiting]);
      expect(completed).toBe(false);
      expect(tracked.has(pid)).toBe(true);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      // Brief Task 2 replaces the development-only shared physical/retirement
      // cutoff documented in docs/cli-architecture.md:5465–5471.
      expect(completed, 'Physical-exit grace cannot expire required retirement').toBe(false);
      expect(tracked.has(pid)).toBe(true);
      // Concurrent Stop joins the same cleanup; the original caller also sees
      // its terminal result, without another request to refresh that outcome.
      const retry = waitForTrackedRunnerProcessesExit({ ...request, timeoutMs: 1_000 });
      releaseMarker();
      expect(await waiting).toBe(true);
      expect(await retry).toBe(true);
      expect(tracked.has(pid)).toBe(false);
      expect(markerRetirementAttempts).toBe(1);
      logger.flushSync();
      const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(previousLogLength);
      expect(diagnostic).toContain('[DAEMON STOP] Tracked runner physical exit observed');
      expect(diagnostic).toContain('[DAEMON STOP] Tracked runner exit lifecycle completed');
      expect(diagnostic).not.toContain('private-launch-credential');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      releaseMarker();
      await waiting;
      vi.useRealTimers();
      consoleLog.mockRestore();
      stdout.mockRestore();
    }
  });

  it.each([false, true])('observes an owned child exit without scans or retiring a replacement (%s)', async replacement => {
    const child = spawn(process.execPath, ['-e', "process.send('ready');process.on('message',()=>process.exit(0))"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    await once(child, 'message');
    const readRunState = vi.fn(async () => 'servable' as const);
    const exits: number[] = [];
    const exitListeners = child.listenerCount('exit');
    const pid = child.pid!;
    const sessionId = `PID-${pid}`;
    const tracked = new Map<number, TrackedSession>([[pid, {
      pid, childProcess: child, startedBy: 'daemon', happySessionId: sessionId, stopRequestedAtMs: Date.now(),
    }]]);
    const onExitObserved = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      // Marker persistence is the OS boundary; retirement and map custody stay real.
      removeSessionMarkerFn: async retiredPid => { exits.push(retiredPid); },
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const waiting = waitForExistingSessionExitIfStopRequested({
      sessionId, pidToTrackedSession: tracked,
      timeoutMs: 1_000, pollIntervalMs: 100, readRunState,
      onExitObserved,
    });
    try {
      await vi.advanceTimersByTimeAsync(900);
      expect(readRunState, 'An owned child supplies push terminal evidence without OS polling').not.toHaveBeenCalled();
      expect(exits).toEqual([]);
      if (replacement) tracked.set(pid, { pid, startedBy: 'daemon', happySessionId: sessionId });
      child.send('exit');
      await exited;
      await waiting;
      expect(exits).toEqual(replacement ? [] : [child.pid]);
      expect(tracked.has(pid)).toBe(replacement);
      expect(child.listenerCount('exit')).toBe(exitListeners - 1);
      // File logging buffers its own flush; exclude that independent owner.
      logger.flushSync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.send('exit');
      await exited;
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      vi.useRealTimers();
    }
  });

  it('releases an owned child subscription when live-runner grace expires and accepts an already-exited child', async () => {
    const child = spawn(process.execPath, ['-e', "process.send('ready');process.on('message',()=>process.exit(0))"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    await once(child, 'message');
    const readRunState = vi.fn(async () => 'servable' as const);
    const exitListeners = child.listenerCount('exit');
    const request = { runners: [{ pid: child.pid!, childProcess: child }],
      timeoutMs: 1_000, pollIntervalMs: 100, readRunState };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const waiting = waitForTrackedRunnerProcessesExit(request);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waiting).toBe(false);
      expect(child.listenerCount('exit')).toBe(exitListeners);
      logger.flushSync();
      expect(vi.getTimerCount()).toBe(0);
      child.send('exit');
      await exited;
      expect(await waitForTrackedRunnerProcessesExit({ ...request, timeoutMs: 0 })).toBe(true);
      expect(readRunState).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.send('exit');
      await exited;
      vi.useRealTimers();
    }
  });

  it('waits until every exact tracked PID is observed dead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const readRunState = vi.fn()
      .mockResolvedValueOnce('servable')
      .mockResolvedValueOnce('servable')
      .mockResolvedValueOnce('dead')
      .mockResolvedValueOnce('zombie');

    try {
      await expect(waitForTrackedRunnerProcessesExit({
      runners: [{ pid: 101 }, { pid: 202 }],
      timeoutMs: 50,
      pollIntervalMs: 0,
      readRunState,
      })).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes every runner death before joining slow exit retirement', async () => {
    const tracked = new Map<number, TrackedSession>([101, 202].map(pid => [pid, {
      pid, startedBy: 'terminal', happySessionId: `PID-${pid}`, stopRequestedAtMs: Date.now(),
    }]));
    let releaseMarker!: () => void;
    let startMarker!: () => void;
    const markerPending = new Promise<void>(resolve => { releaseMarker = resolve; });
    const markerStarted = new Promise<void>(resolve => { startMarker = resolve; });
    const onExitObserved = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: async pid => {
        if (pid === 101) { startMarker(); await markerPending; }
      },
    });
    const readRunState = vi.fn(async (_pid: number) => 'dead' as const);
    const waiting = waitForTrackedRunnerProcessesExit({
      runners: [{ pid: 101 }, { pid: 202 }], timeoutMs: 0, pollIntervalMs: 0, readRunState, onExitObserved,
    });
    try {
      await markerStarted;
      // Slow retirement of one runner must not hold physical observation or
      // the escalation decision for another runner in the same Stop.
      expect(readRunState.mock.calls.map(([pid]) => pid)).toEqual([101, 202]);
    } finally {
      releaseMarker();
      await waiting;
    }
    expect(tracked.size).toBe(0);
  });

  it('preserves the host while a tracked PID remains live or unprobeable', async () => {
    await expect(waitForTrackedRunnerProcessesExit({
      runners: [{ pid: 303 }],
      timeoutMs: 0,
      pollIntervalMs: 0,
      readRunState: vi.fn(async () => 'servable' as const),
    })).resolves.toBe(false);
  });
});


describe('observePlannedRunnerRetirement', () => {
  it('reports unsuccessful adopted retirement instead of dropping the physical observation', async () => {
    await expect(observePlannedRunnerRetirement({ tracked: { pid: 101, startedBy: 'daemon' },
      timeoutMs: 0, pollIntervalMs: 0, readRunState: async () => 'servable' })).resolves.toBe(false);
  });
  it('limits adopted restart process scans to twice per second within the existing completion budget', async () => {
    vi.useFakeTimers();
    try {
      const startedAtMs = Date.now();
      const tracked: TrackedSession = { pid: 101, startedBy: 'daemon', happySessionId: 'sess-1' };
      const exits: number[] = [];
      // OS process-state probes and the clock are the boundaries; the physical-exit owner runs for real.
      const readRunState = vi.fn(async () => Date.now() - startedAtMs >= 1_000 ? 'dead' as const : 'servable' as const);
      const waiting = observePlannedRunnerRetirement({
        tracked, timeoutMs: 1_000, pollIntervalMs: 50, readRunState,
        onExitObserved: (pid) => { exits.push(pid); },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(exits).toEqual([101]);
      expect(readRunState.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
