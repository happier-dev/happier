import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceSwitchDeferralConflictError,
  createConnectedServiceSwitchDeferralQueue,
} from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import type { TrackedSession } from '../types';
import { requestPlannedRunnerRestart, type RequestPlannedRunnerRestartParams } from './requestPlannedRunnerRestart';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';
import { createVersionRuntimeRefreshAttemptHandoff } from './versionRuntimeRefreshAttemptHandoff';
import { observePlannedRunnerRetirement, waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import type { PlannedRunnerRestartSignalRequest } from './types';
import { requestConnectedServiceSessionRestartSignal } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createSessionRunnerRestartAdmission, prepareSessionRunnerRestartAdmission } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { adoptTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import { isPidSafeHappySessionProcess } from '../pidSafety';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

function makeTracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    processCommandHash: 'hash-1',
    processStartTimeMs: 12_345,
    spawnOptions: { directory: '/repo', resume: 'vendor-1' },
    ...overrides,
  } as TrackedSession;
}

describe('requestPlannedRunnerRestart', () => {
  it.each(['direct', 'stable', 'reused child PID', 'replaced child', 'same PID conflicting birth'] as const)('revalidates executable custody and physical launcher custody at the signal boundary (%s)', async change => {
    const tracked = makeTracked();
    const runner = { pid: change === 'same PID conflicting birth' ? tracked.pid : 4343,
      processStartTimeMs: 20_000, processCommandHash: 'child-hash' };
    if (change !== 'direct') adoptTrackedSessionRunnerIdentity(tracked, runner);
    const reads: number[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let childBirth = runner.processStartTimeMs;
    try {
      const result = await requestPlannedRunnerRestart({ sessionId: 'sess-1', tracked,
        deferral: { kind: 'none' }, restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        isProcessSafeToSignal: params => isPidSafeHappySessionProcess(params, {
          readProcessIdentityByPidFn: async pid => { reads.push(pid); return { pid, command: 'fixture',
            processStartTimeMs: pid === tracked.pid ? tracked.processStartTimeMs : childBirth }; },
        }),
        canSignal: () => {
          if (change === 'reused child PID') childBirth++;
          if (change === 'replaced child') adoptTrackedSessionRunnerIdentity(tracked, { ...runner, pid: 4444 });
          return true;
        },
        requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
          shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure }),
      });
      expect(result).toEqual(change === 'stable' || change === 'direct' ? { signaled: true }
        : { signaled: false, notSignaledReason: 'runner_identity_changed' });
      if (change === 'stable' || change === 'direct') {
        expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
        // Two final-generation probes; a direct runner must never pay for a second identity.
        expect(reads).toEqual(change === 'direct' ? [4242, 4242] : [4242, 4343, 4242, 4343]);
      } else expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  it('does not signal when its live receiving hold is lost after readiness', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const connection = new AbortController();
    const tracked = makeTracked({ pid: process.pid });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(requestPlannedRunnerRestart({ sessionId: 'session', tracked, deferral: { kind: 'none' },
        restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        isProcessSafeToSignal: async () => true,
        prepareSignal: signal => prepareSessionRunnerRestartAdmission({ expectedPid: tracked.pid, signal,
          callRpc: (request, signal) => admission(request, AbortSignal.any([signal!, connection.signal])) }),
        canSignal: async () => { connection.abort(); await Promise.resolve(); return true; },
        requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
          shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure }),
      })).resolves.toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });
      expect(kill).not.toHaveBeenCalled();
    } finally { connection.abort(); kill.mockRestore(); }
  });
  it('reopens receiving creation admission when the final activity gate refuses the signal', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const tracked = makeTracked({ pid: process.pid });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(requestPlannedRunnerRestart({ sessionId: 'session', tracked, deferral: { kind: 'none' },
        restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        isProcessSafeToSignal: async () => true,
        prepareSignal: signal => prepareSessionRunnerRestartAdmission({ expectedPid: tracked.pid, signal,
          callRpc: (request, signal) => admission(request, signal) }),
        canSignal: () => 'turn_in_progress',
        requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
          shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure }),
      })).resolves.toEqual({ signaled: false, notSignaledReason: 'turn_in_progress' });
      expect(kill).not.toHaveBeenCalled();
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
    } finally { kill.mockRestore(); }
  });
  it('captures the retiring generation after child work settles and revalidates it before signaling', async () => {
    const tracked = makeTracked();
    const trackedByPid = new Map([[tracked.trackingKey, tracked]]);
    let childIdle = false;
    let capturedAfterIdle = false;
    let signaled = false;
    const result = await requestPlannedRunnerRestart({ sessionId: 'sess-1', tracked,
      deferral: { kind: 'none' }, restartRequestedSessions: new Set(), trackedSessionsByKey: trackedByPid,
      isProcessSafeToSignal: async () => true,
      canSignal: () => { childIdle = true; return true; },
      captureRunnerRemainder: async () => {
        capturedAfterIdle = childIdle;
        // Capture can suspend on the OS. A replaced runner cannot inherit the
        // previous generation's signal authority after it returns.
        trackedByPid.set(legacyPidSessionTrackingKey(tracked.pid), { ...tracked });
        return { scope: 'subtree', roots: [], ownership: [] };
      },
      requestSignal: async request => {
        signaled = await request.shouldSignal();
        return { status: signaled ? 'requested' : 'skipped_stale_owner' };
      },
    });
    expect(capturedAfterIdle).toBe(true);
    expect(signaled).toBe(false);
    expect(result).toMatchObject({ signaled: false, notSignaledReason: 'stale_owner' });
  });
  it('refuses native work that becomes active during remainder capture', async () => {
    const tracked = makeTracked();
    let nativeActive = false;
    let signaled = false;
    const result = await requestPlannedRunnerRestart({ sessionId: 'sess-1', tracked,
      deferral: { kind: 'none' }, restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      isProcessSafeToSignal: async () => true,
      canSignal: () => nativeActive ? 'turn_in_progress' : true,
      captureRunnerRemainder: async () => {
        nativeActive = true;
        return { scope: 'subtree', roots: [], ownership: [] };
      },
      requestSignal: async request => {
        signaled = await request.shouldSignal();
        return { status: signaled ? 'requested' : 'skipped_stale_owner' };
      },
    });
    expect(signaled).toBe(false);
    expect(result).toEqual({ signaled: false, notSignaledReason: 'turn_in_progress' });
  });
  it.each(['none', 'connected_service_switch'] as const)('does not signal after shutdown begins during the final process probe (%s)', async (kind) => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const handoff = createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({
      timeoutMs: 60_000, timeoutCompletion: { ok: false, status: 'partial_failure' },
      supersededCompletion: { ok: false, status: 'partial_failure' },
      cancelledCompletion: { ok: false, status: 'partial_failure' },
    });
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
    let shuttingDown = false;
    let probes = 0;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const queue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
    try {
      const request: RequestPlannedRunnerRestartParams = { sessionId: 'sess-1', tracked, restartRequestedSessions,
        completion: { hasPending: () => handoff.has('sess-1', tracked.pid),
          join: () => handoff.join(target), create: () => handoff.create(target) },
        trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        deferral: kind === 'none' ? { kind } : { kind, source: 'automatic' as const,
          policy: 'defer_until_turn_boundary' as const, target: { serviceId: 'svc', profileId: 'p', groupId: 'g', generation: 2 }, turnDeferralQueue: queue },
        isShuttingDown: () => shuttingDown,
        isProcessSafeToSignal: async () => { if (++probes === 2) shuttingDown = true; return true; },
        requestSignal: (input: PlannedRunnerRestartSignalRequest) => requestConnectedServiceSessionRestartSignal({
          pid: tracked.pid, delayMs: 0, shouldSignal: input.shouldSignal,
          onSignalFailure: input.onSignalFailure, onProcessAlreadyMissing: input.onProcessAlreadyMissing,
        }),
      };
      await expect(requestPlannedRunnerRestart(request)).resolves.toEqual({ signaled: false, notSignaledReason: 'shutting_down' });
      expect(kill).not.toHaveBeenCalled();
      expect(restartRequestedSessions.size).toBe(0);
      expect(handoff.hasPending()).toBe(false);
    } finally { kill.mockRestore(); await queue.cancelAll('daemon_shutdown'); }
  });

  it('reserves the tracked pid before signaling and leaves respawn reservation for requested signal', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async (input) => {
      expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(true);
      await expect(input.shouldSignal()).resolves.toBe(true);
      return { status: 'requested' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: true });

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: 'hash-1',
      expectedProcessStartTimeMs: 12_345,
    });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(true);
  });

  it('refuses an overlapping restart already reserved for the same tracked pid', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set([tracked.trackingKey]);
    const requestSignal = vi.fn();

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      requestSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });

    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedSessions).toEqual(new Set([tracked.trackingKey]));
  });

  it('clears reservation and reports no signal when ownership changes before signal', async () => {
    const tracked = makeTracked();
    const replacement = makeTracked({ pid: tracked.pid, happySessionId: 'sess-1' });
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const clearRestartIntent = vi.fn();
    const requestSignal = vi.fn(async (input) => {
      trackedSessionsByKey.set(legacyPidSessionTrackingKey(tracked.pid), replacement);
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      clearRestartIntent,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'stale_owner' });

    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(false);
    expect(clearRestartIntent).toHaveBeenCalledWith(tracked.trackingKey, expect.stringContaining('stale'));
  });

  it('passes exact command and process birth identity to the final PID safety check', async () => {
    const tracked = makeTracked({
      processCommandHash: 'hash-1',
      processStartTimeMs: 12_345,
    });
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const clearRestartIntent = vi.fn();
    const isProcessSafeToSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      clearRestartIntent,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: 'hash-1',
      expectedProcessStartTimeMs: 12_345,
    });
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(false);
    expect(clearRestartIntent).toHaveBeenCalledWith(tracked.trackingKey, expect.stringContaining('stale'));
  });

  it.each([
    ['missing process birth', { processCommandHash: 'hash-1', processStartTimeMs: undefined }],
    ['non-finite process birth', { processCommandHash: 'hash-1', processStartTimeMs: Number.NaN }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TrackedSession>]>) (
    'does not reserve or enter the signal primitive with %s',
    async (_label, overrides) => {
      const tracked = makeTracked(overrides);
      const restartRequestedSessions = new Set<SessionTrackingKey>();
      const requestSignal = vi.fn(async () => ({
        status: 'requested' as const,
      }));
      const isProcessSafeToSignal = vi.fn(async () => true);

      await expect(requestPlannedRunnerRestart({
        sessionId: 'sess-1',
        tracked,
        deferral: { kind: 'none' },
        restartRequestedSessions,
        trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        requestSignal,
        isProcessSafeToSignal,
      })).resolves.toEqual({
        signaled: false,
        notSignaledReason: 'unsafe_process',
      });

      expect(requestSignal).not.toHaveBeenCalled();
      expect(isProcessSafeToSignal).not.toHaveBeenCalled();
      expect(restartRequestedSessions).toEqual(new Set());
    },
  );

  it('admits a captured process birth without a command hash when the live identity verifies it', async () => {
    const tracked = makeTracked({ processCommandHash: undefined, processStartTimeMs: 12_345 });
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async ({ shouldSignal }: { shouldSignal: () => boolean | Promise<boolean> }) => ({
      status: await shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions: new Set<SessionTrackingKey>(),
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: true });
    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: '',
      expectedProcessStartTimeMs: 12_345,
    });
  });

  it('rechecks the request-start command and process birth witness before PID safety', async () => {
    const tracked = makeTracked({
      processCommandHash: 'hash-1',
      processStartTimeMs: 12_345,
    });
    const restartRequestedSessions = new Set<SessionTrackingKey>();
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
      restartRequestedSessions,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(requestSignal).toHaveBeenCalledOnce();
    expect(isProcessSafeToSignal).not.toHaveBeenCalled();
    expect(restartRequestedSessions).toEqual(new Set());
  });

  it('rechecks the tracked witness after a successful asynchronous signal gate', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
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
      restartRequestedSessions,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      requestSignal,
      canSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(canSignal).toHaveBeenCalledOnce();
    expect(isProcessSafeToSignal).toHaveBeenCalledOnce();
    expect(restartRequestedSessions).toEqual(new Set());
  });

  it('repeats the live OS witness as the last check after a successful asynchronous signal gate', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
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
      restartRequestedSessions,
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
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
    expect(restartRequestedSessions).toEqual(new Set());
  });

  it('clears reservation and reports no signal when activity starts before signal', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const canSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });

    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(false);
  });

  it('preserves exact disabled reason when activity gate blocks before signal', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const canSignal = vi.fn(async () => 'approval_pending' as const);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'approval_pending' });

    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(false);
  });

  it('observes an already-missing process once and keeps the forced-respawn reservation', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const observeProcessMissing = vi.fn();
    const requestSignal = vi.fn(async (input) => {
      input.onProcessAlreadyMissing();
      return { status: 'process_already_missing' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      observeProcessMissing,
    })).resolves.toEqual({ signaled: true });

    expect(observeProcessMissing).toHaveBeenCalledTimes(1);
    expect(observeProcessMissing).toHaveBeenCalledWith(tracked);
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(true);
  });

  it('returns no signal for superseded deferred switches', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
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
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'superseded' });

    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedSessions.size).toBe(0);
  });
  it('reports an emitted restart signal as signaled even when the deferred completion event cannot be admitted', async () => {
    // POST-EFFECT SETTLEMENT (composition of the real deferral queue with the restart primitive):
    // the SIGTERM has already left the daemon. If the completion transcript event then fails to be
    // admitted, throwing here would tell the caller the restart never happened — and every caller
    // answers that by restoring pre-effect bindings and spawn options over a runner that is already
    // dying. The signal is irreversible, so the result must stay `signaled: true`.
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const requestSignal = vi.fn(async () => ({ status: 'requested' as const }));
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
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
      restartRequestedSessions,
      trackedSessionsByKey,
      requestSignal,
      isProcessSafeToSignal: async () => true,
    });

    await Promise.resolve();
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });

    await expect(restart).resolves.toEqual({ signaled: true });
    expect(requestSignal).toHaveBeenCalledTimes(1);
  });
});


describe('requestPlannedRunnerRestart shared refresh completion', () => {
  it.each(['survived', 'observation_failed'] as const)('settles a deadline-free handoff when adopted retirement is %s', async outcome => {
    const tracked = makeTracked();
    const handoff = createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({ timeoutMs: null,
      timeoutCompletion: { ok: false, status: 'partial_failure' },
      supersededCompletion: { ok: false, status: 'partial_failure', diagnostics: { reason: 'superseded' } },
      cancelledCompletion: { ok: false, status: 'partial_failure', diagnostics: { reason: 'cancelled' } } });
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
    const failure = { ok: false, status: 'partial_failure', diagnostics: { respawnTerminalReason: 'runner_retirement_unobserved' } } as const;
    let observed = false;
    const request = requestPlannedRunnerRestart({ sessionId: 'sess-1', tracked, deferral: { kind: 'none' },
      restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      completion: { hasPending: () => handoff.hasPending(), join: () => handoff.join(target),
        create: () => { const attempt = handoff.create(target); return { ...attempt, retire: () => attempt.settle(failure) }; } },
      isProcessSafeToSignal: async () => true,
      requestSignal: async input => ({ status: await input.shouldSignal() ? 'requested' : 'skipped_stale_owner' }),
      observeRunnerRetirement: async () => {
        try {
          return await observePlannedRunnerRetirement({ tracked, timeoutMs: 0, pollIntervalMs: 0,
            readRunState: async () => { if (outcome === 'observation_failed') throw new Error('OS observation unavailable'); return 'servable'; } });
        } finally { observed = true; }
      },
    });
    try {
      await vi.waitFor(() => expect(observed).toBe(true));
      expect(handoff.hasPending()).toBe(false);
      await expect(request).resolves.toEqual({ signaled: true, completion: failure });
    } finally { handoff.settle('sess-1', tracked.pid, failure); await request; }
  });
  function makeHandoff() {
    return createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({
      timeoutMs: 60_000,
      timeoutCompletion: { ok: false, status: 'partial_failure' },
      supersededCompletion: { ok: false, status: 'partial_failure', diagnostics: { reason: 'superseded' } },
      cancelledCompletion: { ok: false, status: 'partial_failure', diagnostics: { reason: 'cancelled' } },
    });
  }

  it('keeps deferred child work outside the respawn completion budget and joins its eventual refresh', async () => {
    vi.useFakeTimers();
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    let releaseChild!: () => void;
    let childObserved = false;
    const childSettled = new Promise<void>(resolve => { releaseChild = resolve; });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
    const request: RequestPlannedRunnerRestartParams = {
      sessionId: 'sess-1', tracked, deferral: { kind: 'none' },
      restartRequestedSessions, trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      isProcessSafeToSignal: async () => true,
      completion: { hasPending: () => handoff.has('sess-1', tracked.pid),
        join: () => handoff.join(target), create: () => handoff.create(target) },
      canSignal: async signal => {
        childObserved = true;
        await Promise.race([childSettled, new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        })]);
        return !signal.aborted;
      },
      requestSignal: input => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
        shouldSignal: input.shouldSignal, onSignalFailure: input.onSignalFailure,
        onProcessAlreadyMissing: input.onProcessAlreadyMissing }),
    };
    let firstSettled = false;
    const first = requestPlannedRunnerRestart(request);
    void first.then(() => { firstSettled = true; });
    const replay = requestPlannedRunnerRestart(request);
    try {
      await vi.advanceTimersByTimeAsync(60_001);
      expect(childObserved).toBe(true);
      expect(firstSettled).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(handoff.hasPending()).toBe(true);
      releaseChild();
      await vi.advanceTimersByTimeAsync(0);
      expect(kill).toHaveBeenCalledWith(tracked.pid, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(firstSettled).toBe(false);
      const outcome = { ok: true, next: { pid: 4343 } } as const;
      handoff.settle('sess-1', tracked.pid, outcome);
      await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
      await expect(replay).resolves.toEqual({ signaled: true, completion: outcome });
    } finally {
      releaseChild();
      handoff.settle('sess-1', tracked.pid, { ok: true });
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('joins equivalent requests without replacing the original completion or signaling again', async () => {
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    let signaled = false;
    const requestSignal = vi.fn(async (input: PlannedRunnerRestartSignalRequest) => {
      signaled = await input.shouldSignal();
      return { status: signaled ? 'requested' as const : 'skipped_stale_owner' as const };
    });
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked, transientSpawnOptions: tracked.spawnOptions };
    const completion = {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join({ ...target, transientSpawnOptions: { ...tracked.spawnOptions! } }),
      create: () => handoff.create(target),
    };
    const request = {
      sessionId: 'sess-1', tracked, deferral: { kind: 'none' as const },
      restartRequestedSessions, trackedSessionsByKey, requestSignal,
      isProcessSafeToSignal: async () => true, completion,
    };
    const first = requestPlannedRunnerRestart(request);
    const replay = requestPlannedRunnerRestart(request);
    // Respawn completion follows the signal, not entry into its asynchronous gate.
    await vi.waitFor(() => expect(signaled).toBe(true));
    const outcome = { ok: true, next: { pid: 4343 } } as const;
    handoff.settle('sess-1', tracked.pid, outcome);

    await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
    await expect(replay).resolves.toEqual({ signaled: true, completion: outcome });
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(true);
  });

  it('keeps differing transient spawn targets busy without cancelling the accepted request', async () => {
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const requestSignal = vi.fn(async (input: PlannedRunnerRestartSignalRequest) => ({
      status: await input.shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    const originalTarget = { sessionId: 'sess-1', previousPid: tracked.pid, tracked, transientSpawnOptions: tracked.spawnOptions };
    const request = {
      sessionId: 'sess-1', tracked, deferral: { kind: 'none' as const },
      restartRequestedSessions, trackedSessionsByKey, requestSignal,
      isProcessSafeToSignal: async () => true,
    };
    const first = requestPlannedRunnerRestart({ ...request, completion: {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join(originalTarget),
      create: () => handoff.create(originalTarget),
    } });
    const differentTarget = { ...originalTarget, transientSpawnOptions: { ...tracked.spawnOptions!, resume: 'vendor-other' } };
    await expect(requestPlannedRunnerRestart({ ...request, completion: {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join(differentTarget),
      create: () => handoff.create(differentTarget),
    } })).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });
    expect(handoff.takeTransientSpawnOptions('sess-1', tracked.pid)).toEqual(tracked.spawnOptions);
    const outcome = { ok: true } as const;
    handoff.settle('sess-1', tracked.pid, outcome);
    await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(true);
  });

  it('retains the original completion and reservation when a deferred auth switch overlaps it', async () => {
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const requestSignal = vi.fn(async (input: PlannedRunnerRestartSignalRequest) => ({
      status: await input.shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
    const request = {
      sessionId: 'sess-1', tracked, restartRequestedSessions, trackedSessionsByKey, requestSignal,
      isProcessSafeToSignal: async () => true,
    };
    const first = requestPlannedRunnerRestart({ ...request, deferral: { kind: 'none' }, completion: {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join(target), create: () => handoff.create(target),
    } });
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const overlap = requestPlannedRunnerRestart({ ...request, deferral: {
      kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
      target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue,
    } });
    await Promise.resolve();
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(overlap).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });
    const outcome = { ok: true } as const;
    handoff.settle('sess-1', tracked.pid, outcome);
    await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
    expect(requestSignal).toHaveBeenCalledOnce();
    expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(true);
  });

  it('observes a slow adopted runner through physical exit for the refresh completion lifetime', async () => {
    vi.useFakeTimers();
    try {
      const tracked = makeTracked();
      const handoff = makeHandoff();
      const startedAtMs = Date.now();
      const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
      const result = requestPlannedRunnerRestart({
        sessionId: 'sess-1', tracked, deferral: { kind: 'none' },
        restartRequestedSessions: new Set<SessionTrackingKey>(), trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        isProcessSafeToSignal: async () => true,
        requestSignal: async (input) => ({
          status: await input.shouldSignal() ? 'requested' : 'skipped_stale_owner',
        }),
        completion: {
          hasPending: () => handoff.has('sess-1', tracked.pid),
          join: () => handoff.join(target),
          create: () => handoff.create(target),
        },
        observeRunnerRetirement: () => {
          // Process-state reading is the OS boundary; the physical-exit wait and handoff stay real.
          void waitForTrackedRunnerProcessesExit({
            runners: [{ pid: tracked.pid }], timeoutMs: 60_000, pollIntervalMs: 500,
            readRunState: async () => Date.now() - startedAtMs >= 45_000 ? 'dead' : 'servable',
            onExitObserved: () => handoff.settle('sess-1', tracked.pid, { ok: true, next: { pid: 4343 } }),
          });
        },
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(result).resolves.toEqual({ signaled: true, completion: { ok: true, next: { pid: 4343 } } });
    } finally {
      vi.useRealTimers();
    }
  });

});


describe('requestPlannedRunnerRestart selected deferral outcome', () => {
  it('reports the selected signal to same-target callers even when retirement precedes their continuation', async () => {
    const tracked = makeTracked();
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
    const requestSignal = vi.fn(async () => {
      // The real exit/respawn owner can retire the reservation before deferred callers resume.
      restartRequestedSessions.delete(tracked.trackingKey);
      return { status: 'requested' as const };
    });
    const request = {
      sessionId: 'sess-1', tracked, restartRequestedSessions, trackedSessionsByKey,
      isProcessSafeToSignal: async () => true, requestSignal,
      deferral: {
        kind: 'connected_service_switch' as const, source: 'manual' as const,
        policy: 'defer_until_turn_boundary' as const,
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue,
      },
    };
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const first = requestPlannedRunnerRestart(request);
    const replay = requestPlannedRunnerRestart(request);
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });

    await expect(first).resolves.toEqual({ signaled: true });
    await expect(replay).resolves.toEqual({ signaled: true });
    expect(requestSignal).toHaveBeenCalledOnce();
  });

  it('retains the selected signal when session_restarting arrives while its callback finishes', async () => {
    const tracked = makeTracked();
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
    const requestSignal = vi.fn(async () => {
      await turnDeferralQueue.cancelSession('sess-1', 'session_restarting');
      return { status: 'requested' as const };
    });
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const result = requestPlannedRunnerRestart({
      sessionId: 'sess-1', tracked, restartRequestedSessions: new Set<SessionTrackingKey>(),
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), requestSignal,
      isProcessSafeToSignal: async () => true,
      deferral: {
        kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue,
      },
    });
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(result).resolves.toEqual({ signaled: true });
  });
});


describe('requestPlannedRunnerRestart cancelled signal admission', () => {
  it.each(['delay', 'process_identity', 'activity'] as const)('does not signal after daemon shutdown cancels the switch during %s', async (boundary) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const tracked = makeTracked();
      const restartRequestedSessions = new Set<SessionTrackingKey>();
      const queue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
      const result = requestPlannedRunnerRestart({
        sessionId: 'sess-1', tracked, restartRequestedSessions,
        trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        deferral: { kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
          target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue: queue },
        isProcessSafeToSignal: async () => {
          if (boundary === 'process_identity') await held;
          return true;
        },
        canSignal: async () => {
          if (boundary === 'activity') await held;
          return true;
        },
        requestSignal: (input) => requestConnectedServiceSessionRestartSignal({
          pid: tracked.pid, delayMs: boundary === 'delay' ? 1_500 : 0,
          shouldSignal: input.shouldSignal, onSignalFailure: input.onSignalFailure,
          onProcessAlreadyMissing: input.onProcessAlreadyMissing,
        }),
      });
      const rejected = expect(result).rejects.toMatchObject({ code: 'daemon_shutdown' });
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
      await vi.advanceTimersByTimeAsync(1_000);
      await queue.cancelAll('daemon_shutdown');
      await rejected;
      expect(restartRequestedSessions.has(tracked.trackingKey)).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(500);
      expect(kill).not.toHaveBeenCalled();
      await queue.cancelAll('daemon_shutdown');
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('requestPlannedRunnerRestart for Sessions of one session host', () => {
  it('ends only the restarted Session through its host handle and keeps restart custody per Session', async () => {
    const hostPid = 4242;
    const hosted = (key: string, sessionId: string) => {
      const end = vi.fn(async () => true);
      const tracked = makeTracked({ trackingKey: key as TrackedSession['trackingKey'], happySessionId: sessionId,
        hostedSession: { end, observed: new Promise<void>(() => {}) } });
      return { tracked, end };
    };
    const a = hosted('session-a', 'sess-a');
    const b = hosted('session-b', 'sess-b');
    const trackedSessionsByKey = new Map([[a.tracked.trackingKey, a.tracked], [b.tracked.trackingKey, b.tracked]]);
    const reservations = new Set<SessionTrackingKey>();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const restart = (tracked: TrackedSession) => requestPlannedRunnerRestart({
      sessionId: tracked.happySessionId!, tracked, deferral: { kind: 'none' },
      restartRequestedSessions: reservations, trackedSessionsByKey,
      isProcessSafeToSignal: async () => true,
      requestSignal: request => requestConnectedServiceSessionRestartSignal({
        pid: request.tracked.pid, delayMs: 0, preferProcessGroup: true, hostedSession: request.tracked.hostedSession,
        shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure,
        onProcessAlreadyMissing: request.onProcessAlreadyMissing,
      }),
    });
    try {
      expect(a.tracked.pid).toBe(hostPid);
      await expect(restart(a.tracked)).resolves.toEqual({ signaled: true });
      expect(a.end).toHaveBeenCalledTimes(1);
      expect(b.end).not.toHaveBeenCalled();
      // A's retained restart custody (held until its respawn settles) is not B's.
      await expect(restart(b.tracked)).resolves.toEqual({ signaled: true });
      expect(b.end).toHaveBeenCalledTimes(1);
      expect(a.end).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
});
