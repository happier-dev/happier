import { describe, expect, it, vi } from 'vitest';
import type { ProcessRunState } from '../processRunState';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from './sessionTrackingKey';

describe('waitForExistingSessionExitIfStopRequested', () => {
  it('does nothing when no tracked session has a stopRequestedAtMs marker for the session id', async () => {

    const readRunState = vi.fn(async () => 'servable' as const);
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(1), { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, happySessionId: 'sess-1' }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      trackedSessionsByKey,
      readRunState,
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(readRunState).not.toHaveBeenCalled();
  });

  it('waits for the runner to exit when the session has an in-flight stop marker', async () => {
    vi.useFakeTimers();

    const runStates: ProcessRunState[] = ['servable', 'servable', 'dead'];
    const readRunState = vi.fn(async () => runStates.shift() ?? 'dead');
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(1), { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    const promise = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      trackedSessionsByKey,
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

    const readRunState = vi.fn(async () => 'dead' as const);
    const onExitObserved = vi.fn();
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(1), { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      trackedSessionsByKey,
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

  it('does not report stop completion until durable exit observation staging completes', async () => {

    let releaseStaging!: () => void;
    const staging = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    const onExitObserved = vi.fn(async () => {
      await staging;
    });
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(1), { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    let completed = false;
    const wait = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      trackedSessionsByKey,
      readRunState: async () => 'dead',
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      onExitObserved,
    }).then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(onExitObserved).toHaveBeenCalledOnce());
    expect(completed).toBe(false);

    releaseStaging();
    await wait;
    expect(completed).toBe(true);
  });
});
