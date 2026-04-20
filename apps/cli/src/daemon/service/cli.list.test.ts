import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { withTempDir } from '../../testkit/fs/tempDir';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { captureStdoutJsonOutput } from '../../testkit/logger/captureOutput';

describe('runDaemonServiceCliCommand list', () => {
  it('ignores invalid installed linux units that only match by filename', async () => {
    await withTempDir('happier-service-list-invalid-unit-', async (homeDir) => {
      const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
      ]);
      envScope.patch({
        HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      });

      try {
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

        const output = captureStdoutJsonOutput<{ ok: boolean; platform: string; services: unknown[] }>();
        try {
          const { runDaemonServiceCliCommand } = await import('./cli.js');
          await runDaemonServiceCliCommand({ argv: ['list', '--json'] });
          expect(output.json()).toEqual({
            ok: true,
            platform: 'linux',
            entries: [],
            services: [],
          });
        } finally {
          output.restore();
        }
      } finally {
        envScope.restore();
      }
    });
  });

  it('includes invalid installed linux units in list --deep output for diagnosis', async () => {
    await withTempDir('happier-service-list-deep-invalid-unit-', async (homeDir) => {
      const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
      ]);
      envScope.patch({
        HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      });

      try {
        const servicesDir = join(homeDir, '.config', 'systemd', 'user');
        mkdirSync(servicesDir, { recursive: true });
        const installedPath = join(servicesDir, 'happier-daemon.default.service');
        writeFileSync(
          installedPath,
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

        const output = captureStdoutJsonOutput<{ ok: boolean; platform: string; entries: Array<{ installed: boolean; path: string }> }>();
        try {
          const { runDaemonServiceCliCommand } = await import('./cli.js');
          await runDaemonServiceCliCommand({ argv: ['list', '--json', '--deep'] });
          expect(output.json()).toEqual(expect.objectContaining({
            ok: true,
            platform: 'linux',
            entries: [expect.objectContaining({ installed: false, path: installedPath })],
          }));
        } finally {
          output.restore();
        }
      } finally {
        envScope.restore();
      }
    });
  });

  it('includes the discovered service mode in list JSON', async () => {
    await withTempDir('happier-service-list-mode-', async (homeDir) => {
      const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
      ]);
      envScope.patch({
        HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      });

      try {
        const servicesDir = join(homeDir, '.config', 'systemd', 'user');
        mkdirSync(servicesDir, { recursive: true });
        writeFileSync(
          join(servicesDir, 'happier-daemon.default.service'),
          renderSystemdServiceUnit({
            description: 'Happier Daemon',
            execStart: ['/usr/bin/node', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
              HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            },
            wantedBy: 'default.target',
          }),
          'utf-8',
        );

        const output = captureStdoutJsonOutput<{ ok: boolean; platform: string; services: Array<{ mode?: string }> }>();
        try {
          const { runDaemonServiceCliCommand } = await import('./cli.js');
          await runDaemonServiceCliCommand({ argv: ['list', '--json'] });
          expect(output.json()).toEqual(expect.objectContaining({
            ok: true,
            platform: 'linux',
            services: [expect.objectContaining({ mode: 'user' })],
          }));
        } finally {
          output.restore();
        }
      } finally {
        envScope.restore();
      }
    });
  });
});
