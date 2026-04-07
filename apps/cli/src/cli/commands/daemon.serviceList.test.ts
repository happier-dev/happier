import { join, dirname } from 'node:path';
import * as fs from 'node:fs';

import { describe, expect, it } from 'vitest';
import { renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import {
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { handleDaemonCliCommand } from './daemon';

describe('happier daemon service list', () => {
  it('lists per-server installed unit paths on linux', async () => {
    const output = captureStdout();

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
          fs.writeFileSync(
            join(unitDir, 'happier-daemon.company.service'),
            renderSystemdServiceUnit({
              description: 'Happier Daemon',
              execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
              env: {
                HAPPIER_ACTIVE_SERVER_ID: 'company',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
              },
              wantedBy: 'default.target',
            }),
            'utf-8',
          );
          fs.writeFileSync(
            join(unitDir, 'happier-daemon.preview.orphan.service'),
            [
              '[Unit]',
              'Description=Happier Daemon',
              '[Service]',
              'Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=preview',
              'ExecStart=/Users/tester/.happier/cli-preview/current/happier daemon start-sync',
              '[Install]',
              'WantedBy=default.target',
              '',
            ].join('\n'),
            'utf-8',
          );
          fs.writeFileSync(
            join(unitDir, 'dev.happier.stack.dev-built.service'),
            renderSystemdServiceUnit({
              description: 'Happier Stack',
              execStart: ['/Users/tester/.happier-stack/bin/hstack', 'run'],
              env: {
                HAPPIER_STACK_ENV_FILE: '/Users/tester/.happier/stacks/dev-built/env',
              },
              wantedBy: 'default.target',
            }),
            'utf-8',
          );

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list'], rawArgv: [], terminalRuntime: null });

          const out = output.text();
          expect(out).toContain('company');
          expect(out).toContain('happier-daemon.company.service');
          expect(out).toContain('happier-daemon.preview.orphan.service');
          expect(out).toContain('dev.happier.stack.dev-built.service');
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
        fs.writeFileSync(
          wrapperPath,
          renderWindowsScheduledTaskWrapperPs1({
            workingDirectory: homeDir,
            programArgs: [join(homeDir, '.happier', 'cli', 'current', 'happier.exe'), 'daemon', 'start-sync'],
            env: {
              HAPPIER_ACTIVE_SERVER_ID: 'company',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            },
            stdoutPath: join(homeDir, '.happier', 'logs', 'daemon-service.company.out.log'),
            stderrPath: join(homeDir, '.happier', 'logs', 'daemon-service.company.err.log'),
          }),
          'utf-8',
        );
        expect(fs.existsSync(wrapperPath)).toBe(true);
        fs.writeFileSync(
          join(homeDir, '.happier', 'services', 'dev.happier.stack.dev-built.ps1'),
          renderWindowsScheduledTaskWrapperPs1({
            workingDirectory: homeDir,
            programArgs: [join(homeDir, '.happier-stack', 'bin', 'hstack.exe'), 'start', '--restart'],
            env: {
              HAPPIER_STACK_ENV_FILE: join(homeDir, '.happier', 'stacks', 'dev-built', 'env'),
            },
            stdoutPath: join(homeDir, '.happier-stack', 'logs', 'stack-service.dev-built.out.log'),
            stderrPath: join(homeDir, '.happier-stack', 'logs', 'stack-service.dev-built.err.log'),
          }),
          'utf-8',
        );

        const output = captureStdoutJsonOutput<{
          ok?: boolean;
          services?: Array<{
            label?: string;
            definitionPath?: string;
            platform?: string;
            backend?: string;
            serviceType?: string;
          }>;
        }>();

        try {
          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json()).toEqual(expect.objectContaining({
            ok: true,
            services: expect.arrayContaining([
            expect.objectContaining({
              label: 'happier-daemon.company',
              serviceType: 'daemon',
              platform: 'win32',
              backend: 'schtasks-user',
              definitionPath: wrapperPath,
            }),
            expect.objectContaining({
              label: 'dev.happier.stack.dev-built',
              serviceType: 'stack-service',
              platform: 'win32',
            }),
            ]),
          }));
        } finally {
          output.restore();
        }
      },
    );
  });

  it('shows candidate services only when --deep is requested', async () => {
    const output = captureStdoutJsonOutput<{
      ok?: boolean;
      services?: Array<{
        label?: string;
        verification?: string;
      }>;
    }>();

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-service-list-deep-',
          env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
          },
        },
        async ({ homeDir }) => {
          process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
          process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';

          const unitDir = join(homeDir, '.config', 'systemd', 'user');
          fs.mkdirSync(unitDir, { recursive: true });
          fs.writeFileSync(
            join(unitDir, 'happier-daemon.preview.cloud.service'),
            [
              '[Unit]',
              'Description=Happier Daemon',
              '[Service]',
              'Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=preview',
              'ExecStart=/Users/tester/.happier/cli-preview/current/happier serve',
              '[Install]',
              'WantedBy=default.target',
              '',
            ].join('\n'),
            'utf-8',
          );

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list', '--json'], rawArgv: [], terminalRuntime: null });
          expect(output.json()).toEqual(expect.objectContaining({
            ok: true,
            services: [],
          }));

          output.restore();
          const deepOutput = captureStdoutJsonOutput<{
            ok?: boolean;
            services?: Array<{ label?: string; verification?: string }>;
          }>();
          try {
            await handleDaemonCliCommand({ args: ['daemon', 'service', 'list', '--deep', '--json'], rawArgv: [], terminalRuntime: null });
            expect(deepOutput.json()).toEqual(expect.objectContaining({
              ok: true,
              services: [
                expect.objectContaining({
                  label: 'happier-daemon.preview.cloud',
                  verification: 'candidate',
                }),
              ],
            }));
          } finally {
            deepOutput.restore();
          }
        },
      );
    } finally {
      output.restore();
    }
  });
});
