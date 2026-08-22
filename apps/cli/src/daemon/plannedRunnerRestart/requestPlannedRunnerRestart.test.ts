import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceSwitchDeferralConflictError,
  createConnectedServiceSwitchDeferralQueue,
} from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import type { TrackedSession } from '../types';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';

function makeTracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    processCommandHash: 'hash-1',
    processStartTimeMs: 12_345,
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

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: 'hash-1',
      expectedProcessStartTimeMs: 12_345,
    });
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

  it('passes exact command and process birth identity to the final PID safety check', async () => {
    const tracked = makeTracked({
      processCommandHash: 'hash-1',
      processStartTimeMs: 12_345,
    });
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

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: 'hash-1',
      expectedProcessStartTimeMs: 12_345,
    });
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    expect(clearRestartIntentForPid).toHaveBeenCalledWith(tracked.pid, expect.stringContaining('stale'));
  });

  it.each([
    ['missing command hash', { processCommandHash: undefined, processStartTimeMs: 12_345 }],
    ['missing process birth', { processCommandHash: 'hash-1', processStartTimeMs: undefined }],
    ['non-finite process birth', { processCommandHash: 'hash-1', processStartTimeMs: Number.NaN }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TrackedSession>]>) (
    'does not reserve or enter the signal primitive with %s',
    async (_label, overrides) => {
      const tracked = makeTracked(overrides);
      const restartRequestedPids = new Set<number>();
      const requestSignal = vi.fn(async () => ({
        status: 'requested' as const,
      }));
      const isProcessSafeToSignal = vi.fn(async () => true);

      await expect(requestPlannedRunnerRestart({
        sessionId: 'sess-1',
        tracked,
        deferral: { kind: 'none' },
        restartRequestedPids,
        pidToTrackedSession: new Map([[tracked.pid, tracked]]),
        requestSignal,
        isProcessSafeToSignal,
      })).resolves.toEqual({
        signaled: false,
        notSignaledReason: 'unsafe_process',
      });

      expect(requestSignal).not.toHaveBeenCalled();
      expect(isProcessSafeToSignal).not.toHaveBeenCalled();
      expect(restartRequestedPids).toEqual(new Set());
    },
  );

  it('rechecks the request-start command and process birth witness before PID safety', async () => {
    const tracked = makeTracked({
      processCommandHash: 'hash-1',
      processStartTimeMs: 12_345,
    });
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async (input) => {
      tracked.processCommandHash = 'hash-replacement';
      tracked.processStartTimeMs = 12_346;
      const shouldSignal = await input.shouldSignal();
      return shouldSignal
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(requestSignal).toHaveBeenCalledOnce();
    expect(isProcessSafeToSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids).toEqual(new Set());
  });

  it('rechecks the tracked witness after a successful asynchronous signal gate', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => true);
    const canSignal = vi.fn(async () => {
      tracked.processCommandHash = 'hash-replacement';
      tracked.processStartTimeMs = 12_346;
      return true;
    });
    const requestSignal = vi.fn(async (input) => {
      const shouldSignal = await input.shouldSignal();
      return shouldSignal
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      canSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(canSignal).toHaveBeenCalledOnce();
    expect(isProcessSafeToSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids).toEqual(new Set());
  });

  it('repeats the live OS witness as the last check after a successful asynchronous signal gate', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const events: string[] = [];
    const isProcessSafeToSignal = vi.fn()
      .mockImplementationOnce(async () => {
        events.push('initial_os_witness');
        return true;
      })
      .mockImplementationOnce(async () => {
        events.push('final_os_witness');
        return false;
      });
    const canSignal = vi.fn(async () => {
      events.push('signal_gate');
      return true;
    });
    const requestSignal = vi.fn(async (input) => {
      const shouldSignal = await input.shouldSignal();
      events.push(shouldSignal ? 'signal' : 'blocked');
      return shouldSignal
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      canSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(events).toEqual([
      'initial_os_witness',
      'signal_gate',
      'final_os_witness',
      'blocked',
    ]);
    expect(restartRequestedPids).toEqual(new Set());
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
  it('reports an emitted restart signal as signaled even when the deferred completion event cannot be admitted', async () => {
    // POST-EFFECT SETTLEMENT (composition of the real deferral queue with the restart primitive):
    // the SIGTERM has already left the daemon. If the completion transcript event then fails to be
    // admitted, throwing here would tell the caller the restart never happened — and every caller
    // answers that by restoring pre-effect bindings and spawn options over a runner that is already
    // dying. The signal is irreversible, so the result must stay `signaled: true`.
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn(async () => ({ status: 'requested' as const }));
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent: async (_sessionId, event) => {
        if ((event as { type?: string }).type === 'connected_service_account_switch_deferral_completed') {
          throw new Error('transcript_admission_failed');
        }
      },
    });

    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const restart = requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: {
        kind: 'connected_service_switch',
        source: 'manual',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 },
        turnDeferralQueue,
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      isProcessSafeToSignal: async () => true,
    });

    await Promise.resolve();
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });

    await expect(restart).resolves.toEqual({ signaled: true });
    expect(requestSignal).toHaveBeenCalledTimes(1);
  });
});
