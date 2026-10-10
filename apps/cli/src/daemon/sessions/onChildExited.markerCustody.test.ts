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

let temporaryHome: string | undefined;

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
  await writeSessionMarker({ pid, happySessionId: 'retained-session', startedBy: 'terminal', cwd: temporaryHome });
  const removals: Promise<void>[] = [];
  const onChildExited = createOnChildExited({
    pidToTrackedSession: new Map(),
    spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(),
    getApiMachineForSessions: () => null,
    removeSessionMarkerFn: (markerPid) => {
      // Observe completion without replacing the real marker persistence owner.
      const removal = removeSessionMarker(markerPid);
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

it('preserves a replacement birth-only marker when exiting custody has a different start witness', async () => {
  temporaryHome = await mkdtemp(join(tmpdir(), 'happier-birth-only-exit-'));
  vi.stubEnv('HAPPIER_HOME_DIR', temporaryHome);
  reloadConfiguration();
  const pid = 54321;
  await writeSessionMarker({ pid, happySessionId: `PID-${pid}`, startedBy: 'terminal', processStartTimeMs: 2000 });
  const tracked: TrackedSession = { pid, happySessionId: `PID-${pid}`, startedBy: 'terminal', processStartTimeMs: 1000 };
  const onChildExited = createOnChildExited({ pidToTrackedSession: new Map([[pid, tracked]]),
    spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null });
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
  const tracked: TrackedSession = { pid, sessionRunnerPid: childPid, childProcess: parent,
    happySessionId: `PID-${pid}`, startedBy: 'daemon', acceptedSpawnMarkerGate,
    processCommand, processCommandHash, processStartTimeMs: identity!.processStartTimeMs };
  const sessions = new Map([[pid, tracked]]);
  const accepted = commit.then(async () => {
    await writeSessionMarker({ pid, happySessionId: `PID-${pid}`, startedBy: 'daemon',
      processCommand, processCommandHash, processStartTimeMs: identity!.processStartTimeMs });
    acceptMarker(true);
  });
  const exit = createOnChildExited({ pidToTrackedSession: sessions,
    spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null });
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
      expect(sessions.get(childPid)).toBe(tracked);
      expect(sessions.has(pid)).toBe(false);
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
    pid, startedBy: 'daemon', happySessionId: 'paired-runner', sessionRunnerPid: runnerPid,
    runnerProcessIdentity: { pid: runnerPid, processStartTimeMs: 2000, processCommandHash },
  };
  const sessions = new Map([[pid, tracked]]);
  const originalKill = process.kill.bind(process);
  const signalProbe = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (target === runnerPid && signal === 0) return true;
    return originalKill(target, signal);
  });
  const exit = createOnChildExited({
    pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null,
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
    removeSessionMarkerFn: async () => {}, stageObservedExitFn: async () => {},
  });
  try {
    await exit(pid, { reason: 'process-exited', code: 0, signal: null });
    expect(sessions.get(runnerPid)).toBe(state === 'present' ? tracked : undefined);
    // A proven reused runner begins retirement, but absent Machine terminal authority
    // retains the existing no-turn Session custody rather than fabricating finalization.
    expect(sessions.get(pid)).toBe(state === 'present' ? undefined : tracked);
    expect(tracked.reportMarkerCustody?.retiring).toBe(state === 'reused' ? true : undefined);
  } finally { signalProbe.mockRestore(); }
});
