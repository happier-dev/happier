import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceSwitchDeferralConflictError } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import type { TrackedSession } from '../types';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';

function makeTracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    spawnOptions: { directory: '/repo', resume: 'vendor-1' },
    ...overrides,
  } as TrackedSession;
}

describe('requestPlannedRunnerRestart', () => {
  it('reserves the tracked pid before signaling and leaves respawn reservation for requested signal', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async (input) => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(true);
      await expect(input.shouldSignal()).resolves.toBe(true);
      return { status: 'requested' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: true });

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({ pid: tracked.pid });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('refuses an overlapping restart already reserved for the same tracked pid', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>([tracked.pid]);
    const requestSignal = vi.fn();

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });

    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids).toEqual(new Set([tracked.pid]));
  });

  it('clears reservation and reports no signal when ownership changes before signal', async () => {
    const tracked = makeTracked();
    const replacement = makeTracked({ pid: tracked.pid, happySessionId: 'sess-1' });
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const clearRestartIntentForPid = vi.fn();
    const requestSignal = vi.fn(async (input) => {
      pidToTrackedSession.set(tracked.pid, replacement);
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      clearRestartIntentForPid,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'stale_owner' });

    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    expect(clearRestartIntentForPid).toHaveBeenCalledWith(tracked.pid, expect.stringContaining('stale'));
  });

  it('clears reservation and reports unsafe process when PID safety check fails', async () => {
    const tracked = makeTracked({ processCommandHash: 'hash-1' });
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const clearRestartIntentForPid = vi.fn();
    const isProcessSafeToSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      clearRestartIntentForPid,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({ pid: tracked.pid, expectedProcessCommandHash: 'hash-1' });
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    expect(clearRestartIntentForPid).toHaveBeenCalledWith(tracked.pid, expect.stringContaining('stale'));
  });

  it('clears reservation and reports no signal when activity starts before signal', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const canSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });

    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('preserves exact disabled reason when activity gate blocks before signal', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const canSignal = vi.fn(async () => 'approval_pending' as const);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'approval_pending' });

    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('observes an already-missing process once and keeps the forced-respawn reservation', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const observeProcessMissing = vi.fn();
    const requestSignal = vi.fn(async (input) => {
      input.onProcessAlreadyMissing();
      return { status: 'process_already_missing' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      observeProcessMissing,
    })).resolves.toEqual({ signaled: true });

    expect(observeProcessMissing).toHaveBeenCalledTimes(1);
    expect(observeProcessMissing).toHaveBeenCalledWith(tracked);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('returns no signal for superseded deferred switches', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn();

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: {
        kind: 'connected_service_switch',
        source: 'manual',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 },
        turnDeferralQueue: {
          requestSwitch: async () => {
            throw new ConnectedServiceSwitchDeferralConflictError({
              code: 'switch_cancelled',
              message: 'superseded',
            });
          },
        },
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'superseded' });

    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });
});
