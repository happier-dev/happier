import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';

import { hasSessionWebhookPidTimedOut, waitForSessionWebhook } from './waitForSessionWebhook';

describe('waitForSessionWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves success when webhook arrives before timeout', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 42,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
    });

    const resolver = pidToAwaiter.get(42);
    expect(typeof resolver).toBe('function');
    resolver?.({ happySessionId: 'session-1' });

    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(pidToAwaiter.has(42)).toBe(false);
    expect(pidToSpawnResultResolver.has(42)).toBe(false);
    expect(pidToSpawnWebhookTimeout.has(42)).toBe(false);
  });

  it('resolves timeout error and cleans maps when webhook does not arrive', async () => {
    vi.useFakeTimers();

    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 77,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 77',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 77',
    });
    expect(pidToAwaiter.has(77)).toBe(false);
    expect(pidToSpawnResultResolver.has(77)).toBe(false);
    expect(pidToSpawnWebhookTimeout.has(77)).toBe(false);
  });

  it('marks the tracked session timed out when no canonical session id exists at timeout', async () => {
    vi.useFakeTimers();

    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const pidToTrackedSession = new Map<number, any>([
      [78, { pid: 78, startedBy: 'daemon', happySessionId: 'PID-78' }],
    ]);

    const promise = waitForSessionWebhook({
      pid: 78,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 78',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 78',
    });
    expect(pidToTrackedSession.get(78)?.sessionWebhookTimedOutAtMs).toEqual(expect.any(Number));
  });

  it('marks the exact startup owner timed out while canonical readiness is still pending', async () => {
    vi.useFakeTimers();

    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const pidToTrackedSession = new Map<number, any>([
      [79, { pid: 79, startedBy: 'daemon', happySessionId: 'session-79' }],
    ]);

    const promise = waitForSessionWebhook({
      pid: 79,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 79',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 79',
    });
    expect(pidToTrackedSession.get(79)?.sessionWebhookTimedOutAtMs).toEqual(expect.any(Number));
  });

  it('times out the exact promoted runner while retaining original waiter-map ownership', async () => {
    vi.useFakeTimers();
    const wrapperPid = 81;
    const runnerPid = 82;
    const originalTracked: TrackedSession = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: `PID-${wrapperPid}`,
    };
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const pidToTrackedSession = new Map<number, any>([
      [wrapperPid, originalTracked],
    ]);
    const onTimeout = vi.fn();
    const promise = waitForSessionWebhook({
      pid: wrapperPid,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      timeoutMs: 25,
      timeoutErrorMessage: `Session webhook timeout for PID ${wrapperPid}`,
      onTimeout,
    });
    Object.assign(originalTracked, {
      pid: runnerPid,
      happySessionId: `PID-${runnerPid}`,
      spawnStartupAwaiterPid: wrapperPid,
    });
    pidToTrackedSession.delete(wrapperPid);
    pidToTrackedSession.set(runnerPid, originalTracked);

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    expect(originalTracked.sessionWebhookTimedOutAtMs)
      .toEqual(expect.any(Number));
    expect(hasSessionWebhookPidTimedOut(wrapperPid)).toBe(true);
    expect(hasSessionWebhookPidTimedOut(runnerPid)).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith(originalTracked);
    expect(pidToAwaiter).toHaveLength(0);
    expect(pidToSpawnResultResolver).toHaveLength(0);
    expect(pidToSpawnWebhookTimeout).toHaveLength(0);
  });

  it('tombstones a reported runner before wrapper-to-runner promotion completes', async () => {
    vi.useFakeTimers();
    const wrapperPid = 83;
    const runnerPid = 84;
    const tracked = {
      pid: wrapperPid,
      sessionRunnerPid: runnerPid,
      startedBy: 'daemon',
      happySessionId: `PID-${runnerPid}`,
    };
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver =
      new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout =
      new Map<number, NodeJS.Timeout>();
    const pidToTrackedSession =
      new Map<number, any>([[wrapperPid, tracked]]);
    const promise = waitForSessionWebhook({
      pid: wrapperPid,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      timeoutMs: 25,
      timeoutErrorMessage:
        `Session webhook timeout for PID ${wrapperPid}`,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(promise).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });

    expect(hasSessionWebhookPidTimedOut(wrapperPid)).toBe(true);
    expect(hasSessionWebhookPidTimedOut(runnerPid)).toBe(true);
  });

  it('does not delete or time out same-PID replacement custody when a superseded request timer fires', async () => {
    vi.useFakeTimers();
    const pid = 80;
    const originalTracked = { pid, startedBy: 'daemon', happySessionId: `PID-${pid}` };
    const replacementTracked = { pid, startedBy: 'daemon', happySessionId: `PID-${pid}` };
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const pidToTrackedSession = new Map<number, any>([[pid, originalTracked]]);
    const onTimeout = vi.fn();

    const promise = waitForSessionWebhook({
      pid,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      timeoutMs: 25,
      timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
      onTimeout,
    });
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeoutCallback = vi.fn();
    const replacementTimeout = setTimeout(replacementTimeoutCallback, 1_000);
    pidToTrackedSession.set(pid, replacementTracked);
    pidToAwaiter.set(pid, replacementAwaiter);
    pidToSpawnResultResolver.set(pid, replacementResolver);
    pidToSpawnWebhookTimeout.set(pid, replacementTimeout);

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: `Session webhook timeout for PID ${pid}`,
    });
    expect(pidToTrackedSession.get(pid)).toBe(replacementTracked);
    expect(pidToAwaiter.get(pid)).toBe(replacementAwaiter);
    expect(pidToSpawnResultResolver.get(pid)).toBe(replacementResolver);
    expect(pidToSpawnWebhookTimeout.get(pid)).toBe(replacementTimeout);
    expect(replacementTracked).not.toHaveProperty('sessionWebhookTimedOutAtMs');
    expect(hasSessionWebhookPidTimedOut(pid)).toBe(false);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    expect(replacementTimeoutCallback).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('allows late webhook within default timeout window', async () => {
    vi.useFakeTimers();
    const previous = process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;

    try {
      const pidToAwaiter = new Map<number, (session: any) => void>();
      const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
      const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

      const promise = waitForSessionWebhook({
        pid: 88,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        timeoutErrorMessage: 'Session webhook timeout for PID 88',
      });

      await vi.advanceTimersByTimeAsync(65_000);

      const resolver = pidToAwaiter.get(88);
      expect(typeof resolver).toBe('function');
      resolver?.({ happySessionId: 'session-late' });

      await expect(promise).resolves.toEqual({
        type: 'success',
        sessionId: 'session-late',
      });
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
      else process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = previous;
    }
  });

  it('does not time out too aggressively by default', async () => {
    vi.useFakeTimers();
    const previous = process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;

    try {
      const pidToAwaiter = new Map<number, (session: any) => void>();
      const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
      const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

      const promise = waitForSessionWebhook({
        pid: 99,
        pidToAwaiter,
        pidToSpawnResultResolver,
        pidToSpawnWebhookTimeout,
        timeoutErrorMessage: 'Session webhook timeout for PID 99',
      });

      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(100_000);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(pidToAwaiter.has(99)).toBe(true);
      expect(pidToSpawnResultResolver.has(99)).toBe(true);
      expect(pidToSpawnWebhookTimeout.has(99)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
      else process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = previous;
    }
  });

  it('fails closed when webhook success is missing happySessionId', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 91,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
    });

    const resolver = pidToAwaiter.get(91);
    expect(typeof resolver).toBe('function');
    resolver?.({});

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'Session webhook did not include a sessionId (pid=91)',
    });
  });

  it('continues waiting for webhook proof before resolving success', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 5150,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
    });

    expect(pidToAwaiter.has(5150)).toBe(true);
    expect(pidToSpawnResultResolver.has(5150)).toBe(true);
    expect(pidToSpawnWebhookTimeout.has(5150)).toBe(true);

    pidToAwaiter.get(5150)?.({ happySessionId: 'session-ready-5150' });

    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-ready-5150',
    });
  });
});
