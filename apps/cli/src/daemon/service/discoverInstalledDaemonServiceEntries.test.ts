import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';

import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';

describe('discoverInstalledDaemonServiceEntries', () => {
  it('prefers the embedded active server id over an env-hash filename for pinned linux units', async () => {
    await withTempDir('happier-discover-service-entry-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      const path = join(servicesDir, 'happier-daemon.env_9675c02.service');
      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'linux',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {
          cloud: {
            name: 'Cloud',
          },
        },
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'cloud',
          name: 'Cloud',
          targetMode: 'pinned',
          path,
        }),
      ]);
    });
  });

  it('ignores invalid darwin launch-agent files that only match by filename', async () => {
    await withTempDir('happier-discover-service-entry-darwin-invalid-', async (homeDir) => {
      const servicesDir = join(homeDir, 'Library', 'LaunchAgents');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        join(servicesDir, 'com.happier.cli.daemon.default.plist'),
        '# installed background service',
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'darwin',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([]);
    });
  });

  it('ignores linux units that declare background-service startup without launching happier daemon start-sync', async () => {
    await withTempDir('happier-discover-service-entry-linux-invalid-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        join(servicesDir, 'happier-daemon.default.service'),
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/usr/bin/env', 'bash', '-lc', 'echo not-happier'],
          env: {
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'linux',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([]);
    });
  });

  it('accepts linux units that launch daemon start-sync through the package-dist node entrypoint', async () => {
    await withTempDir('happier-discover-service-entry-linux-package-dist-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      const path = join(servicesDir, 'happier-daemon.default.service');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: [
            '/usr/bin/node',
            '/Users/tester/happier/apps/cli/package-dist/index.mjs',
            'daemon',
            'start-sync',
          ],
          env: {
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'linux',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default background service',
          happierHomeDir: null,
          targetMode: 'default-following',
          releaseChannel: 'stable',
          path,
        }),
      ]);
    });
  });

  it('accepts legacy linux units installed by older Happier installers without startup-source metadata', async () => {
    await withTempDir('happier-discover-service-entry-linux-legacy-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      const path = join(servicesDir, 'happier-daemon.default.service');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: [
            '/home/tester/.happier/tools/js-runtime/current/bin/happier-js-runtime',
            '/home/tester/.happier/cli-dev/versions/0.2.3-dev.36.1/package-dist/index.mjs',
            'daemon',
            'start-sync',
          ],
          env: {
            HAPPIER_HOME_DIR: '/home/tester/.happier',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'linux',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default background service',
          happierHomeDir: '/home/tester/.happier',
          targetMode: 'default-following',
          releaseChannel: 'publicdev',
          path,
        }),
      ]);
    });
  });

  it('ignores linux units that only declare a release channel without legacy managed home-dir markers', async () => {
    await withTempDir('happier-discover-service-entry-linux-release-only-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        join(servicesDir, 'happier-daemon.default.service'),
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'linux',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([]);
    });
  });
});
