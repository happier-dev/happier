import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(),
  writeDaemonState: vi.fn(),
}));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/projectPath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/projectPath')>();
  return { ...actual, projectPath: vi.fn(actual.projectPath) };
});

import { readFileSync } from 'node:fs';
import { projectPath } from '@/projectPath';

import { readDaemonState } from '@/persistence';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

describe('startDaemonHeartbeatLoop daemon self-restart', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string | null = null;

  function installVersion(projectRoot: string, version: string): string {
    vi.mocked(projectPath).mockReturnValue(projectRoot);
    const manifest = join(projectRoot, 'package.json');
    const replacement = join(projectRoot, 'package.next.json');
    writeFileSync(replacement, JSON.stringify({ version }));
    renameSync(replacement, manifest);
    return manifest;
  }

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS;
    if (happyHomeDir && existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    happyHomeDir = null;
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the daemon startup budget for replacement verification by default', async () => {
    vi.resetModules();

    const { DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS } = await import('./heartbeat');

    expect(DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS).toBe(60_000);
  });

  it('does not permanently lock the heartbeat loop if reading package.json throws', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    const manifest = installVersion(happyHomeDir, '1.0.0');
    const readPackage = vi.mocked(readFileSync);
    const { readFileSync: readFile } = await vi.importActual<typeof import('node:fs')>('node:fs');
    let manifestReads = 0;
    readPackage.mockImplementation(((...args: Parameters<typeof readFileSync>) => {
      if (args[0] === manifest && ++manifestReads === 1) throw new Error('transient read failure');
      return Reflect.apply(readFile, undefined, args);
    }) as typeof readFileSync);

    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    startDaemonHeartbeatLoop({
      trackedSessionsByKey: new Map(),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        runtimeId: 'runtime-heartbeat-restart',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');

    try {
      await tick!();
    } catch {
      // pre-fix behavior: first tick throws and leaves heartbeatRunning stuck true
    }

    await tick!();
    await tick!();
    expect(manifestReads).toBe(2);
    expect(spawnDetachedDaemonStartSync).not.toHaveBeenCalled();
  }, 15_000);

  it('uses start-sync and keeps the current daemon alive if replacement is not confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    installVersion(happyHomeDir, '2.0.0');
    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    const interval = startDaemonHeartbeatLoop({
      trackedSessionsByKey: new Map(),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        runtimeId: 'runtime-heartbeat-restart',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    const firstSpawnCall = vi.mocked(spawnDetachedDaemonStartSync).mock.calls[0]?.[0] as
      | { env?: Record<string, string>; startupSource?: string }
      | undefined;
    expect(firstSpawnCall?.startupSource).toBe('self-restart');
    expect(firstSpawnCall?.env?.HAPPIER_DAEMON_RUNTIME_ID).toBe('runtime-heartbeat-restart');
    expect(exitSpy).not.toHaveBeenCalled();

    installVersion(happyHomeDir, '3.0.0');
    await tick!();
    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(2);

    clearInterval(interval);
  }, 15_000);

  it('exits only after replacement daemon with current CLI version is confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '40';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';
    const replacement = spawnSleepyDetachedProcess();

    try {
      vi.resetModules();

      let tick: (() => Promise<void>) | undefined;
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation(((handler: (...args: any[]) => any) => {
          tick = handler as unknown as () => Promise<void>;
          return 1 as any;
        }) as any);

      installVersion(happyHomeDir, '2.0.0');
      vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
      vi.mocked(readDaemonState)
        .mockResolvedValueOnce({
          pid: process.pid,
          httpPort: 7001,
          startedAt: Date.now(),
          startedWithCliVersion: '1.0.0',
        })
        .mockResolvedValue({
          pid: replacement.pid,
          httpPort: 7002,
          startedAt: Date.now(),
          startedWithCliVersion: '2.0.0',
          runtimeId: 'runtime-heartbeat-confirmed',
          controlToken: 'replacement-control-token',
        });
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        if (
          url.hostname === '127.0.0.1'
          && url.port === '7002'
          && init?.method === 'POST'
          && (init.headers as Record<string, string> | undefined)?.['x-happier-daemon-token'] === 'replacement-control-token'
        ) {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }));

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      const { startDaemonHeartbeatLoop } = await import('./heartbeat');

      const interval = startDaemonHeartbeatLoop({
        trackedSessionsByKey: new Map(),
        spawnResourceCleanupByKey: new Map(),
        sessionAttachCleanupByKey: new Map(),
        getApiMachineForSessions: () => null,
        fileState: {
          pid: process.pid,
          httpPort: 5555,
          startedAt: Date.now(),
          startedWithCliVersion: '1.0.0',
          runtimeId: 'runtime-heartbeat-confirmed',
        },
        currentCliVersion: '1.0.0',
      });

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(tick).toBeTypeOf('function');
      await tick!();

      expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
      const confirmedSpawnCall = vi.mocked(spawnDetachedDaemonStartSync).mock.calls[0]?.[0] as
        | { env?: Record<string, string>; startupSource?: string }
        | undefined;
      expect(confirmedSpawnCall?.startupSource).toBe('self-restart');
      expect(confirmedSpawnCall?.env?.HAPPIER_DAEMON_RUNTIME_ID).toBe('runtime-heartbeat-confirmed');
      expect(exitSpy).toHaveBeenCalledWith(0);

      clearInterval(interval);
    } finally {
      await replacement.kill();
    }
  }, 15_000);
});
