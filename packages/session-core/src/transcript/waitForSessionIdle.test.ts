import { afterEach, expect, it, vi } from 'vitest';

import { waitForIdleObservation, type IdleSocketObserver } from './waitForSessionIdle.js';
import type { SessionTurnActivity } from './sessionTurnActivity.js';

afterEach(() => {
  vi.useRealTimers();
});

it('keeps reconnect catch-up when an unrelated Session metadata update follows turn completion', async () => {
  vi.useFakeTimers();
  const sessionId = 'session';
  const completed = { pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false, pendingInputCount: 0 };
  const activityRead = Promise.withResolvers<SessionTurnActivity>();
  const recheckTurnActivity = vi.fn(() => activityRead.promise);
  const readSnapshot = vi.fn(async () => ({
    projection: { latestTurnStatus: 'completed', pendingCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 },
    agentState: { requests: {} },
  }));
  const subscribed = Promise.withResolvers<Parameters<IdleSocketObserver>[0]>();
  const waiting = waitForIdleObservation({
    sessionId,
    timeoutMs: 1_000,
    initialTurnActivity: { pendingUserTurns: 1, activeTaskInFlight: true, turnInFlight: true, pendingInputCount: 1 },
    initialAgentState: { requests: {} },
    preferProjectionUpdates: true,
    observe: (handlers) => {
      subscribed.resolve(handlers);
      return { dispose: async () => {} };
    },
    recheckTurnActivity,
    readSnapshot,
    openAgentState: JSON.parse,
    openMessage: (content) => content,
  });
  const result = waiting.catch((error: unknown) => error instanceof Error ? error.message : error);
  const transport = await subscribed.promise;

  // The terminal fact was committed while this requester was disconnected.
  transport.onConnected();
  await transport.onUpdate({
    id: 'metadata', seq: 7, createdAt: Date.now(),
    body: { t: 'update-session', id: sessionId, metadata: { value: '{}', version: 2 } },
  });
  activityRead.resolve(completed);
  await vi.advanceTimersByTimeAsync(1_000);

  expect(await result).toMatchObject({ idle: true });
  expect(recheckTurnActivity).toHaveBeenCalledTimes(1);
  expect(readSnapshot).toHaveBeenCalledTimes(1);
});
