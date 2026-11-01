import { describe, expect, it } from 'vitest';

import { RestartAllSessionRunnersResultV1Schema } from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import { resolveSessionRunnerActivityDisabledReason } from '../sessionRunnerRuntime/resolveActivityDisabledReason';
import { restartStaleSessionRunnersAfterDaemonStart } from './restartStaleRunnersAfterDaemonStart';

const CURRENT_VERSION = '0.2.11';

function currentIdentity(version: string = CURRENT_VERSION): SessionRunnerEntrypointIdentity {
  return {
    status: 'known',
    source: 'launch_spec',
    comparableId: `version:${version}`,
    entrypointVersion: version,
  };
}

function runnerCommand(version: string): string {
  return `node /Users/alice/.happier/cli-dev/versions/${version}/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon`;
}

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    processCommand: runnerCommand('0.2.10'),
    vendorResumeId: 'claude-thread-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

/**
 * Boundary fake for the OS signal/respawn adapter: records which runners were signalled.
 * Everything above it (eligibility, version gate, activity gate, aggregation) is real.
 */
function createSignalBoundary(options: Readonly<{ fail?: boolean; onSignal?: () => void }> = {}) {
  const signalledSessionIds: string[] = [];
  const requestRestart = async (input: Readonly<{ sessionId: string; tracked: TrackedSession }>) => {
    if (options.fail) throw new Error('signal adapter unavailable');
    signalledSessionIds.push(input.sessionId);
    options.onSignal?.();
    return { signaled: true };
  };
  return { signalledSessionIds, requestRestart };
}

function createLogSink() {
  const debug: Array<{ message: string; payload?: unknown }> = [];
  const warn: Array<{ message: string; payload?: unknown }> = [];
  return {
    debug,
    warn,
    logDebug: (message: string, payload?: unknown) => debug.push({ message, payload }),
    logWarn: (message: string, payload?: unknown) => warn.push({ message, payload }),
  };
}

describe('restartStaleSessionRunnersAfterDaemonStart', () => {
  it('does nothing when the setting is off (the default)', async () => {
    const signal = createSignalBoundary();
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({}),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [trackedSession()],
      requestRestart: signal.requestRestart,
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome).toEqual({ status: 'disabled' });
    expect(signal.signalledSessionIds).toEqual([]);
  });

  it('leaves a stale runner alone while the server projects background agents', async () => {
    const signal = createSignalBoundary();
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [trackedSession()],
      requestRestart: signal.requestRestart,
      readServerRuntimeActivity: async () => ({ runtimeActivityState: 'active', runtimeActivityActiveCount: 1 }),
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome).toEqual(expect.objectContaining({
      status: 'completed',
      result: expect.objectContaining({ restartedCount: 0, skippedCount: 1 }),
    }));
    expect(signal.signalledSessionIds).toEqual([]);
  });

  it('restarts stale runners with the on-update config reason in if_stale mode when enabled', async () => {
    const signal = createSignalBoundary();
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [
        trackedSession(),
        trackedSession({ pid: 4343, happySessionId: 'sess-2', processCommand: runnerCommand(CURRENT_VERSION) }),
      ],
      requestRestart: signal.requestRestart,
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.request).toEqual({ mode: 'if_stale', reason: 'restart_session_runners_on_update_config' });
    expect(RestartAllSessionRunnersResultV1Schema.parse(outcome.result)).toEqual(outcome.result);
    expect(outcome.result).toEqual(expect.objectContaining({ ok: true, mode: 'if_stale', restartedCount: 1, failedCount: 0 }));
    expect(signal.signalledSessionIds).toEqual(['sess-1']);
    expect(logs.debug.length).toBeGreaterThan(0);
  });

  it('is a no-op when every runner already runs the current CLI (same-version daemon restart)', async () => {
    const signal = createSignalBoundary();
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [trackedSession({ processCommand: runnerCommand(CURRENT_VERSION) })],
      requestRestart: signal.requestRestart,
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.restartedCount).toBe(0);
    expect(outcome.result.results).toEqual([expect.objectContaining({ status: 'already_current' })]);
    expect(signal.signalledSessionIds).toEqual([]);
  });

  it('skips a stale runner whose durable marker still records an active turn the fresh daemon has not observed', async () => {
    // After a daemon restart the in-memory turn queue is empty, so only the reattached marker's
    // activeTurnId proves the runner is mid-turn. An automatic restart must not interrupt it.
    const freshQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    const signal = createSignalBoundary();
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [trackedSession({ activeTurnId: 'turn-7', reattachedFromDiskMarker: true })],
      requestRestart: signal.requestRestart,
      resolveActivityDisabledReason: (sessionId) => resolveSessionRunnerActivityDisabledReason(sessionId, {
        isTurnInProgress: (id) => freshQueue.isTurnInFlight(id),
      }),
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.results).toEqual([
      expect.objectContaining({ ok: false, status: 'busy', reasonCode: 'turn_in_progress' }),
    ]);
    expect(signal.signalledSessionIds).toEqual([]);
  });

  it('logs and contains a restart failure instead of throwing into daemon startup', async () => {
    const signal = createSignalBoundary({ fail: true });
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => false,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [trackedSession()],
      requestRestart: signal.requestRestart,
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome.status).toBe('failed');
    expect(logs.warn).toHaveLength(1);
  });

  it('does not start while the daemon is shutting down', async () => {
    const signal = createSignalBoundary();
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => true,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [trackedSession()],
      requestRestart: signal.requestRestart,
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome).toEqual({ status: 'shutting_down' });
    expect(signal.signalledSessionIds).toEqual([]);
  });

  it('stops restarting further runners once daemon shutdown begins mid-pass', async () => {
    let shuttingDown = false;
    const signal = createSignalBoundary({ onSignal: () => { shuttingDown = true; } });
    const logs = createLogSink();

    const outcome = await restartStaleSessionRunnersAfterDaemonStart({
      readSettings: async () => ({ restartSessionRunnersOnUpdate: true }),
      isShuttingDown: () => shuttingDown,
      resolveCurrentIdentity: () => currentIdentity(),
      trackedSessions: () => [
        trackedSession(),
        trackedSession({ pid: 4343, happySessionId: 'sess-2' }),
      ],
      requestRestart: signal.requestRestart,
      logDebug: logs.logDebug,
      logWarn: logs.logWarn,
    });

    expect(outcome.status).toBe('completed');
    expect(signal.signalledSessionIds).toEqual(['sess-1']);
  });
});
