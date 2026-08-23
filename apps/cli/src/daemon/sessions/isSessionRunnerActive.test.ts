import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '../types';
import { isSessionRunnerActive, probeSessionRunnerServiceability, resolveSessionRunnerResumeDecision } from './isSessionRunnerActive';

describe('probeSessionRunnerServiceability', () => {
  it('uses one decision owner for the servable-to-present-unservable transition', () => {
    expect(resolveSessionRunnerResumeDecision({ state: 'runner_present', control: { state: 'servable' } })).toEqual({ action: 'adopt' });
    expect(resolveSessionRunnerResumeDecision({
      state: 'runner_present', control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' },
    })).toEqual({ action: 'fence', reason: 'rpc_method_unavailable' });
    expect(resolveSessionRunnerResumeDecision({
      state: 'runner_present', control: { state: 'recoverable_unservable', reason: 'runtime_terminating' },
    })).toEqual({ action: 'wait_for_exit', reason: 'runtime_terminating' });
    expect(resolveSessionRunnerResumeDecision({ state: 'runner_absent' })).toEqual({ action: 'spawn' });
  });
  it('does not claim serviceability from a live matching PID alone', async () => {
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 456, happySessionId: 'sess_1' };
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
      probeCapability: async () => ({ state: 'recoverable_unservable', reason: 'rpc_method_unavailable' }),
    })).resolves.toEqual({ state: 'runner_present', control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' } });
  });

  it('reports serviceability only after the exact-session capability succeeds', async () => {
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 456, happySessionId: 'sess_1' };
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
      probeCapability: async () => ({ state: 'servable' }),
    })).resolves.toEqual({ state: 'runner_present', control: { state: 'servable' } });
  });

  it('preserves unknown as a duplicate-spawn fence', async () => {
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 456, happySessionId: 'sess_1' };
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
      probeCapability: async () => ({ state: 'unknown', reason: 'rpc_failed' }),
    })).resolves.toEqual({ state: 'runner_present', control: { state: 'unknown', reason: 'rpc_failed' } });
  });

  it('does not prove runner absence from a stopped process or unreadable runner lock', async () => {
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 456, happySessionId: 'sess_1' };
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [tracked],
      readProcessRunState: async () => 'stopped',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      getProcessCommandHash: async () => null,
      probeCapability: async () => ({ state: 'servable' }),
    })).resolves.toEqual({ state: 'runner_unknown', reason: 'runner_presence_unproven' });

    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'dead',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'io_error', errorMessage: 'read failed' }),
      getProcessCommandHash: async () => null,
      probeCapability: async () => ({ state: 'servable' }),
    })).resolves.toEqual({ state: 'runner_unknown', reason: 'runner_presence_unproven' });
  });

  it('proves runner absence when a live lock PID has been reused by another process instance', async () => {
    const probeCapability = vi.fn(async () => ({ state: 'servable' as const }));

    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: {
          sessionId: 'sess_1',
          pid: 123,
          acquiredAtMs: 1,
          processCommandHash: 'a'.repeat(64),
          processInstanceFingerprint: 'linux-proc:old',
        },
      }),
      getProcessCommandHash: async () => null,
      getProcessInstanceFingerprint: () => 'linux-proc:new',
      probeCapability,
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it('lets atomic lock acquisition replace a proven matching stopped lock holder', async () => {
    const probeCapability = vi.fn(async () => ({ state: 'servable' as const }));

    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'stopped',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: {
          sessionId: 'sess_1',
          pid: 123,
          acquiredAtMs: 1,
          processCommandHash: 'a'.repeat(64),
          processInstanceFingerprint: 'linux-proc:same',
        },
      }),
      getProcessCommandHash: async () => 'a'.repeat(64),
      getProcessInstanceFingerprint: () => 'linux-proc:same',
      probeCapability,
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probeCapability).not.toHaveBeenCalled();
  });
});

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

  it('treats a live lock PID as active when only its legacy command hash drifts', async () => {
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
    expect(res).toBe(true);
  });

  it('treats a live lock PID as inactive when the process-instance fingerprint proves reuse', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: {
          sessionId: 'sess_1',
          pid: 123,
          acquiredAtMs: 1,
          processCommandHash: 'a'.repeat(64),
          processInstanceFingerprint: 'linux-proc:old',
        },
      }),
      getProcessCommandHash: async () => 'b'.repeat(64),
      getProcessInstanceFingerprint: () => 'linux-proc:new',
    });
    expect(res).toBe(false);
  });

  it('treats a live lock PID as active when legacy classification no longer recognizes its command', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) },
      }),
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(true);
  });

  it('treats a live lock PID as active when process identity cannot be inspected', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) },
      }),
      getProcessCommandHash: async () => {
        throw new Error('process inspection failed');
      },
    });
    expect(res).toBe(true);
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

  it('treats a tracked session PID as active when only its legacy command hash drifts', async () => {
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
    expect(res).toBe(true);
  });

  it('treats a tracked session PID as active when legacy classification no longer recognizes its command', async () => {
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
      getProcessCommandHash: async () => null,
    });
    expect(res).toBe(true);
  });

  it('treats a tracked child-process PID as active when legacy classification no longer recognizes its command', async () => {
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 456,
      happySessionId: 'sess_1',
      processCommandHash: 'a'.repeat(64),
      // Boundary fixture: only `pid` is read from the ChildProcess handle in this path.
      childProcess: { pid: 456 } as TrackedSession['childProcess'],
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

  it('treats a tracked session PID as active when process identity cannot be inspected', async () => {
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
      getProcessCommandHash: async () => {
        throw new Error('process inspection failed');
      },
    });
    expect(res).toBe(true);
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
