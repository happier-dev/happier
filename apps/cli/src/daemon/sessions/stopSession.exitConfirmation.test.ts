import { logger } from '@/ui/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessRunState } from '../processRunState';
import { readProcessIdentityByPid } from '../processIdentity';
import { createStopSession } from './stopSession';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import type { TrackedSession } from '../types';
import { createSessionProcessActionLifecycle } from './sessionProcessActionLifecycle';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import { createSessionStopOperationBarrier } from './sessionStopOperationBarrier';

const procfsGate = vi.hoisted(() => ({
  beforeRead: null as ((path: unknown) => Promise<void>) | null,
}));
// Only the OS read is gated; PID classification, safety, and exit observation stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    await procfsGate.beforeRead?.(args[0]);
    return await actual.open(...args);
  }, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    await procfsGate.beforeRead?.(args[0]);
    return await actual.readFile(...args);
  } };
});

afterEach(() => { procfsGate.beforeRead = null; });

describe.skipIf(process.platform !== 'linux')('Stop exit confirmation', () => {
  it('publishes the existing stopping fact before the first native signal', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); process.send('ready'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    await once(child, 'message');
    const pid = child.pid!;
    const identity = await readProcessIdentityByPid(pid);
    if (!identity || identity.processStartTimeMs === undefined) throw new Error('fixture native identity unavailable');
    const tracked: TrackedSession = { pid, startedBy: 'daemon', happySessionId: 'native-first-signal',
      processStartTimeMs: identity.processStartTimeMs, childProcess: child,
      vendorResumeId: 'native-resume', spawnOptions: { directory: '/fixture' } };
    const sessions = new Map([[pid, tracked]]);
    let timestampAtSignal: number | undefined;
    let durableIntentAtSignal = false;
    let durableIntentRecorded = false;
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (targetPid === pid && signal === 'SIGTERM') {
        timestampAtSignal = tracked.stopRequestedAtMs;
        durableIntentAtSignal = durableIntentRecorded;
      }
      return originalKill(targetPid, signal);
    });
    try {
      const stop = createStopSession({ pidToTrackedSession: sessions,
        readHostAttachmentState: async () => ({ status: 'absent' }),
        waitForTrackedRunnersExit: async () => { await exited; return true; } });
      const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2, baseDelayMs: 0,
        maxDelayMs: 0, jitterMs: 0, random: () => 0, isSessionAlreadyRunning: () => false,
        spawnSession: async () => { throw new Error('Intentional Process Stop must not respawn'); },
        logDebug: () => {}, logWarn: () => {} });
      const lifecycle = createSessionProcessActionLifecycle({ pidToTrackedSession: sessions,
        markStopRequested: respawn.markStopRequested,
        registerPhysicalStopEffect: createSessionStopOperationBarrier().registerPhysicalStopEffect,
        recordExplicitStopIntent: async () => { durableIntentRecorded = true; }, stopSession: stop });
      await expect(lifecycle.stopExactSession({ sessionId: tracked.happySessionId!, pid,
        start: { startTimeMs: identity.processStartTimeMs }, actionContext: { surface: 'cli', authority: 'present_user',
          actionCaller: { kind: 'host' }, defaultSessionId: 'not-the-caller' } })).resolves.toEqual({ status: 'stopped' });
      expect(diagnostic.mock.calls).toContainEqual(['[DAEMON STOP] Physical Stop phase started', expect.objectContaining({
        phase: 'signal_request', requestTransport: 'process_action', requestSource: { surface: 'cli', callerKind: 'host' },
      })]);
      expect(timestampAtSignal).toEqual(expect.any(Number));
      expect(durableIntentAtSignal).toBe(true);
      expect(respawn.handleUnexpectedExit(tracked, { reason: 'process-exited', code: null, signal: 'SIGTERM' })).toBe('ignored');
    } finally {
      diagnostic.mockRestore();
      kill.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

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
