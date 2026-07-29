import { join, dirname } from 'node:path';
import * as fs from 'node:fs';

import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildLaunchdPlistXml, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import {
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { handleDaemonCliCommand } from './daemon';
import { handleServiceCliCommand } from './service';

function writeValidWindowsDaemonServiceDefinition(params: Readonly<{
  path: string;
  workingDirectory: string;
  releaseChannel?: string;
  targetMode?: 'default-following' | 'pinned';
}>): void {
  fs.writeFileSync(
    params.path,
    renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: params.workingDirectory,
      programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
      env: {
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: params.targetMode ?? 'pinned',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: params.releaseChannel ?? 'stable',
      },
    }),
    'utf-8',
  );
}

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
          await writeDaemonSettingsFixture(homeDir, {
            servers: {
              'company.prod': {
                id: 'company.prod',
                name: 'Company Prod',
                serverUrl: 'https://company-prod.example.test',
                webappUrl: 'https://company-prod.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
          });

          const unitDir = join(homeDir, '.config', 'systemd', 'user');
          fs.mkdirSync(unitDir, { recursive: true });
          fs.writeFileSync(
            join(unitDir, 'happier-daemon.company.prod.service'),
            renderSystemdServiceUnit({
              description: 'Happier Daemon',
              execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
              env: {
                HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
              },
              wantedBy: 'default.target',
            }),
            'utf-8',
          );

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list'], rawArgv: [], terminalRuntime: null });

          const out = output.text();
          expect(out).toContain('company.prod');
          expect(out).toContain('happier-daemon.company.prod.service');
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
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
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
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
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
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            },
            stdoutPath: join(homeDir, '.happier', 'logs', 'daemon-service.company.out.log'),
            stderrPath: join(homeDir, '.happier', 'logs', 'daemon-service.company.err.log'),
          }),
          'utf-8',
        );
        expect(fs.existsSync(wrapperPath)).toBe(true);

        const output = captureStdoutJsonOutput<{
          ok?: boolean;
          entries?: Array<{
            serverId?: string;
            installed?: boolean;
            path?: string;
            platform?: string;
            releaseChannel?: string;
          }>;
          services?: Array<{
            serviceType?: string;
            ring?: string;
            label?: string;
            targetMode?: string | null;
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
              releaseChannel: 'stable',
            }),
          ]));
          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serviceType: 'daemon',
              ring: 'stable',
              targetMode: 'pinned',
            }),
          ]));
          expect(output.json().services?.[0]?.label).toContain('happier-daemon.company');
        } finally {
          output.restore();
        }
      },
    );
  });
});

describe('happier service list --json', () => {
  it('includes configured and running CLI versions in JSON inventory when they can be resolved', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-cli-versions-',
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

        const runtime = resolveDaemonServiceCliRuntimeFromEnv({
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
        });
        const paths = resolveDaemonServicePaths(runtime);
        fs.mkdirSync(dirname(paths.unitPath), { recursive: true });
        fs.writeFileSync(
          paths.unitPath,
          renderSystemdServiceUnit({
            description: 'Happier Daemon',
            execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
              HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
            },
            wantedBy: 'default.target',
          }),
          'utf-8',
        );

        const managedCliPath = join(homeDir, '.happier', 'cli', 'current', 'happier');
        fs.mkdirSync(dirname(managedCliPath), { recursive: true });
        fs.writeFileSync(
          managedCliPath,
          '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "${1:-}" == "--version" ]]; then\n  echo "0.0.0-configured"\n  exit 0\nfi\nexit 0\n',
          'utf-8',
        );
        fs.chmodSync(managedCliPath, 0o755);

        const { writeDaemonState } = await import('@/persistence');
        writeDaemonState({
          pid: process.pid,
          httpPort: 43118,
          startedAt: Date.now(),
          startedWithCliVersion: '0.0.0-running',
          startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service',
          serviceLabel: paths.label,
        });

        const childProcess = await import('node:child_process');
        const spawnSyncMock = vi.mocked(childProcess.spawnSync);
        spawnSyncMock.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argv = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
          if (cmd === managedCliPath && argv[0] === '--version') {
            return {
              pid: 0,
              output: [],
              stdout: '0.0.0-configured\n',
              stderr: '',
              status: 0,
              signal: null,
              error: undefined,
            } as unknown as SpawnSyncReturns<string>;
          }
          return {
            pid: 0,
            output: [],
            stdout: '',
            stderr: '',
            status: 3,
            signal: null,
            error: undefined,
          } as unknown as SpawnSyncReturns<string>;
        }) as unknown as typeof childProcess.spawnSync);

        const output = captureStdoutJsonOutput<{
          services?: Array<{
            label?: string;
            running?: boolean;
            configuredCliVersion?: string | null;
            runningCliVersion?: string | null;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              label: paths.unitName.replace(/\.service$/i, ''),
              running: true,
              configuredCliVersion: '0.0.0-configured',
              runningCliVersion: '0.0.0-running',
            }),
          ]));
        } finally {
          spawnSyncMock.mockReset();
          output.restore();
        }
      },
    );
  });

  it('marks an active systemd user unit as running in JSON inventory even when daemon state is missing', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-running-systemd-active-',
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

        const runtime = resolveDaemonServiceCliRuntimeFromEnv({
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
        });
        const paths = resolveDaemonServicePaths(runtime);
        fs.mkdirSync(dirname(paths.unitPath), { recursive: true });
        fs.writeFileSync(
          paths.unitPath,
          renderSystemdServiceUnit({
            description: 'Happier Daemon',
            execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            },
            wantedBy: 'default.target',
          }),
          'utf-8',
        );

        const childProcess = await import('node:child_process');
        const spawnSyncMock = vi.mocked(childProcess.spawnSync);
        spawnSyncMock.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argv = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
          if (cmd === 'systemctl' && argv[0] === '--user' && argv[1] === 'is-active' && argv[2] === paths.unitName) {
            return {
              pid: 0,
              output: [],
              stdout: 'active\n',
              stderr: '',
              status: 0,
              signal: null,
              error: undefined,
            } as unknown as SpawnSyncReturns<string>;
          }
          return {
            pid: 0,
            output: [],
            stdout: '',
            stderr: '',
            status: 3,
            signal: null,
            error: undefined,
          } as unknown as SpawnSyncReturns<string>;
        }) as unknown as typeof childProcess.spawnSync);

        const output = captureStdoutJsonOutput<{
          services?: Array<{
            label?: string;
            running?: boolean;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              label: paths.unitName.replace(/\.service$/i, ''),
              running: true,
            }),
          ]));
        } finally {
          spawnSyncMock.mockReset();
          output.restore();
        }
      },
    );
  });

  it('marks an active launch agent as running in JSON inventory even when daemon state is missing', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-running-launchctl-active-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const runtime = resolveDaemonServiceCliRuntimeFromEnv({
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
        });
        const paths = resolveDaemonServicePaths(runtime);
        fs.mkdirSync(dirname(paths.installedPath), { recursive: true });
        fs.writeFileSync(
          paths.installedPath,
          buildLaunchdPlistXml({
            label: paths.label,
            programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            },
            stdoutPath: join(homeDir, '.happier', 'logs', 'daemon-service.out.log'),
            stderrPath: join(homeDir, '.happier', 'logs', 'daemon-service.err.log'),
            workingDirectory: homeDir,
          }),
          'utf-8',
        );

        const childProcess = await import('node:child_process');
        const spawnSyncMock = vi.mocked(childProcess.spawnSync);
        spawnSyncMock.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argv = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
          if (cmd === 'launchctl' && argv[0] === 'print' && argv[1] === `gui/${runtime.uid ?? 0}/${paths.label}`) {
            return {
              pid: 0,
              output: [],
              stdout: 'state = running\n',
              stderr: '',
              status: 0,
              signal: null,
              error: undefined,
            } as unknown as SpawnSyncReturns<string>;
          }
          return {
            pid: 0,
            output: [],
            stdout: '',
            stderr: '',
            status: 1,
            signal: null,
            error: undefined,
          } as unknown as SpawnSyncReturns<string>;
        }) as unknown as typeof childProcess.spawnSync);

        const output = captureStdoutJsonOutput<{
          services?: Array<{
            label?: string;
            running?: boolean;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              label: paths.label,
              running: true,
            }),
          ]));
        } finally {
          spawnSyncMock.mockReset();
          output.restore();
        }
      },
    );
  });

  it('does not mark a loaded but not running launch agent as running in JSON inventory', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-launchctl-not-running-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const runtime = resolveDaemonServiceCliRuntimeFromEnv({
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
        });
        const paths = resolveDaemonServicePaths(runtime);
        fs.mkdirSync(dirname(paths.installedPath), { recursive: true });
        fs.writeFileSync(
          paths.installedPath,
          buildLaunchdPlistXml({
            label: paths.label,
            programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
              HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            },
            stdoutPath: join(homeDir, '.happier', 'logs', 'daemon-service.out.log'),
            stderrPath: join(homeDir, '.happier', 'logs', 'daemon-service.err.log'),
            workingDirectory: homeDir,
          }),
          'utf-8',
        );

        const childProcess = await import('node:child_process');
        const spawnSyncMock = vi.mocked(childProcess.spawnSync);
        spawnSyncMock.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argv = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
          if (cmd === 'launchctl' && argv[0] === 'print' && argv[1] === `gui/${runtime.uid ?? 0}/${paths.label}`) {
            return {
              pid: 0,
              output: [],
              stdout: 'state = not running\n',
              stderr: '',
              status: 0,
              signal: null,
              error: undefined,
            } as unknown as SpawnSyncReturns<string>;
          }
          return {
            pid: 0,
            output: [],
            stdout: '',
            stderr: '',
            status: 1,
            signal: null,
            error: undefined,
          } as unknown as SpawnSyncReturns<string>;
        }) as unknown as typeof childProcess.spawnSync);

        const output = captureStdoutJsonOutput<{
          services?: Array<{
            label?: string;
            running?: boolean;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              label: paths.label,
              running: false,
            }),
          ]));
        } finally {
          spawnSyncMock.mockReset();
          output.restore();
        }
      },
    );
  });

  it('marks an active Windows scheduled task as running in JSON inventory even when daemon state is missing', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-running-schtasks-active-',
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
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
        });
        const paths = resolveDaemonServicePaths(runtime);
        fs.mkdirSync(dirname(paths.installedPath), { recursive: true });
        writeValidWindowsDaemonServiceDefinition({
          path: paths.installedPath,
          workingDirectory: join(homeDir, '.happier'),
          targetMode: 'default-following',
          releaseChannel: 'stable',
        });

        const childProcess = await import('node:child_process');
        const spawnSyncMock = vi.mocked(childProcess.spawnSync);
        spawnSyncMock.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argv = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
          if (
            cmd === 'schtasks'
            && argv[0] === '/Query'
            && argv[1] === '/TN'
            && argv[2] === paths.taskName
            && argv[3] === '/FO'
            && argv[4] === 'LIST'
            && argv[5] === '/V'
          ) {
            return {
              pid: 0,
              output: [],
              stdout: 'Status: Running\nScheduled Task State: Enabled\n',
              stderr: '',
              status: 0,
              signal: null,
              error: undefined,
            } as unknown as SpawnSyncReturns<string>;
          }
          return {
            pid: 0,
            output: [],
            stdout: '',
            stderr: '',
            status: 1,
            signal: null,
            error: undefined,
          } as unknown as SpawnSyncReturns<string>;
        }) as unknown as typeof childProcess.spawnSync);

        const output = captureStdoutJsonOutput<{
          services?: Array<{
            label?: string;
            running?: boolean;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              label: paths.taskName,
              running: true,
            }),
          ]));
        } finally {
          spawnSyncMock.mockReset();
          output.restore();
        }
      },
    );
  });
});
