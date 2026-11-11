import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, removeTempDir, withTempDir } from '@/testkit/fs/tempDir';

const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

describe('runDaemonServiceCommands', () => {
  let commandsDir: string;
  beforeEach(async () => {
    commandsDir = await createTempDir('happier-service-commands-');
    for (const command of ['systemctl', 'launchctl', 'sleep', 'powershell.exe', 'schtasks']) {
      const path = join(commandsDir, process.platform === 'win32' ? `${command}.exe` : command);
      writeFileSync(path, 'fixture');
      chmodSync(path, 0o755);
    }
    vi.stubEnv('PATH', commandsDir);
  });

  afterEach(async () => {
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
    delete process.env.HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS;
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

  it('preserves a legacy service definition when its unregister fails', async () => {
    await withTempDir('happier-uninstall-legacy-', async (dir) => {
      const { planDaemonServiceUninstall } = await import('./plan');
      const { applyDaemonServiceUninstallPlan } = await import('./apply');
      const plan = planDaemonServiceUninstall({ platform: 'linux', instanceId: 'default', userHomeDir: dir, targetMode: 'default-following' });
      const legacy = plan.filesToRemove.find((path) => path.endsWith('/happier-daemon.service'))!;
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.config/systemd/user'), { recursive: true });
      writeFileSync(legacy, 'legacy definition');
      spawnSyncMock.mockImplementation((_cmd: string, args: readonly string[]) => ({
        status: args.includes('happier-daemon.service') ? 1 : 0,
        stdout: '', stderr: 'Permission denied',
      }));

      await expect(applyDaemonServiceUninstallPlan(plan)).rejects.toThrow(/denied/i);
      expect(readFileSync(legacy, 'utf8')).toBe('legacy definition');
    });
  });

  it('continues an uninstall past a failing step the plan tolerates', async () => {
    await withTempDir('happier-uninstall-tolerated-', async (dir) => {
      const { applyDaemonServiceUninstallPlan } = await import('./apply');
      const definition = join(dir, 'daemon.service');
      writeFileSync(definition, 'installed definition');
      spawnSyncMock.mockImplementation((cmd: string) => (cmd === 'schtasks'
        ? { status: 1, stdout: '', stderr: 'ERROR: There is no running instance of the task.' }
        : { status: 0, stdout: '', stderr: '' }));

      await applyDaemonServiceUninstallPlan({
        platform: 'linux',
        filesToRemove: [definition],
        commands: [
          { cmd: 'schtasks', args: ['/End', '/TN', 'Happier\\legacy'], ignoreFailure: true },
          { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
        ],
      });
      expect(existsSync(definition)).toBe(false);
    });
  });

  it('reports a failed definition removal', async () => {
    const { applyDaemonServiceUninstallPlan } = await import('./apply');
    await expect(applyDaemonServiceUninstallPlan({ platform: 'linux', filesToRemove: [commandsDir], commands: [] })).rejects.toThrow();
  });

  it('keeps the existing command timeout when uninstall uses the shared service owner', async () => {
    const { applyDaemonServiceUninstallPlan } = await import('./apply');
    vi.stubEnv('HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS', '42000');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    await applyDaemonServiceUninstallPlan({ platform: 'linux', filesToRemove: [], commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }] });
    expect(spawnSyncMock.mock.calls.at(-1)?.[2]?.timeout).toBe(42000);
  });

  it('does not create or overwrite definitions when a strict install requires a missing manager', async () => {
    await withTempDir('happier-service-missing-manager-', async (dir) => {
      const { applyDaemonServiceInstallPlan } = await import('./apply');
      vi.stubEnv('PATH', dir);
      const existing = join(dir, 'existing.service');
      const fresh = join(dir, 'fresh.service');
      writeFileSync(existing, 'user definition', 'utf8');

      const error = await applyDaemonServiceInstallPlan({
        platform: 'linux',
        files: [
          { path: existing, content: 'replacement', mode: 0o644 },
          { path: fresh, content: 'new definition', mode: 0o644 },
        ],
        commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }],
      }, { commandFailureMode: 'strict' }).then(() => null, (error: unknown) => error);

      expect(readFileSync(existing, 'utf8')).toBe('user definition');
      expect(existsSync(fresh)).toBe(false);
      expect(error).toMatchObject({ code: 'service_manager_unavailable' });
    });
  });

  it('still writes definitions for an explicitly command-free install', async () => {
    await withTempDir('happier-service-no-commands-', async (dir) => {
      const { applyDaemonServiceInstallPlan } = await import('./apply');
      vi.stubEnv('PATH', dir);
      const definition = join(dir, 'fresh.service');
      await applyDaemonServiceInstallPlan({
        platform: 'linux',
        files: [{ path: definition, content: 'new definition', mode: 0o644 }],
        commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }],
      }, { commandFailureMode: 'strict', runCommands: false });
      expect(readFileSync(definition, 'utf8')).toBe('new definition');
    });
  });

  it('ignores missing launchctl bootout cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 3,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Boot-out failed: 3: No such process'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootout', 'gui/501/com.happier.cli.daemon.default'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('ignores missing legacy systemd cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.service does not exist.'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'disable', '--now', 'happier-daemon.service'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('ignores missing suffixed systemd cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.preview.default.service does not exist.'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'disable', '--now', 'happier-daemon.preview.default.service'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('ignores launchctl kickstart service-materialization races in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 113,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['kickstart', '-k', 'gui/501/com.happier.cli.daemon.default'],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('still throws for non-benign launchctl failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Bootstrap failed: 5: Input/output error'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootstrap', 'gui/501', '/tmp/com.happier.cli.daemon.default.plist'],
      },
    ], { failureMode: 'strict' })).toThrow(/Background service command failed/);
  });

  it('ignores optional systemctl cleanup failures in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Failed to disable unit: Unit file happier-daemon.service does not exist.'),
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'disable', '--now', 'happier-daemon.service'],
        ignoreFailure: true,
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('sets the systemd user session environment for user-scoped systemctl commands', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockImplementation((_cmd: string, _args: readonly string[] = [], options?: { env?: NodeJS.ProcessEnv }) => ({
      status: options?.env?.XDG_RUNTIME_DIR && options?.env?.DBUS_SESSION_BUS_ADDRESS ? 0 : 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(options?.env?.XDG_RUNTIME_DIR ? '' : 'Failed to connect to bus: No medium found'),
    }));

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'daemon-reload'],
      },
    ], { failureMode: 'strict' })).not.toThrow();

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'daemon-reload'],
      expect.objectContaining({
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: `/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}/bus`,
        }),
      }),
    );
  });

  it('bounds background service command execution time', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    process.env.HAPPIER_DAEMON_SERVICE_COMMAND_TIMEOUT_MS = '42000';
    spawnSyncMock.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });

    runDaemonServiceCommands([
      {
        cmd: 'systemctl',
        args: ['--user', 'start', 'happier-daemon.default.service'],
      },
    ], { failureMode: 'strict' });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'start', 'happier-daemon.default.service'],
      expect.objectContaining({ timeout: 42000 }),
    );
  });

  it('refreshes the plist mtime before launchctl bootstrap in strict mode', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    const dir = mkdtempSync(join(tmpdir(), 'happier-daemon-service-apply-'));
    const plistPath = join(dir, 'com.happier.cli.daemon.default.plist');
    writeFileSync(plistPath, '<plist version="1.0"></plist>', 'utf-8');
    const initialMtimeMs = statSync(plistPath).mtimeMs;

    spawnSyncMock.mockImplementation((_command: string, args: readonly string[] = []) => {
      if (args[0] === 'bootstrap') {
        const refreshedMtimeMs = statSync(plistPath).mtimeMs;
        return refreshedMtimeMs > initialMtimeMs
          ? { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
          : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
      }
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootstrap', 'gui/501', plistPath],
      },
    ], { failureMode: 'strict' })).not.toThrow();
  });

  it('treats a launchctl bootstrap I/O error as non-fatal when the label is already materialized in launchd', async () => {
    const { runDaemonServiceCommands } = await import('./apply');

    spawnSyncMock.mockImplementation((_command: string, args: readonly string[] = []) => {
      if (args[0] === 'bootstrap') {
        return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
      }
      if (args[0] === 'print' && args[1] === 'gui/501/com.happier.cli.daemon.default') {
        return { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') };
      }
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    });

    expect(() => runDaemonServiceCommands([
      {
        cmd: 'launchctl',
        args: ['bootstrap', 'gui/501', '/tmp/com.happier.cli.daemon.default.plist'],
      },
    ], { failureMode: 'strict' })).not.toThrow();

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'launchctl',
      ['print', 'gui/501/com.happier.cli.daemon.default'],
      expect.objectContaining({
        env: expect.any(Object),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });
});
