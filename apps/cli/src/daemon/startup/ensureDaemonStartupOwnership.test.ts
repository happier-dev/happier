import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('ensureDaemonStartupOwnership', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.doUnmock('@/daemon/doctor');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('fails closed when daemon state is missing but a relay process is still alive', async () => {
    await withTempDir('happier-daemon-startup-process-only-owner-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
      });
      vi.resetModules();
      const daemonCommand = `${process.execPath} ${join(process.cwd(), 'package-dist/index.mjs')} daemon start-sync`;
      vi.doMock('@/daemon/doctor', () => ({
        findAllHappyProcesses: vi.fn(async () => [
          {
            pid: 4242,
            command: daemonCommand,
            type: 'daemon',
          },
        ]),
      }));

      const [{ ensureDaemonStartupOwnership }, { logger }] = await Promise.all([
        import('./ensureDaemonStartupOwnership'),
        import('@/ui/logger'),
      ]);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        return undefined as never;
      }) as typeof process.exit);

      const result = await ensureDaemonStartupOwnership({
        takeoverRequested: false,
        startupSource: 'manual',
        runtimeId: 'runtime-test',
      });

      expect(result).toEqual({ action: 'exit' });
      expect(exitSpy).toHaveBeenCalledWith(1);
      const logContent = await readFile(logger.logFilePath, 'utf8');
      expect(logContent).toContain('Relay ownership conflict prevented daemon startup');
      expect(logContent).toContain('Another relay owner already owns this relay');
    });
  });

  it('force-stops a state-less relay process when takeover is requested', async () => {
    await withTempDir('happier-daemon-startup-process-only-takeover-', async (homeDir) => {
      const daemonCommand = `${process.execPath} ${join(process.cwd(), 'package-dist/index.mjs')} daemon start-sync`;
      const processOnlyOwner = {
        pid: 4242,
        command: daemonCommand,
        type: 'daemon',
      };
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
      });
      vi.resetModules();
      vi.doMock('@/daemon/doctor', () => ({
        findAllHappyProcesses: vi.fn(async () => [processOnlyOwner]),
        findHappyProcessByPid: vi.fn(async (pid: number) => (pid === processOnlyOwner.pid ? processOnlyOwner : null)),
      }));

      const { ensureDaemonStartupOwnership } = await import('./ensureDaemonStartupOwnership');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === processOnlyOwner.pid && signal === 0) {
          throw new Error('process exited');
        }
        return true;
      }) as typeof process.kill);

      const result = await ensureDaemonStartupOwnership({
        takeoverRequested: true,
        startupSource: 'manual',
        runtimeId: 'runtime-test',
      });

      expect(result).toEqual({ action: 'continue' });
      expect(killSpy).toHaveBeenCalledWith(processOnlyOwner.pid, 'SIGTERM');
    });
  });
});
