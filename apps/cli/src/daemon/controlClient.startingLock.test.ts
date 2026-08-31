import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { classifyDaemonLifecycleProcessByPid, HappyProcessInfo } from '@/daemon/doctor';
import type { readProcessRunState } from '@/daemon/processRunState';

const daemonProcessFixture = {
  pid: process.pid,
  command: 'happier daemon --started-by daemon',
  type: 'dev-daemon',
} satisfies HappyProcessInfo;
const classifyDaemonLifecycleProcessByPidMock = vi.fn<typeof classifyDaemonLifecycleProcessByPid>(
  async () => ({ kind: 'unknown' }),
);
const readProcessRunStateMock = vi.fn<typeof readProcessRunState>(async () => 'servable');

vi.mock('@/daemon/doctor', () => ({
  classifyDaemonLifecycleProcessByPid: classifyDaemonLifecycleProcessByPidMock,
}));

vi.mock('@/daemon/processRunState', () => ({
  readProcessRunState: readProcessRunStateMock,
}));

describe('daemon control client startup lock inspection', () => {
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    classifyDaemonLifecycleProcessByPidMock.mockReset();
    classifyDaemonLifecycleProcessByPidMock.mockResolvedValue({ kind: 'unknown' });
    readProcessRunStateMock.mockReset();
    readProcessRunStateMock.mockResolvedValue('servable');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('treats a fresh live unclassified lock holder as daemon startup in progress', async () => {
    await withTempDir('happier-daemon-control-fresh-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${process.pid}\n`, 'utf8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: process.pid,
      });
      unlinkSync(configuration.daemonLockFile);
    });
  }, 120_000);

  it('keeps an old live unclassified lock holder fail-closed', async () => {
    await withTempDir('happier-daemon-control-stale-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${process.pid}\n`, 'utf8');
      const old = new Date(Date.now() - 120_000);
      utimesSync(configuration.daemonLockFile, old, old);

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: process.pid,
      });
      unlinkSync(configuration.daemonLockFile);
    });
  }, 120_000);

  it('keeps a previously admitted live daemon startup after the lock freshness window', async () => {
    await withTempDir('happier-daemon-control-slow-admitted-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      classifyDaemonLifecycleProcessByPidMock
        .mockResolvedValueOnce({ kind: 'daemon', process: daemonProcessFixture })
        .mockResolvedValueOnce({ kind: 'unknown' });
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${process.pid}\n`, 'utf8');
      const old = new Date(Date.now() - 120_000);
      utimesSync(configuration.daemonLockFile, old, old);

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: process.pid,
      });
      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: process.pid,
      });
    });
  }, 120_000);

  it('does not retain startup admission after the lock holder becomes a zombie', async () => {
    await withTempDir('happier-daemon-control-zombie-admitted-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      classifyDaemonLifecycleProcessByPidMock
        .mockResolvedValueOnce({ kind: 'daemon', process: daemonProcessFixture })
        .mockResolvedValueOnce({ kind: 'unknown' });
      readProcessRunStateMock.mockResolvedValueOnce('zombie');
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${process.pid}\n`, 'utf8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: process.pid,
      });
      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'not-running',
      });
    });
  }, 120_000);

  it('does not stop an admitted live startup before state publication', async () => {
    await withTempDir('happier-daemon-control-stop-admitted-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      classifyDaemonLifecycleProcessByPidMock.mockResolvedValue({
        kind: 'daemon',
        process: daemonProcessFixture,
      });
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${process.pid}\n`, 'utf8');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'startup_in_progress',
        pid: process.pid,
      });

      expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
      expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
    });
  }, 120_000);
});
