import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('daemon control client startup lock inspection', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  const spawnedChildren: ChildProcess[] = [];

  afterEach(() => {
    while (spawnedChildren.length > 0) {
      const child = spawnedChildren.pop();
      if (!child) continue;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    vi.resetModules();
    vi.doUnmock('@/daemon/doctor');
  });

  it('reports startup in progress when a live daemon lock exists before state is written', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-starting-lock-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
    });

    try {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '/repo/dist/index.mjs', 'daemon', 'start-sync'],
        { stdio: 'ignore' },
      );
      if (!child.pid) throw new Error('missing pid for child');
      spawnedChildren.push(child);

      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, String(child.pid), 'utf-8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: child.pid,
      });
      expect(existsSync(configuration.daemonLockFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('treats a fresh live unclassified lock holder as startup in progress', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-starting-lock-unclassified-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: vi.fn(async () => ({ kind: 'unknown' as const })),
    }));

    try {
      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, '424242', 'utf-8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: 424242,
      });
      expect(existsSync(configuration.daemonLockFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
      removeTempDirSync(homeDir);
    }
  });

  it('does not report startup forever for a stale live unclassified lock holder', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stale-live-lock-unclassified-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: vi.fn(async () => ({ kind: 'unknown' as const })),
    }));

    try {
      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, '424243', 'utf-8');
      const stale = new Date(Date.now() - 10 * 60_000);
      utimesSync(configuration.daemonLockFile, stale, stale);

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'not-running',
      });
      expect(existsSync(configuration.daemonLockFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
      removeTempDirSync(homeDir);
    }
  });

  it('keeps a previously classified live startup after the freshness window', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-slow-classified-lock-');
    envScope.patch({ HAPPIER_HOME_DIR: homeDir });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    const classifyDaemonLifecycleProcessByPid = vi.fn()
      .mockResolvedValueOnce({
        kind: 'daemon' as const,
        process: { pid: 424245, command: 'happier daemon start-sync', type: 'dev-daemon' },
      })
      .mockResolvedValueOnce({ kind: 'unknown' as const });
    vi.doMock('@/daemon/doctor', () => ({ classifyDaemonLifecycleProcessByPid }));
    vi.doMock('@/daemon/processRunState', () => ({
      readProcessRunState: vi.fn(async () => 'servable'),
    }));

    try {
      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, '424245', 'utf-8');
      const stale = new Date(Date.now() - 10 * 60_000);
      utimesSync(configuration.daemonLockFile, stale, stale);

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: 424245,
      });
      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: 424245,
      });
    } finally {
      killSpy.mockRestore();
      vi.doUnmock('@/daemon/processRunState');
      removeTempDirSync(homeDir);
    }
  }, 120_000);

  it('does not stop a fresh live daemon startup lock before state is written', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-starting-lock-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
    });

    const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      killCalls.push({ pid: Number(pid), signal: signal as NodeJS.Signals | 0 | undefined });
      return true as any;
    });
    vi.doMock('@/daemon/doctor', () => ({
      classifyDaemonLifecycleProcessByPid: vi.fn(async () => ({
        kind: 'daemon' as const,
        process: { pid: 424244, command: 'happier daemon start-sync', type: 'dev-daemon' },
      })),
    }));

    try {
      vi.resetModules();
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, '424244', 'utf-8');

      await stopDaemon();

      expect(killCalls).toEqual([{ pid: 424244, signal: 0 }]);
      expect(existsSync(configuration.daemonLockFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
      removeTempDirSync(homeDir);
    }
  });
});
