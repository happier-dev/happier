import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { readProcessRunState } from '../processRunState';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { adoptReportedSessionRunnerIdentity } from './onHappySessionWebhook';
import { createStopSession } from './stopSession';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';

const procfsGate = vi.hoisted(() => ({
  beforeRead: null as ((path: unknown) => Promise<void>) | null,
}));
// Only the OS read is gated; PID classification, safety, and exit observation stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    await procfsGate.beforeRead?.(args[0]);
    return await actual.readFile(...args);
  } };
});

afterEach(() => { procfsGate.beforeRead = null; });

describe.skipIf(process.platform !== 'linux')('Stop exit confirmation', () => {
  it('stops the reported runner and settles its launcher-keyed custody while the launcher is still alive', async () => {
    const idle = "process.send('ready'); setInterval(() => {}, 1000)";
    const launcher = spawn(process.execPath, ['-e', idle], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const runner = spawn(process.execPath, ['-e', idle, '--', '@happier-dev/cli', '--started-by', 'daemon'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = [once(launcher, 'exit'), once(runner, 'exit')];
    try {
      await Promise.all([once(launcher, 'message'), once(runner, 'message')]);
      const launcherPid = launcher.pid!;
      const runnerPid = runner.pid!;
      const runnerFingerprint = readProcessInstanceFingerprintSync(runnerPid);
      expect(runnerFingerprint).toBeTruthy();
      const sessionId = `PID-${launcherPid}`;
      const session: TrackedSession = { pid: launcherPid, startedBy: 'daemon', happySessionId: sessionId };
      adoptReportedSessionRunnerIdentity(session, runnerPid, 'wrong-process-instance');
      const tracked = new Map([[launcherPid, session]]);
      const onExitObserved = createOnChildExited({
        pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
        getApiMachineForSessions: () => null,
        removeSessionMarkerFn: async () => {},
      });
      const stop = createStopSession({
        pidToTrackedSession: tracked,
        readAttachmentState: async () => ({ status: 'absent' }),
        waitForTrackedRunnersExit: async ({ trackedPids }) => {
          await waitForExistingSessionExitIfStopRequested({
            sessionId, pidToTrackedSession: tracked, trackedPids, timeoutMs: 1_000, pollIntervalMs: 10, onExitObserved,
          });
          return !tracked.has(launcherPid);
        },
      });
      await expect(stop(sessionId)).resolves.toEqual({ status: 'incomplete', reason: 'runner_signal_incomplete' });
      expect(await readProcessRunState(runnerPid)).toBe('servable');
      expect(tracked.get(launcherPid)).toBe(session);

      adoptReportedSessionRunnerIdentity(session, runnerPid, runnerFingerprint!);
      await expect(stop(sessionId)).resolves.toEqual({ status: 'stopped' });
      expect(await readProcessRunState(runnerPid)).toBe('dead');
      expect(await readProcessRunState(launcherPid)).toBe('servable');
      expect(tracked.size).toBe(0);
    } finally {
      for (const child of [launcher, runner]) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.all(exited);
    }
  });

  it('confirms runner death during guarded escalation without signaling an unverified PID', async () => {
    // Development-only owned child. It ignores graceful Stop until the identity probe starts.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    await once(child, 'message');
    const pid = child.pid!;
    const tracked = new Map([[pid, { pid, startedBy: 'daemon' as const, happySessionId: 'exit-during-safety', childProcess: child }]]);
    const observeExit = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) => {
      return await waitForTrackedRunnerProcessesExit({
        runners: trackedPids.map((runnerPid) => ({ pid: runnerPid })), timeoutMs: 0, pollIntervalMs: 0,
        onExitObserved: (runnerPid) => { tracked.delete(runnerPid); },
      });
    };
    let guardedProbeStarted = false;
    procfsGate.beforeRead = async (path) => {
      if (String(path) !== `/proc/${pid}/cmdline`) return;
      guardedProbeStarted = true;
      child.kill('SIGKILL');
      await exited;
    };
    const signals: NodeJS.Signals[] = [];
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (targetPid === pid && signal === 'SIGKILL') signals.push(signal);
      return originalKill(targetPid, signal);
    });
    try {
      const stop = createStopSession({
        pidToTrackedSession: tracked,
        readAttachmentState: async () => ({ status: 'absent' }),
        areTrackedRunnersExited: observeExit,
        waitForTrackedRunnersExit: observeExit,
      });
      await expect(stop('exit-during-safety')).resolves.toEqual({ status: 'stopped' });
      expect(guardedProbeStarted).toBe(true);
      expect(signals).not.toContain('SIGKILL');
      expect(tracked.size).toBe(0);
      expect(await readProcessRunState(pid)).toBe('dead');
    } finally {
      procfsGate.beforeRead = null;
      kill.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
