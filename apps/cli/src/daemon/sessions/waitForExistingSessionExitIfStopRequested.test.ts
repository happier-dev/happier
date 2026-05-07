import { describe, expect, it, vi } from 'vitest';

describe('waitForExistingSessionExitIfStopRequested', () => {
  it('does nothing when no tracked session has a stopRequestedAtMs marker for the session id', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const isSessionRunnerActive = vi.fn(async () => true);
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1' }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive,
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(isSessionRunnerActive).not.toHaveBeenCalled();
  });

  it('waits for the runner to exit when the session has an in-flight stop marker', async () => {
    vi.useFakeTimers();
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const activeStates = [true, true, false];
    const isSessionRunnerActive = vi.fn(async () => activeStates.shift() ?? false);
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    const promise = waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(isSessionRunnerActive).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('notifies the caller when a stopped tracked runner is no longer active', async () => {
    const { waitForExistingSessionExitIfStopRequested } = await import('./waitForExistingSessionExitIfStopRequested');

    const isSessionRunnerActive = vi.fn(async () => false);
    const onExitObserved = vi.fn();
    const pidToTrackedSession = new Map<number, any>([
      [1, { happySessionId: 'sess-1', stopRequestedAtMs: 123 }],
    ]);

    await waitForExistingSessionExitIfStopRequested({
      sessionId: 'sess-1',
      pidToTrackedSession,
      isSessionRunnerActive,
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
});
