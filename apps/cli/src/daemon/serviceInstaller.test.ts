import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { installDaemonService, uninstallDaemonService } from './service/installer';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('daemon service installer', () => {
  it('installs and uninstalls a linux user service (no systemctl)', async () => {
    await withTempDir('happier-service-installer-home-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
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
    });
  });

  it('installs and uninstalls a darwin LaunchAgent (no launchctl)', async () => {
    await withTempDir('happier-service-installer-home-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      const plistPath = join(userHomeDir, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.cloud.plist');
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
    });
  });

  it('throws for unsupported platform values', async () => {
    await expect(
      installDaemonService({
        platform: 'aix' as never,
      }),
    ).rejects.toThrow('Daemon service installation is currently only supported on macOS, Linux, and Windows');
  });

  it('uses apiServerUrl for HAPPIER_SERVER_URL when canonical server URL differs (linux)', async () => {
    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
    ]);

    await withTempDir('happier-service-installer-home-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'company',
        HAPPIER_PUBLIC_SERVER_URL: 'https://public.example.test',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'https://app.public.example.test',
      });
      reloadConfiguration();

      try {
        await installDaemonService({
          platform: 'linux',
          uid: 123,
          userHomeDir,
          happierHomeDir,
          runCommands: false,
        });

        const unitPath = join(userHomeDir, '.config', 'systemd', 'user', 'happier-daemon.company.service');
        expect(existsSync(unitPath)).toBe(true);
        const raw = await (await import('node:fs/promises')).readFile(unitPath, 'utf-8');
        expect(raw).toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=company');
        expect(raw).toContain('Environment=HAPPIER_SERVER_URL=http://127.0.0.1:3005');
        expect(raw).toContain('Environment=HAPPIER_PUBLIC_SERVER_URL=https://public.example.test');
      } finally {
        envScope.restore();
        reloadConfiguration();
      }
    });
  });
});
