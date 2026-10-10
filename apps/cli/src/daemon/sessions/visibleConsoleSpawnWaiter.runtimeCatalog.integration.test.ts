import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';

import { waitForVisibleConsoleSessionWebhook } from './visibleConsoleSpawnWaiter';
import { createOnChildExited } from './onChildExited';
import { armSessionWebhookStartupCustody } from '../spawn/waitForSessionWebhook';
import { createOnHappySessionWebhook } from './onHappySessionWebhook';
import { spawnInlineNodeParentWithChild } from '@/testkit/process/spawn';
import { configuration } from '@/configuration';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { writeSessionMarker } from '../sessionRegistry';

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
  it.skipIf(process.platform === 'win32')('keeps the same pending completion when actual wrapper exit promotes its live runner', async () => {
    const previousHome = configuration.happyHomeDir;
    const home = await mkdtemp(join(tmpdir(), 'happier-visible-promotion-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: home });
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const pid = parent.pid!;
    const tracked: TrackedSession = { pid, startedBy: 'daemon', happySessionId: `PID-${pid}`, sessionRunnerPid: childPid, childProcess: parent };
    const sessions = new Map([[pid, tracked]]);
    const state = createWaiterState();
    const exit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null });
    const completion = waitForVisibleConsoleSessionWebhook({ ...state, pid, pollMs: 10, pidToTrackedSession: sessions, onChildExited: exit });
    try {
      await writeSessionMarker({ pid, happySessionId: `PID-${pid}`, startedBy: 'daemon' });
      const exited = once(parent, 'exit');
      parent.kill('SIGTERM');
      await exited;
      await vi.waitFor(() => expect(sessions.get(childPid)).toBe(tracked));
      expect(state.pidToAwaiter.has(pid)).toBe(true);
      const report = createOnHappySessionWebhook({ pidToTrackedSession: sessions, pidToAwaiter: state.pidToAwaiter });
      await report('session-live-promoted-runner', { path: home, host: 'fixture', homeDir: home, happyHomeDir: home,
        happyLibDir: home, happyToolsDir: home, hostPid: childPid, startedBy: 'daemon', machineId: 'fixture-machine' });
      await expect(completion).resolves.toMatchObject({ type: 'success', sessionId: 'session-live-promoted-runner' });
    } finally {
      state.pidToSpawnResultResolver.get(pid)?.({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
      await Promise.allSettled([completion]);
      for (const timeout of state.pidToSpawnWebhookTimeout.values()) clearTimeout(timeout);
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
      await tracked.reportMarkerCustody?.pending;
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
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
      reason: 'process-missing',
      code: null,
      signal: null,
    });
  });

  it('delegates pending runner absence to the canonical startup exit owner', async () => {
    vi.useFakeTimers();
    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);
    const pid = 12347;
    const tracked: TrackedSession = { pid, startedBy: 'daemon' };
    const sessions = new Map([[pid, tracked]]);
    const state = createWaiterState();
    const exit = createOnChildExited({ pidToTrackedSession: sessions,
      spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null, removeSessionMarkerFn: async () => {} });
    const completion = waitForVisibleConsoleSessionWebhook({
      ...state, pid, pollMs: 10, pidToTrackedSession: sessions, onChildExited: exit,
    });
    armSessionWebhookStartupCustody(tracked, completion, Promise.resolve());
    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(10);
    await expect(completion).resolves.toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
    expect(state.pidToAwaiter.has(pid)).toBe(false);
    expect(sessions.has(pid)).toBe(false);
  });

  it('retains physical custody when canonical exit cleanup rejects after startup failure', async () => {
    vi.useFakeTimers();
    const aliveRef = { alive: true };
    installProcessKillMock(aliveRef);
    const pid = 12348;
    const tracked: TrackedSession = { pid, startedBy: 'daemon' };
    const sessions = new Map([[pid, tracked]]);
    const state = createWaiterState();
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    // Owned external resource disposal is a system boundary; the exit/startup owners remain real.
    const exit = createOnChildExited({ pidToTrackedSession: sessions,
      spawnResourceCleanupByPid: new Map([[pid, async () => await cleanup]]), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null, removeSessionMarkerFn: async () => {} });
    const completion = waitForVisibleConsoleSessionWebhook({
      ...state, pid, pollMs: 10, pidToTrackedSession: sessions, onChildExited: exit,
    });
    armSessionWebhookStartupCustody(tracked, completion, Promise.resolve());
    aliveRef.alive = false;
    await vi.advanceTimersByTimeAsync(10);
    await expect(completion).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK });
    expect(state.pidToAwaiter.has(pid)).toBe(false);
    rejectCleanup(new Error('provider retirement failed'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions.get(pid)).toBe(tracked);
    expect(tracked.reportMarkerCustody?.retiring).toBe(true);
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
