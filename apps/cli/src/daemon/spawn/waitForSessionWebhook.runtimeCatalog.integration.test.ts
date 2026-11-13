import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout } from 'node:timers';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { createPersistedTakeoverAdmissionWaiter } from './persistedTakeoverAdmission';

import { armSessionWebhookStartupCustody, waitForSessionWebhook } from './waitForSessionWebhook';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('waitForSessionWebhook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves the observed child exit cause when startup custody settles before the webhook', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(745525), pid: 745525, startedBy: 'daemon', happySessionId: 'PID-745525' };
    const completion = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(tracked.pid), pid: tracked.pid, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
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
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(42), pid: 42,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'timeout',
    });

    const resolver = spawnAwaiterByKey.get(legacyPidSessionTrackingKey(42));
    expect(typeof resolver).toBe('function');
    resolver?.({ happySessionId: 'session-1' });

    await expect(promise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(42))).toBe(false);
    expect(spawnResultResolverByKey.has(legacyPidSessionTrackingKey(42))).toBe(false);
    expect(spawnWebhookTimeoutByKey.has(legacyPidSessionTrackingKey(42))).toBe(false);
  });

  it('does not acknowledge the webhook until async startup finalization completes', async () => {
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    let finishFinalization!: () => void;
    const finalization = new Promise<void>((resolve) => {
      finishFinalization = resolve;
    });

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(44), pid: 44,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'timeout',
      onSuccess: async () => {
        await finalization;
      },
    });

    const resolver = spawnAwaiterByKey.get(legacyPidSessionTrackingKey(44));
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
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(43), pid: 43,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'timeout',
    });

    spawnAwaiterByKey.get(legacyPidSessionTrackingKey(43))?.({
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

    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(77), pid: 77,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 77',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 77',
    });
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(77))).toBe(false);
    expect(spawnResultResolverByKey.has(legacyPidSessionTrackingKey(77))).toBe(false);
    expect(spawnWebhookTimeoutByKey.has(legacyPidSessionTrackingKey(77))).toBe(false);
  });

  it('marks the tracked session timed out when no canonical session id exists at timeout', async () => {
    vi.useFakeTimers();

    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(78), { trackingKey: legacyPidSessionTrackingKey(78), pid: 78, startedBy: 'daemon', happySessionId: 'PID-78' }],
    ]);

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(78), pid: 78,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      trackedSessionsByKey,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 78',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 78',
    });
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(78))?.sessionWebhookTimedOutAtMs).toEqual(expect.any(Number));
  });

  it('marks the exact startup owner timed out without retaining PID expiry timers', async () => {
    vi.useFakeTimers();

    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(79), { trackingKey: legacyPidSessionTrackingKey(79), pid: 79, startedBy: 'daemon', happySessionId: 'session-79' }],
    ]);

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(79), pid: 79,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      trackedSessionsByKey,
      timeoutMs: 1000,
      timeoutErrorMessage: 'Session webhook timeout for PID 79',
    });

    vi.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 79',
    });
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(79))?.sessionWebhookTimedOutAtMs).toEqual(expect.any(Number));
    expect(spawnAwaiterByKey.size).toBe(0);
    expect(spawnResultResolverByKey.size).toBe(0);
    expect(spawnWebhookTimeoutByKey.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out the exact promoted runner while retaining original waiter-map ownership', async () => {
    vi.useFakeTimers();
    const wrapperPid = 81;
    const runnerPid = 82;
    const originalTracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: `PID-${wrapperPid}`,
    };
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(wrapperPid), originalTracked],
    ]);
    const onTimeout = vi.fn();
    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      trackedSessionsByKey,
      timeoutMs: 25,
      timeoutErrorMessage: `Session webhook timeout for PID ${wrapperPid}`,
      onTimeout,
    });
    // Promotion rewrites the Session's pid in place; it stays keyed by its own tracking key.
    Object.assign(originalTracked, {
      pid: runnerPid,
      happySessionId: `PID-${runnerPid}`,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    expect(originalTracked.sessionWebhookTimedOutAtMs)
      .toEqual(expect.any(Number));
    expect(onTimeout).toHaveBeenCalledWith(originalTracked);
    expect(spawnAwaiterByKey).toHaveLength(0);
    expect(spawnResultResolverByKey).toHaveLength(0);
    expect(spawnWebhookTimeoutByKey).toHaveLength(0);
  });

  it('marks a reported runner owner timed out before wrapper-to-runner promotion completes', async () => {
    vi.useFakeTimers();
    const wrapperPid = 83;
    const runnerPid = 84;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      sessionRunnerPid: runnerPid,
      startedBy: 'daemon',
      happySessionId: `PID-${runnerPid}`,
    };
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey =
      new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey =
      new Map<number, NodeJS.Timeout>();
    const trackedSessionsByKey =
      new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      trackedSessionsByKey,
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
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(wrapperPid))).toBe(tracked);
  });

  it('does not delete or time out same-PID replacement custody when a superseded request timer fires', async () => {
    vi.useFakeTimers();
    const pid = 80;
    const originalTracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: `PID-${pid}` };
    const replacementTracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: `PID-${pid}` };
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), originalTracked]]);
    const onTimeout = vi.fn();

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      trackedSessionsByKey,
      timeoutMs: 25,
      timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
      onTimeout,
    });
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeoutCallback = vi.fn();
    const replacementTimeout = setTimeout(replacementTimeoutCallback, 1_000);
    trackedSessionsByKey.set(legacyPidSessionTrackingKey(pid), replacementTracked);
    spawnAwaiterByKey.set(legacyPidSessionTrackingKey(pid), replacementAwaiter);
    spawnResultResolverByKey.set(legacyPidSessionTrackingKey(pid), replacementResolver);
    spawnWebhookTimeoutByKey.set(legacyPidSessionTrackingKey(pid), replacementTimeout);

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: `Session webhook timeout for PID ${pid}`,
    });
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementTracked);
    expect(spawnAwaiterByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementAwaiter);
    expect(spawnResultResolverByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementResolver);
    expect(spawnWebhookTimeoutByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementTimeout);
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
      const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
      const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
      const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

      const promise = waitForSessionWebhook({
        trackingKey: legacyPidSessionTrackingKey(88), pid: 88,
        spawnAwaiterByKey,
        spawnResultResolverByKey,
        spawnWebhookTimeoutByKey,
        timeoutErrorMessage: 'Session webhook timeout for PID 88',
      });

      await vi.advanceTimersByTimeAsync(65_000);

      const resolver = spawnAwaiterByKey.get(legacyPidSessionTrackingKey(88));
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
      const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
      const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
      const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

      const promise = waitForSessionWebhook({
        trackingKey: legacyPidSessionTrackingKey(99), pid: 99,
        spawnAwaiterByKey,
        spawnResultResolverByKey,
        spawnWebhookTimeoutByKey,
        timeoutErrorMessage: 'Session webhook timeout for PID 99',
      });

      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(100_000);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(99))).toBe(true);
      expect(spawnResultResolverByKey.has(legacyPidSessionTrackingKey(99))).toBe(true);
      expect(spawnWebhookTimeoutByKey.has(legacyPidSessionTrackingKey(99))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
      else process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = previous;
    }
  });

  it('fails closed when webhook success is missing happySessionId', async () => {
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(91), pid: 91,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'timeout',
    });

    const resolver = spawnAwaiterByKey.get(legacyPidSessionTrackingKey(91));
    expect(typeof resolver).toBe('function');
    resolver?.({});

    await expect(promise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'Session webhook did not include a sessionId (pid=91)',
    });
  });

  it('continues waiting for webhook proof before resolving success', async () => {
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: any) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: any) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();

    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(5150), pid: 5150,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'timeout',
    });

    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(5150))).toBe(true);
    expect(spawnResultResolverByKey.has(legacyPidSessionTrackingKey(5150))).toBe(true);
    expect(spawnWebhookTimeoutByKey.has(legacyPidSessionTrackingKey(5150))).toBe(true);

    spawnAwaiterByKey.get(legacyPidSessionTrackingKey(5150))?.({ happySessionId: 'session-ready-5150' });

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
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(4201), pid: 4201, startedBy: 'daemon', happySessionId: 'session-1' };
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const promise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(tracked.pid), pid: tracked.pid,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      trackedSessionsByKey,
      takeoverAdmission: admission,
      timeoutErrorMessage: 'startup timed out',
    });
    return { waiter, correlation, admission, tracked, promise, spawnAwaiterByKey, spawnResultResolverByKey, spawnWebhookTimeoutByKey, trackedSessionsByKey };
  }

  it.each(['persisted', 'external_linked'] as const)('keeps %s pending beyond 30 seconds and ACKs the ordinary webhook before runtime binding', async (mode) => {
    vi.useFakeTimers();
    const current = start(mode);
    let result: SpawnSessionResult | undefined;
    void current.promise.then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(current.admission.readOutcome()).toBeNull();
    // The HTTP owner calls this void callback: it must ACK without waiting for runtime_bound.
    expect(current.spawnAwaiterByKey.get(legacyPidSessionTrackingKey(current.tracked.pid))?.(current.tracked)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeUndefined();
    expect(current.waiter.settle({ ...current.correlation, attemptId: 'other-attempt' }, { status: 'committed' })).toBe(false);
    current.waiter.settle(current.correlation, { status: 'committed' });
    await expect(current.promise).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
    expect(current.spawnWebhookTimeoutByKey.size).toBe(0);
  });

  it('uses the owning startup timeout after the ordinary webhook and revokes a reserved admission', async () => {
    vi.useFakeTimers();
    const current = start('persisted');
    current.spawnAwaiterByKey.get(legacyPidSessionTrackingKey(current.tracked.pid))?.(current.tracked);
    const reserved = current.waiter.reserveRuntimeBound(current.correlation);
    if (reserved.status !== 'reserved') throw new Error('Expected exact reservation');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(current.promise).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT });
    expect(current.admission.readOutcome()?.status).toBe('failed');
    expect(reserved.reservation.commit()).toBe(false);
    expect(current.spawnResultResolverByKey.size).toBe(0);
  });

  it.each(['abort', 'child_exit'] as const)('settles admission and cleans startup on %s after the ordinary webhook', async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const current = start('external_linked', controller.signal);
    current.spawnAwaiterByKey.get(legacyPidSessionTrackingKey(current.tracked.pid))?.(current.tracked);
    if (reason === 'abort') controller.abort();
    else current.spawnResultResolverByKey.get(legacyPidSessionTrackingKey(current.tracked.pid))?.({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK, errorMessage: 'exited' });
    await expect(current.promise).resolves.toMatchObject({ type: 'error' });
    expect(current.admission.readOutcome()?.status).toBe('failed');
    expect(current.spawnWebhookTimeoutByKey.size).toBe(0);
    expect(current.spawnResultResolverByKey.size).toBe(0);
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
    current.spawnAwaiterByKey.get(legacyPidSessionTrackingKey(current.tracked.pid))?.(current.tracked);
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
    expect(current.spawnWebhookTimeoutByKey.size).toBe(0);
    expect(current.waiter.getRegistration(current.correlation)).toBeNull();
  });

  it.each(['pending', 'timed_out'] as const)('keeps a replacement PID owner isolated from a %s admission callback', async (state) => {
    vi.useFakeTimers();
    const current = start('persisted');
    const lateCallback = current.spawnAwaiterByKey.get(legacyPidSessionTrackingKey(current.tracked.pid))!;
    lateCallback(current.tracked);
    if (state === 'timed_out') await vi.advanceTimersByTimeAsync(5 * 60_000);
    const replacement: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(current.tracked.pid), pid: current.tracked.pid, startedBy: 'daemon', happySessionId: 'replacement' };
    current.trackedSessionsByKey.set(replacement.trackingKey, replacement);
    const replacementCallback = () => undefined;
    const replacementResolver = () => undefined;
    const replacementTimeout = setTimeout(() => undefined, 10_000);
    current.spawnAwaiterByKey.set(legacyPidSessionTrackingKey(replacement.pid), replacementCallback);
    current.spawnResultResolverByKey.set(legacyPidSessionTrackingKey(replacement.pid), replacementResolver);
    current.spawnWebhookTimeoutByKey.set(legacyPidSessionTrackingKey(replacement.pid), replacementTimeout);
    current.waiter.settle(current.correlation, { status: 'committed' });
    lateCallback(current.tracked);
    await expect(current.promise).resolves.toMatchObject({ type: 'error' });
    expect(current.spawnAwaiterByKey.get(legacyPidSessionTrackingKey(replacement.pid))).toBe(replacementCallback);
    expect(current.spawnResultResolverByKey.get(legacyPidSessionTrackingKey(replacement.pid))).toBe(replacementResolver);
    expect(current.spawnWebhookTimeoutByKey.get(legacyPidSessionTrackingKey(replacement.pid))).toBe(replacementTimeout);
    expect(replacement.spawnStartupReadinessFailure).toBeUndefined();
    expect(replacement.sessionWebhookTimedOutAtMs).toBeUndefined();
    clearTimeout(replacementTimeout);
  });

});
