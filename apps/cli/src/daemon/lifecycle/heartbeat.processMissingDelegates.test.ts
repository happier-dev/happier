import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SessionMarkerReadResult = Awaited<ReturnType<typeof import('../sessionRegistry').readSessionMarkerForPid>>;
const readSessionMarkerForPid = vi.hoisted(() => vi.fn<
  (_pid: number) => Promise<SessionMarkerReadResult>
>(async () => null));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' }) as any),
  };
});

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(),
  writeDaemonStateIfLockOwned: vi.fn(),
}));

vi.mock('../sessionRegistry', () => ({
  promoteSessionMarkerConnectedServiceRestartIntent: vi.fn(async () => {}),
  readSessionMarkerForPid,
  removeSessionMarker: vi.fn(async () => {}),
  updateSessionMarkerActiveTurn: vi.fn(async () => {}),
}));

import { readDaemonState } from '@/persistence';
import { removeSessionMarker } from '../sessionRegistry';

describe('startDaemonHeartbeatLoop process-missing delegation', () => {
  beforeEach(() => {
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    vi.useFakeTimers();
    vi.resetModules();
    readSessionMarkerForPid.mockReset();
    readSessionMarkerForPid.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('delegates missing pids to onChildExited when provided', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const pid = 111111;
    const pidToTrackedSession = new Map<number, any>([[pid, { pid, happySessionId: 'sess-1' }]]);

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === pid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExitedMock = vi.fn();
    const onChildExited = (targetPid: number, exit: any) => {
      onChildExitedMock(targetPid, exit);
      pidToTrackedSession.delete(targetPid);
    };

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    expect(onChildExitedMock).toHaveBeenCalledTimes(1);
    expect(onChildExitedMock).toHaveBeenCalledWith(pid, expect.objectContaining({ reason: 'process-missing' }));
    expect(pidToTrackedSession.has(pid)).toBe(false);
  });

  it('does not treat legacy command drift as proof that a live pid was reused', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const pid = 555555;
    const pidToTrackedSession = new Map<number, any>([[
      pid,
      { pid, happySessionId: 'sess-4', processCommandHash: 'a'.repeat(64) },
    ]]);

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === pid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExitedMock = vi.fn();
    const onChildExited = (targetPid: number, exit: any) => {
      onChildExitedMock(targetPid, exit);
      pidToTrackedSession.delete(targetPid);
    };

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
      readSessionRunnerProcessIdentity: async () => ({ kind: 'not_happy' }),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    expect(onChildExitedMock).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(pid)).toBe(true);
  });

  it('prunes a live pid when the process-instance fingerprint proves reuse', async () => {
    const tracked = {
      startedBy: 'terminal',
      pid: 555557,
      processCommandHash: 'a'.repeat(64),
      processInstanceFingerprint: 'linux-proc:old',
    } as const;
    const { getTrackedSessionHeartbeatPruneReason } = await import('./heartbeat');

    expect(getTrackedSessionHeartbeatPruneReason({
      isPidAlive: true,
      trackedSession: tracked,
      currentIdentity: {
        kind: 'happy',
        processCommandHash: 'b'.repeat(64),
        processInstanceFingerprint: 'linux-proc:new',
      },
    })).toBe('process-reused');
  });

  it('does not prune a daemon-owned session while its child process handle is still live', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const pid = 555556;
    const pidToTrackedSession = new Map<number, any>([[
      pid,
      {
        pid,
        startedBy: 'daemon',
        happySessionId: 'sess-live-child',
        processCommandHash: 'a'.repeat(64),
        childProcess: {
          pid,
          exitCode: null,
          signalCode: null,
        },
      },
    ]]);

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === pid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExitedMock = vi.fn();
    const onChildExited = (targetPid: number, exit: any) => {
      onChildExitedMock(targetPid, exit);
      pidToTrackedSession.delete(targetPid);
    };

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
      readSessionRunnerProcessIdentity: async () => ({ kind: 'not_happy' }),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    expect(onChildExitedMock).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(pid)).toBe(true);
  });

  it('releases stale session runner markers through the canonical no-exact-turn observation', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const pid = 222222;
    const runnerPid = 333333;
    const pidToTrackedSession = new Map<number, any>([
      [pid, { pid, sessionRunnerPid: runnerPid, happySessionId: 'sess-2' }],
    ]);

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === pid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    vi.mocked(removeSessionMarker).mockClear();

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    expect(removeSessionMarker).toHaveBeenCalledWith(pid);
    expect(removeSessionMarker).toHaveBeenCalledWith(runnerPid);
    expect(pidToTrackedSession.has(pid)).toBe(false);
  });

  it('does not prune sessions when kill(0) fails with EPERM (process exists but permission denied)', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const pid = 444444;
    const pidToTrackedSession = new Map<number, any>([[pid, { pid, happySessionId: 'sess-3' }]]);

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === pid && signal === 0) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExitedMock = vi.fn();
    const onChildExited = (targetPid: number, exit: any) => {
      onChildExitedMock(targetPid, exit);
      pidToTrackedSession.delete(targetPid);
    };

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    expect(onChildExitedMock).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(pid)).toBe(true);
  });

  it('clears tracked host-dead status after the runner marker reports a recovered host', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });
    readSessionMarkerForPid.mockResolvedValue({
      pid: process.pid,
      happySessionId: 'sess-recovered',
      startedBy: 'daemon',
      cwd: '/workspace',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 2,
    });
    vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);
    const tracked = {
      pid: process.pid,
      happySessionId: 'sess-recovered',
      terminalHostHealth: {
        status: 'host_dead',
        sessionId: 'sess-recovered',
        runnerPid: process.pid,
        hostKind: 'zellij',
        observedAt: 1,
        reason: 'pane_dead',
      },
    };
    const pidToTrackedSession = new Map<number, any>([[process.pid, tracked]]);

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    await tick?.();

    expect(tracked.terminalHostHealth).toBeUndefined();
  });
});
