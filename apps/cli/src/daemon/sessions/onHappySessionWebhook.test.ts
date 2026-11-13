import { bindTrackedSessionIdentity } from './sessionReportCorrelation';
import { createPersistedTakeoverAdmissionWaiter } from '../spawn/persistedTakeoverAdmission';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createOnChildExited } from './onChildExited';
import { promoteSessionMarkerPid, readSessionMarker, writeSessionMarker } from '../sessionRegistry';
import { spawnInlineNodeParentWithChild, spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { once } from 'node:events';

import {
  createOnDaemonSessionStartupFailure,
  createOnHappySessionWebhook,
  resolveSessionWebhookPath,
} from './onHappySessionWebhook';
import {
  armSessionWebhookStartupCustody,
  waitForSessionWebhook,
} from '../spawn/waitForSessionWebhook';
import { hashProcessCommand } from '../sessionRegistry';
import { readProcessIdentityByPid } from '../processIdentity';
import { serializeWindowsCommandLine } from '../platform/windows/windowsCommandLine';
import { probeSessionRunnerPresence } from './isSessionRunnerActive';
import { resolveExistingSessionSpawnPreGate } from '../spawn/resolveExistingSessionSpawnPreGate';
import { resolveSessionRunnerRuntimeState } from '../sessionRunnerRuntime/resolveRuntimeState';
import { buildSessionRunnerRuntimeRefreshRequestV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { restartSessionRunnerOnCurrentRuntime } from '../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { legacyPidSessionTrackingKey, trackedSessionsForProcess, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

function createMetadata(pid: number, startedBy: 'daemon' | 'terminal', rootPath = '/tmp'): Metadata {
  return {
    path: rootPath,
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy,
    machineId: 'machine-test',
  };
}

describe('createOnHappySessionWebhook', () => {
  it.each(['current', 'reused'] as const)('qualifies the captured runner marker before fresh wrapper startup readiness (%s)', async (generation) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'happier-wrapper-startup-marker-'));
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...originalHome, value: dir });
    try {
      const wrapperPid = 649121;
      const runnerPid = 649122;
      const sessionId = 'session-wrapper-startup';
      const readIdentity = async (pid: number) => ({
        pid,
        processStartTimeMs: pid === wrapperPid ? 12_345 : 23_456,
        command: pid === wrapperPid ? '/runtime/scope-exit' : '/runtime/versions/1.2.3/bin/happier claude --happy-starting-mode remote --started-by daemon',
      });
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon', happySessionId: `PID-${wrapperPid}`,
        agentRuntimeDaemonServiceAuthorityFilePath: path.join(dir, 'authority.json'),
        acceptedSpawnMarkerGate: Promise.resolve(true),
        spawnOptions: { directory: dir, backendTarget: { kind: 'backend', backendId: 'claude' }, spawnNonce: 'wrapper-launch', resume: 'retained-thread' },
      };
      await writeSessionMarker({
        trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, happySessionId: `PID-${wrapperPid}`, startedBy: 'daemon', cwd: dir,
        processStartTimeMs: 12_345,
        respawn: { version: 1, directory: dir, backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, spawnNonce: 'wrapper-launch' },
      });
      if (generation === 'reused') {
        await writeSessionMarker({
          trackingKey: tracked.trackingKey, pid: runnerPid, happySessionId: sessionId, startedBy: 'daemon', cwd: dir, processStartTimeMs: 23_455,
          respawn: { version: 1, directory: dir, backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, spawnNonce: 'wrapper-launch' },
        });
      }
      const sessions = new Map([[tracked.trackingKey, tracked]]);
      const awaiter = vi.fn();
      const onTrackedSessionReady = vi.fn(async () => {
        expect(await readSessionMarker(tracked.trackingKey)).toMatchObject({
          pid: runnerPid, happySessionId: sessionId, processStartTimeMs: 23_456,
          agentRuntimeDaemonServiceAuthorityFilePath: tracked.agentRuntimeDaemonServiceAuthorityFilePath,
        });
        expect(sessions.get(legacyPidSessionTrackingKey(wrapperPid))).toBe(tracked);
        expect(tracked.pid).toBe(wrapperPid);
        expect(tracked.processStartTimeMs).toBe(12_345);
        expect(tracked.runnerProcessIdentity).toMatchObject({ pid: runnerPid, processStartTimeMs: 23_456 });
        const currentIdentity = { status: 'known', source: 'launch_spec', comparableId: 'version:1.2.4', entrypointVersion: '1.2.4' } as const;
        const state = resolveSessionRunnerRuntimeState({ sessionId, tracked, currentIdentity });
        expect(state.runner).toMatchObject({ pid: wrapperPid, runtimeId: 'version:1.2.3', startingMode: 'remote' });
        expect(state.plannedRestart).toMatchObject({ eligible: true, disabledReason: null });
        const request = buildSessionRunnerRuntimeRefreshRequestV1(state);
        expect(request).toMatchObject({ expectedRunnerPid: wrapperPid,
          expectedProcessCommandHash: hashProcessCommand('/runtime/scope-exit'), expectedRunnerEntrypointIdentity: 'version:1.2.3' });
        if ('ok' in request) throw new Error('Expected guarded runner refresh');
        const requestRestart = vi.fn();
        expect(await restartSessionRunnerOnCurrentRuntime({ tracked, currentIdentity,
          request: { ...request, dryRun: true }, requestRestart })).toMatchObject({ ok: true, status: 'dry_run_restartable' });
        expect(requestRestart).not.toHaveBeenCalled();
        const changedRunner = resolveSessionRunnerRuntimeState({ sessionId, currentIdentity,
          tracked: { ...tracked, sessionRunnerPid: runnerPid + 1 } });
        expect(changedRunner.runner).toMatchObject({ runtimeId: null, startingMode: 'unknown' });
        expect(buildSessionRunnerRuntimeRefreshRequestV1(changedRunner)).toMatchObject({
          ok: false, reasonCode: 'runner_entrypoint_unknown',
        });
      });
      const report = createOnHappySessionWebhook({
        trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(wrapperPid), awaiter]]),
        getParentPidFn: () => wrapperPid,
        readProcessIdentityByPidFn: readIdentity,
        // The OS identity read is the boundary; the marker promotion and persistence remain real.
        promoteSessionMarkerFn: (input) => promoteSessionMarkerPid(input, { readProcessIdentityByPidFn: readIdentity }),
        readCredentialsFn: async () => null,
        onTrackedSessionReady,
      });
      const reporting = report(sessionId, createMetadata(runnerPid, 'daemon', dir));
      if (generation === 'reused') {
        // One marker per Session: a stale runner generation already recorded on the
        // Session's own marker fails canonical adoption before readiness.
        await expect(reporting).rejects.toThrow('session_marker_canonical_adoption_ownership_mismatch');
        expect(onTrackedSessionReady).not.toHaveBeenCalled();
      } else {
        await reporting;
        expect(onTrackedSessionReady).toHaveBeenCalledOnce();
      }
      expect(awaiter).toHaveBeenCalledOnce();
      expect((await readSessionMarker(legacyPidSessionTrackingKey(wrapperPid)))?.happySessionId).toBe(sessionId);
    } finally {
      Object.defineProperty(configuration, 'happyHomeDir', originalHome);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the Session materialized-state observation binding on an existing-Session runner marker', async () => {
    // A reattaching daemon reads only the runner marker. Losing the binding there
    // makes every shared-state transcript follow fail after a daemon replacement.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'happier-runner-marker-binding-'));
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...originalHome, value: dir });
    try {
      const wrapperPid = 649131;
      const runnerPid = 649132;
      const sessionId = 'session-existing-runner-binding';
      const binding = {
        agentId: 'claude', pluginId: 'happier.agent.claude',
        sourceCustody: { kind: 'development' as const, registeredRootId: path.join(dir, 'plugins', 'claude') },
        nativeHomeRoot: path.join(dir, 'home', 'claude-config'),
        entries: [{ entryPath: 'projects', sourceEntryRoot: path.join(dir, 'native', 'projects'),
          materializedEntryPath: path.join(dir, 'home', 'claude-config', 'projects') }],
      };
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon', happySessionId: sessionId,
        agentRuntimeDaemonServiceAuthorityFilePath: path.join(dir, 'authority.json'),
        materializedStateObservationBinding: binding,
        spawnOptions: { directory: dir, backendTarget: { kind: 'backend', backendId: 'claude' },
          spawnNonce: 'existing-launch', existingSessionId: sessionId },
      };
      const sessions = new Map([[tracked.trackingKey, tracked]]);
      const report = createOnHappySessionWebhook({
        trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(wrapperPid), vi.fn()]]),
        getParentPidFn: () => wrapperPid,
        // The OS identity read is the boundary; marker persistence stays real.
        readProcessIdentityByPidFn: async (pid) => ({ pid, processStartTimeMs: pid === wrapperPid ? 1_000 : 2_000,
          command: pid === wrapperPid ? '/runtime/scope-exit' : '/runtime/bin/happier claude --started-by daemon' }),
        readCredentialsFn: async () => null,
      });
      await report(sessionId, createMetadata(runnerPid, 'daemon', dir));
      await tracked.reportMarkerCustody?.pending;
      expect(await readSessionMarker(tracked.trackingKey)).toMatchObject({
        pid: runnerPid, happySessionId: sessionId, materializedStateObservationBinding: binding,
      });
    } finally {
      Object.defineProperty(configuration, 'happyHomeDir', originalHome);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not replace the latest reported runner PID with a delayed earlier identity read', async () => {
    const wrapperPid = 649125;
    const firstRunnerPid = 649126;
    const latestRunnerPid = 649127;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon', happySessionId: `PID-${wrapperPid}` };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(wrapperPid), () => {}]]);
    let releaseFirst!: () => void;
    let releaseLatest!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const latestGate = new Promise<void>((resolve) => { releaseLatest = resolve; });
    let firstRead = false;
    let latestRead = false;
    const report = createOnHappySessionWebhook({
      trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters, getParentPidFn: () => wrapperPid,
      // Different reports enter the real owner before their queued OS reads complete.
      readProcessIdentityByPidFn: async (pid) => {
        if (pid === firstRunnerPid) { firstRead = true; await firstGate; }
        if (pid === latestRunnerPid) { latestRead = true; await latestGate; }
        return { pid, processStartTimeMs: 2000, command: 'runner' };
      },
      writeSessionMarkerFn: async () => {}, listSessionMarkersFn: async () => [], readCredentialsFn: async () => null,
    });
    try {
      await report(`PID-${firstRunnerPid}`, createMetadata(firstRunnerPid, 'daemon'));
      await vi.waitFor(() => expect(firstRead).toBe(true));
      await report(`PID-${latestRunnerPid}`, createMetadata(latestRunnerPid, 'daemon'));
      expect(tracked.sessionRunnerPid).toBe(latestRunnerPid);
      releaseFirst();
      await vi.waitFor(() => expect(latestRead).toBe(true));
      expect(tracked.sessionRunnerPid).toBe(latestRunnerPid);
      expect(tracked.runnerProcessIdentity?.pid).not.toBe(firstRunnerPid);
      releaseLatest();
      await tracked.reportMarkerCustody?.pending;
      expect(tracked.runnerProcessIdentity?.pid).toBe(latestRunnerPid);
    } finally {
      releaseFirst(); releaseLatest();
      await tracked.reportMarkerCustody?.pending;
    }
  });

  it('retains startup and fences Resume while a reported wrapper runner generation is still being read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'happier-pending-wrapper-marker-'));
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    onTestFinished(async () => {
      Object.defineProperty(configuration, 'happyHomeDir', originalHome);
      await rm(dir, { recursive: true, force: true });
    });
    Object.defineProperty(configuration, 'happyHomeDir', { ...originalHome, value: dir });
    const wrapperPid = 649124;
    const runnerPid = process.pid;
    const sessionId = 'session-report-generation-pending';
    const runnerIdentity = await readProcessIdentityByPid(runnerPid);
    if (runnerIdentity?.processStartTimeMs === undefined || !runnerIdentity.command) {
      throw new Error('Test requires current runner generation evidence');
    }
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon', happySessionId: `PID-${wrapperPid}`,
      processStartTimeMs: 1000, spawnOptions: { directory: '/tmp', spawnNonce: 'pending-wrapper-launch' },
      agentRuntimeDaemonServiceAuthorityFilePath: '/tmp/fixture-session-authority',
    };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const completion = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
      spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts,
      timeoutErrorMessage: 'Fixture webhook timeout',
    });
    armSessionWebhookStartupCustody(tracked, completion, Promise.resolve());
    let releaseIdentity!: () => void;
    const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    let releaseReadiness!: () => void;
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    let identityReadStarted = false;
    const readIdentity = async (pid: number) => {
      if (pid !== runnerPid) return { pid, processStartTimeMs: 1000, command: 'wrapper' };
      identityReadStarted = true;
      await identityGate;
      return runnerIdentity;
    };
    await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, happySessionId: `PID-${wrapperPid}`, startedBy: 'daemon',
      processStartTimeMs: 1000, respawn: { version: 1, directory: '/tmp', spawnNonce: 'pending-wrapper-launch' } });
    const promoteMarker = (input: Parameters<typeof promoteSessionMarkerPid>[0]) => promoteSessionMarkerPid(input,
      { readProcessIdentityByPidFn: readIdentity });
    const report = createOnHappySessionWebhook({
      trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
      getParentPidFn: () => wrapperPid,
      // Hold the OS read after the real report owner records its runner PID.
      readProcessIdentityByPidFn: readIdentity,
      promoteSessionMarkerFn: promoteMarker,
      readCredentialsFn: async () => null,
    });
    const reporting = report(sessionId, createMetadata(runnerPid, 'daemon'), async () => await readinessGate);
    const readState = async (pid: number) => pid === wrapperPid ? 'dead' as const : 'servable' as const;
    const exit = createOnChildExited({
      trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      processPresenceDependencies: { readProcessRunState: readState, readProcessIdentityByPid },
      promoteSessionMarkerFn: promoteMarker,
    });
    try {
      await vi.waitFor(() => expect(identityReadStarted).toBe(true));
      expect(tracked.sessionRunnerPid).toBe(runnerPid);
      expect(tracked.runnerProcessIdentity).toBeUndefined();
      const resumed = await resolveExistingSessionSpawnPreGate({
        existingSessionId: sessionId, trackedSessionsByKey: sessions,
        probeSessionRunnerPresence: async (id) => await probeSessionRunnerPresence({
          sessionId: id, trackedSessions: sessions.values(), readProcessRunState: readState,
          readProcessIdentityByPid, readSessionRunnerLockStatus: async () => ({ ok: false, reason: 'not_found' }),
        }),
        pendingSessionStartup: {
          spawnAwaiterByKey: awaiters, machineId: 'machine-test', happyHomeDir: configuration.happyHomeDir,
          readSessionMetadata: async () => null,
        },
        waitForExitTimeoutMs: 0, waitForExitPollIntervalMs: 1, logDebug: () => {}, logWarn: () => {},
      });
      expect(resumed.shortCircuitResult).toMatchObject({ type: 'error', errorCode: 'UNEXPECTED' });
      await exit(wrapperPid, { reason: 'process-missing', code: null, signal: null });
      expect(sessions.get(tracked.trackingKey)).toBe(tracked);
      expect(tracked.pid).toBe(wrapperPid);
      expect(completion.isPending()).toBe(true);
      releaseIdentity();
      await vi.waitFor(() => expect(tracked.runnerProcessIdentity?.pid).toBe(runnerPid));
      releaseReadiness();
      await reporting;
      await expect(completion).resolves.toMatchObject({ type: 'success', sessionId });
      await exit(wrapperPid, { reason: 'process-missing', code: null, signal: null });
      expect(sessions.get(tracked.trackingKey)).toBe(tracked);
      expect(tracked.pid).toBe(runnerPid);
      expect(trackedSessionsForProcess(sessions, wrapperPid)).toEqual([]);
    } finally {
      releaseIdentity(); releaseReadiness();
      completion.settleFailure({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Fixture cleanup' });
      await Promise.allSettled([reporting, completion, tracked.reportMarkerCustody?.pending]);
      for (const timeout of timeouts.values()) clearTimeout(timeout);
    }
  });

  it('preserves canonical marker custody validation after early fresh-session identity binding', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'happier-early-startup-marker-'));
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    // Isolate the real persistence owner through its environment boundary.
    Object.defineProperty(configuration, 'happyHomeDir', { ...originalHome, value: dir });
    try {
      const pid = 649123;
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'PID-' + pid,
        agentRuntimeDaemonServiceAuthorityFilePath: path.join(dir, 'authority.json'),
        acceptedSpawnMarkerGate: Promise.resolve(true),
        spawnOptions: { directory: dir, backendTarget: { kind: 'backend', backendId: 'claude' }, spawnNonce: 'current-launch' },
      };
      await writeSessionMarker({
        trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'PID-' + pid, startedBy: 'daemon', cwd: dir, processStartTimeMs: 123456,
        respawn: { version: 1, directory: dir, backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, spawnNonce: 'different-launch' },
      });
      bindTrackedSessionIdentity(tracked, 'session-before-webhook');
      const onTrackedSessionReady = vi.fn();
      const report = createOnHappySessionWebhook({
        trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]), spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(pid), () => {}]]),
        readProcessIdentityByPidFn: async () => ({ pid, processStartTimeMs: 123456, command: '/runtime/versions/1.2.3/bin/happier claude' }),
        readCredentialsFn: async () => null, onTrackedSessionReady,
      });
      await expect(report('session-before-webhook', createMetadata(pid, 'daemon', dir)))
        .rejects.toThrow('session_marker_canonical_adoption_ownership_mismatch');
      expect((await readSessionMarker(legacyPidSessionTrackingKey(pid)))?.happySessionId).toBe('PID-' + pid);
      expect(onTrackedSessionReady).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(configuration, 'happyHomeDir', originalHome);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('registers accepted canonical Sessions only after startup readiness, preserving their nested directory', async () => {
    const accepted: string[] = [];
    const metadata = createMetadata(process.pid, 'daemon', '/repo/packages/app');
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', happySessionId: `PID-${process.pid}` };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const report = createOnHappySessionWebhook({
      trackedSessionsByKey: sessions,
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(process.pid), () => {}]]),
      readProcessIdentityByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      readCredentialsFn: async () => null,
      // The callback is the external persistence effect; admission stays real.
      registerAcceptedWorkspace: async (acceptedMetadata) => { accepted.push(acceptedMetadata.path); },
    });
    await report(`PID-${process.pid}`, metadata);
    expect(accepted).toEqual([]);
    await expect(report('rejected-session', metadata, async () => { throw new Error('readiness refused'); }))
      .rejects.toThrow('readiness refused');
    expect(accepted).toEqual([]);

    const foreground = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(),
      readProcessIdentityByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      registerAcceptedWorkspace: async (acceptedMetadata) => { accepted.push(acceptedMetadata.path); },
    });
    await foreground('wrong-stack', { ...metadata, startedBy: 'terminal', happyHomeDir: 'another-stack' });
    await foreground('missing-pid', { ...metadata, startedBy: 'terminal', hostPid: undefined });
    expect(accepted).toEqual([]);
    await foreground('accepted-foreground', { ...metadata, startedBy: 'terminal' });
    await vi.waitFor(() => expect(accepted).toEqual(['/repo/packages/app']));

    const daemonTracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', happySessionId: `PID-${process.pid}` };
    const daemon = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map([[daemonTracked.trackingKey, daemonTracked]]),
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(process.pid), () => {}]]),
      readProcessIdentityByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      readCredentialsFn: async () => null,
      registerAcceptedWorkspace: async (acceptedMetadata) => { accepted.push(acceptedMetadata.path); },
    });
    await daemon('accepted-daemon', metadata, async () => { expect(accepted).toHaveLength(1); });
    await vi.waitFor(() => expect(accepted).toEqual(['/repo/packages/app', '/repo/packages/app']));
  });
  it.skipIf(process.platform === 'win32')('cannot revive a superseded wrapper marker when its real process census completes after strict promotion', async () => {
    const previousHome = configuration.happyHomeDir;
    const home = await mkdtemp(path.join(os.tmpdir(), 'happier-wrapper-marker-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: home });
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const pid = parent.pid!;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: `PID-${pid}`, sessionRunnerPid: childPid, childProcess: parent };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    let releaseCensus!: () => void;
    const census = new Promise<void>((resolve) => { releaseCensus = resolve; });
    let censusEntered = false;
    const report = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map(),
      readProcessIdentityByPidFn: async (reportedPid) => {
        if (reportedPid === pid) { censusEntered = true; await census; }
        return readProcessIdentityByPid(reportedPid);
      },
      findHappyProcessByPidFn: async () => null });
    const exit = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
    try {
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: `PID-${pid}`, startedBy: 'daemon' });
      await report(`PID-${pid}`, createMetadata(pid, 'daemon'));
      await vi.waitFor(() => expect(censusEntered).toBe(true));
      const exited = once(parent, 'exit');
      parent.kill('SIGTERM');
      await exited;
      await exit(pid, { reason: 'process-exited', code: 0, signal: null });
      // The Session keeps its key; promotion moves only its hosting pid.
      expect(sessions.get(tracked.trackingKey)).toBe(tracked);
      expect(tracked.pid).toBe(childPid);
      const promotedMarker = await readSessionMarker(tracked.trackingKey);
      expect(promotedMarker?.pid).toBe(childPid);
      releaseCensus();
      await tracked.reportMarkerCustody?.pending;
      // The late wrapper census cannot revive the wrapper pid on the Session's one marker.
      expect(await readSessionMarker(tracked.trackingKey)).toEqual(promotedMarker);
    } finally {
      releaseCensus();
      await tracked.reportMarkerCustody?.pending;
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
  it('rejects a positively dead untracked daemon report without changing live or terminal-origin registration', async () => {
    const child = spawnInlineNodeTestProcess('');
    const pid = child.pid!;
    await once(child, 'exit');
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const report = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null, readProcessIdentityByPidFn: async () => null,
      findHappyProcessByPidFn: async () => null, writeSessionMarkerFn: async () => {} });
    await report(`PID-${pid}`, createMetadata(pid, 'daemon'));
    expect(trackedSessionsForProcess(sessions, pid)).toHaveLength(0);
    await report(`PID-${process.pid}`, createMetadata(process.pid, 'daemon'));
    expect(trackedSessionsForProcess(sessions, process.pid)).toHaveLength(1);
    await report(`PID-${pid}`, createMetadata(pid, 'terminal'));
    expect(trackedSessionsForProcess(sessions, pid)).toHaveLength(1);
  });
  it.skipIf(process.platform === 'win32')('re-correlates accepted custody installed during the real process-state probe', async () => {
    const child = spawnInlineNodeTestProcess('');
    const pid = child.pid!;
    await once(child, 'exit');
    const sessions = new Map<SessionTrackingKey, TrackedSession>();
    const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: `PID-${pid}` };
    let completion: ReturnType<typeof waitForSessionWebhook> | undefined;
    const kill = process.kill;
    const probe = vi.spyOn(process, 'kill').mockImplementation((reportedPid, signal) => {
      if (reportedPid === pid && signal === 0 && !completion) {
        sessions.set(tracked.trackingKey, tracked);
        completion = waitForSessionWebhook({ trackingKey: legacyPidSessionTrackingKey(pid), pid, trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
          spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts, timeoutErrorMessage: 'Fixture timeout' });
      }
      return kill(reportedPid, signal);
    });
    const report = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
      readProcessIdentityByPidFn: async () => null, findHappyProcessByPidFn: async () => null,
      readCredentialsFn: async () => null, writeSessionMarkerFn: async () => {} });
    try {
      await report('session-admitted-during-probe', createMetadata(pid, 'daemon'));
      expect(sessions.get(legacyPidSessionTrackingKey(pid))).toBe(tracked);
      expect(completion).toBeDefined();
      await expect(completion).resolves.toMatchObject({ type: 'success', sessionId: 'session-admitted-during-probe' });
    } finally {
      probe.mockRestore();
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      completion?.settleFailure({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Fixture cleanup' });
    }
  });
  it.each(['daemon', 'terminal'] as const)('drains correlated %s report marker work before actual exit retirement', async (origin) => {
    const previousHome = configuration.happyHomeDir;
    const home = await mkdtemp(path.join(os.tmpdir(), 'happier-report-retirement-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: home });
    const pid = 4812;
    const sessionId = `PID-${pid}`;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: origin === 'daemon' ? 'daemon' : 'happy directly - likely by user from terminal', happySessionId: sessionId };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    let releaseCensus!: () => void;
    const census = new Promise<void>((resolve) => { releaseCensus = resolve; });
    let censusEntered = false;
    let written = false;
    const report = createOnHappySessionWebhook({
      trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map(),
      readProcessIdentityByPidFn: async () => { censusEntered = true; await census; return null; },
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (...args) => { await writeSessionMarker(...args); written = true; },
    });
    const exit = createOnChildExited({ trackedSessionsByKey: sessions,
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
    let exiting: Promise<void> | undefined;
    try {
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: sessionId, startedBy: origin });
      await report(sessionId, createMetadata(pid, origin));
      await vi.waitFor(() => expect(censusEntered).toBe(true));
      let retired = false;
      exiting = exit(pid, { reason: 'process-exited', code: 0, signal: null }).then(() => { retired = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retired).toBe(false);
      releaseCensus();
      await exiting;
      await vi.waitFor(() => expect(written).toBe(true));
      expect(sessions.has(legacyPidSessionTrackingKey(pid))).toBe(false);
      expect(await readSessionMarker(legacyPidSessionTrackingKey(pid))).toBeNull();
    } finally {
      releaseCensus();
      await exiting;
      await vi.waitFor(() => expect(written).toBe(true));
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
  it.each(['daemon', 'terminal'] as const)('does not change retiring %s marker identity on a first late canonical report', async (origin) => {
    const previousHome = configuration.happyHomeDir;
    const home = await mkdtemp(path.join(os.tmpdir(), 'happier-retiring-report-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: home });
    const pid = 4813;
    const sessionId = `PID-${pid}`;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: origin === 'daemon' ? 'daemon' : 'happy directly - likely by user from terminal', happySessionId: sessionId };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const resourcePath = path.join(home, 'owned-resource');
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupEntered = false;
    const exit = createOnChildExited({ trackedSessionsByKey: sessions,
      spawnResourceCleanupByKey: new Map([[tracked.trackingKey, async () => { cleanupEntered = true; await cleanup; await unlink(resourcePath); }]]),
      sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
    const report = createOnHappySessionWebhook({ trackedSessionsByKey: sessions, spawnAwaiterByKey: new Map(),
      readProcessIdentityByPidFn: async () => null, findHappyProcessByPidFn: async () => null,
      readCredentialsFn: async () => null });
    let exiting: Promise<void> | undefined;
    try {
      await writeFile(resourcePath, 'fixture');
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: sessionId, startedBy: origin });
      exiting = exit(pid, { reason: 'process-exited', code: 0, signal: null });
      await vi.waitFor(() => expect(cleanupEntered).toBe(true));
      await expect(report('session-late-canonical-report', createMetadata(pid, origin))).rejects.toThrow('retiring');
      releaseCleanup();
      await exiting;
      expect(await readSessionMarker(legacyPidSessionTrackingKey(pid))).toBeNull();
      expect(sessions.has(legacyPidSessionTrackingKey(pid))).toBe(false);
    } finally {
      releaseCleanup();
      await exiting;
      Object.defineProperty(configuration, 'happyHomeDir', { value: previousHome });
      await rm(home, { recursive: true, force: true });
    }
  });
  it('settles only the exact pending daemon spawn awaiter with a typed organization refusal', async () => {
    const pid = 808;
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      spawnOptions: { directory: '/tmp', spawnNonce: 'creation-attempt-808' },
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resultPromise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      spawnAwaiterByKey,
      trackedSessionsByKey,
      spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(),
      timeoutMs: 10_000,
      timeoutErrorMessage: 'not expected',
    });
    const onStartupFailure = createOnDaemonSessionStartupFailure({
      trackedSessionsByKey,
      spawnAwaiterByKey,
    });

    expect(onStartupFailure({
      spawnNonce: 'other-attempt',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(false);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(pid))).toBe(true);

    expect(onStartupFailure({
      spawnNonce: 'creation-attempt-808',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Session creation organization placement is invalid',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    });
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false);
    // A duplicated or late terminal callback cannot settle the same waiter twice.
    expect(onStartupFailure({
      spawnNonce: 'creation-attempt-808',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(false);
  });

  it('settles the exact pending daemon spawn awaiter with a typed correspondence conflict', async () => {
    const pid = 810;
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      spawnOptions: { directory: '/tmp', spawnNonce: 'creation-conflict-attempt-810' },
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const resultPromise = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      spawnAwaiterByKey,
      trackedSessionsByKey,
      spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(),
      timeoutMs: 10_000,
      timeoutErrorMessage: 'not expected',
    });
    const onStartupFailure = createOnDaemonSessionStartupFailure({
      trackedSessionsByKey,
      spawnAwaiterByKey,
    });

    expect(onStartupFailure({
      spawnNonce: 'creation-conflict-attempt-810',
      errorDetail: {
        kind: 'session_creation_correspondence_conflict',
        code: 'creation_conflict',
      },
    })).toBe(true);
    await expect(resultPromise).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Session creation correspondence conflicts with the existing Session',
      errorDetail: {
        kind: 'session_creation_correspondence_conflict',
        code: 'creation_conflict',
      },
    });
  });

  it('does not settle a terminal failure against a timed-out spawn attempt', () => {
    const pid = 809;
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      spawnOptions: { directory: '/tmp', spawnNonce: 'creation-attempt-timed-out' },
      sessionWebhookTimedOutAtMs: 123,
    };
    const awaiter = vi.fn();
    const onStartupFailure = createOnDaemonSessionStartupFailure({
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(pid), awaiter]]),
    });

    expect(onStartupFailure({
      spawnNonce: 'creation-attempt-timed-out',
      errorDetail: {
        kind: 'session_creation_organization_invalid',
        code: 'organization_invalid',
      },
    })).toBe(false);
    expect(awaiter).not.toHaveBeenCalled();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('registers an externally started session when PID is unknown', async () => {
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('PID-123', createMetadata(123, 'terminal'));

    // A Session first learned of from its report gets a fresh key.
    expect(trackedSessionsForProcess(trackedSessionsByKey, 123)).toHaveLength(1);
    const tracked = trackedSessionsForProcess(trackedSessionsByKey, 123)[0];
    expect(tracked).toBeDefined();
    expect(tracked?.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked?.happySessionId).toBe('PID-123');
  });

  it('exposes externally started canonical marker persistence to foreground promotion before acknowledgement', async () => {
    const pid = 124;
    let releaseMarkerWrite!: () => void;
    const markerWriteBlocked = new Promise<void>((resolve) => {
      releaseMarkerWrite = resolve;
    });
    let markerWriteStarted!: () => void;
    const markerWriteObserved = new Promise<void>((resolve) => {
      markerWriteStarted = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      markerWriteStarted();
      await markerWriteBlocked;
    });
    const trackedSessionsByKey =
      new Map<SessionTrackingKey, TrackedSession>();
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid,
        processStartTimeMs: 2_000,
        processCommandHash: hashProcessCommand('happier codex'),
        command: 'happier codex',
      }),
      writeSessionMarkerFn,
    });

    let acknowledged = false;
    const webhook = onWebhook(
      'session-foreground-124',
      createMetadata(pid, 'terminal'),
    ).then(() => {
      acknowledged = true;
    });

    await markerWriteObserved;
    expect(acknowledged).toBe(true);
    const tracked = trackedSessionsForProcess(trackedSessionsByKey, pid)[0];
    expect(tracked?.sessionMarkerPersistence).toBeDefined();

    releaseMarkerWrite();
    await webhook;

    expect(acknowledged).toBe(true);
    await expect(
      tracked!.sessionMarkerPersistence,
    ).resolves.toBe(true);
    expect(writeSessionMarkerFn).toHaveBeenCalledOnce();
  });

  it('coalesces duplicate canonical Windows Terminal webhooks while transferring host custody before ACK', async () => {
    const windowsTerminalHostPid = 8_888;
    const agentPid = 9_999;
    const spawnCleanup = vi.fn();
    const attachCleanup = vi.fn(async () => undefined);
    const executablePath =
      'C:\\Program Files\\Happier\\happier.exe';
    const launchArgv = [
      'codex',
      '--happy-terminal-mode',
      'windows_terminal',
      '--happy-terminal-launch-correlation',
      'ab'.repeat(16),
    ];
    const processCommand = serializeWindowsCommandLine([
      executablePath,
      ...launchArgv,
    ]);
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(windowsTerminalHostPid), pid: windowsTerminalHostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${windowsTerminalHostPid}`,
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: windowsTerminalHostPid,
          windowId: 'happier-cli',
          title: 'Happier codex spawn-unique',
        },
      },
      windowsTerminalLaunchCustody: {
        executablePath,
        argv: launchArgv,
        correlation: 'ab'.repeat(16),
      },
    };
    const trackedSessionsByKey =
      new Map<SessionTrackingKey, TrackedSession>([[
        tracked.trackingKey,
        tracked,
      ]]);
    const spawnAwaiterByKey =
      new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey =
      new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const spawnWebhookTimeoutByKey =
      new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnResourceCleanupByKey =
      new Map([[tracked.trackingKey, spawnCleanup]]);
    const sessionAttachCleanupByKey =
      new Map([[tracked.trackingKey, attachCleanup]]);
    const lifecycleTargets = new Map<number, string>([[
      windowsTerminalHostPid,
      'known-or-resumed-session',
    ]]);
    const onPidPromoted = vi.fn(({
      fromPid,
      toPid,
    }: Readonly<{
      fromPid: number;
      toPid: number;
      trackedSession: TrackedSession;
    }>) => {
      const target = lifecycleTargets.get(fromPid);
      lifecycleTargets.delete(fromPid);
      if (target) lifecycleTargets.set(toPid, target);
    });
    const wait = waitForSessionWebhook({
      trackingKey: legacyPidSessionTrackingKey(windowsTerminalHostPid), pid: windowsTerminalHostPid,
      trackedSessionsByKey,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutMs: 1_000,
      timeoutErrorMessage:
        `Session webhook timeout for PID ${windowsTerminalHostPid}`,
    });
    let resolveInventoryBarrier!: () => void;
    const inventoryBarrier = new Promise<void>((resolve) => {
      resolveInventoryBarrier = resolve;
    });
    let inventoryReadCount = 0;
    const onTrackedSessionReady = vi.fn(async () => undefined);
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: {
        happySessionId: `PID-${windowsTerminalHostPid}`,
      },
      targetMarkerOwnership: {
        happySessionId: `PID-${agentPid}`,
        processCommandHash: hashProcessCommand(processCommand),
        processStartTimeMs: 2_000,
      },
      targetProcessCommand: processCommand,
    }));
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: agentPid,
        processStartTimeMs: 2_000,
        executablePath,
        command: processCommand,
      }),
      readAllWindowsProcessFactsFn: async () => {
        inventoryReadCount += 1;
        if (inventoryReadCount === 2) {
          resolveInventoryBarrier();
        }
        await inventoryBarrier;
        return new Map([
          [agentPid, {
            pid: agentPid,
            processStartTimeMs: 2_000,
            executablePath,
            command: processCommand,
          }],
        ]);
      },
      writeSessionMarkerFn: async () => {},
      promoteSessionMarkerFn,
      onTrackedSessionReady,
      onPidPromoted,
    });

    const metadata: Metadata = {
        ...createMetadata(agentPid, 'daemon'),
        terminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            windowId: 'happier-cli',
            title: 'Happier codex spawn-unique',
          },
        },
      };
    await Promise.all([
      onWebhook(
        'session-agent-windows-terminal',
        metadata,
      ),
      onWebhook(
        'session-agent-windows-terminal',
        metadata,
      ),
    ]);

    await expect(wait).resolves.toEqual({
      type: 'success',
      sessionId: 'session-agent-windows-terminal',
    });
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toBe(tracked);
    expect(trackedSessionsForProcess(trackedSessionsByKey, windowsTerminalHostPid)).toEqual([]);
    expect(tracked).toEqual(expect.objectContaining({
      pid: agentPid,
      happySessionId: 'session-agent-windows-terminal',
      startedBy: 'daemon',
    }));
    // Per-Session resources stay under the Session's key across the promotion.
    expect(spawnResourceCleanupByKey.get(tracked.trackingKey)).toBe(spawnCleanup);
    expect(sessionAttachCleanupByKey.get(tracked.trackingKey)).toBe(attachCleanup);
    expect(tracked.runnerProcessIdentity).toEqual({
      pid: agentPid,
      processStartTimeMs: 2_000,
      processCommandHash: hashProcessCommand(processCommand),
      processCommand,
    });
    expect(onPidPromoted).toHaveBeenCalledOnce();
    expect(onPidPromoted).toHaveBeenCalledWith({
      fromPid: windowsTerminalHostPid,
      toPid: agentPid,
      trackedSession: tracked,
    });
    expect(lifecycleTargets).toEqual(new Map([[
      agentPid,
      'known-or-resumed-session',
    ]]));
    expect(promoteSessionMarkerFn).toHaveBeenCalledOnce();
    expect(onTrackedSessionReady).toHaveBeenCalledOnce();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('correlates duplicate-title Windows Terminal launches by exact full argv and private correlation', async () => {
    const firstHostPid = 8_881;
    const secondHostPid = 8_882;
    const agentPid = 9_991;
    const firstAwaiter = vi.fn();
    const secondAwaiter = vi.fn();
    const createTracked = (
      pid: number,
      title: string,
      correlation: string,
    ): TrackedSession => ({
      trackingKey: legacyPidSessionTrackingKey(pid),
      pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid,
          windowId: 'happier-cli',
          title,
        },
      },
      windowsTerminalLaunchCustody: {
        executablePath:
          'C:\\Program Files\\Happier\\happier.exe',
        argv: [
          'codex',
          '--happy-terminal-mode',
          'windows_terminal',
          '--happy-terminal-title',
          title,
          '--happy-terminal-launch-correlation',
          correlation,
        ],
        correlation,
      },
    });
    const duplicateTitle = 'Happier codex session-known';
    const firstTracked =
      createTracked(firstHostPid, duplicateTitle, '11'.repeat(16));
    const secondTracked =
      createTracked(secondHostPid, duplicateTitle, '22'.repeat(16));
    const secondLaunch = secondTracked.windowsTerminalLaunchCustody!;
    const processCommand = serializeWindowsCommandLine([
      secondLaunch.executablePath,
      ...secondLaunch.argv,
    ]);
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
      [legacyPidSessionTrackingKey(firstHostPid), firstTracked],
      [secondTracked.trackingKey, secondTracked],
    ]);
    const spawnAwaiterByKey =
      new Map<SessionTrackingKey, (session: TrackedSession) => void>([
        [firstTracked.trackingKey, firstAwaiter],
        [secondTracked.trackingKey, secondAwaiter],
      ]);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: agentPid,
        processStartTimeMs: 3_000,
        executablePath: secondLaunch.executablePath,
        command: processCommand,
      }),
      readAllWindowsProcessFactsFn: async () => new Map([
        [agentPid, {
          pid: agentPid,
          processStartTimeMs: 3_000,
          executablePath: secondLaunch.executablePath,
          command: processCommand,
        }],
      ]),
      writeSessionMarkerFn: async () => {},
      promoteSessionMarkerFn: vi.fn(async ({ fromPid, toPid }: Parameters<typeof promoteSessionMarkerPid>[0]) => ({
        sourceMarkerOwnership: {
          happySessionId: `PID-${fromPid}`,
        },
        targetMarkerOwnership: {
          happySessionId: `PID-${toPid}`,
          processCommandHash: hashProcessCommand(processCommand),
          processStartTimeMs: 3_000,
        },
        targetProcessCommand: processCommand,
      })),
    });

    await onWebhook('session-second', {
      ...createMetadata(agentPid, 'daemon'),
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier-cli',
          title: duplicateTitle,
        },
      },
    });

    expect(firstAwaiter).not.toHaveBeenCalled();
    expect(secondAwaiter).toHaveBeenCalledWith(secondTracked);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(firstHostPid))).toBe(firstTracked);
    expect(trackedSessionsByKey.get(secondTracked.trackingKey)).toBe(secondTracked);
    expect(secondTracked.pid).toBe(agentPid);
    expect(trackedSessionsForProcess(trackedSessionsByKey, secondHostPid)).toEqual([]);
  });

  it('keeps an exact late Windows Terminal webhook fail-closed after the spawn awaiter is removed', async () => {
    const hostPid = 8_883;
    const agentPid = 9_993;
    const correlation = '33'.repeat(16);
    const executablePath =
      'C:\\Program Files\\Happier\\happier.exe';
    const argv = [
      'codex',
      '--happy-terminal-launch-correlation',
      correlation,
    ];
    const processCommand = serializeWindowsCommandLine([
      executablePath,
      ...argv,
    ]);
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(hostPid), pid: hostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${hostPid}`,
      acceptedSpawnMarkerGate: Promise.resolve(false),
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          pid: hostPid,
          windowId: 'happier-cli',
          title: 'Happier codex delayed',
        },
      },
      windowsTerminalLaunchCustody: {
        executablePath,
        argv,
        correlation,
      },
    };
    const trackedSessionsByKey =
      new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: agentPid,
        processStartTimeMs: 3_300,
        executablePath,
        command: processCommand,
      }),
      readAllWindowsProcessFactsFn: async () => new Map([
        [agentPid, {
          pid: agentPid,
          processStartTimeMs: 3_300,
          executablePath,
          command: processCommand,
        }],
      ]),
      writeSessionMarkerFn: async () => {},
    });

    await expect(onWebhook('session-delayed', {
      ...createMetadata(agentPid, 'daemon'),
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier-cli',
          title: 'Happier codex delayed',
        },
      },
    })).rejects.toThrow('Daemon spawn custody was not accepted');

    expect(trackedSessionsByKey.get(tracked.trackingKey)).toBe(tracked);
    expect(tracked.pid).toBe(hostPid);
    expect(trackedSessionsForProcess(trackedSessionsByKey, agentPid)).toEqual([]);
    expect(tracked.startedBy).toBe('daemon');
    expect(tracked.runnerProcessIdentity).toEqual({
      pid: agentPid,
      processStartTimeMs: 3_300,
      processCommandHash: hashProcessCommand(processCommand),
    });
  });

  it('carries Windows Terminal host custody from a PID placeholder report into canonical marker acceptance', async () => {
    const hostPid = 8_885;
    const agentPid = 9_995;
    const correlation = '55'.repeat(16);
    const executablePath = 'C:\\Happier\\happier.exe';
    const argv = [
      'codex',
      '--happy-terminal-launch-correlation',
      correlation,
    ];
    const command = serializeWindowsCommandLine([
      executablePath,
      ...argv,
    ]);
    let acceptMarker!: (accepted: boolean) => void;
    const acceptedSpawnMarkerGate =
      new Promise<boolean>((resolve) => {
        acceptMarker = resolve;
      });
    const persistTargetMarker = vi.fn(async () => {
      acceptMarker(true);
    });
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(hostPid), pid: hostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${hostPid}`,
      acceptedSpawnMarkerGate,
      persistWindowsTerminalAcceptedAgentMarker:
        persistTargetMarker,
      windowsTerminalLaunchCustody: {
        executablePath,
        argv,
        correlation,
      },
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier',
          title: 'Happier codex placeholder',
        },
      },
    };
    const awaiter = vi.fn();
    const trackedSessionsByKey =
      new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map([[legacyPidSessionTrackingKey(hostPid), awaiter]]);
    const promotion = vi.fn(async () => ({
      sourceMarkerOwnership: null,
      targetMarkerOwnership: {
        happySessionId: 'session-canonical',
        processCommandHash: hashProcessCommand(command),
        processStartTimeMs: 5_500,
      },
      targetProcessCommand: command,
    }));
    const process = {
      pid: agentPid,
      processStartTimeMs: 5_500,
      executablePath,
      command,
    };
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      readProcessIdentityByPidFn: async () => process,
      readAllWindowsProcessFactsFn: async () =>
        new Map([[agentPid, process]]),
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      promoteSessionMarkerFn: promotion,
    });
    const terminal = tracked.hostedTerminal;

    await onWebhook(`PID-${agentPid}`, {
      ...createMetadata(agentPid, 'daemon'),
      terminal,
    });
    expect(tracked.sessionRunnerPid).toBe(agentPid);
    expect(persistTargetMarker).not.toHaveBeenCalled();

    await onWebhook('session-canonical', {
      ...createMetadata(agentPid, 'daemon'),
      terminal,
    });

    expect(persistTargetMarker).toHaveBeenCalledWith({
      pid: agentPid,
      processStartTimeMs: 5_500,
      processCommandHash: hashProcessCommand(command),
    });
    expect(promotion).toHaveBeenCalledWith({
      trackingKey: tracked.trackingKey,
      fromPid: hostPid,
      toPid: agentPid,
    });
    expect(awaiter).toHaveBeenCalledWith(tracked);
  });

  it('rescans the complete Windows inventory before canonical marker acceptance and refuses a duplicate that appeared after the placeholder webhook', async () => {
    const hostPid = 8_886;
    const agentPid = 9_996;
    const duplicatePid = 9_997;
    const correlation = '66'.repeat(16);
    const executablePath = 'C:\\Happier\\happier.exe';
    const argv = [
      'codex',
      '--happy-terminal-launch-correlation',
      correlation,
    ];
    const command = serializeWindowsCommandLine([
      executablePath,
      ...argv,
    ]);
    const persistTargetMarker = vi.fn(async () => {});
    const activate = vi.fn(async () => null);
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(hostPid), pid: hostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${hostPid}`,
      acceptedSpawnMarkerGate: Promise.resolve(true),
      persistWindowsTerminalAcceptedAgentMarker:
        persistTargetMarker,
      activateConnectedAccountSessionBindingOnCanonicalSession:
        activate,
      windowsTerminalLaunchCustody: {
        executablePath,
        argv,
        correlation,
      },
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier',
          title: 'Happier codex placeholder-duplicate',
        },
      },
    };
    const process = {
      pid: agentPid,
      processStartTimeMs: 6_600,
      executablePath,
      command,
    };
    let inventoryReadCount = 0;
    const awaiter = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey:
        new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(hostPid), awaiter]]),
      getParentPidFn: () => null,
      readProcessIdentityByPidFn: async () => process,
      readAllWindowsProcessFactsFn: async () => {
        inventoryReadCount += 1;
        return new Map([
          [agentPid, process],
          ...(inventoryReadCount > 1
            ? [[duplicatePid, {
                ...process,
                pid: duplicatePid,
              }] as const]
            : []),
        ]);
      },
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: vi.fn(async () => {}),
      promoteSessionMarkerFn: vi.fn(async () => {
        throw new Error('promotion must remain unreachable');
      }),
    });
    const metadata = {
      ...createMetadata(agentPid, 'daemon'),
      terminal: tracked.hostedTerminal,
    };

    await onWebhook(`PID-${agentPid}`, metadata);
    expect(tracked.sessionRunnerPid).toBe(agentPid);

    await expect(
      onWebhook('session-canonical-duplicate', metadata),
    ).rejects.toThrow(
      'Windows Terminal Agent launch custody could not be revalidated',
    );
    expect(inventoryReadCount).toBe(2);
    expect(persistTargetMarker).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(awaiter).not.toHaveBeenCalled();
    expect(tracked.happySessionId).toBe(`PID-${agentPid}`);
  });

  it.each([
    ['absent', undefined],
    ['different', {
      mode: 'windows_terminal' as const,
      requested: 'windows_terminal' as const,
      windows: {
        host: 'windows_terminal' as const,
        windowId: 'happier',
        title: 'Happier codex another-correlation',
      },
    }],
  ])('lets a daemon webhook with %s Windows Terminal correlation fall through to ordinary PPID matching while another Terminal startup is pending', async (_variant, unrelatedTerminal) => {
    const windowsTerminalHostPid = 8_887;
    const ordinaryWrapperPid = 7_771;
    const ordinaryAgentPid = 7_772;
    const correlation = '77'.repeat(16);
    const pendingTerminal: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(windowsTerminalHostPid), pid: windowsTerminalHostPid,
      startedBy: 'daemon',
      happySessionId: `PID-${windowsTerminalHostPid}`,
      windowsTerminalLaunchCustody: {
        executablePath: 'C:\\Happier\\happier.exe',
        argv: [
          'codex',
          '--happy-terminal-launch-correlation',
          correlation,
        ],
        correlation,
      },
      hostedTerminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windows: {
          host: 'windows_terminal',
          windowId: 'happier',
          title: 'Happier codex pending-unrelated',
        },
      },
    };
    const ordinary: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(ordinaryWrapperPid), pid: ordinaryWrapperPid,
      startedBy: 'daemon',
    };
    const ordinaryAwaiter = vi.fn();
    const trackedSessionsByKey =
      new Map<SessionTrackingKey, TrackedSession>([
        [legacyPidSessionTrackingKey(windowsTerminalHostPid), pendingTerminal],
        [ordinary.trackingKey, ordinary],
      ]);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey:
        new Map([[ordinary.trackingKey, ordinaryAwaiter]]),
      getParentPidFn: (pid) =>
        pid === ordinaryAgentPid ? ordinaryWrapperPid : null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      readProcessIdentityByPidFn: async () => null,
      readAllWindowsProcessFactsFn: async () => {
        throw new Error(
          'unrelated webhook must not enter Windows inventory',
        );
      },
    });

    await onWebhook(
      'session-ordinary-while-terminal-pending',
      {
        ...createMetadata(ordinaryAgentPid, 'daemon'),
        ...(unrelatedTerminal
          ? { terminal: unrelatedTerminal }
          : {}),
      },
    );

    expect(ordinaryAwaiter).toHaveBeenCalledWith(ordinary);
    expect(ordinary.sessionRunnerPid).toBe(ordinaryAgentPid);
    expect(ordinary.happySessionId).toBe(
      'session-ordinary-while-terminal-pending',
    );
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(windowsTerminalHostPid)))
      .toBe(pendingTerminal);
  });

  it.each([
    'unreadable identity',
    'wrong executable',
    'forged argv',
    'duplicate exact process',
    'missing terminal metadata',
    'wrong title',
  ] as const)(
    'rejects %s without ACK, activation, marker effects, or external adoption',
    async (variant) => {
      const hostPid = 8_884;
      const agentPid = 9_994;
      const correlation = '44'.repeat(16);
      const executablePath =
        'C:\\Program Files\\Happier\\happier.exe';
      const argv = [
        'codex',
        '--happy-terminal-launch-correlation',
        correlation,
      ];
      const processCommand = serializeWindowsCommandLine([
        executablePath,
        ...argv,
      ]);
      const activate = vi.fn(async () => null);
      const awaiter = vi.fn();
      const writeSessionMarker = vi.fn(async () => {});
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(hostPid), pid: hostPid,
        startedBy: 'daemon',
        happySessionId: `PID-${hostPid}`,
        activateConnectedAccountSessionBindingOnCanonicalSession:
          activate,
        hostedTerminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            pid: hostPid,
            windowId: 'happier-cli',
            title: 'Happier codex exact',
          },
        },
        windowsTerminalLaunchCustody: {
          executablePath,
          argv,
          correlation,
        },
      };
      const trackedSessionsByKey =
        new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
      const onWebhook = createOnHappySessionWebhook({
        trackedSessionsByKey,
        spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(hostPid), awaiter]]),
        getParentPidFn: () => null,
        findHappyProcessByPidFn: async () => null,
        readProcessIdentityByPidFn: async () => {
          if (variant === 'unreadable identity') return null;
          return {
            pid: agentPid,
            processStartTimeMs: 4_400,
            executablePath:
              variant === 'wrong executable'
                ? 'C:\\forged.exe'
                : executablePath,
            command:
              variant === 'forged argv'
                ? serializeWindowsCommandLine([
                    executablePath,
                    '--forged',
                    correlation,
                  ])
                : processCommand,
          };
        },
        readAllWindowsProcessFactsFn: async () => {
          if (variant === 'unreadable identity') {
            return new Map();
          }
          const process = {
            pid: agentPid,
            processStartTimeMs: 4_400,
            executablePath:
              variant === 'wrong executable'
                ? 'C:\\forged.exe'
                : executablePath,
            command:
              variant === 'forged argv'
                ? serializeWindowsCommandLine([
                    executablePath,
                    '--forged',
                    correlation,
                  ])
                : processCommand,
          };
          return new Map([
            [agentPid, process],
            ...(variant === 'duplicate exact process'
              ? [[agentPid + 1, {
                  ...process,
                  pid: agentPid + 1,
                }] as const]
              : []),
          ]);
        },
        writeSessionMarkerFn: writeSessionMarker,
      });
      const metadata: Metadata = {
        ...createMetadata(agentPid, 'daemon'),
        ...(variant === 'missing terminal metadata'
          ? {}
          : {
              terminal: {
                mode: 'windows_terminal' as const,
                requested: 'windows_terminal' as const,
                windows: {
                  host: 'windows_terminal' as const,
                  windowId: 'happier-cli',
                  title:
                    variant === 'wrong title'
                      ? 'Happier codex wrong'
                      : 'Happier codex exact',
                },
              },
            }),
      };

      await expect(
        onWebhook('session-forged', metadata),
      ).rejects.toThrow(
        'Windows Terminal Agent launch custody could not be verified',
      );
      expect(activate).not.toHaveBeenCalled();
      expect(awaiter).not.toHaveBeenCalled();
      expect(writeSessionMarker).not.toHaveBeenCalled();
      expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(hostPid))).toBe(tracked);
      expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(agentPid))).toBe(false);
      expect(tracked.happySessionId).toBe(`PID-${hostPid}`);
    },
  );

  it('updates an already tracked external session when a new session id is reported', () => {
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
      [
        legacyPidSessionTrackingKey(456),
        {
          trackingKey: legacyPidSessionTrackingKey(456), pid: 456,
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: 'PID-456',
        },
      ],
    ]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-real-456', createMetadata(456, 'terminal'));

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(456))?.happySessionId).toBe('session-real-456');
  });

  it('updates daemon-spawned session id and resolves spawn awaiter', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(789), pid: 789,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(789), awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('session-daemon-789', createMetadata(789, 'daemon'));

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(789))?.happySessionId).toBe('session-daemon-789');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(789))).toBe(false);
  });

  it('waits for async spawn finalization before acknowledging the session report', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(792), pid: 792,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    let finishFinalization!: () => void;
    const finalization = new Promise<void>((resolve) => {
      finishFinalization = resolve;
    });
    const awaiter = vi.fn(async () => {
      await finalization;
    });
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(792), awaiter]]);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    const report = onWebhook('session-daemon-792', createMetadata(792, 'daemon'));
    let acknowledged = false;
    void report.then(() => {
      acknowledged = true;
    });

    await vi.waitFor(() => expect(awaiter).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);

    finishFinalization();
    await report;
    expect(acknowledged).toBe(true);
  });

  it('stores the separate create-or-rejoin outcome on the matched daemon runner before resolving', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(790), pid: 790,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(790), awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });
    const sessionCreationOutcome = {
      disposition: 'rejoined' as const,
      organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
    };

    await onWebhook(
      'session-daemon-790',
      createMetadata(790, 'daemon'),
      undefined,
      sessionCreationOutcome,
    );

    expect(tracked.sessionCreationOutcome).toEqual(sessionCreationOutcome);
    expect(awaiter).toHaveBeenCalledWith(tracked);
  });

  it('ignores a late webhook from a daemon spawn that already timed out', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(791), pid: 791,
      startedBy: 'daemon',
      happySessionId: 'PID-791',
      sessionWebhookTimedOutAtMs: 123,
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(791), awaiter]]);
    const onTrackedSessionReported = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReported,
    });

    onWebhook('session-daemon-791', createMetadata(791, 'daemon'));
    await Promise.resolve();

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(791))?.happySessionId).toBe('PID-791');
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(791))?.happySessionMetadataFromLocalWebhook).toBeUndefined();
    expect(awaiter).not.toHaveBeenCalled();
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(791))).toBe(true);
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('allows a fresh daemon retry through its current PID owner', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(795), pid: 795,
      startedBy: 'daemon',
      happySessionId: 'PID-795',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(795), awaiter]]);
    const onTrackedSessionReported = vi.fn();
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      resolveMarker();
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReported,
    });

    onWebhook('session-daemon-795', createMetadata(795, 'daemon'));
    await markerWritten;

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(795))?.happySessionId).toBe('session-daemon-795');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-daemon-795',
      pid: 795,
    }));
    expect(writeSessionMarkerFn).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh wrapper retry through its current parent PID owner', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(796), pid: 796,
      startedBy: 'daemon',
      happySessionId: 'PID-796',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(796), awaiter]]);
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      resolveMarker();
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => 796,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
    });

    onWebhook('session-daemon-797', createMetadata(797, 'daemon'));
    await markerWritten;

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(796))?.happySessionId).toBe('session-daemon-797');
    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(writeSessionMarkerFn).toHaveBeenCalledTimes(1);
  });

  it('notifies when a tracked daemon session reports its canonical session id', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(790), pid: 790,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const onTrackedSessionReported = vi.fn();

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported,
    });

    await onWebhook('session-daemon-790', createMetadata(790, 'daemon'));

    expect(onTrackedSessionReported).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-daemon-790',
      pid: 790,
    }));
  });

  it('waits for accepted spawn custody and required readiness before resolving the spawn awaiter', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(798), pid: 798,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-798',
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-798.json',
    };
    let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
    tracked.acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
      resolveAcceptedSpawnMarker = resolve;
    });
    let resolveReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
    const awaiter = vi.fn();
    let canonicalMarkerPersisted = false;
    const onTrackedSessionReady = vi.fn(async () => {
      expect(canonicalMarkerPersisted).toBe(true);
      await readiness;
    });
    const onTrackedSessionReported = vi.fn();
    let resolveCanonicalMarker!: () => void;
    const canonicalMarker = new Promise<void>((resolve) => {
      resolveCanonicalMarker = resolve;
    });
    const writeSessionMarkerFn = vi.fn(async () => {
      await canonicalMarker;
      canonicalMarkerPersisted = true;
    });
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(798), awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_798,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady,
      onTrackedSessionReported,
    });

    const registration = onWebhook('session-daemon-798', createMetadata(798, 'daemon'));

    expect(awaiter).not.toHaveBeenCalled();
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();

    resolveAcceptedSpawnMarker(true);
    await vi.waitFor(() => expect(writeSessionMarkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: tracked.pid,
        happySessionId: 'session-daemon-798',
        processStartTimeMs: 1_717_171_717_798,
      }),
    ));
    expect(awaiter).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).toHaveBeenCalledWith(tracked);
    expect(onTrackedSessionReady).not.toHaveBeenCalled();

    resolveCanonicalMarker();
    await vi.waitFor(() => expect(onTrackedSessionReady).toHaveBeenCalledWith(tracked));
    expect(awaiter).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).toHaveBeenCalledOnce();

    resolveReadiness();
    await expect(registration).resolves.toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
    expect(onTrackedSessionReported).toHaveBeenCalledWith(tracked);
  });

  it('waits for report-scoped canonical readiness before resolving the spawn awaiter', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(796), pid: 796,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness.json',
    };
    const awaiter = vi.fn();
    let resolveCanonicalReadiness!: () => void;
    const canonicalReadiness = new Promise<void>((resolve) => {
      resolveCanonicalReadiness = resolve;
    });
    let canonicalMarkerPersisted = false;
    const reconcileCanonicalReadiness = vi.fn(async () => {
      expect(canonicalMarkerPersisted).toBe(true);
      await canonicalReadiness;
    });
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(tracked.pid), awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_796,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => {
        canonicalMarkerPersisted = true;
      }),
    });

    const registration = onWebhook(
      'session-daemon-796',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    );

    await vi.waitFor(() => {
      expect(reconcileCanonicalReadiness).toHaveBeenCalledWith(tracked);
    });
    expect(awaiter).not.toHaveBeenCalled();

    resolveCanonicalReadiness();
    await expect(registration).resolves.toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
  });

  it('joins concurrent non-Windows canonical reports into one fresh-spawn readiness reconciliation', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(7_961), pid: 7_961,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-concurrent.json',
    };
    const awaiter = vi.fn();
    let releaseReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const reconcileCanonicalReadiness = vi.fn(async () => {
      await readiness;
    });
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(tracked.pid), awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_961,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });

    const first = onWebhook(
      'session-daemon-7961',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    );
    await vi.waitFor(() => {
      expect(reconcileCanonicalReadiness).toHaveBeenCalledOnce();
    });
    const retry = onWebhook(
      'session-daemon-7961',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcileCanonicalReadiness).toHaveBeenCalledOnce();
    releaseReadiness();
    await expect(Promise.all([first, retry])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(awaiter).toHaveBeenCalledOnce();

    await expect(onWebhook(
      'session-daemon-7961',
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    )).resolves.toBeUndefined();
    expect(reconcileCanonicalReadiness).toHaveBeenCalledOnce();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('does not apply fresh-spawn readiness reconciliation to reattached runners', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(7_962), pid: 7_962,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-7962',
      reattachedFromDiskMarker: true,
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-reattached.json',
    };
    const reconcileCanonicalReadiness = vi.fn(async () => {
      throw new Error('fresh-spawn readiness must not run');
    });
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_962,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });

    await expect(onWebhook(
      tracked.happySessionId!,
      createMetadata(tracked.pid, 'daemon'),
      reconcileCanonicalReadiness,
    )).resolves.toBeUndefined();
    expect(reconcileCanonicalReadiness).not.toHaveBeenCalled();
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
  });

  it('fails the existing spawn readiness result when report-scoped canonical readiness rejects', async () => {
    const { logger } = await import('@/ui/logger');
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(795), pid: 795,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-failure.json',
    };
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey =
      new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey =
      new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnResult = waitForSessionWebhook({
      trackingKey: tracked.trackingKey, pid: tracked.pid,
      trackedSessionsByKey,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'unexpected timeout',
    });
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [],
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_795,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });

    const startupFailure = Object.assign(
      new Error('runner authority refresh failed'),
      { code: 'SESSION_MARKER_MUTATION_LOCK_TIMEOUT' },
    );
    const debugSpy = vi.spyOn(logger, 'debug');
    try {
      await expect(onWebhook(
        'session-daemon-795',
        createMetadata(tracked.pid, 'daemon'),
        async () => {
          throw startupFailure;
        },
      )).rejects.toThrow('runner authority refresh failed');
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Canonical Session startup readiness failed: '
          + 'SESSION_MARKER_MUTATION_LOCK_TIMEOUT: runner authority refresh failed',
        ),
        startupFailure,
      );
    } finally {
      debugSpy.mockRestore();
    }
    await expect(spawnResult).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: 'Session startup reconciliation failed',
    });
    expect(spawnAwaiterByKey.size).toBe(0);
    expect(spawnResultResolverByKey.size).toBe(0);
    expect(spawnWebhookTimeoutByKey.size).toBe(0);
  });

  it('returns canonical-session activation failure through the spawn awaiter and rejects startup acknowledgement', async () => {
    const failure = {
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_account_request_auth_activation_failed',
    };
    const activateConnectedAccountSessionBindingOnCanonicalSession =
      vi.fn(async () => failure);
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(797), pid: 797,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      activateConnectedAccountSessionBindingOnCanonicalSession,
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
      [tracked.trackingKey, tracked],
    ]);
    const spawnAwaiterByKey =
      new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey =
      new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnResult = waitForSessionWebhook({
      trackingKey: tracked.trackingKey, pid: tracked.pid,
      trackedSessionsByKey,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutErrorMessage: 'unexpected timeout',
    });
    const onTrackedSessionReady = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    await expect(
      onWebhook(
        'session-from-server',
        createMetadata(tracked.pid, 'daemon'),
      ),
    ).rejects.toThrow(failure.errorMessage);
    await expect(spawnResult).resolves.toEqual(failure);
    expect(
      activateConnectedAccountSessionBindingOnCanonicalSession,
    ).toHaveBeenCalledWith('session-from-server');
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(
      tracked.activateConnectedAccountSessionBindingOnCanonicalSession,
    ).toBeUndefined();
    expect(spawnAwaiterByKey.size).toBe(0);
    expect(spawnResultResolverByKey.size).toBe(0);
    expect(spawnWebhookTimeoutByKey.size).toBe(0);

    await expect(
      onWebhook(
        'session-from-server',
        createMetadata(tracked.pid, 'daemon'),
      ),
    ).rejects.toThrow(failure.errorMessage);
    expect(
      activateConnectedAccountSessionBindingOnCanonicalSession,
    ).toHaveBeenCalledOnce();
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('keeps ordinary fresh-daemon marker refresh failure best effort', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(793), pid: 793,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      activateConnectedAccountSessionBindingOnCanonicalSession:
        vi.fn(async () => null),
    };
    const awaiter = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {
      throw new Error('ordinary marker refresh failed');
    });
    const onTrackedSessionReady = vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map([[legacyPidSessionTrackingKey(tracked.pid), awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: tracked.pid,
        processStartTimeMs: 1_717_171_717_793,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    await expect(onWebhook(
      'session-daemon-793',
      createMetadata(tracked.pid, 'daemon'),
    )).resolves.toBeUndefined();
    await vi.waitFor(() => expect(writeSessionMarkerFn).toHaveBeenCalledOnce());
    expect(writeSessionMarkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        happySessionId: 'session-daemon-793',
      }),
    );
    expect(onTrackedSessionReady).toHaveBeenCalledWith(tracked);
    expect(tracked.spawnStartupReadinessFailure).toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
  });

  it('keeps promoted startup custody until exact takeover admission completes after the ordinary ACK', async () => {
    const wrapperPid = 792;
    const runnerPid = 793;
    const trackedBeforePromotion: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: `PID-${wrapperPid}`,
      sessionRunnerPid: runnerPid,
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/runner-authority-readiness-promoted.json',
      activateConnectedAccountSessionBindingOnCanonicalSession:
        vi.fn(async () => null),
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
      [legacyPidSessionTrackingKey(wrapperPid), trackedBeforePromotion],
    ]);
    const spawnAwaiterByKey =
      new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey =
      new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
    const spawnWebhookTimeoutByKey =
      new Map<SessionTrackingKey, NodeJS.Timeout>();
    const admissionWaiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = { mode: 'persisted' as const, operationId: 'operation-1', attemptId: 'attempt-1' };
    const admission = admissionWaiter.register(correlation);
    const spawnResult = waitForSessionWebhook({
      takeoverAdmission: admission,
      trackingKey: trackedBeforePromotion.trackingKey,
      pid: wrapperPid,
      trackedSessionsByKey,
      spawnAwaiterByKey,
      spawnResultResolverByKey,
      spawnWebhookTimeoutByKey,
      timeoutMs: 1_000,
      timeoutErrorMessage: 'unexpected timeout',
    });
    const promoted = Object.assign(trackedBeforePromotion, {
      pid: runnerPid,
      happySessionId: `PID-${runnerPid}`,
      sessionRunnerPid: undefined,
    });
    const writeSessionMarkerFn = vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: 1_717_171_717_793,
        command: '/usr/bin/happier-agent',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady: vi.fn(async () => undefined),
    });

    await expect(onWebhook(
      'session-daemon-promoted',
      createMetadata(runnerPid, 'daemon'),
    )).resolves.toBeUndefined();
    // Startup waiters stay keyed by the Session across wrapper→runner promotion.
    expect(trackedSessionsByKey.get(promoted.trackingKey)).toBe(promoted);
    expect(spawnResultResolverByKey.has(promoted.trackingKey)).toBe(true);
    expect(admission.readOutcome()).toBeNull();
    admissionWaiter.settle(correlation, { status: 'committed' });
    await expect(spawnResult).resolves.toEqual({
      type: 'success',
      sessionId: 'session-daemon-promoted',
    });
    expect(writeSessionMarkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-daemon-promoted',
      }),
      { adoptCanonicalSessionIdFromPidPlaceholder: true },
    );
    expect(spawnAwaiterByKey).toHaveLength(0);
    expect(spawnResultResolverByKey).toHaveLength(0);
    expect(spawnWebhookTimeoutByKey).toHaveLength(0);
  });

  it('locks the first canonical daemon session identity across concurrent webhooks', async () => {
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    const activateConnectedAccountSessionBindingOnCanonicalSession =
      vi.fn(async () => {
        await activation;
        return null;
      });
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(796), pid: 796,
      startedBy: 'daemon',
      acceptedSpawnMarkerGate: Promise.resolve(true),
      activateConnectedAccountSessionBindingOnCanonicalSession,
    };
    const onTrackedSessionReady = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map<SessionTrackingKey, TrackedSession>([
        [tracked.trackingKey, tracked],
      ]),
      spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    const first = onWebhook(
      'session-first',
      createMetadata(tracked.pid, 'daemon'),
    );
    await vi.waitFor(() => {
      expect(
        activateConnectedAccountSessionBindingOnCanonicalSession,
      ).toHaveBeenCalledOnce();
    });
    const conflicting = onWebhook(
      'session-conflict',
      createMetadata(tracked.pid, 'daemon'),
    );
    await expect(conflicting).rejects.toThrow(
      'connected_account_canonical_session_identity_conflict',
    );
    expect(tracked.happySessionId).toBe('session-first');

    resolveActivation();
    await expect(first).rejects.toThrow(
      'connected_account_canonical_session_identity_conflict',
    );
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('rejects a canonical webhook that conflicts with a known daemon session before readiness effects', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(797), pid: 797,
      startedBy: 'daemon',
      happySessionId: 'session-expected',
      acceptedSpawnMarkerGate:
        Promise.resolve(true),
    };
    const onTrackedSessionReady = vi.fn();
    const writeSessionMarkerFn =
      vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey:
        new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      onTrackedSessionReady,
    });

    await expect(onWebhook(
      'session-conflict',
      createMetadata(tracked.pid, 'daemon'),
    )).rejects.toThrow(
      'connected_account_canonical_session_identity_conflict',
    );
    expect(tracked.happySessionId)
      .toBe('session-expected');
    expect(tracked.spawnStartupReadinessFailure)
      .toMatchObject({
        errorCode:
          SPAWN_SESSION_ERROR_CODES
            .SPAWN_VALIDATION_FAILED,
        errorMessage:
          'connected_account_canonical_session_identity_conflict',
      });
    expect(onTrackedSessionReady)
      .not.toHaveBeenCalled();
    expect(writeSessionMarkerFn)
      .not.toHaveBeenCalled();
  });

  it('rejects required readiness when accepted spawn custody is declined', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(799), pid: 799,
      startedBy: 'daemon',
    };
    let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
    tracked.acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
      resolveAcceptedSpawnMarker = resolve;
    });
    const onTrackedSessionReady = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map<SessionTrackingKey, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReady,
    });

    const registration = onWebhook('session-daemon-799', createMetadata(799, 'daemon'));
    resolveAcceptedSpawnMarker(false);

    await expect(registration).rejects.toThrow('spawn custody');
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
  });

  it('does not fail session registration when a best-effort tracked-session observer throws synchronously', () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(791), pid: 791,
      startedBy: 'daemon',
    };
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map<SessionTrackingKey, (session: TrackedSession) => void>(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      onTrackedSessionReported: () => {
        throw new ReferenceError('optional observer is unavailable');
      },
    });

    expect(() => onWebhook('session-daemon-791', createMetadata(791, 'daemon'))).not.toThrow();
    expect(tracked.happySessionId).toBe('session-daemon-791');
  });

  it('stores vendorResumeId from session metadata when available', () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(444), pid: 444,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    onWebhook('session-daemon-444', {
      ...createMetadata(444, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-444',
    });

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(444))?.vendorResumeId).toBe('vendor-session-444');
  });

  it('does not preserve durable connected-service restart intent by default when refreshing a daemon marker from webhook metadata', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(447), pid: 447,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    let markerOptions: unknown;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (_args: unknown, options: unknown) => {
        markerOptions = options;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-447', {
      ...createMetadata(447, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-447',
    });
    await markerWritten;

    expect(markerOptions).toBeUndefined();
  });

  it('does not preserve durable connected-service restart intent through routine marker refreshes', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(448), pid: 448,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    let markerOptions: unknown;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (_args: unknown, options: unknown) => {
        markerOptions = options;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-448', {
      ...createMetadata(448, 'daemon'),
      flavor: 'codex',
      codexSessionId: 'vendor-session-448',
    });
    await markerWritten;

    expect(markerOptions).toBeUndefined();
  });

   it('preserves a previously discovered provider session id when a later webhook metadata payload is stale', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(445), pid: 445,
      startedBy: 'daemon',
      happySessionId: 'session-daemon-445',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      listSessionMarkersFn: async () => [
        {
          trackingKey: tracked.trackingKey,
          pid: 445,
          happySessionId: 'session-daemon-445',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          flavor: 'ohMyPi',
          metadata: {
            flavor: 'ohMyPi',
            hostPid: 445,
            path: '/tmp',
            ohMyPiSessionId: 'omp-session-existing',
          },
        },
      ],
      writeSessionMarkerFn: async (args: Record<string, unknown>) => {
        markerArgs = args;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-445', {
      ...createMetadata(445, 'daemon'),
      flavor: 'ohMyPi',
    });
    await markerWritten;

    expect(markerArgs.metadata).toEqual(expect.objectContaining({
      flavor: 'ohMyPi',
      hostPid: 445,
      ohMyPiSessionId: 'omp-session-existing',
    }));
  });

  it('does not resolve daemon awaiter on PID placeholder and resolves on canonical id', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(9001), pid: 9001,
      startedBy: 'daemon',
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(9001), awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('PID-9001', createMetadata(9001, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(0);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(9001))).toBe(true);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(9001))?.happySessionId).toBe('PID-9001');

    await onWebhook('session-real-9001', createMetadata(9001, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(9001))).toBe(false);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(9001))?.happySessionId).toBe('session-real-9001');
  });

  it('expands tilde paths before writing the session marker', async () => {
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('PID-321', createMetadata(321, 'terminal', '~/Documents/Development/happier/dev'));
    await markerWritten;

    const expected = path.join(os.homedir(), 'Documents', 'Development', 'happier', 'dev');
    expect(markerArgs.cwd).toBe(expected);
    expect(markerArgs.metadata.path).toBe(expected);
  });

  it('normalizes Windows home paths through the canonical CLI path owner', () => {
    expect(resolveSessionWebhookPath(
      '~\\Documents/happier',
      { USERPROFILE: 'C:\\Users\\Alice' },
      'win32',
    )).toBe('C:\\Users\\Alice\\Documents\\happier');
  });

  it('includes safe and sealed respawn env continuity for daemon-spawned sessions with spawnOptions', async () => {
    const credentials = {
      token: 't',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(3),
        machineKey: new Uint8Array(32).fill(9),
      },
    };

    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(555), pid: 555,
      startedBy: 'daemon',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        transcriptStorage: 'direct',
        token: 'secret-token-should-not-be-persisted',
        resume: 'vendor-resume-id',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
          ANTHROPIC_AUTH_TOKEN: 'secret-provider-token',
          FOO: 'bar',
        },
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
        },
      } as any,
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readCredentialsFn: async () => credentials,
      writeSessionMarkerFn: async (args: Record<string, unknown>) => {
        markerArgs = args;
        resolveMarker();
      },
    } as any);

    onWebhook('session-daemon-555', createMetadata(555, 'daemon', '/tmp/workspace'));
    await markerWritten;

    expect(markerArgs.respawn).toEqual({
      version: 1,
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'vendor-resume-id',
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'happy', isolated: true, tmpDir: '/tmp/tmux' },
      },
      transcriptStorage: 'direct',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
      },
      sealedEnvironmentVariables: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
    });
    expect(markerArgs.respawn?.token).toBeUndefined();
    expect(markerArgs.respawn?.environmentVariables).not.toMatchObject({
      ANTHROPIC_AUTH_TOKEN: expect.any(String),
      FOO: expect.any(String),
    });
  });

  it('persists zellij topology in the daemon marker respawn fallback', async () => {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(556), pid: 556,
      startedBy: 'daemon',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        terminal: {
          mode: 'zellij',
        },
      },
    };
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    type WriteSessionMarkerFn = NonNullable<
      Parameters<typeof createOnHappySessionWebhook>[0]['writeSessionMarkerFn']
    >;
    const captured = {
      marker: undefined as Parameters<WriteSessionMarkerFn>[0] | undefined,
    };
    const writeSessionMarkerFn = vi.fn<WriteSessionMarkerFn>(async (
      marker: Parameters<WriteSessionMarkerFn>[0],
    ) => {
      captured.marker = marker;
      resolveMarker();
    });
    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
      spawnAwaiterByKey: new Map(),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
    });

    onWebhook('session-zellij-556', createMetadata(556, 'daemon', '/tmp/workspace'));
    await markerWritten;

    expect(captured.marker?.respawn).toMatchObject({
      version: 1,
      directory: '/tmp/workspace',
      terminal: {
        mode: 'zellij',
      },
    });
  });

  it('matches an unknown webhook PID to a daemon-tracked wrapper PID via PPID and resolves awaiter', async () => {
    const wrapperPid = 111;
    const runnerPid = 222;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon' };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(wrapperPid), awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook('session-real-222', createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(wrapperPid))).toBe(false);
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(runnerPid))).toBe(false);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(wrapperPid))?.happySessionId).toBe('session-real-222');
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(wrapperPid))?.sessionRunnerPid).toBe(runnerPid);
  });

  it('defers wrapper awaiter resolution on PID placeholder and resolves on canonical id', async () => {
    const wrapperPid = 111;
    const runnerPid = 222;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon' };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const awaiter = vi.fn();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>([[legacyPidSessionTrackingKey(wrapperPid), awaiter]]);

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
    });

    await onWebhook(`PID-${runnerPid}`, createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(0);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(wrapperPid))).toBe(true);

    await onWebhook('session-real-222', createMetadata(runnerPid, 'daemon'));

    expect(awaiter).toHaveBeenCalledTimes(1);
    expect(spawnAwaiterByKey.has(legacyPidSessionTrackingKey(wrapperPid))).toBe(false);
  });

  it('keeps birth-only webhook identity without hashing daemon child spawn arguments', async () => {
    const sessionPid = 777;
    const spawnArgs = [
      '/usr/bin/node',
      '/repo/.project/tmp/cli-dist-snapshot/src/index.ts',
      'claude',
      '--happy-starting-mode',
      'remote',
      '--started-by',
      'daemon',
    ];
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(sessionPid), pid: sessionPid,
      startedBy: 'daemon',
      childProcess: { pid: sessionPid, spawnargs: spawnArgs } as any,
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[tracked.trackingKey, tracked]]);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();

    let markerArgs: any = null;
    let resolveMarker!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    const onWebhook = createOnHappySessionWebhook({
      trackedSessionsByKey,
      spawnAwaiterByKey,
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: sessionPid,
        processStartTimeMs: 1_717_171_717_000,
        command: '',
      }),
      writeSessionMarkerFn: async (args) => {
        markerArgs = args;
        resolveMarker();
      },
    });

    onWebhook('session-daemon-777', createMetadata(sessionPid, 'daemon', '/tmp/workspace'));
    await markerWritten;

    expect(markerArgs.processCommand).toBeUndefined();
    expect(markerArgs.processCommandHash).toBeUndefined();
    expect(markerArgs.processStartTimeMs).toBe(1_717_171_717_000);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(sessionPid))?.processCommand).toBeUndefined();
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(sessionPid))?.processCommandHash).toBeUndefined();
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(sessionPid))?.processStartTimeMs).toBe(1_717_171_717_000);
  });
});
