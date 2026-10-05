import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessRunState } from '../processRunState';
import { readProcessIdentityByPid } from '../processIdentity';
import { createStopSession } from './stopSession';
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
  it('confirms runner death during guarded escalation without signaling an unverified PID', async () => {
    // Development-only owned child. It ignores graceful Stop until the identity probe starts.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    await once(child, 'message');
    const pid = child.pid!;
    const identity = await readProcessIdentityByPid(pid);
    if (!identity) throw new Error('owned child identity was not observable');
    const tracked = new Map([[pid, { pid, startedBy: 'daemon' as const, happySessionId: 'exit-during-safety', childProcess: child,
      processStartTimeMs: identity.processStartTimeMs }]]);
    const observeExit = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) => {
      return await waitForTrackedRunnerProcessesExit({
        runners: trackedPids.map((runnerPid) => ({ pid: runnerPid })), timeoutMs: 0, pollIntervalMs: 0,
        onExitObserved: (runnerPid) => { tracked.delete(runnerPid); },
      });
    };
    let guardedProbeStarted = false;
    let gracefulSignalSent = false;
    procfsGate.beforeRead = async (path) => {
      if (!gracefulSignalSent || String(path) !== `/proc/${pid}/cmdline`) return;
      guardedProbeStarted = true;
      child.kill('SIGKILL');
      await exited;
    };
    const signals: NodeJS.Signals[] = [];
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (Math.abs(targetPid) === pid && signal === 'SIGTERM') gracefulSignalSent = true;
      if (targetPid === pid && signal === 'SIGKILL') signals.push(signal);
      return originalKill(targetPid, signal);
    });
    try {
      const stop = createStopSession({
        pidToTrackedSession: tracked,
        readHostAttachmentState: async () => ({ status: 'absent' }),
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
