import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '../types';
import { isSessionRunnerActive } from './isSessionRunnerActive';

describe('isSessionRunnerActive', () => {
  it('returns false for empty session id', async () => {
    const res = await isSessionRunnerActive({ sessionId: '   ', trackedSessions: [] });
    expect(res).toBe(false);
  });

  it('treats a servable lock PID as active (fail-closed)', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(true);
  });

  it('treats a live lock PID as inactive when command hash mismatch proves PID reuse', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) },
      }),
      getProcessCommandHash: async () => 'b'.repeat(64),
    });
    expect(res).toBe(false);
  });

  it('treats a dead lock PID as inactive', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'dead',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(false);
  });

  it('treats a STOPPED (SIGSTOP-wedged) lock PID as inactive so a resume can respawn', async () => {
    // Incident class 2026-06-12 06:01: "already running" refusal while the runner cannot serve.
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'stopped',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(false);
  });

  it('treats a ZOMBIE lock PID as inactive', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'zombie',
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
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(true);
  });

  it('treats a tracked session PID as inactive when command hash mismatch proves PID reuse', async () => {
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 456,
      happySessionId: 'sess_1',
      processCommandHash: 'a'.repeat(64),
    };
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => 'b'.repeat(64),
    });
    expect(res).toBe(false);
  });

  it('treats a STOPPED tracked session PID as inactive even with a live child handle', async () => {
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 456,
      happySessionId: 'sess_1',
      // Boundary fixture: only `pid` is read from the ChildProcess handle in this path.
      childProcess: { pid: 456 } as TrackedSession['childProcess'],
    };
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      readProcessRunState: async () => 'stopped',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(false);
  });
});
