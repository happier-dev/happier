import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { resolveSessionRunnerRuntimeState, resolveTrackedSessionRunnerActivity } from './resolveRuntimeState';
import { restartSessionRunnerOnCurrentRuntime } from '../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { requestPlannedRunnerRestart } from '../plannedRunnerRestart/requestPlannedRunnerRestart';
import { requestConnectedServiceSessionRestartSignal } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { adoptTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import { resolveSessionRunnerRuntimeStatusV2 } from './resolveRuntimeStatusV2';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('resolveSessionRunnerRuntimeState', () => {
  it.each(['activeTurnId', 'reattachedInterruptedTurnId'] as const)('projects tracked %s custody without an injected activity reader', field => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(123), happySessionId: 'sess-1', pid: 123, startedBy: 'daemon',
      processCommand: 'node /work/apps/cli/src/index.ts claude --happy-starting-mode remote --started-by daemon',
      processCommandHash: 'runner-command-hash', processStartTimeMs: 12_345,
      spawnOptions: { directory: '/work', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, resume: 'thread-1' },
      [field]: 'tracked-turn',
    };
    const input = { sessionId: 'sess-1', tracked,
      currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'path:/work/apps/cli' } as const };
    expect(resolveSessionRunnerRuntimeState(input).plannedRestart)
      .toMatchObject({ eligible: false, disabledReason: 'turn_in_progress' });
    delete tracked[field];
    expect(resolveSessionRunnerRuntimeState(input).plannedRestart).toMatchObject({ eligible: true, disabledReason: null });
  });
  it('projects one executable identity for a wrapped runner without borrowing launcher evidence', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: 'wrapped',
      processStartTimeMs: 100, processCommandHash: 'launcher-hash', processCommand: 'launcher' };
    adoptTrackedSessionRunnerIdentity(tracked, { pid: 456, processStartTimeMs: 200,
      processCommandHash: 'runner-hash',
      processCommand: 'node /cli/versions/0.3.0/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon' });
    const state = resolveSessionRunnerRuntimeState({ sessionId: 'wrapped', tracked,
      currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.3.0' } });
    const readProcessIdentityByPidFn = vi.fn(async (pid: number) => ({ pid, processStartTimeMs: 200, command: 'runner' }));
    const status = await resolveSessionRunnerRuntimeStatusV2({ state, tracked, readProcessIdentityByPidFn });
    expect(status.state.runner).toMatchObject({ pid: 456, processCommandHash: 'runner-hash', runtimeId: 'version:0.3.0' });
    expect(status.runnerProcessIdentity).toEqual({ pid: status.state.runner.pid, processStartTimeMs: 200 });
    expect(readProcessIdentityByPidFn.mock.calls).toEqual([[456]]);
    expect(tracked.pid).toBe(123);
  });

  it('does not make a refresh hold itself or another Session effect', () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: 'session' };
    const operations = [
      { method: 'session.runtime.refresh', activeForMs: 1,
        sessionEffect: { sessionId: 'session', actionId: 'session.runtime.refresh' } },
      { method: 'scm.diffSummary.generate', activeForMs: 1,
        sessionEffect: { sessionId: 'other', actionId: 'scm.diffSummary.generate' } },
      { method: 'scm.diffSummary.result.list', activeForMs: 1 },
    ];
    expect(resolveTrackedSessionRunnerActivity(tracked, operations)).toBeNull();
    expect(resolveTrackedSessionRunnerActivity({ ...tracked, activeTurnId: 'turn' }, operations))
      .toMatchObject({ reasonCode: 'turn_in_progress', diagnostics: { busySource: 'foreground_turn' } });
  });

  it('does not make a connected-account switch hold its own restart while retaining other work', () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: 'session' };
    const switchOperation = { method: 'approved-switch', activeForMs: 1,
      sessionEffect: { sessionId: 'session', actionId: 'session.connected_services_auth.set' } };
    expect(resolveTrackedSessionRunnerActivity(tracked, [switchOperation]))
      .toMatchObject({ reasonCode: 'turn_in_progress', diagnostics: { busySource: 'session_action' } });
    expect(resolveTrackedSessionRunnerActivity(tracked, [switchOperation], 'session.connected_services_auth.set')).toBeNull();
    expect(resolveTrackedSessionRunnerActivity({ ...tracked, activeTurnId: 'turn' }, [switchOperation], 'session.connected_services_auth.set'))
      .toMatchObject({ reasonCode: 'turn_in_progress', diagnostics: { busySource: 'foreground_turn' } });
    expect(resolveTrackedSessionRunnerActivity(tracked, [switchOperation, {
      method: 'session.compact', activeForMs: 1,
      sessionEffect: { sessionId: 'session', actionId: 'session.compact' },
    }], 'session.connected_services_auth.set')).toMatchObject({ reasonCode: 'turn_in_progress', diagnostics: { busySource: 'session_action', actionId: 'session.compact' } });
  });

  it('keeps unattested freshness unknown while preflight and explicit refresh agree on eligibility', async () => {
    const input = {
      sessionId: 'sess-1',
      tracked: {
        trackingKey: legacyPidSessionTrackingKey(123), happySessionId: 'sess-1',
        pid: 123,
        startedBy: 'daemon',
        processCommand: 'node /work/apps/cli/src/index.ts claude --happy-starting-mode remote --started-by daemon',
        processCommandHash: 'runner-command-hash',
        processStartTimeMs: 12_345,
        spawnOptions: {
          directory: '/work',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          resume: 'thread-1',
        },
      } as TrackedSession,
      currentIdentity: {
        status: 'known' as const,
        source: 'launch_spec' as const,
        comparableId: 'path:/work/apps/cli',
        entrypointVersion: null,
      },
      observedAtMs: 100,
    };
    const state = resolveSessionRunnerRuntimeState(input);

    expect(state.versionState).toBe('unknown');
    expect(state.plannedRestart).toMatchObject({
      eligible: true,
      disabledReason: null,
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const requestRestart: Parameters<typeof restartSessionRunnerOnCurrentRuntime>[0]['requestRestart'] = async request =>
      await requestPlannedRunnerRestart({ ...request, deferral: { kind: 'none' },
        restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[input.tracked.trackingKey, input.tracked]]),
        isProcessSafeToSignal: async () => true,
        requestSignal: signal => requestConnectedServiceSessionRestartSignal({ pid: input.tracked.pid, delayMs: 0,
          shouldSignal: signal.shouldSignal, onSignalFailure: signal.onSignalFailure }) });
    try {
      await expect(restartSessionRunnerOnCurrentRuntime({ ...input, requestRestart,
        request: { sessionId: input.sessionId, mode: 'force_current_cli', reason: 'ui_stale_runner_banner',
          expectedRunnerPid: input.tracked.pid, expectedProcessCommandHash: input.tracked.processCommandHash } })).resolves.toMatchObject({ ok: true, status: 'restarted' });
      expect(kill).toHaveBeenCalledWith(input.tracked.pid, 'SIGTERM');
      await expect(restartSessionRunnerOnCurrentRuntime({ ...input, requestRestart,
        request: { sessionId: input.sessionId, mode: 'if_stale', reason: 'ui_stale_runner_banner' } })).resolves.toMatchObject({ ok: false, status: 'version_unknown', reasonCode: 'runner_generation_unattested' });
    } finally { kill.mockRestore(); }
  });
});
