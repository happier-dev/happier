import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '../types';
import { isSessionRunnerActive, probeSessionRunnerPresence, probeSessionRunnerServiceability, resolveSessionRunnerResumeDecision } from './isSessionRunnerActive';

describe('probeSessionRunnerServiceability', () => {
  it('waits for a live runner whose exact controls fail during resume', () => {
    expect(resolveSessionRunnerResumeDecision({
      state: 'runner_present',
      control: { state: 'unknown', reason: 'rpc_failed' },
    })).toEqual({ action: 'wait_for_exit', reason: 'rpc_failed' });
    expect(resolveSessionRunnerResumeDecision({
      state: 'runner_present',
      control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' },
    })).toEqual({ action: 'wait_for_exit', reason: 'rpc_method_unavailable' });
  });

  it('retains live process presence when exact-session controls are unservable', async () => {
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 456, happySessionId: 'sess_1' };
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1', trackedSessions: [tracked],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      probeCapability: async () => ({ state: 'recoverable_unservable', reason: 'rpc_method_unavailable' }),
    })).resolves.toEqual({ state: 'runner_present', control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' } });
  });

  it('does not prove runner absence from a stopped process or unreadable runner lock', async () => {
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 456, happySessionId: 'sess_1' };
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1', trackedSessions: [tracked],
      readProcessRunState: async () => 'stopped',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      probeCapability: async () => ({ state: 'servable' }),
    })).resolves.toEqual({ state: 'runner_unknown', reason: 'runner_presence_unproven' });

    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1', trackedSessions: [],
      readProcessRunState: async () => 'dead',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'io_error', errorMessage: 'read failed' }),
      probeCapability: async () => ({ state: 'servable' }),
    })).resolves.toEqual({ state: 'runner_unknown', reason: 'runner_presence_unproven' });
  });

  it('proves runner absence when a live lock PID belongs to a newer process generation', async () => {
    const probeCapability = vi.fn(async () => ({ state: 'servable' as const }));
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: {
        sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processStartTimeMs: 1_000,
      } }),
      readProcessIdentityByPid: async (pid) => ({ pid, processStartTimeMs: 2_000, command: 'other' }),
      probeCapability,
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it('lets atomic acquisition replace a stopped lock with a matching process generation', async () => {
    const probeCapability = vi.fn(async () => ({ state: 'servable' as const }));
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'stopped',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: {
        sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processStartTimeMs: 1_000,
      } }),
      readProcessIdentityByPid: async (pid) => ({ pid, processStartTimeMs: 1_000, command: 'runner' }),
      probeCapability,
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it('accepts predecessor fingerprint evidence when it proves a live lock PID was reused', async () => {
    const probeCapability = vi.fn(async () => ({ state: 'servable' as const }));
    await expect(probeSessionRunnerServiceability({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: {
        sessionId: 'sess_1',
        pid: 123,
        acquiredAtMs: 1,
        processCommandHash: 'a'.repeat(64),
        processInstanceFingerprint: 'darwin-ps:old',
      } }),
      readProcessIdentityByPid: async (pid) => ({ pid, processStartTimeMs: 2_000, command: 'other' }),
      readProcessInstanceFingerprint: (_pid, expectedFingerprint) =>
        expectedFingerprint === 'darwin-ps:old' ? 'darwin-ps:new' : null,
      probeCapability,
    })).resolves.toEqual({ state: 'runner_absent' });
    expect(probeCapability).not.toHaveBeenCalled();
  });
});

describe('isSessionRunnerActive', () => {
  it.each(['state', 'identity'] as const)('fences a newer runner report received during the OS %s read', async (read) => {
    const tracked: TrackedSession = {
      pid: 456, sessionRunnerPid: 457, startedBy: 'daemon', happySessionId: 'sess-overlap',
      runnerProcessIdentity: { pid: 457, processStartTimeMs: 2000, processCommandHash: 'a'.repeat(64) },
    };
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let started = false;
    const pending = probeSessionRunnerPresence({
      sessionId: 'sess-overlap', trackedSessions: [tracked],
      readProcessRunState: async () => {
        if (read === 'state') { started = true; await gate; return 'dead'; }
        return 'servable';
      },
      readProcessIdentityByPid: async (pid) => {
        started = true; await gate;
        return { pid, processStartTimeMs: 3000, command: 'replacement' };
      },
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
    });
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      tracked.sessionRunnerPid = 458;
      releaseRead();
      await expect(pending).resolves.toEqual({ state: 'runner_unknown', reason: 'runner_presence_unproven' });
    } finally { releaseRead(); await pending; }
  });

  it.each(['unpaired', 'previous_runner', 'present', 'reused', 'unreadable'] as const)('keeps reported runner evidence separate from its dead wrapper (%s)', async (evidence) => {
    const wrapperPid = 456;
    const runnerPid = 457;
    const tracked: TrackedSession = {
      pid: wrapperPid, sessionRunnerPid: runnerPid, startedBy: 'daemon', happySessionId: 'sess-wrapper',
      processStartTimeMs: 1000,
      ...(evidence === 'unpaired' ? {} : {
        runnerProcessIdentity: { pid: evidence === 'previous_runner' ? 458 : runnerPid, processStartTimeMs: 2000, processCommandHash: 'a'.repeat(64) },
      }),
    };
    const result = await probeSessionRunnerPresence({
      sessionId: 'sess-wrapper', trackedSessions: [tracked],
      readProcessRunState: async (pid) => {
        if (evidence === 'unreadable') throw new Error('OS process state unavailable');
        return pid === wrapperPid ? 'dead' : 'servable';
      },
      readProcessIdentityByPid: async (pid) => evidence === 'unreadable' ? null : {
        pid, processStartTimeMs: evidence === 'reused' ? 3000 : 2000, command: 'runner',
      },
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
    });
    expect(result).toEqual(evidence === 'present'
      ? { state: 'runner_present' }
      : evidence === 'reused'
        ? { state: 'runner_absent' }
        : { state: 'runner_unknown', reason: 'runner_presence_unproven' });
  });

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
    });
    expect(res).toBe(true);
  });

  it('does not treat command drift as PID reuse for a legacy live lock', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({
        ok: true,
        lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processCommandHash: 'a'.repeat(64) },
      }),
    });
    expect(res).toBe(true);
  });

  it('treats a live lock PID as inactive when process generation proves PID reuse', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1', trackedSessions: [],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: {
        sessionId: 'sess_1', pid: 123, acquiredAtMs: 1, processStartTimeMs: 1_000,
      } }),
      readProcessIdentityByPid: async (pid) => ({ pid, processStartTimeMs: 2_000, command: 'other' }),
    });
    expect(res).toBe(false);
  });

  it('treats a dead lock PID as inactive', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'dead',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
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
    });
    expect(res).toBe(false);
  });

  it('treats a ZOMBIE lock PID as inactive', async () => {
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1',
      trackedSessions: [],
      readProcessRunState: async () => 'zombie',
      readSessionRunnerLockStatus: async () => ({ ok: true, lock: { sessionId: 'sess_1', pid: 123, acquiredAtMs: 1 } }),
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
    });
    expect(res).toBe(true);
  });

  it('does not treat command drift as PID reuse for a legacy tracked session', async () => {
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
    });
    expect(res).toBe(true);
  });

  it('treats a tracked session PID as inactive when process generation proves PID reuse', async () => {
    const tracked: TrackedSession = {
      startedBy: 'daemon', pid: 456, happySessionId: 'sess_1', processStartTimeMs: 1_000,
    };
    const res = await isSessionRunnerActive({
      sessionId: 'sess_1', trackedSessions: [tracked],
      readProcessRunState: async () => 'servable',
      readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
      readProcessIdentityByPid: async (pid) => ({ pid, processStartTimeMs: 2_000, command: 'other' }),
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
    });
    expect(res).toBe(false);
  });
});
