import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLaunchdPlistXml, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';

import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn<typeof import('node:child_process').spawnSync>(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

describe('discoverInstalledDaemonServiceEntries', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: '' } as never);
  });

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

  it('keeps explicit pinned service identity separate from the active relay profile id', async () => {
    await withTempDir('happier-discover-service-entry-pinned-active-profile-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      const path = join(servicesDir, 'happier-daemon.service-instance.service');
      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_ACTIVE_SERVER_ID: 'company-profile',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
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
          'company-profile': {
            name: 'Company profile',
            serverUrl: 'https://company.example.test',
          },
        },
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'service-instance',
          activeServerId: 'company-profile',
          name: 'Company profile',
          relayUrl: 'https://company.example.test',
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

  it('accepts legacy darwin launch agents installed by older Happier installers without startup-source metadata', async () => {
    await withTempDir('happier-discover-service-entry-darwin-legacy-', async (homeDir) => {
      const servicesDir = join(homeDir, 'Library', 'LaunchAgents');
      const path = join(servicesDir, 'com.happier.cli.daemon.default.plist');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        path,
        buildLaunchdPlistXml({
          label: 'com.happier.cli.daemon.default',
          programArgs: [
            '/Users/tester/.happier/cli/current/happier',
            'daemon',
            'start-sync',
          ],
          env: {
            HAPPIER_HOME_DIR: '/Users/tester/.happier',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
          stdoutPath: '/tmp/happier-daemon.log',
          stderrPath: '/tmp/happier-daemon.log',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'darwin',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default automatic startup',
          happierHomeDir: '/Users/tester/.happier',
          targetMode: 'default-following',
          releaseChannel: 'stable',
          path,
        }),
      ]);
    });
  });

  it('uses the canonical launchd parser for XML-escaped service environment values', async () => {
    await withTempDir('happier-discover-service-entry-darwin-escaped-env-', async (homeDir) => {
      const servicesDir = join(homeDir, 'Library', 'LaunchAgents');
      const path = join(servicesDir, 'com.happier.cli.daemon.default.plist');
      const happierHomeDir = '/Users/tester/Happier & Friends/.happier';
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        path,
        buildLaunchdPlistXml({
          label: 'com.happier.cli.daemon.default',
          programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_HOME_DIR: happierHomeDir,
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          stdoutPath: '/tmp/happier-daemon.log',
          stderrPath: '/tmp/happier-daemon.log',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'darwin',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          happierHomeDir,
          path,
        }),
      ]);
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
          name: 'Default automatic startup',
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
          name: 'Default automatic startup',
          happierHomeDir: '/home/tester/.happier',
          targetMode: 'default-following',
          releaseChannel: 'publicdev',
          path,
        }),
      ]);
    });
  });

  it('accepts raw legacy linux daemon units installed before default-following unit names', async () => {
    await withTempDir('happier-discover-service-entry-linux-raw-legacy-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      const path = join(servicesDir, 'happier-daemon.service');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: [
            '/home/tester/.happier/tools/js-runtime/current/bin/happier-js-runtime',
            '/home/tester/.happier/cli-preview/versions/0.2.2-preview.1/package-dist/index.mjs',
            'daemon',
            'start-sync',
          ],
          env: {
            HAPPIER_HOME_DIR: '/home/tester/.happier',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
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
          name: 'Default automatic startup',
          happierHomeDir: '/home/tester/.happier',
          targetMode: 'default-following',
          releaseChannel: 'preview',
          label: 'happier-daemon',
          path,
        }),
      ]);
    });
  });

  it('unquotes systemd Environment values so discovered metadata does not include surrounding quotes', async () => {
    await withTempDir('happier-discover-service-entry-linux-quoted-env-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      const path = join(servicesDir, 'happier-daemon.default.service');
      mkdirSync(servicesDir, { recursive: true });

      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: [
            '/home/tester/.happier/tools/js-runtime/current/bin/happier-js-runtime',
            '/home/tester/.happier/cli-preview/versions/0.2.2-preview.1/package-dist/index.mjs',
            'daemon',
            'start-sync',
          ],
          env: {
            // Contains a space, so the systemd renderer will quote it.
            HAPPIER_HOME_DIR: '/home/tester/My Happier/.happier',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
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
          happierHomeDir: '/home/tester/My Happier/.happier',
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

  it('accepts legacy Windows wrappers installed by older Happier installers without startup-source metadata', async () => {
    await withTempDir('happier-discover-service-entry-windows-legacy-', async (homeDir) => {
      const servicesDir = join(homeDir, '.happier', 'services');
      const path = join(servicesDir, 'happier-daemon.default.ps1');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        path,
        renderWindowsScheduledTaskWrapperPs1({
          workingDirectory: 'C:\\Users\\tester',
          programArgs: [
            'C:\\Users\\tester\\.happier\\cli\\current\\happier.exe',
            'daemon',
            'start-sync',
          ],
          env: {
            HAPPIER_HOME_DIR: 'C:\\Users\\tester\\.happier',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
          },
          stdoutPath: 'C:\\Users\\tester\\.happier\\logs\\daemon-service.out.log',
          stderrPath: 'C:\\Users\\tester\\.happier\\logs\\daemon-service.err.log',
        }),
        'utf-8',
      );

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir: join(homeDir, '.happier'),
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default automatic startup',
          happierHomeDir: 'C:\\Users\\tester\\.happier',
          targetMode: 'default-following',
          releaseChannel: 'preview',
          path,
        }),
      ]);
    });
  });

  it('discovers Windows scheduled tasks even when the wrapper file is missing', async () => {
    await withTempDir('happier-discover-service-entry-windows-orphaned-task-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      spawnSyncMock.mockImplementation((command, args) => {
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
        if (normalizedArgs.join(' ') === '/Query /FO CSV /NH') {
          return {
            status: 0,
            stdout: '"\\\\Happier\\\\happier-daemon.default","N/A"\r\n',
            stderr: '',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /XML') {
          return {
            status: 0,
            stdout: `
              <Task>
                <Actions>
                  <Exec>
                    <Arguments>-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1"</Arguments>
                  </Exec>
                </Actions>
              </Task>
            `,
            stderr: '',
          } as never;
        }
        return { status: 1, stdout: '', stderr: 'unexpected schtasks call' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default automatic startup',
          happierHomeDir: 'C:\\Users\\tester\\.happier',
          targetMode: 'default-following',
          releaseChannel: 'stable',
          label: 'Happier\\happier-daemon.default',
          path: 'C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1',
        }),
      ]);
    });
  });

  it('discovers Windows scheduled tasks even when the services directory is missing', async () => {
    await withTempDir('happier-discover-service-entry-windows-missing-services-dir-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');

      spawnSyncMock.mockImplementation((command, args) => {
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
        if (normalizedArgs.join(' ') === '/Query /FO CSV /NH') {
          return {
            status: 0,
            stdout: '"\\\\Happier\\\\happier-daemon.default","N/A"\r\n',
            stderr: '',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /XML') {
          return {
            status: 0,
            stdout: `
              <Task>
                <Actions>
                  <Exec>
                    <Arguments>-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1"</Arguments>
                  </Exec>
                </Actions>
              </Task>
            `,
            stderr: '',
          } as never;
        }
        return { status: 1, stdout: '', stderr: 'unexpected schtasks call' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default automatic startup',
          label: 'Happier\\happier-daemon.default',
          path: 'C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1',
          happierHomeDir: 'C:\\Users\\tester\\.happier',
          targetMode: 'default-following',
        }),
      ]);
    });
  });

  it('uses schtasks LIST fallback wrapper path when XML task export is unavailable', async () => {
    await withTempDir('happier-discover-service-entry-windows-list-fallback-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      spawnSyncMock.mockImplementation((command, args) => {
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
        if (normalizedArgs.join(' ') === '/Query /FO CSV /NH') {
          return {
            status: 0,
            stdout: '"\\\\Happier\\\\happier-daemon.default","N/A"\r\n',
            stderr: '',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /XML') {
          return {
            status: 1,
            stdout: '',
            stderr: 'xml unavailable',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /FO LIST /V') {
          return {
            status: 0,
            stdout: [
              'TaskName: Happier\\happier-daemon.default',
              'Task To Run: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\tester\\.happier-l21-alt\\services\\happier-daemon.default.ps1"',
              '',
            ].join('\r\n'),
            stderr: '',
          } as never;
        }
        return { status: 1, stdout: '', stderr: 'unexpected schtasks call' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([
        expect.objectContaining({
          serverId: 'default',
          name: 'Default automatic startup',
          happierHomeDir: 'C:\\Users\\tester\\.happier-l21-alt',
          targetMode: 'default-following',
          releaseChannel: 'stable',
          label: 'Happier\\happier-daemon.default',
          path: 'C:\\Users\\tester\\.happier-l21-alt\\services\\happier-daemon.default.ps1',
        }),
      ]);
    });
  });

  it('does not fabricate a local wrapper path when Windows task wrapper path cannot be resolved', async () => {
    await withTempDir('happier-discover-service-entry-windows-unresolved-task-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      spawnSyncMock.mockImplementation((command, args) => {
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
        if (normalizedArgs.join(' ') === '/Query /FO CSV /NH') {
          return {
            status: 0,
            stdout: '"\\\\Happier\\\\happier-daemon.default","N/A"\r\n',
            stderr: '',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /XML') {
          return {
            status: 1,
            stdout: '',
            stderr: 'xml unavailable',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /FO LIST /V') {
          return {
            status: 1,
            stdout: '',
            stderr: 'list unavailable',
          } as never;
        }
        return { status: 1, stdout: '', stderr: 'unexpected schtasks call' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });

      expect(entries).toEqual([]);
    });
  });

  it('applies a timeout to Windows schtasks discovery calls', async () => {
    await withTempDir('happier-discover-service-entry-windows-timeout-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      const observedTimeouts: number[] = [];
      spawnSyncMock.mockImplementation((command, args, options) => {
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        observedTimeouts.push(Number((options as { timeout?: number } | undefined)?.timeout ?? 0));
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
        if (normalizedArgs.join(' ') === '/Query /FO CSV /NH') {
          return {
            status: 0,
            stdout: '"\\\\Happier\\\\happier-daemon.default","N/A"\r\n',
            stderr: '',
          } as never;
        }
        if (normalizedArgs.join(' ') === '/Query /TN Happier\\happier-daemon.default /XML') {
          return {
            status: 0,
            stdout: `
              <Task>
                <Actions>
                  <Exec>
                    <Arguments>-NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1"</Arguments>
                  </Exec>
                </Actions>
              </Task>
            `,
            stderr: '',
          } as never;
        }
        return { status: 1, stdout: '', stderr: 'unexpected schtasks call' } as never;
      });

      await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });

      expect(observedTimeouts.length).toBeGreaterThan(0);
      expect(observedTimeouts.every((timeout) => timeout > 0)).toBe(true);
    });
  });
});
