import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { installDaemonService, uninstallDaemonService } from './service/installer';
import { reloadConfiguration } from '@/configuration';

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
        platform: 'aix' as never,
      }),
    ).rejects.toThrow('Daemon service installation is currently only supported on macOS, Linux, and Windows');
  });

  it('uses apiServerUrl for HAPPIER_SERVER_URL when canonical server URL differs (linux)', async () => {
    const userHomeDir = await mkdtemp(join(tmpdir(), 'happier-service-installer-home-'));
    const happierHomeDir = join(userHomeDir, '.happier');

    const envBackup = { ...process.env };
    try {
      process.env.HAPPIER_HOME_DIR = happierHomeDir;
      process.env.HAPPIER_ACTIVE_SERVER_ID = 'company';
      process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://public.example.test';
      process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3005';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.public.example.test';
      reloadConfiguration();

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
      process.env = envBackup;
      reloadConfiguration();
      await rm(userHomeDir, { recursive: true, force: true });
    }
  });
});
