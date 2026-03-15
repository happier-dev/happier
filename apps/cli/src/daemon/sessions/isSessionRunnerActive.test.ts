import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '../types';
import { isSessionRunnerActive } from './isSessionRunnerActive';

describe('isSessionRunnerActive', () => {
  it('returns false for empty session id', async () => {
    const res = await isSessionRunnerActive({ sessionId: '   ', trackedSessions: [] });
    expect(res).toBe(false);
  });

  it('treats a live lock PID as active (fail-closed)', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      isPidAlive: () => true,
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(true);
  });

  it('treats a dead lock PID as inactive', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      isPidAlive: () => false,
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(false);
  });

  it('treats a tracked session PID as active when it matches the session id', async () => {
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 456,
      happySessionId: 'sess_1',
    };
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      isPidAlive: () => true,
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(true);
  });
});

