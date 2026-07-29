import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' }) as any),
  };
});

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(),
  writeDaemonState: vi.fn(),
}));

vi.mock('../sessionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessionRegistry')>();
  return {
    ...actual,
    removeSessionMarker: vi.fn(async () => {}),
    removeSessionMarkerIfOwned: vi.fn(async () => true),
    promoteSessionMarkerPid: vi.fn(async () => {}),
  };
});

import { readDaemonState, writeDaemonState } from '@/persistence';
import {
  hashProcessCommand,
  removeSessionMarkerIfOwned,
} from '../sessionRegistry';

describe('startDaemonHeartbeatLoop process-missing delegation', () => {
  beforeEach(() => {
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    vi.useFakeTimers();
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

  it('keeps an exact live runner but prunes a reused PID through the existing exit cleanup exactly once', async () => {
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

    const samePid = 111112;
    const reusedPid = 111113;
    const sameCommand = 'happier session --existing-session sess-exact-live';
    const oldCommand = 'happier session --existing-session sess-reused';
    const pidToTrackedSession = new Map<number, any>([
      [samePid, {
        pid: samePid,
        happySessionId: 'sess-exact-live',
        processStartTimeMs: 1_000,
        processCommandHash: hashProcessCommand(sameCommand),
      }],
      [reusedPid, {
        pid: reusedPid,
        happySessionId: 'sess-reused',
        processStartTimeMs: 2_000,
        processCommandHash: hashProcessCommand(oldCommand),
      }],
    ]);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      targetPid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if ((targetPid === samePid || targetPid === reusedPid) && signal === 0) {
        return true;
      }
      throw new Error(`unexpected process signal ${String(signal)} for ${targetPid}`);
    }) as typeof process.kill);
    const cleanupReusedPid = vi.fn(async () => undefined);
    const onChildExited = vi.fn(async (targetPid: number) => {
      await cleanupReusedPid();
      pidToTrackedSession.delete(targetPid);
    });
    const readProcessIdentityByPidFn = vi.fn(async (pid: number) => ({
      pid,
      processStartTimeMs: pid === samePid ? 1_000 : 9_000,
      command: pid === samePid ? sameCommand : 'foreign reused command',
    }));
    const findHappyProcessByPidFn = vi.fn(async (pid: number) => ({
      pid,
      command: sameCommand,
      type: 'daemon-spawned-session',
    }));

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
      pidSafetyDependencies: {
        readProcessIdentityByPidFn,
        findHappyProcessByPidFn,
      },
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
    await tick!();

    expect(onChildExited).toHaveBeenCalledTimes(1);
    expect(onChildExited).toHaveBeenCalledWith(
      reusedPid,
      expect.objectContaining({ reason: 'process-missing' }),
    );
    expect(pidToTrackedSession.has(samePid)).toBe(true);
    expect(pidToTrackedSession.has(reusedPid)).toBe(false);
    expect(cleanupReusedPid).toHaveBeenCalledOnce();
    expect(readProcessIdentityByPidFn).toHaveBeenCalledWith(samePid);
    expect(readProcessIdentityByPidFn).toHaveBeenCalledWith(reusedPid);
    expect(findHappyProcessByPidFn).toHaveBeenCalledWith(samePid);
    expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it('does not publish PID cleanup or self-restart after shutdown begins during exact identity proof', async () => {
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
    const pid = 111114;
    const command =
      'happier session --existing-session sess-quiescing';
    const pidToTrackedSession = new Map<number, any>([[
      pid,
      {
        pid,
        happySessionId: 'sess-quiescing',
        processStartTimeMs: 1_000,
        processCommandHash: hashProcessCommand(command),
      },
    ]]);
    vi.spyOn(process, 'kill').mockImplementation(((
      targetPid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (targetPid === pid && signal === 0) return true;
      throw new Error(`unexpected process signal ${String(signal)} for ${targetPid}`);
    }) as typeof process.kill);
    let markIdentityReadEntered: (() => void) | null = null;
    const identityReadEntered = new Promise<void>((resolve) => {
      markIdentityReadEntered = resolve;
    });
    let resolveIdentityRead!: (
      identity: Readonly<{
        pid: number;
        processStartTimeMs: number;
        command: string;
      }>,
    ) => void;
    const identityReadResult = new Promise<Readonly<{
      pid: number;
      processStartTimeMs: number;
      command: string;
    }>>((resolve) => {
      resolveIdentityRead = resolve;
    });
    const onChildExited = vi.fn(async () => undefined);
    const requestSelfRestart = vi.fn(async () => ({
      status: 'replacement_not_confirmed' as const,
    }));
    let shuttingDown = false;

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
      pidSafetyDependencies: {
        findHappyProcessByPidFn: vi.fn(async () => ({
          pid,
          command,
          type: 'daemon-spawned-session',
        })),
        readProcessIdentityByPidFn: vi.fn(async () => {
          markIdentityReadEntered?.();
          return await identityReadResult;
        }),
      },
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '0.9.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '0.9.0',
      requestShutdown: vi.fn(),
      requestSelfRestart,
      isShuttingDown: () => shuttingDown,
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined =
      (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    const tickPromise = tick!();
    await identityReadEntered;
    shuttingDown = true;
    resolveIdentityRead({
      pid,
      processStartTimeMs: 2_000,
      command: 'foreign reused process',
    });
    await tickPromise;

    expect(onChildExited).not.toHaveBeenCalled();
    expect(requestSelfRestart).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(pid)).toBe(true);
  });

  it('uses a sub-minute default heartbeat interval for state freshness', async () => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
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

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
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

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
  });

  it('removes stale session runner markers when onChildExited is not provided', async () => {
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

    vi.mocked(removeSessionMarkerIfOwned).mockClear();

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

    expect(
      vi.mocked(removeSessionMarkerIfOwned).mock.calls
        .map(([input]) => input.pid),
    ).toEqual(
      expect.arrayContaining([pid, runnerPid]),
    );
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

  it('does not request shutdown when the state file is clobbered by another pid', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid + 1234,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const requestShutdown = vi.fn();

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
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
      requestShutdown,
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    expect(requestShutdown).not.toHaveBeenCalled();
    expect(writeDaemonState).toHaveBeenCalledWith(expect.objectContaining({
      pid: process.pid,
    }));
  });
});
