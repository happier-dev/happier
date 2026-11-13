import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from '../types';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';
import { requestConnectedServiceSessionRestartSignal } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { restartStaleRunnersAfterDaemonStart } from './restartStaleRunnersAfterDaemonStart';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('startup stale-runner refresh', () => {
  afterEach(() => vi.restoreAllMocks());
  function fixture() {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const runners: TrackedSession[] = [
      { trackingKey: legacyPidSessionTrackingKey(401), pid: 401, happySessionId: 'idle', startedBy: 'daemon', processCommandHash: 'hash-401', processStartTimeMs: 100,
        processCommand: 'node /tmp/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
        spawnOptions: { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, resume: 'thread-idle' } },
    ];
    const base = runners[0]!;
    runners.push({ ...base, trackingKey: legacyPidSessionTrackingKey(402), pid: 402, happySessionId: 'active', activeTurnId: 'turn-active' },
      { ...base, trackingKey: legacyPidSessionTrackingKey(403), pid: 403, happySessionId: 'reattached-active', reattachedInterruptedTurnId: 'turn-reattached' },
      { ...base, trackingKey: legacyPidSessionTrackingKey(404), pid: 404, happySessionId: 'current', processCommand: base.processCommand!.replace('0.2.10', '0.2.11') });
    const tracked = new Map(runners.map(runner => [runner.trackingKey, runner]));
    const reservations = new Set<SessionTrackingKey>();
    const logWarn = vi.fn();
    const input: Parameters<typeof restartStaleRunnersAfterDaemonStart>[0] = {
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }), isShuttingDown: () => false,
      restart: () => ({ trackedSessions: runners,
        currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.2.11', entrypointVersion: '0.2.11' },
        requestRestart: async request => requestPlannedRunnerRestart({ ...request, deferral: { kind: 'none' },
          restartRequestedSessions: reservations, trackedSessionsByKey: tracked,
          isProcessSafeToSignal: async () => true,
          requestSignal: signal => requestConnectedServiceSessionRestartSignal({ pid: signal.tracked.pid,
            delayMs: 0, shouldSignal: signal.shouldSignal, onSignalFailure: signal.onSignalFailure }),
        }),
      }), logDebug: () => {}, logWarn,
    };
    return { input, runners, kill, logWarn };
  }
  it('refreshes only stale runners without known active custody through the shared restart path', async () => {
    const { input, kill } = fixture();
    const outcome = await restartStaleRunnersAfterDaemonStart(input);
    expect(outcome).toMatchObject({ status: 'completed', result: { restartedCount: 1, skippedCount: 3 } });
    if (outcome.status !== 'completed') throw new Error('startup pass did not complete');
    expect(outcome.result.results.map(entry => [entry.sessionId, entry.status, entry.reasonCode])).toEqual([
      ['idle', 'restarted', undefined], ['active', 'busy', 'turn_in_progress'],
      ['reattached-active', 'busy', 'turn_in_progress'], ['current', 'already_current', undefined],
    ]);
    expect(kill.mock.calls).toEqual([[401, 'SIGTERM']]);
  });
  it.each([undefined, false])('is disabled unless the setting is explicitly true (%s)', async enabled => {
    const { input, kill } = fixture();
    expect(await restartStaleRunnersAfterDaemonStart({ ...input, readSettings: async () => ({ restartSessionRunnersOnUpdate: enabled }) })).toEqual({ status: 'disabled' });
    expect(kill).not.toHaveBeenCalled();
  });
  it('contains a settings failure and leaves the daemon running with an observable warning', async () => {
    const { input, kill, logWarn } = fixture();
    expect(await restartStaleRunnersAfterDaemonStart({ ...input, readSettings: async () => { throw new Error('settings unavailable'); } })).toEqual({ status: 'failed' });
    expect(kill).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(expect.any(String), { error: 'settings unavailable' });
  });
  it('does no work if shutdown begins during the settings read', async () => {
    const { input, kill } = fixture();
    expect(await restartStaleRunnersAfterDaemonStart({ ...input, isShuttingDown: () => true })).toEqual({ status: 'shutting_down' });
    expect(kill).not.toHaveBeenCalled();
  });
});
