import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { spawnInlineNodeTestProcess, isPidAlive } from '@/testkit/process/spawn';

import type { TrackedSession } from '@/daemon/types';
import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { resolveSessionRunnerActivityDisabledReason } from '@/daemon/sessionRunnerRuntime/resolveActivityDisabledReason';
import { createRestartCompletionWaiters } from './completionWaiters';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';
import { restartSessionRunnerOnCurrentRuntime } from './restartSessionRunnerOnCurrentRuntime';
import { restartStaleSessionRunnersAfterDaemonStart } from './restartStaleRunnersAfterDaemonStart';
import { applyTrackedSessionTurnLifecycle } from '@/daemon/sessions/applyTrackedSessionTurnLifecycle';
import { resolveSessionRunnerRuntimeState } from '@/daemon/sessionRunnerRuntime/resolveRuntimeState';

function createHarness(options: Readonly<{ beforeSignal?: (tracked: TrackedSession) => Promise<void> }> = {}) {
  const tracked: TrackedSession = {
    startedBy: 'daemon',
    pid: 838383,
    happySessionId: 'active-foreground',
    processCommandHash: 'process-hash',
    processCommand: 'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
    vendorResumeId: 'native-claude-session',
    activeTurnId: 'canonical-turn-active-before-daemon-restart',
    reattachedFromDiskMarker: true,
    spawnOptions: {
      directory: '/tmp/restart-test',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'native-claude-session',
    },
  };
  const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
  // Genuine OS boundary: no real process receives a signal in this probe.
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const waiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
  const currentIdentity = {
    status: 'known', source: 'launch_spec', comparableId: 'version:0.2.11', entrypointVersion: '0.2.11',
  } as const;
  const activityGuard = (sessionId: string) => resolveSessionRunnerActivityDisabledReason(sessionId, {
    isTurnInProgress: (id) => queue.isTurnInFlight(id),
  });
  // Compose the daemon restart owners; only OS inspection and signaling are replaced.
  const requestRestart = async () => {
    const result = await requestPlannedRunnerRestart({
      sessionId: tracked.happySessionId!, tracked, reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids: new Set(),
      completionWaiters: waiters,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      canSignal: async () => {
        const reason = activityGuard(tracked.happySessionId!);
        await options.beforeSignal?.(tracked);
        return reason ?? true;
      },
      // Genuine OS inspection boundary; the fixture represents a verified live runner.
      isProcessSafeToSignal: async () => true,
      requestSignal: ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
        requestConnectedServiceSessionRestartSignal({
          pid: tracked.pid, delayMs: 0, shouldSignal, onSignalFailure, onProcessAlreadyMissing,
        }),
      logDebug: () => {},
    });
    waiters.settle(tracked.happySessionId!, tracked.pid, { ok: true });
    return result;
  };
  const readServerRuntimeActivity = async () => ({ runtimeActivityState: 'idle' as const, runtimeActivityActiveCount: 0 });
  const restart = () => restartSessionRunnerOnCurrentRuntime({
    request: {
      sessionId: tracked.happySessionId!, mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
    },
    tracked, currentIdentity, requestRestart,
    resolveActivityDisabledReason: activityGuard,
    readServerRuntimeActivity,
    // Genuine filesystem boundary: this runner has no terminal-host attachment file.
    readTerminalAttachmentInfo: async () => null,
  });
  return { tracked, queue, kill, restart, requestRestart, currentIdentity, activityGuard, readServerRuntimeActivity };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('foreground turn custody during runner restart', () => {
  it('blocks an observed live turn even when the server background projection is idle', async () => {
    const probe = createHarness();
    probe.queue.recordTurnLifecycleEvent({ sessionId: probe.tracked.happySessionId!, event: 'task_started' });
    const result = await probe.restart();
    expect(result).toMatchObject({ ok: false, status: 'busy', reasonCode: 'turn_in_progress' });
    expect(probe.kill).not.toHaveBeenCalled();
  });

  it('blocks a reattached active canonical turn before a doctor runner restart sends SIGTERM', async () => {
    const probe = createHarness();
    expect(probe.queue.isTurnInFlight(probe.tracked.happySessionId!)).toBe(false);
    const result = await probe.restart();
    expect({ result, osSignals: probe.kill.mock.calls }).toMatchObject({
      result: { ok: false, status: 'busy', reasonCode: 'turn_in_progress' },
      osSignals: [],
    });
  });

  it('also blocks the startup restart pass', async () => {
    const probe = createHarness();
    const result = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => probe.currentIdentity,
      trackedSessions: () => [probe.tracked],
      requestRestart: probe.requestRestart,
      resolveActivityDisabledReason: probe.activityGuard,
      readServerRuntimeActivity: probe.readServerRuntimeActivity,
      logDebug: () => {}, logWarn: () => {},
    });
    expect(result).toMatchObject({ status: 'completed', result: { restartedCount: 0, skippedCount: 1 } });
    expect(probe.kill).not.toHaveBeenCalled();
  });

  it('blocks a live queue turn at the final signal boundary', async () => {
    const probe = createHarness();
    probe.queue.recordTurnLifecycleEvent({ sessionId: probe.tracked.happySessionId!, event: 'prompt_or_steer' });
    const result = await probe.requestRestart();
    expect(result).toMatchObject({ signaled: false, notSignaledReason: 'activity_in_progress' });
    expect(probe.kill).not.toHaveBeenCalled();
  });
});


describe('foreground restart lifecycle boundaries', () => {
  it('previews a reattached foreground turn as ineligible for restart', () => {
    const probe = createHarness();
    const state = resolveSessionRunnerRuntimeState({
      sessionId: probe.tracked.happySessionId!, tracked: probe.tracked,
      currentIdentity: probe.currentIdentity, resolveActivityDisabledReason: probe.activityGuard,
    });
    expect(state.plannedRestart).toMatchObject({ eligible: false, disabledReason: 'turn_in_progress' });
  });

  it('checks exact turn custody again after the awaited final activity reader', async () => {
    const probe = createHarness({ beforeSignal: async (tracked) => {
      await applyTrackedSessionTurnLifecycle({
        trackedSessions: [tracked], sessionId: tracked.happySessionId!,
        event: 'task_started', turnId: 'turn-started-during-signal-probe',
        updateSessionMarkerActiveTurn: async () => true, // Filesystem boundary.
      });
    } });
    delete probe.tracked.activeTurnId;
    const result = await probe.requestRestart();
    expect(result).toMatchObject({
      signaled: false, notSignaledReason: 'activity_in_progress', activityDisabledReason: 'turn_in_progress',
    });
    expect(probe.kill).not.toHaveBeenCalled();
  });

  it('allows refresh after the exact persisted turn completes', async () => {
    const probe = createHarness();
    await applyTrackedSessionTurnLifecycle({
      trackedSessions: [probe.tracked], sessionId: probe.tracked.happySessionId!,
      event: 'assistant_message_end', turnId: probe.tracked.activeTurnId,
      updateSessionMarkerActiveTurn: async () => true, // Filesystem boundary.
    });
    expect(await probe.restart()).toMatchObject({ ok: true, status: 'restarted' });
    expect(probe.kill).toHaveBeenCalledWith(probe.tracked.pid, 'SIGTERM');
  });
});


it('retains the connected-service forced-boundary policy while exact turn custody remains active', async () => {
  vi.useFakeTimers();
  const probe = createHarness();
  probe.queue.recordTurnLifecycleEvent({ sessionId: probe.tracked.happySessionId!, event: 'task_started' });
  const waiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
  const pending = requestPlannedRunnerRestart({
    sessionId: probe.tracked.happySessionId!, tracked: probe.tracked, reason: 'connected_service_switch',
    deferral: {
      kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
      target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
      turnDeferralQueue: probe.queue,
    },
    restartRequestedPids: new Set(), completionWaiters: waiters,
    pidToTrackedSession: new Map([[probe.tracked.pid, probe.tracked]]),
    canSignal: () => probe.activityGuard(probe.tracked.happySessionId!) ?? true,
    isProcessSafeToSignal: async () => true,
    requestSignal: ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
      requestConnectedServiceSessionRestartSignal({
        pid: probe.tracked.pid, delayMs: 0, shouldSignal, onSignalFailure, onProcessAlreadyMissing,
      }),
    logDebug: () => {},
  });
  expect(probe.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await pending).toMatchObject({ signaled: true });
  expect(probe.tracked.activeTurnId).toBeTruthy();
  expect(probe.queue.getTurnLifecycleState(probe.tracked.happySessionId!).forcedSwitchInterruptedLiveTurn).toBe(true);
  expect(probe.kill).toHaveBeenCalledWith(probe.tracked.pid, 'SIGTERM');
  waiters.settle(probe.tracked.happySessionId!, probe.tracked.pid, { ok: true });
});

it('keeps a real owned process alive during a turn and signals it after exact settlement', async () => {
  const child = spawnInlineNodeTestProcess("process.send('ready'); setInterval(() => {}, 1000)", {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    const probe = createHarness();
    probe.kill.mockRestore();
    probe.tracked.pid = child.pid!;
    expect(await probe.restart()).toMatchObject({ ok: false, status: 'busy', reasonCode: 'turn_in_progress' });
    expect(isPidAlive(child.pid!)).toBe(true);
    await applyTrackedSessionTurnLifecycle({
      trackedSessions: [probe.tracked], sessionId: probe.tracked.happySessionId!,
      event: 'assistant_message_end', turnId: probe.tracked.activeTurnId,
      updateSessionMarkerActiveTurn: async () => true, // Filesystem boundary; process signaling is real.
    });
    expect(await probe.restart()).toMatchObject({ ok: true, status: 'restarted' });
    await exited;
    expect(isPidAlive(child.pid!)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
