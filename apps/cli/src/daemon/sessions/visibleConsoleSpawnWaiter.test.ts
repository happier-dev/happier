import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';

import { waitForVisibleConsoleSessionWebhook } from './visibleConsoleSpawnWaiter';

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

describe('waitForVisibleConsoleSessionWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      reason: 'process-exited',
      code: null,
      signal: null,
    });
  });

  it('labels an exit observed while the webhook request is pending', async () => {
    vi.useFakeTimers();

    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);
    const pid = 12347;
    const { pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = createWaiterState();
    const promise = waitForVisibleConsoleSessionWebhook({
      pid,
      pollMs: 10,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      onChildExited,
    });

    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toEqual(expect.objectContaining({
      type: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
    }));
    expect(onChildExited).toHaveBeenCalledWith(pid, {
      reason: 'process-exited-before-webhook',
      code: null,
      signal: null,
    });
  });

  it('awaits canonical exit cleanup and reports incomplete retirement when it rejects', async () => {
    vi.useFakeTimers();

    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);
    const pid = 12348;
    const {
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
    } = createWaiterState();
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject;
    });
    const onChildExited = vi.fn(async () => await cleanup);
    const promise = waitForVisibleConsoleSessionWebhook({
      pid,
      pollMs: 10,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      onChildExited,
    });
    const settled = vi.fn();
    void promise.then(settled);

    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(onChildExited).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    rejectCleanup(new Error('provider retirement failed'));
    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage:
        'startup_retirement_incomplete:exit_cleanup_incomplete',
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
      reason: 'process-exited',
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
      reason: 'process-exited',
      code: null,
      signal: null,
    });
  });

  it('keeps waiting for webhook proof before resolving success', async () => {
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

    expect(pidToAwaiter.size).toBe(1);
    expect(pidToSpawnResultResolver.size).toBe(1);
    expect(pidToSpawnWebhookTimeout.size).toBe(1);

    pidToAwaiter.get(pid)?.({ startedBy: 'daemon', pid, happySessionId: 'session-visible-9876' });

    await expect(promise).resolves.toEqual({ type: 'success', sessionId: 'session-visible-9876' });
    expect(onChildExited).not.toHaveBeenCalled();
  });
});
