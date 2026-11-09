import { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';
import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';

const { spawnSyncMock, spawnMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn(), spawnMock: vi.fn() }));
// Keep command resolution, CLI launch specifications and service discovery real beneath the OS boundary.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));

import { runDaemonServiceCommands } from './apply';
import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import { resolveCliVersionFromBinary } from './resolveCliVersionFromBinary';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

describe('Windows background CLI process consoles', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const envScope = createSpawnHappyCliEnvScope();
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    envScope.restore();
    vi.unstubAllEnvs();
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
  });

  it('hides scheduler lifecycle, inventory and installed-version probes', async () => {
    await withTempDir('happier-cli-console-', async (directory) => {
      for (const name of ['powershell.exe', 'schtasks.exe', 'happier.exe']) writeFileSync(join(directory, name), '');
      mkdirSync(join(directory, '.happier', 'services'), { recursive: true });
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      vi.stubEnv('PATH', directory);
      spawnSyncMock.mockImplementation((command: string, args: readonly string[] = []) => ({
        status: 0,
        stdout: command === 'powershell.exe' && args.some((arg) => arg.includes('.GetFolder("\\Happier")')) ? '[]' : '',
        stderr: '',
      }));
      runDaemonServiceCommands([
        { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Stop-ScheduledTask'] },
        { cmd: 'schtasks', args: ['/Run', '/TN', 'Happier\\happier-daemon.default'] },
      ], { failureMode: 'strict' });
      expect(await discoverInstalledDaemonServiceEntries({
        platform: 'win32', mode: 'user', userHomeDir: directory,
        happierHomeDir: join(directory, '.happier'), serversById: {},
      })).toEqual([]);
      spawnSyncMock.mockReturnValue({ status: 0, stdout: '0.2.15\n', stderr: '' });
      expect(resolveCliVersionFromBinary({ binaryPath: join(directory, 'happier.exe'), platform: 'win32' })).toBe('0.2.15');
      expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
      for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
    });
  });

  it('runs live system-task service controls hidden and reports OS command failures', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-system-task-console-', env: {
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const commandPath = join(homeDir, 'systemctl');
      writeFileSync(commandPath, '#!/bin/sh\nexit 0\n');
      chmodSync(commandPath, 0o755);
      vi.stubEnv('PATH', homeDir);
      const { resolveDaemonServiceCliRuntimeFromEnv } = await import('./cli');
      const { resolveDaemonServicePaths } = await import('./paths');
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode: 'user' });
      const paths = resolveDaemonServicePaths(runtime, { mode: 'user' });
      const { dirname } = await import('node:path');
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(paths.installedPath, renderSystemdServiceUnit({
        description: 'Happier daemon', execStart: ['/fixture/happier', 'daemon', 'start-sync'],
        env: { HAPPIER_HOME_DIR: runtime.happierHomeDir,
          HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: runtime.happierHomeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' },
      }));
      spawnSyncMock.mockImplementation((_command: string, args: readonly string[] = []) => ({
        status: args.includes('stop') ? 23 : 0, stdout: 'enabled', stderr: args.includes('stop') ? 'access denied' : '',
      }));
      const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
      const adapter = getLiveSystemTasksRunnerAdapter();
      const started = await adapter.start({ spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, kind: 'daemon.service.stop.v1',
        params: { target: { kind: 'local' }, mode: 'user', channel: 'stable' },
      } });
      if (!started || typeof started !== 'object' || !('taskId' in started) || typeof started.taskId !== 'string') {
        throw new Error('System task start did not return a task id.');
      }
      const task = { taskId: started.taskId };
      try {
        const result = await adapter.wait(task);
        const stop = spawnSyncMock.mock.calls.find(([, args]) => args.includes('stop'));
        expect(stop?.[2].windowsHide).toBe(true);
        expect(result).toMatchObject({ ok: false });
        expect(JSON.stringify(result)).toContain('Background service command failed');
      } finally { await adapter.cancel(task); }
    });
  });

  it('hides background CLI children while retaining an explicit interactive visibility choice', async () => {
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint });
      spawnMock.mockImplementation(() => new ChildProcess());
      spawnHappyCLI(['daemon', 'start-sync'], { stdio: 'ignore' });
      expect(spawnMock.mock.calls[0]?.[2].windowsHide).toBe(true);
      spawnHappyCLI(['daemon', 'start-sync'], { stdio: 'ignore', windowsHide: undefined });
      expect(spawnMock.mock.calls[1]?.[2].windowsHide).toBe(true);
      spawnHappyCLI(['auth', 'login'], { stdio: 'inherit', windowsHide: false });
      expect(spawnMock.mock.calls[2]?.[2].windowsHide).toBe(false);
    });
  });

  it('keeps repeated desktop service status commands hidden when this computer has no daemon', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-status-console-', env: {
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
    } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      for (const name of ['schtasks.exe', 'powershell.exe']) writeFileSync(join(homeDir, name), '');
      vi.stubEnv('PATH', homeDir);
      mkdirSync(join(homeDir, 'services'), { recursive: true });
      spawnSyncMock.mockImplementation((command: string, args: readonly string[] = []) => ({
        status: 0,
        stdout: command === 'powershell.exe' && args.some((arg) => arg.includes('.GetFolder("\\Happier")')) ? '[]' : '',
        stderr: '',
      }));
      const { runDaemonServiceCliCommand } = await import('./cli');
      const output = captureStdoutJsonOutput<{ ok: boolean; daemon: { running: boolean } }>();
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await runDaemonServiceCliCommand({ argv: ['status', '--json'] });
          expect(output.json().daemon.running).toBe(false);
          output.chunks.length = 0;
        }
        expect(spawnSyncMock.mock.calls.some(([command]) => command === 'schtasks')).toBe(true);
        for (const [, , options] of spawnSyncMock.mock.calls) expect(options.windowsHide).toBe(true);
      } finally {
        output.restore();
      }
    });
  });
});
