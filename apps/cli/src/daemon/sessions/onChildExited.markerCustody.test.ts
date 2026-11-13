import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { writeSessionMarker, listSessionMarkers, removeSessionMarker, hashProcessCommand } from '../sessionRegistry';
import { createOnChildExited } from './onChildExited';
import { spawnInlineNodeParentWithChild } from '@/testkit/process/spawn';
import { once } from 'node:events';
import type { TrackedSession } from '../types';
import { readProcessIdentityByPid } from '../processIdentity';
import { armSessionWebhookStartupCustody, waitForSessionWebhook } from '../spawn/waitForSessionWebhook';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let temporaryHome: string | undefined;

it('settles the exact guard receipt before requester resource retirement and retains failed publication for retry', async () => {
  temporaryHome = await mkdtemp(join(tmpdir(), 'happier-guard-exit-'));
  vi.stubEnv('HAPPIER_HOME_DIR', temporaryHome); reloadConfiguration();
  const pid = 54321;
  const order: string[] = [];
  let unavailable = true;
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: `PID-${pid}`, startedBy: 'terminal',
    guardStopReceipt: { settle: async status => {
      order.push(status);
      if (unavailable) throw new Error('Record publication unavailable');
    } } };
  const sessions = new Map([[tracked.trackingKey, tracked]]);
  const exit = createOnChildExited({ trackedSessionsByKey: sessions,
    spawnResourceCleanupByKey: new Map([[tracked.trackingKey, () => { order.push('cleanup'); }]]),
    sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  await exit(pid, { reason: 'process-missing', code: null, signal: null });
  expect(order).toEqual(['stopped']);
  expect(sessions.get(tracked.trackingKey)).toBe(tracked);
  unavailable = false;
  await exit(pid, { reason: 'process-missing', code: null, signal: null });
  expect(order).toEqual(['stopped', 'stopped', 'cleanup']);
  expect(sessions.has(tracked.trackingKey)).toBe(false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  reloadConfiguration();
  if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
});

it('preserves marker evidence when an exit notification has no tracked custody', async () => {
  temporaryHome = await mkdtemp(join(tmpdir(), 'happier-untracked-exit-'));
  vi.stubEnv('HAPPIER_HOME_DIR', temporaryHome);
  // Refresh the real environment owner; keep module-loading cost outside the test action clock.
  reloadConfiguration();
  const pid = 54321;
  await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'retained-session', startedBy: 'terminal', cwd: temporaryHome });
  const removals: Promise<void>[] = [];
  const onChildExited = createOnChildExited({
    trackedSessionsByKey: new Map(),
    spawnResourceCleanupByKey: new Map(),
    sessionAttachCleanupByKey: new Map(),
    getApiMachineForSessions: () => null,
    removeSessionMarkerFn: (trackingKey) => {
      // Observe completion without replacing the real marker persistence owner.
      const removal = removeSessionMarker(trackingKey);
      removals.push(removal);
      return removal;
    },
  });

  await onChildExited(pid, { reason: 'process-missing', code: null, signal: null });
  await Promise.all(removals);

  expect(await listSessionMarkers()).toEqual([
    expect.objectContaining({ pid, happySessionId: 'retained-session' }),
  ]);
});

it('retains pending wrapper custody until a reported runner has paired generation evidence', async () => {
  const pid = 683103;
  const runnerPid = process.pid;
  const tracked: TrackedSession = {
    trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'pending-paired-runner', sessionRunnerPid: runnerPid,
    processStartTimeMs: 1000,
  };
  const sessions = new Map([[tracked.trackingKey, tracked]]);
  const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
  const resolvers = new Map<SessionTrackingKey, (result: SpawnSessionResult) => void>();
  const timeouts = new Map<SessionTrackingKey, NodeJS.Timeout>();
  const completion = waitForSessionWebhook({
    trackingKey: tracked.trackingKey, pid, trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
    spawnResultResolverByKey: resolvers, spawnWebhookTimeoutByKey: timeouts,
    timeoutErrorMessage: 'Fixture webhook timeout',
  });
  armSessionWebhookStartupCustody(tracked, completion, Promise.resolve());
  const exit = createOnChildExited({
    trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
    getApiMachineForSessions: () => null,
    processPresenceDependencies: {
      readProcessRunState: async (target) => target === pid ? 'dead' : 'servable',
      readProcessIdentityByPid,
    },
    promoteSessionMarkerFn: async () => ({ sourceMarkerOwnership: null, targetMarkerOwnership: { happySessionId: 'pending-paired-runner' } }),
    removeSessionMarkerFn: async () => {},
  });
  try {
    await exit(pid, { reason: 'process-missing', code: null, signal: null });
    expect(sessions.get(tracked.trackingKey)).toBe(tracked);
    expect(tracked.pid).toBe(pid);
    expect(sessions.size).toBe(1);
    expect(completion.isPending()).toBe(true);
    expect(tracked.processStartTimeMs).toBe(1000);
  } finally {
    completion.settleFailure({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Fixture cleanup' });
    await Promise.allSettled([completion, tracked.reportMarkerCustody?.pending]);
    for (const timeout of timeouts.values()) clearTimeout(timeout);
  }
});

it('preserves a replacement birth-only marker when exiting custody has a different start witness', async () => {
  temporaryHome = await mkdtemp(join(tmpdir(), 'happier-birth-only-exit-'));
  vi.stubEnv('HAPPIER_HOME_DIR', temporaryHome);
  reloadConfiguration();
  const pid = 54321;
  await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: `PID-${pid}`, startedBy: 'terminal', processStartTimeMs: 2000 });
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: `PID-${pid}`, startedBy: 'terminal', processStartTimeMs: 1000 };
  const onChildExited = createOnChildExited({ trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  await onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });
  expect(await listSessionMarkers()).toEqual([expect.objectContaining({ pid, processStartTimeMs: 2000 })]);
});

it.skipIf(process.platform === 'win32').each([false, true])('joins held accepted wrapper marker custody before live promotion or real final retirement (runner dies %s)', async (runnerDies) => {
  temporaryHome = await mkdtemp(join(tmpdir(), 'happier-wrapper-acceptance-'));
  vi.stubEnv('HAPPIER_HOME_DIR', temporaryHome);
  reloadConfiguration();
  const { parent, childPid } = await spawnInlineNodeParentWithChild();
  const pid = parent.pid!;
  const identity = await readProcessIdentityByPid(pid);
  expect(identity).not.toBeNull();
  const processCommand = identity!.command;
  const processCommandHash = processCommand ? hashProcessCommand(processCommand) : undefined;
  let acceptMarker!: (accepted: boolean) => void;
  const acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => { acceptMarker = resolve; });
  let releaseCommit!: () => void;
  const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, sessionRunnerPid: childPid, childProcess: parent,
    happySessionId: `PID-${pid}`, startedBy: 'daemon', acceptedSpawnMarkerGate,
    processCommand, processCommandHash, processStartTimeMs: identity!.processStartTimeMs };
  const sessions = new Map([[tracked.trackingKey, tracked]]);
  const accepted = commit.then(async () => {
    await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: `PID-${pid}`, startedBy: 'daemon',
      processCommand, processCommandHash, processStartTimeMs: identity!.processStartTimeMs });
    acceptMarker(true);
  });
  const exit = createOnChildExited({ trackedSessionsByKey: sessions,
    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  let exiting: Promise<void> | undefined;
  try {
    const exited = once(parent, 'exit');
    parent.kill('SIGTERM');
    await exited;
    // Existing marker-per-PID serialization makes the ordering observable:
    // promotion must not claim its marker mutation before accepted persistence.
    exiting = exit(pid, { reason: 'process-exited-before-webhook', code: 0, signal: null });
    if (runnerDies) {
      process.kill(childPid, 'SIGTERM');
      await vi.waitFor(() => {
        expect(() => process.kill(childPid, 0)).toThrow();
      });
    }
    releaseCommit();
    await Promise.all([accepted, exiting]);
    if (runnerDies) {
      expect(sessions.size).toBe(0);
      expect(await listSessionMarkers()).toEqual([]);
    } else {
      expect(sessions.get(tracked.trackingKey)).toBe(tracked);
      expect(tracked.pid).toBe(childPid);
      expect(sessions.size).toBe(1);
      expect((await listSessionMarkers()).map((marker) => marker.pid)).toEqual([childPid]);
    }
  } finally {
    releaseCommit();
    acceptMarker(false);
    await Promise.allSettled([accepted, ...(exiting ? [exiting] : [])]);
    try { process.kill(childPid, 'SIGTERM'); } catch {}
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
  }
});


it.each(['present', 'reused', 'unknown', 'stopped'] as const)('promotes wrapper custody only for the captured runner generation (%s)', async (state) => {
  const pid = 683101;
  const runnerPid = 683102;
  const command = 'happier codex --existing-session paired-runner';
  const processCommandHash = hashProcessCommand(command);
  const tracked: TrackedSession = {
    trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'paired-runner', sessionRunnerPid: runnerPid,
    runnerProcessIdentity: { pid: runnerPid, processStartTimeMs: 2000, processCommandHash },
  };
  const sessions = new Map([[tracked.trackingKey, tracked]]);
  const originalKill = process.kill.bind(process);
  const signalProbe = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (target === runnerPid && signal === 0) return true;
    return originalKill(target, signal);
  });
  const exit = createOnChildExited({
    trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
    sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null,
    processPresenceDependencies: {
      readProcessRunState: async () => {
        if (state === 'unknown') throw new Error('OS run state unavailable');
        return state === 'stopped' ? 'stopped' : 'servable';
      },
      readProcessIdentityByPid: async () => state === 'unknown' ? null : {
        pid: runnerPid, processStartTimeMs: state === 'reused' ? 9000 : 2000, command,
      },
    },
    // Filesystem boundary models the marker committed for the live captured runner.
    promoteSessionMarkerFn: async () => ({ sourceMarkerOwnership: null,
      targetMarkerOwnership: { happySessionId: 'paired-runner', processStartTimeMs: 2000, processCommandHash } }),
    removeSessionMarkerFn: async () => {},
  });
  try {
    await exit(pid, { reason: 'process-exited', code: 0, signal: null });
    // A proven reused runner begins retirement, but absent Machine terminal authority
    // retains the existing no-turn Session custody rather than fabricating finalization.
    expect(sessions.get(tracked.trackingKey)).toBe(tracked);
    expect(tracked.pid).toBe(state === 'present' ? runnerPid : pid);
    expect(tracked.reportMarkerCustody?.retiring).toBe(state === 'reused' ? true : undefined);
  } finally { signalProbe.mockRestore(); }
});
