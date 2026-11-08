import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, removeTempDir, withTempDir } from '@/testkit/fs/tempDir';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

describe('daemon service uninstall', () => {
  let commandsDir: string;
  beforeEach(async () => {
    commandsDir = await createTempDir('happier-uninstall-commands-');
    for (const command of ['systemctl', 'launchctl', 'powershell.exe', 'schtasks']) {
      const path = join(commandsDir, process.platform === 'win32' && !command.endsWith('.exe') ? `${command}.exe` : command);
      writeFileSync(path, 'fixture');
      chmodSync(path, 0o755);
    }
    vi.stubEnv('PATH', commandsDir);
  });
  afterEach(async () => {
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
    await removeTempDir(commandsDir);
  });
  it.each(['linux', 'darwin', 'win32'] as const)('preserves the %s definition when unregister is denied', async (platform) => {
    await withTempDir('happier-uninstall-denied-', async (dir) => {
      const { planDaemonServiceUninstall } = await import('./plan');
      const { applyDaemonServiceUninstallPlan } = await import('./apply');
      const definition = join(dir, platform === 'darwin' ? 'daemon.plist' : platform === 'win32' ? 'daemon.ps1' : 'daemon.service');
      writeFileSync(definition, 'installed definition');
      spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'Access denied: Operation not permitted' });
      const plan = planDaemonServiceUninstall({ platform, instanceId: 'default', userHomeDir: dir, happierHomeDir: dir, installedPath: definition, uid: 501 });
      await expect(applyDaemonServiceUninstallPlan(plan)).rejects.toThrow(/denied|permitted/i);
      expect(readFileSync(definition, 'utf8')).toBe('installed definition');
    });
  });
  it('removes an already absent Linux service definition before reloading systemd', async () => {
    await withTempDir('happier-uninstall-absent-', async (dir) => {
      const { planDaemonServiceUninstall } = await import('./plan');
      const { applyDaemonServiceUninstallPlan } = await import('./apply');
      const definition = join(dir, 'happier-daemon.default.service');
      writeFileSync(definition, 'stale definition');
      let reloaded = false;
      spawnSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => {
        if (args.includes('daemon-reload')) {
          expect(existsSync(definition)).toBe(false);
          reloaded = true;
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'Unit happier-daemon.default.service does not exist.' };
      });
      await applyDaemonServiceUninstallPlan(planDaemonServiceUninstall({ platform: 'linux', instanceId: 'default', userHomeDir: dir, installedPath: definition }));
      expect(existsSync(definition)).toBe(false);
      expect(reloaded).toBe(true);
    });
  });
  it('reports a failed definition removal', async () => {
    const { applyDaemonServiceUninstallPlan } = await import('./apply');
    await expect(applyDaemonServiceUninstallPlan({ platform: 'linux', filesToRemove: [commandsDir], commands: [] })).rejects.toThrow();
  });
  it.each(['linux', 'darwin', 'win32'] as const)('lets the %s service manager finish uninstall before removing its definition', async (platform) => {
    await withTempDir('happier-uninstall-slow-', async (dir) => {
      const { planDaemonServiceUninstall } = await import('./plan');
      const { applyDaemonServiceUninstallPlan } = await import('./apply');
      const definition = join(dir, 'installed-definition');
      writeFileSync(definition, 'installed definition');
      vi.stubEnv('HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS', '30000');
      // Native unregister completes after the old 30-second subprocess cutoff.
      spawnSyncMock.mockImplementation((_command: string, _args: readonly string[], options?: { timeout?: number }) =>
        options?.timeout !== undefined && options.timeout < 34_000
          ? { status: null, error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }) }
          : { status: 0, stdout: '', stderr: '' });
      const plan = planDaemonServiceUninstall({ platform, instanceId: 'default', userHomeDir: dir, happierHomeDir: dir, installedPath: definition, uid: 501 });
      await expect(applyDaemonServiceUninstallPlan(plan)).resolves.toBeUndefined();
      expect(existsSync(definition)).toBe(false);
    });
  });
  it('rejects an expired caller deadline', async () => {
    const { applyDaemonServiceUninstallPlan } = await import('./apply');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const plan = { platform: 'linux' as const, filesToRemove: [], commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }] };
    await expect(applyDaemonServiceUninstallPlan(plan, { deadlineMs: Date.now() - 1 })).rejects.toMatchObject({ code: 'service_start_timeout' });
  });
});
