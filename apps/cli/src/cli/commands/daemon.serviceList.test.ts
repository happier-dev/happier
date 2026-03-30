import { join, dirname } from 'node:path';
import * as fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import {
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { handleDaemonCliCommand } from './daemon';

describe('happier daemon service list', () => {
  it('lists per-server installed unit paths on linux', async () => {
    const output = captureConsoleLogAndMuteStdout();

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-service-list-',
          env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
          },
        },
        async ({ homeDir }) => {
          process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
          process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
          await writeDaemonSettingsFixture(homeDir);

          const unitDir = join(homeDir, '.config', 'systemd', 'user');
          fs.mkdirSync(unitDir, { recursive: true });
          fs.writeFileSync(join(unitDir, 'happier-daemon.company.service'), '# fake', 'utf-8');

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list'], rawArgv: [], terminalRuntime: null });

          const out = output.logs.join('\n');
          expect(out).toContain('company');
          expect(out).toContain('happier-daemon.company.service');
          expect(out.toLowerCase()).toContain('installed');
        },
      );
    } finally {
      output.restore();
    }
  });

  it('prints per-server service entries as JSON on Windows with installed-path parity', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-daemon-service-list-json-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(homeDir, '.happier');
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const runtime = resolveDaemonServiceCliRuntimeFromEnv({
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
            HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://company.example.test',
            HAPPIER_DAEMON_SERVICE_WEBAPP_URL: 'https://company.example.test',
          },
        });
        const wrapperPath = resolveDaemonServicePaths(runtime).wrapperPath;
        fs.mkdirSync(dirname(wrapperPath), { recursive: true });
        fs.writeFileSync(wrapperPath, '# fake', 'utf-8');
        expect(fs.existsSync(wrapperPath)).toBe(true);

        const output = captureStdoutJsonOutput<{
          entries?: Array<{
            serverId?: string;
            installed?: boolean;
            path?: string;
            platform?: string;
          }>;
        }>();

        try {
          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serverId: 'company',
              installed: true,
              platform: 'win32',
              path: wrapperPath,
            }),
          ]));
        } finally {
          output.restore();
        }
      },
    );
  });
});
