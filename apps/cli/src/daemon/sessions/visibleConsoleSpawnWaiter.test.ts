import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
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
});
