import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '../types';
import { applyTrackedSessionTurnLifecycle } from './applyTrackedSessionTurnLifecycle';

function tracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 41,
    sessionRunnerPid: 42,
    startedBy: 'daemon',
    happySessionId: 'session-1',
    ...overrides,
  };
}

describe('applyTrackedSessionTurnLifecycle', () => {
  it('records one exact open turn and clears it only for the matching terminal event', async () => {
    const current = tracked();
    const updateSessionMarkerActiveTurn = vi.fn(async () => true);

    await expect(applyTrackedSessionTurnLifecycle({
      trackedSessions: [current],
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'session-turn:exact-1',
      updateSessionMarkerActiveTurn,
    })).resolves.toEqual({ status: 'recorded', activeTurnId: 'session-turn:exact-1' });
    expect(current.activeTurnId).toBe('session-turn:exact-1');
    expect(updateSessionMarkerActiveTurn).toHaveBeenLastCalledWith({
      pid: 42,
      sessionId: 'session-1',
      activeTurnId: 'session-turn:exact-1',
    });

    await expect(applyTrackedSessionTurnLifecycle({
      trackedSessions: [current],
      sessionId: 'session-1',
      event: 'assistant_message_end',
      turnId: 'session-turn:other',
      updateSessionMarkerActiveTurn,
    })).resolves.toEqual({ status: 'ignored_turn_mismatch', activeTurnId: 'session-turn:exact-1' });
    expect(current.activeTurnId).toBe('session-turn:exact-1');

    await expect(applyTrackedSessionTurnLifecycle({
      trackedSessions: [current],
      sessionId: 'session-1',
      event: 'assistant_message_end',
      turnId: 'session-turn:exact-1',
      updateSessionMarkerActiveTurn,
    })).resolves.toEqual({ status: 'recorded', activeTurnId: null });
    expect(current.activeTurnId).toBeUndefined();
  });

  it('fails closed for missing exact identity, ambiguous sessions, and marker failure', async () => {
    const current = tracked({ activeTurnId: 'session-turn:existing' });
    const duplicate = tracked({ pid: 43, sessionRunnerPid: 44, activeTurnId: 'session-turn:other' });
    const updateSessionMarkerActiveTurn = vi.fn(async () => false);

    await expect(applyTrackedSessionTurnLifecycle({
      trackedSessions: [current],
      sessionId: 'session-1',
      event: 'assistant_message_end',
      updateSessionMarkerActiveTurn,
    })).resolves.toEqual({ status: 'ignored_missing_exact_turn', activeTurnId: 'session-turn:existing' });
    await expect(applyTrackedSessionTurnLifecycle({
      trackedSessions: [current, duplicate],
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'session-turn:replacement',
      updateSessionMarkerActiveTurn,
    })).resolves.toEqual({ status: 'ignored_session_ambiguous', activeTurnId: null });
    await expect(applyTrackedSessionTurnLifecycle({
      trackedSessions: [current],
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'session-turn:replacement',
      updateSessionMarkerActiveTurn,
    })).resolves.toEqual({ status: 'ignored_marker_not_updated', activeTurnId: 'session-turn:existing' });
    expect(current.activeTurnId).toBe('session-turn:existing');
    expect(updateSessionMarkerActiveTurn).toHaveBeenCalledTimes(1);
  });
});
