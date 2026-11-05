import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionId } from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';

import { createSessionRunnerRespawnManager } from './sessionRunnerRespawn';
import { createVersionRuntimeRefreshAttemptHandoff } from '../plannedRunnerRestart/versionRuntimeRefreshAttemptHandoff';
import { buildVersionRuntimeRefreshTerminalCompletion } from '../plannedRunnerRestart/buildVersionRuntimeRefreshTerminalCompletion';
import { requestPlannedRunnerRestart } from '../plannedRunnerRestart/requestPlannedRunnerRestart';
import type { RestartSessionRunnerCompletion } from '../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { HostTerminalTranscriptFollowAdmissionError } from '@/agent/runtime/session/terminal/contract';
import { resolveSessionRunnerFailureExitCode } from '@/cli/resolveSessionRunnerFailureExitCode';
import { PluginError } from '@happier-dev/plugin-sdk';

type RespawnOptionsResolver = (input: Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

describe('createSessionRunnerRespawnManager', () => {
  it.each([
    SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT,
    SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
    SPAWN_SESSION_ERROR_CODES.BACKEND_DISABLED,
    SPAWN_SESSION_ERROR_CODES.SESSION_INITIAL_ACCESS_NOT_AUTHENTICATED,
    SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
    SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING,
  ])('settles an awaiting restart after one permanent replacement refusal (%s)', async errorCode => {
    vi.useFakeTimers();
    const failure = { ok: false, status: 'partial_failure' } as const;
    const handoff = createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({
      timeoutMs: null, timeoutCompletion: failure, supersededCompletion: failure, cancelledCompletion: failure,
    });
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 111, happySessionId: 'signed-out',
      processCommandHash: 'runner-command', processStartTimeMs: 100,
      spawnOptions: { directory: '/repo', resume: 'vendor-session' } };
    const target = { sessionId: 'signed-out', previousPid: tracked.pid, tracked };
    const spawnSession = vi.fn(async () => ({ type: 'error' as const, errorCode, errorMessage: 'User action required' }));
    const terminal = vi.fn(({ reason, detail }: Parameters<NonNullable<Parameters<typeof createSessionRunnerRespawnManager>[0]['onRespawnTerminal']>>[0]) => {
      handoff.settle(target.sessionId, target.previousPid, buildVersionRuntimeRefreshTerminalCompletion(reason, detail));
    });
    const manager = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: null,
      baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0, random: () => 0,
      isSessionAlreadyRunning: () => false, spawnSession, onRespawnTerminal: terminal,
      logDebug: () => {}, logWarn: () => {} });
    let settled = false;
    const restart = requestPlannedRunnerRestart({ sessionId: target.sessionId, tracked,
      deferral: { kind: 'none' }, restartRequestedPids: new Set(), pidToTrackedSession: new Map([[111, tracked]]),
      isProcessSafeToSignal: async () => true,
      completion: { hasPending: () => handoff.hasPending(), join: () => handoff.join(target), create: () => handoff.create(target) },
      requestSignal: async request => {
        if (!await request.shouldSignal()) return { status: 'skipped_stale_owner' };
        manager.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 0, signal: null }, { forceRestart: true });
        return { status: 'requested' };
      },
    }).then(result => { settled = true; return result; });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ detail: errorCode });
      expect(settled).toBe(true);
      await expect(restart).resolves.toMatchObject({ signaled: true,
        completion: { ok: false, status: 'spawn_failed', diagnostics: { errorCode } } });
      expect(handoff.hasPending()).toBe(false);
    } finally {
      manager.markStopRequested(target.sessionId, { reason: 'test_cleanup', requestedAtMs: 1_000 });
      handoff.settle(target.sessionId, target.previousPid, failure);
      await restart;
      vi.useRealTimers();
    }
  });

  it.each(['scheduled', 'retry', 'preflight'] as const)('settles the exact predecessor refresh when Stop retires a %s respawn', async phase => {
    vi.useFakeTimers();
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 111, happySessionId: 'stopped-refresh',
      vendorResumeId: 'native', spawnOptions: { directory: '/repo' } };
    const handoff = createVersionRuntimeRefreshAttemptHandoff({ timeoutMs: null,
      timeoutCompletion: 'timeout', supersededCompletion: 'superseded', cancelledCompletion: 'cancelled' });
    const attempt = handoff.create({ sessionId: 'stopped-refresh', previousPid: 111, tracked });
    const other = handoff.create({ sessionId: 'other-session', previousPid: 222, tracked: { ...tracked, pid: 222 } });
    let releasePreflight!: (value: boolean) => void;
    const preflight = new Promise<boolean>(resolve => { releasePreflight = resolve; });
    const terminals: number[] = [];
    const spawnSession = vi.fn(async () => ({ type: 'error', errorCode: 'SPAWN_FAILED' }));
    const manager = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
      baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
      isSessionAlreadyRunning: () => phase === 'preflight' ? preflight : false, spawnSession,
      onRespawnTerminal: ({ sessionId, previousPid, reason }) => {
        terminals.push(previousPid);
        handoff.settle(sessionId, previousPid, reason);
      }, random: () => 0, logDebug: () => {}, logWarn: () => {} });
    try {
      attempt.start();
      manager.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 1, signal: null }, { forceRestart: true });
      if (phase !== 'scheduled') await vi.advanceTimersByTimeAsync(0);
      if (phase === 'retry') expect(spawnSession).toHaveBeenCalledOnce();
      manager.markStopRequested('stopped-refresh', { reason: 'daemon_stop_session', requestedAtMs: 10 });
      expect(handoff.has('stopped-refresh', 111)).toBe(false);
      await expect(attempt.promise).resolves.toBe('stop_requested');
      expect(handoff.has('other-session', 222)).toBe(true);
      manager.prepareFreshExplicitResumeAdmission('stopped-refresh').complete();
      releasePreflight(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(terminals).toEqual([111]);
      expect(spawnSession).toHaveBeenCalledTimes(phase === 'retry' ? 1 : 0);
    } finally { releasePreflight(false); attempt.cancel(); other.cancel(); vi.useRealTimers(); }
  });
  it('keeps intended replacement custody scoped to its Session until launch settles or Stop retires it', async () => {
    vi.useFakeTimers();
    let finishSpawn!: (result: { type: 'success' }) => void;
    const spawn = new Promise<{ type: 'success' }>(resolve => { finishSpawn = resolve; });
    const spawnSession = vi.fn(() => spawn);
    const manager = createSessionRunnerRespawnManager({
      enabled: true, maxRestarts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
      isSessionAlreadyRunning: async () => false, spawnSession,
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 111, happySessionId: 'planned-session',
      vendorResumeId: 'vendor-session', spawnOptions: { directory: '/repo' } };
    try {
      expect(manager.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 0, signal: null },
        { forceRestart: true })).toBe('scheduled');
      expect(manager.hasPendingIntendedRestarts('planned-session')).toBe(true);
      expect(manager.hasPendingIntendedRestarts('another-session')).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(manager.hasPendingIntendedRestarts('planned-session')).toBe(true);
      finishSpawn({ type: 'success' });
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.hasPendingIntendedRestarts('planned-session')).toBe(false);
      expect(spawnSession).toHaveBeenCalledOnce();
      expect(manager.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 0, signal: null },
        { forceRestart: true })).toBe('scheduled');
      manager.markStopRequested('planned-session', { reason: 'daemon_stop_session', requestedAtMs: 100 });
      expect(manager.hasPendingIntendedRestarts('planned-session')).toBe(false);
    } finally { finishSpawn({ type: 'success' }); vi.useRealTimers(); }
  });

  it('ends automatic recovery after a deterministic requester-custody refusal while preserving explicit Resume', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async () => ({ type: 'success' as const }));
      const terminal = vi.fn();
      const manager = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: null, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
        isSessionAlreadyRunning: async () => false, spawnSession, onRespawnTerminal: terminal,
        random: () => 0, logDebug: () => {}, logWarn: () => {},
      });
      const error = new PluginError({ code: 'project_requester_credentials_unavailable',
        message: 'Runner PluginServices operation failed (dispatch: project_requester_credentials_unavailable)',
        details: { cause: { code: 'project_requester_credentials_unavailable', stage: 'dispatch' } } });
      const exitCode = resolveSessionRunnerFailureExitCode(error);
      expect(exitCode).toBe(79);
      const tracked: TrackedSession = { startedBy: 'daemon', pid: 111, happySessionId: 'requester-refusal',
        spawnOptions: { directory: '/repo' } };
      expect(manager.handleUnexpectedExit(tracked, { reason: 'process-exit', code: exitCode, signal: null })).toBe('terminal');
      await vi.runAllTimersAsync();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(terminal).toHaveBeenCalledWith({ sessionId: 'requester-refusal', previousPid: 111,
        reason: 'terminal_follow_admission_failed' });
      manager.prepareFreshExplicitResumeAdmission('requester-refusal').complete();
      expect(manager.prepareAutomaticResumeAdmission('requester-refusal')()).toBe(true);
      expect(resolveSessionRunnerFailureExitCode(new PluginError({ code: 'runner_plugin_services_unavailable',
        message: 'Transport unavailable' }))).toBe(1);
      const unavailableHome = resolveSessionRunnerFailureExitCode(new PluginError({ code: 'project_requester_home_unavailable',
        message: 'Requester Home temporarily unavailable' }));
      expect(unavailableHome).toBe(1);
      expect(manager.handleUnexpectedExit({ ...tracked, happySessionId: 'requester-home-unavailable' },
        { reason: 'process-exit', code: unavailableHome, signal: null })).toBe('scheduled');
      await vi.advanceTimersByTimeAsync(50);
      expect(spawnSession).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(['bind', 'active'] as const)('preserves terminal follow %s failure through runner exit and daemon recovery', async phase => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async () => ({ type: 'success' as const }));
      const terminal = vi.fn();
      const manager = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: null, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
        isSessionAlreadyRunning: async () => false, spawnSession, onRespawnTerminal: terminal,
        random: () => 0, logDebug: () => {}, logWarn: () => {},
      });
      const error = new HostTerminalTranscriptFollowAdmissionError('native_agent_terminal_provider_session_unavailable', phase);
      const code = resolveSessionRunnerFailureExitCode(error);
      if (phase === 'bind') {
        // A terminal replacement failure also retires an already scheduled crash cycle.
        manager.handleUnexpectedExit({
          startedBy: 'daemon', pid: 100, happySessionId: 'follow-admission', spawnOptions: { directory: '/repo' },
        }, { reason: 'process-exit', code: 1, signal: null });
      }
      const disposition = manager.handleUnexpectedExit({
        startedBy: 'daemon', pid: 111, happySessionId: 'follow-admission', spawnOptions: { directory: '/repo' },
      }, { reason: 'process-exit', code, signal: null });
      expect(disposition).toBe(phase === 'bind' ? 'terminal' : 'scheduled');
      await vi.advanceTimersByTimeAsync(50);
      if (phase === 'bind') {
        expect(code).not.toBe(1);
        expect(spawnSession).not.toHaveBeenCalled();
        expect(terminal).toHaveBeenCalledWith({
          sessionId: 'follow-admission', previousPid: 111, reason: 'terminal_follow_admission_failed',
        });
        // An explicit later start is independent of the terminal automatic cycle.
        manager.prepareFreshExplicitResumeAdmission('follow-admission').complete();
        expect(manager.prepareAutomaticResumeAdmission('follow-admission')()).toBe(true);
        expect(manager.handleUnexpectedExit({
          startedBy: 'daemon', pid: 222, happySessionId: 'follow-admission', spawnOptions: { directory: '/repo' },
        }, { reason: 'process-exit', code: 1, signal: null })).toBe('scheduled');
        await vi.advanceTimersByTimeAsync(50);
        expect(spawnSession).toHaveBeenCalledOnce();
      } else {
        expect(code).toBe(1);
        expect(spawnSession).toHaveBeenCalledOnce();
        expect(terminal).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not revive earlier automatic launch admission when explicit Resume clears Stop', () => {
    const manager = createSessionRunnerRespawnManager({
      enabled: true, maxRestarts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
      isSessionAlreadyRunning: async () => false, spawnSession: async () => ({ type: 'success' }),
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    const beforeStop = manager.prepareAutomaticResumeAdmission('recovering-session');
    expect(beforeStop()).toBe(true);
    manager.markStopRequested('recovering-session', { reason: 'daemon_stop_session', requestedAtMs: 100 });
    const whileStopped = manager.prepareAutomaticResumeAdmission('recovering-session');
    expect(beforeStop()).toBe(false);
    expect(whileStopped()).toBe(false);
    manager.prepareFreshExplicitResumeAdmission('recovering-session').complete();
    expect(beforeStop()).toBe(false);
    expect(whileStopped()).toBe(false);
    const afterResume = manager.prepareAutomaticResumeAdmission('recovering-session');
    expect(afterResume()).toBe(true);
    manager.markStopRequested('recovering-session', { reason: 'daemon_stop_session', requestedAtMs: 101 });
    expect(afterResume()).toBe(false);
  });

  it.each(['none', 'before', 'after'] as const)('preserves topology retirement admission with external Stop %s', (externalStop) => {
    const manager = createSessionRunnerRespawnManager({
      enabled: true, maxRestarts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
      isSessionAlreadyRunning: async () => false, spawnSession: async () => ({ type: 'success' }),
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    const oldAutomaticAdmission = manager.prepareAutomaticResumeAdmission('repair-session');
    const admission = manager.prepareFreshExplicitResumeAdmission('repair-session');
    const stop = () => manager.markStopRequested('repair-session', { reason: 'daemon_stop_session', requestedAtMs: 101 });
    if (externalStop === 'before') stop();
    admission.retireIncumbent({ reason: 'daemon_stop_session', requestedAtMs: 100 });
    expect(oldAutomaticAdmission()).toBe(false);
    expect(admission.isCurrent()).toBe(externalStop !== 'before');
    if (externalStop === 'after') stop();
    admission.complete();
    expect(admission.isCurrent()).toBe(externalStop === 'none');
    expect(manager.prepareAutomaticResumeAdmission('repair-session')()).toBe(externalStop === 'none');
    expect(oldAutomaticAdmission()).toBe(false);
  });

  it.each(['stop', 'stop-then-resume', 'launch-refused'] as const)(
    'keeps a prepared runner from launching after %s', async retirement => {
      vi.useFakeTimers();
      try {
        let finishPreparation!: () => void;
        const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
        const launchedPids: number[] = [];
        let preparationStarted = false;
        const upstreamLaunchAdmission = vi.fn(async () => retirement !== 'launch-refused');
        const manager = createSessionRunnerRespawnManager({
          enabled: true, maxRestarts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
          isSessionAlreadyRunning: async () => false,
          // The process adapter prepares launch resources asynchronously, then invokes
          // the same final admission hook as executeSpawnSessionRequest before OS spawn.
          spawnSession: async options => {
            preparationStarted = true;
            await preparation;
            if (options.beforeSessionRunnerLaunch && !await options.beforeSessionRunnerLaunch()) {
              return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE };
            }
            launchedPids.push(222);
            return { type: 'success', pid: 222 };
          },
          random: () => 0, logDebug: () => {}, logWarn: () => {},
        });
        manager.handleUnexpectedExit({ startedBy: 'daemon', pid: 111, happySessionId: 'prepared-runner',
          spawnOptions: { directory: '/repo', beforeSessionRunnerLaunch: upstreamLaunchAdmission } },
        { reason: 'process-exit', code: 1, signal: null });
        await vi.advanceTimersByTimeAsync(50);
        expect(preparationStarted).toBe(true);
        if (retirement !== 'launch-refused') {
          manager.markStopRequested('prepared-runner', { reason: 'daemon_stop_session', requestedAtMs: 100 });
          if (retirement === 'stop-then-resume') manager.prepareFreshExplicitResumeAdmission('prepared-runner').complete();
        }
        finishPreparation();
        await vi.advanceTimersByTimeAsync(50);
        expect(launchedPids).toEqual([]);
        if (retirement === 'launch-refused') expect(upstreamLaunchAdmission).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('retains a typed startup dependency failure without repeatedly launching the runner', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async () => ({ type: 'success' as const, pid: 222 }));
      const onRespawnTerminal = vi.fn();
      const issue = { v: 1, scope: 'primary_session', status: 'failed',
        source: 'dependency_failure', code: 'profile_missing', occurredAt: 1_100,
        sanitizedPreview: 'Prompt context could not be prepared.' } as const;
      const manager = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: 10, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
        isSessionAlreadyRunning: async () => false, spawnSession, onRespawnTerminal,
        random: () => 0, logDebug: () => {}, logWarn: () => {},
        // Home transport returns the retained issue for this exact exited runner.
        readStartupFailure: async () => issue,
      });
      const tracked: TrackedSession = { startedBy: 'daemon', pid: 111,
        happySessionId: 'startup-failed', processStartTimeMs: 1_000,
        spawnOptions: { directory: '/repo' } };
      expect(manager.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 1, signal: null })).toBe('scheduled');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnSession).not.toHaveBeenCalled();
      expect(onRespawnTerminal).toHaveBeenCalledWith({ sessionId: 'startup-failed', previousPid: 111,
        reason: 'startup_dependency_failure', detail: 'profile_missing' });

      // Unavailable transport is transient; keep ordinary crash recovery reachable.
      for (const code of ['preparation_pending', 'daemon_plugin_catalog_unavailable']) {
        const transientFailure = createSessionRunnerRespawnManager({
          enabled: true, maxRestarts: 10, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
          isSessionAlreadyRunning: async () => false, spawnSession, onRespawnTerminal,
          random: () => 0, logDebug: () => {}, logWarn: () => {},
          readStartupFailure: async () => ({ ...issue, code }),
        });
        transientFailure.handleUnexpectedExit(tracked, { reason: 'process-exit', code: 1, signal: null });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(spawnSession).toHaveBeenCalledOnce();
        spawnSession.mockClear();
      }

      // Explicit Resume starts a fresh occurrence; Home has no matching startup failure.
      const fresh = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: 10, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
        isSessionAlreadyRunning: async () => false, spawnSession,
        random: () => 0, logDebug: () => {}, logWarn: () => {},
        readStartupFailure: async () => issue,
      });
      fresh.handleUnexpectedExit({ ...tracked, pid: 333, processStartTimeMs: 2_000 },
        { reason: 'process-exit', code: 1, signal: null });
      await vi.advanceTimersByTimeAsync(50);
      expect(spawnSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets Stop veto respawn while the Home startup-failure read is pending', async () => {
    vi.useFakeTimers();
    try {
      let finishRead!: () => void;
      const pendingRead = new Promise<null>((resolve) => { finishRead = () => resolve(null); });
      const spawnSession = vi.fn(async () => ({ type: 'success' as const }));
      const manager = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: 10, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
        isSessionAlreadyRunning: async () => false, readStartupFailure: () => pendingRead,
        spawnSession, random: () => 0, logDebug: () => {}, logWarn: () => {},
      });
      manager.handleUnexpectedExit({ startedBy: 'daemon', pid: 111, happySessionId: 'pending-home-read',
        spawnOptions: { directory: '/repo' } }, { reason: 'process-exit', code: 1, signal: null });
      await vi.advanceTimersByTimeAsync(50);
      manager.markStopRequested('pending-home-read', { reason: 'daemon_stop_session', requestedAtMs: 100 });
      finishRead();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resume an old preflight after Stop and a fresh explicit Resume clear its stop intent', async () => {
    vi.useFakeTimers();
    try {
      let finishRead!: () => void;
      const pendingRead = new Promise<null>((resolve) => { finishRead = () => resolve(null); });
      const spawnSession = vi.fn(async () => ({ type: 'success' as const }));
      const manager = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: 10, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
        isSessionAlreadyRunning: async () => false, readStartupFailure: () => pendingRead,
        spawnSession, random: () => 0, logDebug: () => {}, logWarn: () => {},
      });
      manager.handleUnexpectedExit({ startedBy: 'daemon', pid: 111, happySessionId: 'resume-during-read',
        spawnOptions: { directory: '/repo' } }, { reason: 'process-exit', code: 1, signal: null });
      await vi.advanceTimersByTimeAsync(50);
      manager.markStopRequested('resume-during-read', { reason: 'daemon_stop_session', requestedAtMs: 100 });
      manager.prepareFreshExplicitResumeAdmission('resume-during-read').complete();
      finishRead();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops automatic managed-folder recovery without carrying forward prior recreation consent', async () => {
    vi.useFakeTimers();
    const onRespawnTerminal = vi.fn();
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING' }));
    const manager = createSessionRunnerRespawnManager({
      enabled: true, maxRestarts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
      isSessionAlreadyRunning: async () => false, spawnSession, onRespawnTerminal,
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon', pid: 111, happySessionId: 'managed-session',
      spawnOptions: {
        directory: '/private/chat', directoryKind: 'managed', approvedNewDirectoryCreation: true,
        freshSessionCreation: true, managedDirectorySeed: { sourceSessionId: 'source', sourcePath: '/private/source' },
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, resume: 'vendor-1',
      },
    };
    expect(manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null })).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(500);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({ approvedNewDirectoryCreation: false });
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('freshSessionCreation');
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('managedDirectorySeed');
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'session_directory_missing' }));
    vi.useRealTimers();
  });

  it('spawns a replacement runner after an unexpected termination', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'vendor-sess-1' } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-1',
        resume: 'vendor-sess-1',
        approvedNewDirectoryCreation: true,
      }),
    );
  });

  it('uses tracked vendorResumeId when spawnOptions has no resume', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-2',
      vendorResumeId: 'vendor-sess-2',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-2',
        resume: 'vendor-sess-2',
        approvedNewDirectoryCreation: true,
      }),
    );
  });

  it('respawns with the exact bytes of an opaque tracked vendor resume id', async () => {
    vi.useFakeTimers();
    // Respawn hands this id straight back to the Agent. Trimming it turns a
    // silent recovery into a resume of a session the Agent never minted.
    const opaqueVendorResumeId = '  provider\nses/AB+cd==  ';
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-opaque',
      vendorResumeId: opaqueVendorResumeId,
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ resume: opaqueVendorResumeId }),
    );
  });

  it('respawns with the exact bytes of an opaque spawn-options resume id', async () => {
    vi.useFakeTimers();
    const opaqueResume = '  provider\nses/AB+cd==  ';
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-opaque-2',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: opaqueResume,
      } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ resume: opaqueResume }),
    );
  });

  it('terminalizes a required continuation refusal without scheduling a retry', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const onRespawnTerminal = vi.fn();
    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession,
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-continuation-unreachable',
      vendorResumeId: 'provider-thread',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: 78, signal: null },
    )).toBe('terminal');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-continuation-unreachable',
      previousPid: 111,
      reason: 'continuation_unreachable',
    });
  });

  it('suppresses cold resume when startup-instruction effectiveness is unproven', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const onRespawnTerminal = vi.fn();
    const startupInstructionsSentinel =
      'PRIV-R01 startup instructions must not survive Agent session open';
    const startupInstructionsMarker = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 7,
    };

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'global-voice-session',
      vendorResumeId: 'codex-thread',
      agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
      spawnOptions: {
        directory: '/repo',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      } satisfies SpawnSessionOptions,
    } satisfies TrackedSession & Readonly<{
      agentSessionStartupInstructionsMarkerV1: typeof startupInstructionsMarker;
    }>;

    expect(tracked).toHaveProperty(
      'agentSessionStartupInstructionsMarkerV1',
      startupInstructionsMarker,
    );
    expect(JSON.stringify(tracked.spawnOptions)).not.toContain(
      startupInstructionsSentinel,
    );
    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('terminal');

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'global-voice-session',
      reason: 'startup_instructions_cold_resume_unproven',
    }));
  });

  it('allows the daemon to refresh runtime snapshot state before respawn', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const resolveRespawnOptions = vi.fn<RespawnOptionsResolver>(async ({ defaultOptions }) => ({
      ...defaultOptions,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 40,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'fresh-profile',
          },
        },
      },
    }));
    const managerParams: Parameters<typeof createSessionRunnerRespawnManager>[0] & {
      resolveRespawnOptions: RespawnOptionsResolver;
    } = {
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      resolveRespawnOptions,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    };

    const manager = createSessionRunnerRespawnManager(managerParams);

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-snapshot',
      vendorResumeId: 'vendor-snapshot',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } satisfies SpawnSessionOptions,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(resolveRespawnOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-snapshot',
      vendorResumeId: 'vendor-snapshot',
      defaultOptions: expect.not.objectContaining({ resume: expect.anything() }),
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 40,
      connectedServices: expect.objectContaining({
        bindingsByServiceId: expect.objectContaining({
          'claude-subscription': expect.objectContaining({ profileId: 'fresh-profile' }),
        }),
      }),
    }));
  });

  it('drops whitespace-only resume values before respawn', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-3',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: '   ',
      } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.not.objectContaining({ resume: expect.anything() }));
  });

  it('does not respawn sessions that were not started by the daemon', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'user-session',
      pid: 111,
      happySessionId: 'sess-user',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('forces respawn for connected-service restart requests even when general respawn is disabled', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: false,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-connected-service-restart',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, resume: 'codex-thread' } as any,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess-connected-service-restart',
      resume: 'codex-thread',
    }));
  });

  it('does not delay connected-service restart requests behind crash-respawn backoff', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-connected-service-immediate-restart',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'claude-thread' } as any,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess-connected-service-immediate-restart',
      resume: 'claude-thread',
    }));
  });

  it('suppresses respawn when stop was requested', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    manager.markStopRequested('sess-1', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(0);
  });

  it('lets an explicit stop veto a pending connected-service forced restart', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    manager.markStopRequested('sess-1', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
      { forceRestart: true },
    )).toBe('ignored');
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not let an older resume admission clear a newer stop request', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess-stop-race' }));
    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 112,
      happySessionId: 'sess-stop-race',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.markStopRequested('sess-stop-race', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    const completeAdmission = manager.prepareFreshExplicitResumeAdmission('sess-stop-race');
    manager.markStopRequested('sess-stop-race', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_001,
    });
    completeAdmission.complete();

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
      { forceRestart: true },
    )).toBe('ignored');
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not respawn when stop is requested while the running-session preflight is pending', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    let resolvePreflight: (alreadyRunning: boolean) => void = () => {
      throw new Error('preflight resolver was not initialized');
    };
    const isSessionAlreadyRunning = vi.fn(async () =>
      new Promise<boolean>((resolve) => {
        resolvePreflight = resolve;
      }),
    );
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stop-during-running-preflight',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stop-during-running-preflight', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    resolvePreflight(false);
    await vi.runAllTimersAsync();

    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-stop-during-running-preflight',
      reason: 'stop_requested',
    }));
  });

  it('does not respawn when stop is requested while respawn options are resolving', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    let resolveOptions: (options: SpawnSessionOptions) => void = () => {
      throw new Error('respawn options resolver was not initialized');
    };
    const resolveRespawnOptions = vi.fn<RespawnOptionsResolver>(async ({ defaultOptions }) =>
      new Promise<SpawnSessionOptions>((resolve) => {
        resolveOptions = () => resolve(defaultOptions);
      }),
    );
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      resolveRespawnOptions,
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stop-during-options',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(resolveRespawnOptions).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stop-during-options', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    resolveOptions({ directory: '/tmp' } as SpawnSessionOptions);
    await vi.runAllTimersAsync();

    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-stop-during-options',
      reason: 'stop_requested',
    }));
  });

  it('resets restart state when a replacement session is already running before the timer fires', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const isSessionAlreadyRunning = vi
      .fn<() => boolean>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(0);

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);

    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('retries respawn when spawnSession returns a non-success result', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ type: 'error' as const, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-1' });

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('cancels a scheduled retry when Stop arrives in the no-runner respawn gap', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ type: 'error' as const, errorCode: 'SPAWN_FAILED', errorMessage: 'stale source dependency' })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-stop-retry-gap' });

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stop-retry-gap',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stop-retry-gap', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('treats resume-not-supported as terminal instead of retrying a permanent refusal', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async () => ({
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      errorMessage: 'Resume is not supported for this Agent',
    }));
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession,
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-resume-not-supported',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(onRespawnTerminal).toHaveBeenCalledTimes(1);
    expect(onRespawnTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-resume-not-supported',
      previousPid: 111,
      reason: 'resume_not_supported',
      detail: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
    });
  });

  it('counts a pre-webhook child exit once when spawn result precedes staged exit notification', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: 'replacement exited before webhook',
      })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-pre-webhook-exit' });
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked = (pid: number): TrackedSession => ({
      startedBy: 'daemon',
      pid,
      happySessionId: 'sess-pre-webhook-exit',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    // The real spawn path resolves the error before durable exit staging invokes this notification.
    expect(manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited-before-webhook', code: null, signal: null },
    )).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(onRespawnTerminal).not.toHaveBeenCalled();
  });

  it('bounds successful respawns whose replacement runners immediately crash', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, sessionId: 'sess-quick-crash' }));
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked = (pid: number): TrackedSession => ({
      startedBy: 'daemon',
      pid,
      happySessionId: 'sess-quick-crash',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    manager.handleUnexpectedExit(tracked(222), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(2);

    expect(manager.handleUnexpectedExit(
      tracked(333),
      { reason: 'process-exited', code: 1, signal: null },
    )).toBe('terminal');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-quick-crash',
      previousPid: 333,
      reason: 'no_restart',
      detail: 'max_restarts_exceeded:2',
    }));
  });

  it('restores the crash budget after a replacement runner remains stable', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, sessionId: 'sess-stable' }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      stabilityWindowMs: 100,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked = (pid: number): TrackedSession => ({
      startedBy: 'daemon',
      pid,
      happySessionId: 'sess-stable',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited', code: 1, signal: null },
    )).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('discards retained crash state when stop is requested during the stability window', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, sessionId: 'sess-stopped' }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      stabilityWindowMs: 100,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked = (pid: number): TrackedSession => ({
      startedBy: 'daemon',
      pid,
      happySessionId: 'sess-stopped',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stopped', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });
    manager.prepareFreshExplicitResumeAdmission('sess-stopped').complete();
    expect(manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited', code: 1, signal: null },
    )).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('suppresses respawn retries when spawnSession returns not_authenticated', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn().mockResolvedValue({
      type: 'error' as const,
      errorCode: 'not_authenticated',
      errorMessage: 'expired token',
    });
    const logWarn = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn,
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stale-auth',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      '[DAEMON RUN] Respawn suppressed for session sess-stale-auth (spawn:not_authenticated)',
    );

    await vi.advanceTimersByTimeAsync(150);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('retries respawn when the running-session preflight throws', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const isSessionAlreadyRunning = vi
      .fn<() => boolean>()
      .mockRejectedValueOnce(new Error('preflight offline'))
      .mockResolvedValueOnce(false);

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-preflight-retry',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('suppresses respawn when a running-session preflight failure exhausts retries', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const isSessionAlreadyRunning = vi
      .fn<() => boolean>()
      .mockRejectedValueOnce(new Error('preflight offline 1'));
    const logWarn = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn,
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-preflight-exhausted',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);

    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledTimes(0);
    expect(logWarn).toHaveBeenCalledWith(
      '[DAEMON RUN] Session sess-preflight-exhausted crashed; respawn suppressed (max_restarts_exceeded:1)',
    );
  });
});

describe('createSessionRunnerRespawnManager intended-restart storms (RR-2 cross-cycle)', () => {
  function createTracked(): TrackedSession {
    return {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-storm',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'vendor-1' } as any,
    } as TrackedSession;
  }

  it('refuses the N+1th SUCCESSFUL intended restart within the window loudly', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 222 }));
      const warns: string[] = [];
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 5,
        maxIntendedRestarts: 2,
        intendedRestartWindowMs: 30 * 60_000,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession: (opts) => spawnSession(opts),
        random: () => 0,
        logDebug: () => {},
        logWarn: (message) => warns.push(message),
      });

      // Two intended (connected-service) restarts; each respawn SUCCEEDS (cycle ends successfully).
      for (let i = 0; i < 2; i += 1) {
        manager.handleUnexpectedExit(createTracked(), { reason: 'connected-service-restart', code: null, signal: null }, { forceRestart: true });
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(spawnSession).toHaveBeenCalledTimes(2);

      // The third intended restart within the window is REFUSED despite the successful cycles.
      manager.handleUnexpectedExit(createTracked(), { reason: 'connected-service-restart', code: null, signal: null }, { forceRestart: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(warns.some((message) => message.includes('max_intended_restarts_exceeded'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires retained intended-restart state when its existing rolling window elapses', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 222 }));
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 2,
        maxIntendedRestarts: 1,
        intendedRestartWindowMs: 100,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession: (opts) => spawnSession(opts),
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      manager.handleUnexpectedExit(
        createTracked(),
        { reason: 'connected-service-restart', code: null, signal: null },
        { forceRestart: true },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(vi.getTimerCount()).toBe(0);
      expect(manager.handleUnexpectedExit(
        createTracked(),
        { reason: 'connected-service-restart', code: null, signal: null },
        { forceRestart: true },
      )).toBe('scheduled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a genuine crash after a successful intended restart still respawns (crash budget untouched)', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 222 }));
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 2,
        maxIntendedRestarts: 1,
        intendedRestartWindowMs: 30 * 60_000,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession: (opts) => spawnSession(opts),
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      // One successful intended restart consumes the whole intended budget.
      manager.handleUnexpectedExit(createTracked(), { reason: 'connected-service-restart', code: null, signal: null }, { forceRestart: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(1);

      // A genuine crash afterwards still respawns on the untouched crash budget.
      manager.handleUnexpectedExit(createTracked(), { reason: 'process-missing', code: null, signal: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a transient spawn override for exactly the first respawn attempt without mutating durable tracked options', async () => {
    vi.useFakeTimers();
    try {
      const durableSpawnOptions = {
        directory: '/repo',
        resume: 'vendor-1',
      };
      const transientSpawnOptions = {
        ...durableSpawnOptions,
        providerBindingSecurityChangeConfirmationV1: {
          v: 1 as const,
          sessionId: 'sess-1',
          connectionId: 'pc_gateway' as ProviderConnectionId,
          previousBindingSecurityFingerprint: 'binding-security:v1:a',
          nextBindingSecurityFingerprint: 'binding-security:v1:b',
        },
      };
      const tracked: TrackedSession = {
        ...createTracked(),
        spawnOptions: durableSpawnOptions,
      };
      const spawnSession = vi
        .fn()
        .mockResolvedValueOnce({ type: 'error', errorCode: 'first_attempt_failed' })
        .mockResolvedValueOnce({ type: 'success', pid: 222 });
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 3,
        maxIntendedRestarts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession,
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      manager.handleUnexpectedExit(
        tracked,
        { reason: 'connected-service-restart', code: null, signal: null },
        { forceRestart: true, spawnOptionsOverride: transientSpawnOptions },
      );

      expect(tracked.spawnOptions).toBe(durableSpawnOptions);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({
        providerBindingSecurityChangeConfirmationV1: transientSpawnOptions.providerBindingSecurityChangeConfirmationV1,
      });
      expect(spawnSession.mock.calls[1]?.[0]).not.toHaveProperty('providerBindingSecurityChangeConfirmationV1');
      expect(tracked.spawnOptions).toBe(durableSpawnOptions);
    } finally {
      vi.useRealTimers();
    }
  });
});
