import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { installDaemonService, uninstallDaemonService } from './service/installer';

describe('daemon service installer', () => {
  it('installs and uninstalls a linux user service (no systemctl)', async () => {
    const userHomeDir = await mkdtemp(join(tmpdir(), 'happier-service-installer-home-'));
    const happierHomeDir = join(userHomeDir, '.happier');

    try {
      await installDaemonService({
        platform: 'linux',
        uid: 123,
        userHomeDir,
        happierHomeDir,
        instanceId: 'cloud',
        nodePath: '/usr/bin/node',
        entryPath: '/opt/happier/dist/index.mjs',
        runCommands: false,
      });

      expect(existsSync(join(userHomeDir, '.config', 'systemd', 'user', 'happier-daemon.cloud.service'))).toBe(true);

      await uninstallDaemonService({
        platform: 'linux',
        uid: 123,
        userHomeDir,
        instanceId: 'cloud',
        runCommands: false,
      });

      expect(existsSync(join(userHomeDir, '.config', 'systemd', 'user', 'happier-daemon.cloud.service'))).toBe(false);
    } finally {
      await rm(userHomeDir, { recursive: true, force: true });
    }
  });

  it('installs and uninstalls a darwin LaunchAgent (no launchctl)', async () => {
    const userHomeDir = await mkdtemp(join(tmpdir(), 'happier-service-installer-home-'));
    const happierHomeDir = join(userHomeDir, '.happier');
    const plistPath = join(userHomeDir, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.cloud.plist');

    try {
      await installDaemonService({
        platform: 'darwin',
        uid: 501,
        userHomeDir,
        happierHomeDir,
        instanceId: 'cloud',
        nodePath: '/usr/bin/node',
        entryPath: '/opt/happier/dist/index.mjs',
        runCommands: false,
      });

      expect(existsSync(plistPath)).toBe(true);

      await uninstallDaemonService({
        platform: 'darwin',
        uid: 501,
        userHomeDir,
        instanceId: 'cloud',
        runCommands: false,
      });

      expect(existsSync(plistPath)).toBe(false);
    } finally {
      await rm(userHomeDir, { recursive: true, force: true });
    }
  });

  it('throws for unsupported platform values', async () => {
    await expect(
      installDaemonService({
        platform: 'win32' as never,
      }),
    ).rejects.toThrow('Daemon service installation is currently only supported on macOS and Linux');
  });
});
