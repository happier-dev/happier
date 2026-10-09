import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';
import { logger } from '@/ui/logger';

import { waitForVisibleConsoleSessionWebhook } from './visibleConsoleSpawnWaiter';
import { createOnChildExited } from './onChildExited';
import { buildWindowsHostedTerminalAttachment } from '../platform/windows/windowsHostedSessionRuntime';

function installProcessKillMock(aliveRef: { alive: boolean }): void {
  vi.spyOn(process, 'kill').mockImplementation(
    ((pid: number, signal?: number | NodeJS.Signals) => {
      if (!aliveRef.alive) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill,
  );
}

function createWaiterState(): {
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, ReturnType<typeof setTimeout>>;
  onChildExited: (pid: number, exit: ChildExit) => void;
} {
  return {
    pidToAwaiter: new Map<number, (session: TrackedSession) => void>(),
    pidToSpawnResultResolver: new Map<number, (result: SpawnSessionResult) => void>(),
    pidToSpawnWebhookTimeout: new Map<number, ReturnType<typeof setTimeout>>(),
    onChildExited: vi.fn<(pid: number, exit: ChildExit) => void>(),
  };
}

function armTestStartupCustody(
  tracked: TrackedSession,
  state: ReturnType<typeof createWaiterState>,
  completion: Promise<SpawnSessionResult>,
): void {
  const pid = tracked.pid;
  tracked.startupCustody = {
    finalization: completion.then(() => {}),
    observeExit: () => {
      const timeout = state.pidToSpawnWebhookTimeout.get(pid);
      if (timeout) clearTimeout(timeout);
      state.pidToSpawnWebhookTimeout.delete(pid);
      state.pidToAwaiter.delete(pid);
      const resolve = state.pidToSpawnResultResolver.get(pid);
      state.pidToSpawnResultResolver.delete(pid);
      resolve?.({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'runner startup failed' });
    },
  };
}

describe('waitForVisibleConsoleSessionWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps unresolved Windows runner startup after its launcher disappears, until a terminal failure', async () => {
    vi.useFakeTimers();
    installProcessKillMock({ alive: false });
    const pid = 681001;
    const state = createWaiterState();
    const tracked: TrackedSession = {
      pid, startedBy: 'daemon',
      hostedTerminal: buildWindowsHostedTerminalAttachment({ actualMode: 'windows_terminal', requestedMode: 'windows_terminal', pid, windowId: 'startup-window', title: 'startup-title' }),
    };
    const trackedSessions = new Map([[pid, tracked]]);
    const onChildExited = createOnChildExited({
      pidToTrackedSession: trackedSessions,
      spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: async () => {}, // Filesystem boundary; real exit staging remains exercised.
    });
    const completion = waitForVisibleConsoleSessionWebhook({ ...state, pid, pollMs: 10, onChildExited });
    armTestStartupCustody(tracked, state, completion);

    await vi.advanceTimersByTimeAsync(20);
    expect(state.pidToAwaiter.has(pid)).toBe(true);
    expect(trackedSessions.get(pid)).toBe(tracked);
    expect(tracked.reportMarkerCustody?.retiring).not.toBe(true);

    await onChildExited(pid, { reason: 'process-error', code: 1, signal: null });
    await expect(completion).resolves.toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
    expect(trackedSessions.has(pid)).toBe(false);
    expect(state.pidToAwaiter.has(pid)).toBe(false);
  });

  it('reports startup exit immediately and retains tracking when terminal cleanup fails', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, 'warn');
    installProcessKillMock({ alive: false });
    const pid = 12347;
    const tracked: TrackedSession = {
      pid,
      startedBy: 'daemon',
      happySessionId: 'session-terminal-custody-unavailable',
      activeTurnId: 'turn-unsettled',
    };
    const pidToTrackedSession = new Map([[pid, tracked]]);
    const state = createWaiterState();
    const completion = waitForVisibleConsoleSessionWebhook({
      ...state,
      pid,
      pollMs: 10,
      onChildExited: createOnChildExited({
        pidToTrackedSession,
        spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(),
        getApiMachineForSessions: () => null,
      }),
    });

    armTestStartupCustody(tracked, state, completion);

    await vi.advanceTimersByTimeAsync(10);

    await expect(completion).resolves.toMatchObject({
      type: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
    });
    expect(pidToTrackedSession.get(pid)).toBe(tracked);
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pid, error: expect.any(Error) }));
  });

  it('fails closed when webhook success is missing happySessionId', async () => {
    vi.useFakeTimers();

    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);

    const pid = 12346;
    const { pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = createWaiterState();

    const promise = waitForVisibleConsoleSessionWebhook({
      pid,
      pollMs: 10,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      onChildExited,
    });

    const awaiter = pidToAwaiter.get(pid);
    expect(typeof awaiter).toBe('function');

    awaiter?.({ startedBy: 'daemon', pid });
    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: 'UNEXPECTED',
      errorMessage: `Session webhook did not include a sessionId (pid=${pid})`,
    });

    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(20);

    expect(onChildExited).toHaveBeenCalledWith(pid, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });

  it('keeps exit polling active after webhook success so cleanup can run on process exit', async () => {
    vi.useFakeTimers();

    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);

    const pid = 12345;
    const { pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = createWaiterState();

    const promise = waitForVisibleConsoleSessionWebhook({
      pid,
      pollMs: 10,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      onChildExited,
    });

    const awaiter = pidToAwaiter.get(pid);
    expect(typeof awaiter).toBe('function');

    awaiter?.({ startedBy: 'daemon', pid, happySessionId: 's1' });
    await expect(promise).resolves.toEqual({ type: 'success', sessionId: 's1' });

    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(20);

    expect(onChildExited).toHaveBeenCalledWith(pid, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });

  it('uses the shared default webhook timeout window instead of a visible-console-specific short timeout', async () => {
    vi.useFakeTimers();

    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const pid = 22334;
    const { pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = createWaiterState();

    const promise = waitForVisibleConsoleSessionWebhook({
      pid,
      pollMs: 10,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      onChildExited,
    });

    const awaiter = pidToAwaiter.get(pid);
    expect(typeof awaiter).toBe('function');
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);

    awaiter?.({ startedBy: 'daemon', pid, happySessionId: 'session-visible-late' });

    await expect(promise).resolves.toEqual({ type: 'success', sessionId: 'session-visible-late' });

    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(20);

    expect(onChildExited).toHaveBeenCalledWith(pid, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });

  it('continues waiting for webhook proof before resolving success', async () => {
    vi.useFakeTimers();
    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);

    const pid = 9876;
    const { pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = createWaiterState();

    const promise = waitForVisibleConsoleSessionWebhook({
      pid,
      pollMs: 10,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      onChildExited,
    });

    expect(pidToAwaiter.has(pid)).toBe(true);
    expect(pidToSpawnResultResolver.has(pid)).toBe(true);
    expect(pidToSpawnWebhookTimeout.has(pid)).toBe(true);

    pidToAwaiter.get(pid)?.({ startedBy: 'daemon', pid, happySessionId: 'session-visible-9876' });

    await expect(promise).resolves.toEqual({ type: 'success', sessionId: 'session-visible-9876' });

    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(20);

    expect(onChildExited).toHaveBeenCalledWith(pid, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });
});
