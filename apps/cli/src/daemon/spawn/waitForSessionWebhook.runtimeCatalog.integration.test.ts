import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout } from 'node:timers';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createPersistedTakeoverAdmissionWaiter } from './persistedTakeoverAdmission';

import { armSessionWebhookStartupCustody, waitForSessionWebhook } from './waitForSessionWebhook';

describe('waitForSessionWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves the observed child exit cause when startup custody settles before the webhook', async () => {
    const tracked: TrackedSession = { pid: 745525, startedBy: 'daemon', happySessionId: 'PID-745525' };
    const completion = waitForSessionWebhook({
      pid: tracked.pid, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(), pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      timeoutErrorMessage: 'startup timed out',
    });
    armSessionWebhookStartupCustody(tracked, completion, Promise.resolve());
    tracked.startupCustody!.observeExit({ reason: 'process-exited-before-webhook', code: 1, signal: null,
      stderrTail: 'Provider-bound model selection requires a validated provider binding handoff' });
    const result = await completion;
    expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK });
    if (result.type !== 'error') throw new Error('Expected child exit refusal');
    expect(result.errorMessage).toContain('code=1');
    expect(result.errorMessage).toContain('signal=null');
    expect(result.errorMessage).toContain('Provider-bound model selection requires a validated provider binding handoff');
    expect(result.errorDetail).toMatchObject({ kind: 'launch_error',
      code: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      childExit: { code: 1, signal: null,
        stderrHead: 'Provider-bound model selection requires a validated provider binding handoff' },
    });
    await completion.waitForFinalization();
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

  it('does not acknowledge the webhook until async startup finalization completes', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    let finishFinalization!: () => void;
    const finalization = new Promise<void>((resolve) => {
      finishFinalization = resolve;
    });

    const promise = waitForSessionWebhook({
      pid: 44,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
      onSuccess: async () => {
        await finalization;
      },
    });

    const resolver = pidToAwaiter.get(44);
    expect(typeof resolver).toBe('function');
    resolver?.({ happySessionId: 'session-finalized' });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    finishFinalization();
    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-finalized',
    });
  });

  it('returns the authoritative create-or-rejoin outcome carried by the matched runner', async () => {
    const pidToAwaiter = new Map<number, (session: any) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: any) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      pid: 43,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      timeoutErrorMessage: 'timeout',
    });

    pidToAwaiter.get(43)?.({
      happySessionId: 'session-create-outcome',
      sessionCreationOutcome: {
        disposition: 'rejoined',
        organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
      },
    });

    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-create-outcome',
      sessionCreationOutcome: {
        disposition: 'rejoined',
        organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
      },
    });
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

  it('marks the exact startup owner timed out without retaining PID expiry timers', async () => {
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
    expect(pidToAwaiter.size).toBe(0);
    expect(pidToSpawnResultResolver.size).toBe(0);
    expect(pidToSpawnWebhookTimeout.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
    expect(onTimeout).toHaveBeenCalledWith(originalTracked);
    expect(pidToAwaiter).toHaveLength(0);
    expect(pidToSpawnResultResolver).toHaveLength(0);
    expect(pidToSpawnWebhookTimeout).toHaveLength(0);
  });

  it('marks a reported runner owner timed out before wrapper-to-runner promotion completes', async () => {
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

    expect(tracked).toHaveProperty('sessionWebhookTimedOutAtMs', expect.any(Number));
    expect(pidToTrackedSession.get(wrapperPid)).toBe(tracked);
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


describe('takeover admission within canonical spawn readiness', () => {
  afterEach(() => vi.useRealTimers());

  function start(mode: 'persisted' | 'external_linked', signal?: AbortSignal) {
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = { mode, operationId: 'operation-1', attemptId: 'attempt-1' };
    const admission = waiter.register(correlation, { signal });
    const tracked: TrackedSession = { pid: 4201, startedBy: 'daemon', happySessionId: 'session-1' };
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const promise = waitForSessionWebhook({
      pid: tracked.pid,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      takeoverAdmission: admission,
      timeoutErrorMessage: 'startup timed out',
    });
    return { waiter, correlation, admission, tracked, promise, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, pidToTrackedSession };
  }

  it.each(['persisted', 'external_linked'] as const)('keeps %s pending beyond 30 seconds and ACKs the ordinary webhook before runtime binding', async (mode) => {
    vi.useFakeTimers();
    const current = start(mode);
    let result: SpawnSessionResult | undefined;
    void current.promise.then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(current.admission.readOutcome()).toBeNull();
    // The HTTP owner calls this void callback: it must ACK without waiting for runtime_bound.
    expect(current.pidToAwaiter.get(current.tracked.pid)?.(current.tracked)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeUndefined();
    expect(current.waiter.settle({ ...current.correlation, attemptId: 'other-attempt' }, { status: 'committed' })).toBe(false);
    current.waiter.settle(current.correlation, { status: 'committed' });
    await expect(current.promise).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
    expect(current.pidToSpawnWebhookTimeout.size).toBe(0);
  });

  it('uses the owning startup timeout after the ordinary webhook and revokes a reserved admission', async () => {
    vi.useFakeTimers();
    const current = start('persisted');
    current.pidToAwaiter.get(current.tracked.pid)?.(current.tracked);
    const reserved = current.waiter.reserveRuntimeBound(current.correlation);
    if (reserved.status !== 'reserved') throw new Error('Expected exact reservation');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(current.promise).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(current.admission.readOutcome()?.status).toBe('failed');
    expect(reserved.reservation.commit()).toBe(false);
    expect(current.pidToSpawnResultResolver.size).toBe(0);
  });

  it.each(['abort', 'child_exit'] as const)('settles admission and cleans startup on %s after the ordinary webhook', async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const current = start('external_linked', controller.signal);
    current.pidToAwaiter.get(current.tracked.pid)?.(current.tracked);
    if (reason === 'abort') controller.abort();
    else current.pidToSpawnResultResolver.get(current.tracked.pid)?.({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK, errorMessage: 'exited' });
    await expect(current.promise).resolves.toMatchObject({ type: 'error' });
    expect(current.admission.readOutcome()?.status).toBe('failed');
    expect(current.pidToSpawnWebhookTimeout.size).toBe(0);
    expect(current.pidToSpawnResultResolver.size).toBe(0);
    expect(current.waiter.reserveRuntimeBound(current.correlation).status).toBe('unavailable');
  });
  it('retains committed admission until the ordinary webhook completes', async () => {
    vi.useFakeTimers();
    const current = start('persisted');
    let result: SpawnSessionResult | undefined;
    void current.promise.then((value) => { result = value; });
    current.waiter.settle(current.correlation, { status: 'committed' });
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeUndefined();
    current.pidToAwaiter.get(current.tracked.pid)?.(current.tracked);
    await expect(current.promise).resolves.toMatchObject({ type: 'success' });
    current.admission.cancel();
    expect(current.admission.readOutcome()).toEqual({ status: 'committed' });
  });

  it('rejects an already-cancelled registration without waiting for the startup timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const current = start('persisted', controller.signal);
    await expect(current.promise).resolves.toMatchObject({ type: 'error' });
    expect(current.pidToSpawnWebhookTimeout.size).toBe(0);
    expect(current.waiter.getRegistration(current.correlation)).toBeNull();
  });

  it.each(['pending', 'timed_out'] as const)('keeps a replacement PID owner isolated from a %s admission callback', async (state) => {
    vi.useFakeTimers();
    const current = start('persisted');
    const lateCallback = current.pidToAwaiter.get(current.tracked.pid)!;
    lateCallback(current.tracked);
    if (state === 'timed_out') await vi.advanceTimersByTimeAsync(5 * 60_000);
    const replacement: TrackedSession = { pid: current.tracked.pid, startedBy: 'daemon', happySessionId: 'replacement' };
    current.pidToTrackedSession.set(replacement.pid, replacement);
    const replacementCallback = () => undefined;
    const replacementResolver = () => undefined;
    const replacementTimeout = setTimeout(() => undefined, 10_000);
    current.pidToAwaiter.set(replacement.pid, replacementCallback);
    current.pidToSpawnResultResolver.set(replacement.pid, replacementResolver);
    current.pidToSpawnWebhookTimeout.set(replacement.pid, replacementTimeout);
    current.waiter.settle(current.correlation, { status: 'committed' });
    lateCallback(current.tracked);
    await expect(current.promise).resolves.toMatchObject({ type: 'error' });
    expect(current.pidToAwaiter.get(replacement.pid)).toBe(replacementCallback);
    expect(current.pidToSpawnResultResolver.get(replacement.pid)).toBe(replacementResolver);
    expect(current.pidToSpawnWebhookTimeout.get(replacement.pid)).toBe(replacementTimeout);
    expect(replacement.spawnStartupReadinessFailure).toBeUndefined();
    expect(replacement.sessionWebhookTimedOutAtMs).toBeUndefined();
    clearTimeout(replacementTimeout);
  });

});
