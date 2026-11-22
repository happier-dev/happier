import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { createRestartCompletionWaiters } from './completionWaiters';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { requestConnectedServiceSwitchBeforeTurnWithDeferral } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchBeforeTurnDeferral';
import { waitForExistingSessionExitIfStopRequested } from '@/daemon/sessions/waitForExistingSessionExitIfStopRequested';

function trackedSession(): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
  };
}

function createHarness(isProcessSafeToSignal?: () => Promise<boolean>) {
  const tracked = trackedSession();
  const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
  const restartRequestedPids = new Set<number>();
  const completionWaiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
  // The runner keeps exiting after the first SIGTERM, so its pid identity no longer verifies.
  let runnerExiting = false;
  const sendSignal = vi.fn(() => {
    runnerExiting = true;
  });
  const observeRunnerRetirement = vi.fn();
  const restartEvents: number[] = [];

  const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
  const target = { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 };
  const request = (reason: 'version_runtime_refresh' | 'connected_service_switch' = 'version_runtime_refresh', profileId = 'work', source: 'manual' | 'automatic' = 'automatic') => requestPlannedRunnerRestart({
    sessionId: 'sess-1', tracked, reason,
    deferral: reason === 'version_runtime_refresh' ? { kind: 'none' } : {
      kind: 'connected_service_switch', source, policy: 'defer_until_turn_boundary',
      target: { ...target, profileId }, turnDeferralQueue: queue,
    },
    completionWaiters, awaitCompletion: true,
    restartRequestedPids, pidToTrackedSession,
    observeRunnerRetirement,
    onRestartSignaled: () => { restartEvents.push(tracked.pid); },
    isProcessSafeToSignal: isProcessSafeToSignal ?? (async () => !runnerExiting),
    requestSignal: async ({ shouldSignal }) => {
      if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
      sendSignal();
      return { status: 'requested' as const };
    },
    logDebug: () => {},
  });

  return { tracked, restartRequestedPids, completionWaiters, sendSignal, observeRunnerRetirement, request, queue, pidToTrackedSession, restartEvents };
}

describe('requestPlannedRunnerRestart completion lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('joins an in-flight restart instead of re-signalling or cancelling its respawn intent', async () => {
    const harness = createHarness();

    const first = harness.request();
    await vi.waitFor(() => expect(harness.sendSignal).toHaveBeenCalledTimes(1));
    const duplicate = harness.request();

    expect(harness.restartRequestedPids.has(harness.tracked.pid)).toBe(true);
    harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });

    await expect(first).resolves.toEqual({ signaled: true, completion: { ok: true } });
    await expect(duplicate).resolves.toEqual({ signaled: true, completion: { ok: true } });
    expect(harness.sendSignal).toHaveBeenCalledTimes(1);
    expect(harness.observeRunnerRetirement).toHaveBeenCalledTimes(1);
  });

  it('shares a same-target deferred outcome even when retirement completes before queued callers resume', async () => {
    const harness = createHarness();
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    harness.observeRunnerRetirement.mockImplementation(() => {
      harness.queue.cancelSession('sess-1', 'session_restarting');
      harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });
    });
    const first = harness.request('connected_service_switch');
    const second = harness.request('connected_service_switch');
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(first).resolves.toEqual({ signaled: true, completion: { ok: true } });
    await expect(second).resolves.toEqual({ signaled: true, completion: { ok: true } });
    expect(harness.sendSignal).toHaveBeenCalledTimes(1);
    expect(harness.restartEvents).toEqual([harness.tracked.pid]);
  });

  it('does not claim a restart when a same-target before-turn account operation was selected', async () => {
    const harness = createHarness();
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    await requestConnectedServiceSwitchBeforeTurnWithDeferral({
      deferralQueue: harness.queue, sessionId: 'sess-1', source: 'manual', policy: 'defer_until_turn_boundary',
      target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
      runSwitch: async () => ({ status: 'applied_in_place' }),
    });
    const restart = harness.request('connected_service_switch');
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(restart).resolves.toEqual({ signaled: false, notSignaledReason: 'duplicate_restart' });
    expect(harness.sendSignal).not.toHaveBeenCalled();
    expect(harness.restartRequestedPids.size).toBe(0);
  });

  it('preserves a deferred manual target without joining a different automatic target', async () => {
    const harness = createHarness();
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    harness.observeRunnerRetirement.mockImplementation(() => {
      harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });
    });
    const manual = harness.request('connected_service_switch', 'work', 'manual');
    const automatic = harness.request('connected_service_switch', 'personal');
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(manual).resolves.toEqual({ signaled: true, completion: { ok: true } });
    await expect(automatic).resolves.toEqual({ signaled: false, notSignaledReason: 'duplicate_restart' });
    expect(harness.sendSignal).toHaveBeenCalledTimes(1);
    expect(harness.restartEvents).toEqual([harness.tracked.pid]);
  });

  it('reports a joined request as unsignalled when the original request fails its final process guard', async () => {
    let resolveProcessProbe!: (safe: boolean) => void;
    const processProbe = new Promise<boolean>((resolve) => { resolveProcessProbe = resolve; });
    const harness = createHarness(async () => processProbe);
    const first = harness.request();
    const joiner = harness.request();
    resolveProcessProbe(false);
    await expect(first).resolves.toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });
    await expect(joiner).resolves.toEqual({ signaled: false, notSignaledReason: 'duplicate_restart' });
    expect(harness.sendSignal).not.toHaveBeenCalled();
    expect(harness.restartEvents).toEqual([]);
    expect(harness.restartRequestedPids.size).toBe(0);
    expect(harness.completionWaiters.join('sess-1', harness.tracked.pid)).toBeNull();
  });

  it('keeps a version waiter and reservation when a connected-service restart overlaps', async () => {
    const harness = createHarness();
    const version = harness.request();
    await vi.waitFor(() => expect(harness.sendSignal).toHaveBeenCalledTimes(1));
    await expect(harness.request('connected_service_switch')).resolves.toEqual({
      signaled: false, notSignaledReason: 'duplicate_restart',
    });
    expect(harness.restartRequestedPids.has(harness.tracked.pid)).toBe(true);
    harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });
    await expect(version).resolves.toEqual({ signaled: true, completion: { ok: true } });
    expect(harness.sendSignal).toHaveBeenCalledTimes(1);
  });

  it('does not join a materially different connected-service target or clear its reservation', async () => {
    const harness = createHarness();
    const first = harness.request('connected_service_switch');
    await vi.waitFor(() => expect(harness.sendSignal).toHaveBeenCalledTimes(1));
    await expect(harness.request('connected_service_switch', 'personal')).resolves.toEqual({
      signaled: false, notSignaledReason: 'duplicate_restart',
    });
    expect(harness.restartRequestedPids.has(harness.tracked.pid)).toBe(true);
    harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });
    await expect(first).resolves.toEqual({ signaled: true, completion: { ok: true } });
  });

  it('lets the real deferral queue supersede a pending target before admitting a restart', async () => {
    const harness = createHarness();
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    const first = harness.request('connected_service_switch');
    const newer = harness.request('connected_service_switch', 'personal');
    await expect(first).resolves.toEqual({ signaled: false, notSignaledReason: 'superseded' });
    expect(harness.restartRequestedPids.size).toBe(0);
    expect(harness.completionWaiters.join('sess-1', harness.tracked.pid)).toBeNull();
    harness.queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await vi.waitFor(() => expect(harness.sendSignal).toHaveBeenCalledTimes(1));
    harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });
    await expect(newer).resolves.toEqual({ signaled: true, completion: { ok: true } });
  });

  it.each(['signal_delay', 'process_probe', 'activity_probe'] as const)(
    'does not signal after deferral execution expires during %s', async (pendingBoundary) => {
      vi.useFakeTimers();
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const harness = createHarness();
      const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 1_000, disableDeferral: false });
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
      let releaseProbe!: (allowed: boolean) => void;
      const probe = new Promise<boolean>((resolve) => { releaseProbe = resolve; });
      const restart = requestPlannedRunnerRestart({
        sessionId: 'sess-1', tracked: harness.tracked, reason: 'connected_service_switch',
        deferral: {
          kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
          target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
          turnDeferralQueue: queue,
        },
        completionWaiters: harness.completionWaiters, restartRequestedPids: harness.restartRequestedPids,
        pidToTrackedSession: harness.pidToTrackedSession,
        isProcessSafeToSignal: async () => pendingBoundary === 'process_probe' ? await probe : true,
        canSignal: async () => pendingBoundary === 'activity_probe' ? await probe : true,
        // Keep the real delayed signal adapter and deferral queue. Only OS signalling/probing and
        // time are replaced so the late SIGTERM remains reachable through the production path.
        requestSignal: ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
          requestConnectedServiceSessionRestartSignal({
            pid: harness.tracked.pid, delayMs: pendingBoundary === 'signal_delay' ? 1_500 : 0,
            shouldSignal, onSignalFailure, onProcessAlreadyMissing,
          }),
        logDebug: () => {},
      }).catch((error: unknown) => error);
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await restart).toMatchObject({ code: 'switch_execution_timeout' });
      expect(harness.restartRequestedPids.size).toBe(0);
      releaseProbe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(kill).not.toHaveBeenCalled();
      expect(harness.completionWaiters.join('sess-1', harness.tracked.pid)).toBeNull();
    },
  );

  it('observes retirement and completes when the restart notification boundary throws', async () => {
    const harness = createHarness();
    const warnings: unknown[] = [];
    const restart = requestPlannedRunnerRestart({
      sessionId: 'sess-1', tracked: harness.tracked, reason: 'version_runtime_refresh', deferral: { kind: 'none' },
      completionWaiters: harness.completionWaiters, awaitCompletion: true,
      restartRequestedPids: harness.restartRequestedPids, pidToTrackedSession: harness.pidToTrackedSession,
      isProcessSafeToSignal: async () => true,
      requestSignal: async ({ shouldSignal }) => await shouldSignal() ? { status: 'requested' } : { status: 'skipped_stale_owner' },
      // Outbound notification boundary: a failing transcript transport must remain nonfatal.
      onRestartSignaled: () => { throw new Error('notification_transport_unavailable'); },
      observeRunnerRetirement: async (tracked) => {
        await waitForExistingSessionExitIfStopRequested({
          sessionId: 'sess-1', pidToTrackedSession: harness.pidToTrackedSession, trackedPids: [tracked.pid],
          timeoutMs: 60_000, pollIntervalMs: 100, readRunState: async () => 'dead',
          onExitObserved: () => harness.completionWaiters.settle('sess-1', tracked.pid, { ok: true }),
        });
      },
      logDebug: () => {}, logWarn: (_message, error) => { warnings.push(error); },
    });
    await expect(restart).resolves.toEqual({ signaled: true, completion: { ok: true } });
    expect(warnings).toEqual([expect.objectContaining({ message: 'notification_transport_unavailable' })]);
  });

  it('observes a slow adopted runner exit throughout the completion window', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const startedAt = Date.now();
    const restart = requestPlannedRunnerRestart({
      sessionId: 'sess-1', tracked: harness.tracked, reason: 'version_runtime_refresh', deferral: { kind: 'none' },
      completionWaiters: harness.completionWaiters, awaitCompletion: true,
      restartRequestedPids: harness.restartRequestedPids, pidToTrackedSession: harness.pidToTrackedSession,
      isProcessSafeToSignal: async () => true,
      requestSignal: async ({ shouldSignal }) => await shouldSignal() ? { status: 'requested' } : { status: 'skipped_stale_owner' },
      observeRunnerRetirement: async (tracked) => {
        await waitForExistingSessionExitIfStopRequested({
          sessionId: 'sess-1', pidToTrackedSession: harness.pidToTrackedSession, trackedPids: [tracked.pid],
          timeoutMs: 60_000, pollIntervalMs: 100,
          readRunState: async () => Date.now() - startedAt >= 10_000 ? 'dead' : 'servable',
          onExitObserved: () => harness.completionWaiters.settle('sess-1', tracked.pid, { ok: true }),
        });
      },
      logDebug: () => {},
    });
    await vi.advanceTimersByTimeAsync(10_100);
    await expect(restart).resolves.toEqual({ signaled: true, completion: { ok: true } });
  });

  it('reports a duplicate without signalling when another pending restart already reserved the runner', async () => {
    const harness = createHarness();
    harness.restartRequestedPids.add(harness.tracked.pid);

    await expect(harness.request()).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'duplicate_restart',
    });
    expect(harness.sendSignal).not.toHaveBeenCalled();
    expect(harness.restartRequestedPids.has(harness.tracked.pid)).toBe(true);
  });

  it('releases its waiter when the restart is not signalled', async () => {
    const harness = createHarness();
    const refused = requestPlannedRunnerRestart({
      sessionId: 'sess-1', tracked: harness.tracked, reason: 'version_runtime_refresh', deferral: { kind: 'none' },
      completionWaiters: harness.completionWaiters, awaitCompletion: true,
      restartRequestedPids: harness.restartRequestedPids, pidToTrackedSession: harness.pidToTrackedSession,
      observeRunnerRetirement: harness.observeRunnerRetirement,
      isProcessSafeToSignal: async () => true, canSignal: () => false,
      requestSignal: async ({ shouldSignal }) => await shouldSignal() ? { status: 'requested' } : { status: 'skipped_stale_owner' },
      logDebug: () => {},
    });

    await expect(refused).resolves.toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });
    expect(harness.completionWaiters.join('sess-1', harness.tracked.pid)).toBeNull();
    expect(harness.observeRunnerRetirement).not.toHaveBeenCalled();
  });
});
