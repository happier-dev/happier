import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLaunchdPlistXml,
  renderSystemdServiceUnit,
  renderWindowsScheduledTaskWrapperPs1,
  resolveInstalledWindowsServiceLauncherPaths,
} from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createWindowsServiceLauncherPeFixture } from '@/testkit/fs/windowsServiceLauncherFixture';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { evaluateDaemonStartupServiceConflict } from '@/daemon/ownership/daemonServiceInventory';
import { resolveDaemonServiceCliRuntimeFromEnv } from './cli';
import { previewDaemonServiceInstall } from './installer';
import { resolveDaemonWindowsServiceLauncherInstallSpec } from './windowsServiceLauncher';
import { planServiceDaemonsRestartAfterUpdate } from '@/cli/runtime/update/restartServiceDaemonAfterUpdate';

import { discoverInstalledDaemonServiceEntries, isInstalledDaemonServiceForHappierHome, isValidInstalledDaemonServiceFile, readInstalledDaemonServiceAutostartMode, readInstalledDaemonServiceHomeDir, readInstalledDaemonServiceTargetMode } from './discoverInstalledDaemonServiceEntries';

const { readdirSyncMock, readFileSyncMock } = vi.hoisted(() => ({ readdirSyncMock: vi.fn(), readFileSyncMock: vi.fn() }));
// Filesystem enumeration and reads are the OS boundary; all discovery/parsing stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: readdirSyncMock, readFileSync: readFileSyncMock };
});

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn<typeof import('node:child_process').spawnSync>(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

function isHappierTaskFolderListing(command: string, args: readonly string[] | undefined): boolean {
  return command === 'powershell.exe' && Boolean(args?.some((arg) => arg.includes('.GetFolder("\\Happier")')));
}

function happierTaskFolderListing(taskPaths: readonly string[]) {
  return { status: 0, stdout: `${JSON.stringify(taskPaths)}\r\n`, stderr: '' } as never;
}

function ranFullScheduledTaskEnumeration(): boolean {
  return spawnSyncMock.mock.calls.some(([command, args]) => command === 'schtasks' && !args?.includes('/TN'));
}

describe('discoverInstalledDaemonServiceEntries', () => {
  beforeEach(async () => {
    readdirSyncMock.mockReset();
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    readdirSyncMock.mockImplementation(fs.readdirSync);
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(fs.readFileSync);
    spawnSyncMock.mockReset();
    // Successful empty OS enumeration; individual tests override real task results.
    spawnSyncMock.mockImplementation((command, args) => (isHappierTaskFolderListing(command, args)
      ? happierTaskFolderListing([])
      : { status: 0, stdout: '', stderr: '' } as never));
  });

  it.each([
    ["\"C:\\Users\\O'Connor\\qa`$HOME\\.happier``cache\"", String.raw`C:\Users\O'Connor\qa$HOME\.happier` + '`cache'],
    [String.raw`'C:\Users\O''Connor\qa\$HOME\.happier'`, String.raw`C:\Users\O'Connor\qa\$HOME\.happier`],
  ])('recognizes the owning home from a quoted Windows definition %s', async (quotedHome, expectedHome) => {
    await withTempDir('happier-windows-literal-home-', async (dir) => {
      const path = join(dir, 'happier-daemon.default.ps1');
      writeFileSync(path, [
        `$env:HAPPIER_HOME_DIR = ${quotedHome}`,
        '$env:HAPPIER_DAEMON_STARTUP_SOURCE = "background-service"',
        '& "C:\\happier.exe" "daemon" "start-sync"',
      ].join('\n'));

      expect(readInstalledDaemonServiceHomeDir({ platform: 'win32', path })).toBe(expectedHome);
      expect(isInstalledDaemonServiceForHappierHome({
        platform: 'win32', path, expectedLabel: 'Happier\\happier-daemon.default', happierHomeDir: expectedHome,
      })).toBe(true);
    });
  });

  it.each(['EACCES', 'EIO'])('propagates %s rather than reporting an empty service inventory', async (code) => {
    const error = Object.assign(new Error('cannot enumerate services'), { code });
    readdirSyncMock.mockImplementationOnce(() => { throw error; });
    await expect(discoverInstalledDaemonServiceEntries({
      platform: 'linux', userHomeDir: '/unused', happierHomeDir: '/unused/.happier', mode: 'user', serversById: {},
    })).rejects.toMatchObject({ code: 'service_inventory_unavailable', cause: error });
  });

  it.each(['linux', 'darwin', 'win32'] as const)('requires readable %s definitions to prove installation while optional metadata remains unknown', (platform) => {
    const cause = Object.assign(new Error('cannot read service definition'), { code: 'EACCES' });
    readFileSyncMock.mockImplementation(() => { throw cause; });
    expect(() => isValidInstalledDaemonServiceFile({ platform, path: '/unused', expectedLabel: 'happier-daemon.default' }))
      .toThrow(expect.objectContaining({ code: 'service_inventory_unavailable', cause }));
    expect(readInstalledDaemonServiceAutostartMode({ platform, path: '/unused' })).toBeNull();
    const installedPath = platform === 'linux' ? '/unused/happier-daemon.default.service'
      : platform === 'darwin' ? '/unused/com.happier.cli.daemon.default.plist'
      : '/unused/happier-daemon.default.ps1';
    expect(readInstalledDaemonServiceTargetMode({ platform, path: installedPath })).toBeNull();

    readFileSyncMock.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    expect(isValidInstalledDaemonServiceFile({ platform, path: '/unused', expectedLabel: 'happier-daemon.default' })).toBe(false);
  });

  it.each(['daemon-start', 'service-install', 'self-update'] as const)('names unknown inventory before %s can change services', async (operation) => {
    await withConfiguredDaemonTestHome({ prefix: 'w12-cli-inventory-', env: { HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable' } }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const cause = Object.assign(new Error('cannot enumerate service directory'), { code: 'EACCES' });
      readdirSyncMock.mockImplementation(() => { throw cause; });
      const command = operation === 'daemon-start'
        ? evaluateDaemonStartupServiceConflict({ startupSource: 'manual', runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }) })
        : operation === 'service-install'
          ? previewDaemonServiceInstall({ platform: 'linux', userHomeDir: homeDir, happierHomeDir: homeDir, channel: 'stable', nodePath: process.execPath, entryPath: process.argv[1] })
          : planServiceDaemonsRestartAfterUpdate({ channel: 'stable' });
      await expect(command).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringMatching(/background services.*could not be listed/i), cause });
    });
  });

  it('reports a missing service directory as an empty inventory', async () => {
    readdirSyncMock.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    await expect(discoverInstalledDaemonServiceEntries({
      platform: 'linux', userHomeDir: '/unused', happierHomeDir: '/unused/.happier', mode: 'user', serversById: {},
    })).resolves.toEqual([]);
  });

  it('propagates a Windows task enumeration error rather than losing services with missing wrappers', async () => {
    await withTempDir('happier-discover-task-error-', async (homeDir) => {
      mkdirSync(join(homeDir, '.happier', 'services'), { recursive: true });
      const error = Object.assign(new Error('cannot enumerate scheduled tasks'), { code: 'EACCES' });
      spawnSyncMock.mockReturnValueOnce({ status: null, error, stdout: '', stderr: '' } as never);
      await expect(discoverInstalledDaemonServiceEntries({
        platform: 'win32', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {},
      })).rejects.toMatchObject({ code: 'service_inventory_unavailable', cause: error });
    });
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

  /**
   * A stable-ring service pinned to the profile named `default` occupies the same unit name the
   * default-following installation uses, so the file name cannot decide the mode. The definition
   * declares it, and a definition that says `pinned` is pinned.
   */
  it('reports a pinned definition on the default-segment unit name as pinned', async () => {
    await withTempDir('happier-discover-service-entry-pinned-default-segment-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      const path = join(servicesDir, 'happier-daemon.default.service');
      writeFileSync(
        path,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_ACTIVE_SERVER_ID: 'default',
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
        serversById: { default: { name: 'Default', serverUrl: 'https://relay.example.test' } },
      });

      expect(entries).toEqual([
        expect.objectContaining({ serverId: 'default', targetMode: 'pinned', path }),
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

  describe('readInstalledDaemonServiceAutostartMode', () => {
    /**
     * The mode a caller acts on has to describe what the platform will actually do. On darwin
     * the login trigger is the plist's own `RunAtLoad`, so that key decides and the recorded
     * declaration cannot outvote it: `launchctl`-driven edits or a hand-edited plist would
     * otherwise leave the desktop toggle claiming this computer answers at login when it does
     * not.
     */
    it('reads the darwin login trigger from RunAtLoad, not from the recorded declaration', async () => {
      await withTempDir('happier-autostart-darwin-runatload-', async (homeDir) => {
        const path = join(homeDir, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
        mkdirSync(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(
          path,
          buildLaunchdPlistXml({
            label: 'com.happier.cli.daemon.default',
            programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_AUTOSTART: 'at-login',
            },
            stdoutPath: '/tmp/out.log',
            stderrPath: '/tmp/err.log',
            runAtLoad: false,
            keepAliveOnFailure: false,
          }),
          'utf-8',
        );

        expect(readInstalledDaemonServiceAutostartMode({ platform: 'darwin', path })).toBe('on-demand');
      });
    });

    it('reads an at-login darwin definition from RunAtLoad', async () => {
      await withTempDir('happier-autostart-darwin-runatload-login-', async (homeDir) => {
        const path = join(homeDir, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
        mkdirSync(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(
          path,
          buildLaunchdPlistXml({
            label: 'com.happier.cli.daemon.default',
            programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_AUTOSTART: 'on-demand',
            },
            stdoutPath: '/tmp/out.log',
            stderrPath: '/tmp/err.log',
            runAtLoad: true,
          }),
          'utf-8',
        );

        expect(readInstalledDaemonServiceAutostartMode({ platform: 'darwin', path })).toBe('at-login');
      });
    });

    /**
     * Linux and Windows keep the recorded declaration: their real trigger is a systemd enable
     * symlink / a scheduled-task trigger, and reading either needs a `systemctl is-enabled` or
     * `schtasks /Query` subprocess that this synchronous reader runs on the healthy status
     * fast path. Neither platform is read from the OS here.
     */
    /**
     * The Windows trigger lives in the registered task, not in the wrapper this reader parses, so
     * the marker stays the only thing that reports the mode — including for the never-due `ONCE`
     * task an on-demand install registers. Uninstall and drift refresh read the same wrapper.
     */
    it('keeps the recorded declaration on win32', async () => {
      await withTempDir('happier-autostart-win32-declaration-', async (homeDir) => {
        const path = join(homeDir, '.happier', 'services', 'happier-daemon.default.ps1');
        mkdirSync(join(homeDir, '.happier', 'services'), { recursive: true });
        writeFileSync(
          path,
          renderWindowsScheduledTaskWrapperPs1({
            programArgs: ['C:\\Users\\test\\.happier\\cli\\current\\happier.exe', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_AUTOSTART: 'on-demand',
            },
            stdoutPath: 'C:\\out.log',
            stderrPath: 'C:\\err.log',
          }),
          'utf-8',
        );

        expect(readInstalledDaemonServiceAutostartMode({ platform: 'win32', path })).toBe('on-demand');
      });
    });

    it('keeps the recorded declaration on linux', async () => {
      await withTempDir('happier-autostart-linux-declaration-', async (homeDir) => {
        const path = join(homeDir, '.config', 'systemd', 'user', 'happier-daemon.default.service');
        mkdirSync(join(homeDir, '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(
          path,
          renderSystemdServiceUnit({
            description: 'Happier CLI daemon (default)',
            execStart: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
            env: {
              HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
              HAPPIER_DAEMON_SERVICE_AUTOSTART: 'on-demand',
            },
            wantedBy: 'default.target',
          }),
          'utf-8',
        );

        expect(readInstalledDaemonServiceAutostartMode({ platform: 'linux', path })).toBe('on-demand');
      });
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
        if (isHappierTaskFolderListing(command, args)) {
          return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        }
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
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
          windowsLauncherUpgradeNeeded: true,
        }),
      ]);
      expect(ranFullScheduledTaskEnumeration()).toBe(false);
    });
  });

  it.each([
    ['single native action', '', false],
    ['additional executable action', '<Exec><Command>cmd.exe</Command><Arguments>/c exit 0</Arguments></Exec>', true],
    ['additional COM action', '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>', true],
  ])('checks the complete registered action set for a %s', async (_case, additionalAction, upgradeNeeded) => {
    await withTempDir('happier-discover-native-launcher-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      const wrapperPath = join(happierHomeDir, 'services', 'happier-daemon.default.ps1');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });
      writeFileSync(wrapperPath, renderWindowsScheduledTaskWrapperPs1({
        workingDirectory: homeDir,
        programArgs: ['node.exe', 'daemon', 'start-sync'],
        env: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        },
      }));
      const launcher = resolveInstalledWindowsServiceLauncherPaths({
        definitionPath: wrapperPath,
        label: 'happier-daemon.default',
        version: resolveDaemonWindowsServiceLauncherInstallSpec().version,
      });
      mkdirSync(dirname(launcher.launcherPath), { recursive: true });
      const pe = Buffer.alloc(512);
      pe.writeUInt16LE(0x5a4d, 0);
      pe.writeUInt32LE(0x80, 0x3c);
      pe.writeUInt32LE(0x00004550, 0x80);
      pe.writeUInt16LE(0x8664, 0x84);
      pe.writeUInt16LE(0x20b, 0x98);
      pe.writeUInt16LE(2, 0x98 + 68);
      pe.write('HAPPIER_SERVICE_LAUNCHER_V1', 0x120, 'ascii');
      writeFileSync(launcher.launcherPath, pe);

      spawnSyncMock.mockImplementation((command, args) => {
        if (isHappierTaskFolderListing(command, args)) return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        if (command === 'schtasks' && args?.includes('/XML')) {
          return {
            status: 0,
            stdout: `<Task><Actions><Exec><Command>${launcher.launcherPath}</Command><Arguments>--wrapper &quot;${wrapperPath}&quot; --diagnostic-log &quot;${launcher.diagnosticLogPath}&quot;</Arguments></Exec>${additionalAction}</Actions></Task>`,
            stderr: '',
          } as never;
        }
        return { status: 1, stdout: '', stderr: '' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });
      expect(entries).toEqual([expect.objectContaining({
        path: wrapperPath,
        windowsLauncherUpgradeNeeded: upgradeNeeded,
      })]);
    });
  });

  it.each([
    ['is missing', () => ''],
    ['names another file', (logPath: string) => ` --diagnostic-log &quot;${logPath}.elsewhere&quot;`],
  ])('reports a launcher upgrade when the native action diagnostic log %s', async (_case, diagnosticLogArgument) => {
    await withTempDir('happier-discover-native-launcher-malformed-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      const wrapperPath = join(happierHomeDir, 'services', 'happier-daemon.default.ps1');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });
      writeFileSync(wrapperPath, renderWindowsScheduledTaskWrapperPs1({
        workingDirectory: homeDir,
        programArgs: ['node.exe', 'daemon', 'start-sync'],
        env: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        },
      }));
      const launcher = resolveInstalledWindowsServiceLauncherPaths({
        definitionPath: wrapperPath,
        label: 'happier-daemon.default',
        version: resolveDaemonWindowsServiceLauncherInstallSpec().version,
      });
      mkdirSync(dirname(launcher.launcherPath), { recursive: true });
      writeFileSync(launcher.launcherPath, createWindowsServiceLauncherPeFixture());

      spawnSyncMock.mockImplementation((command, args) => {
        if (isHappierTaskFolderListing(command, args)) return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        if (command === 'schtasks' && args?.includes('/XML')) {
          return {
            status: 0,
            stdout: `<Task><Actions><Exec><Command>${launcher.launcherPath}</Command><Arguments>--wrapper &quot;${wrapperPath}&quot;${diagnosticLogArgument(launcher.diagnosticLogPath)}</Arguments></Exec></Actions></Task>`,
            stderr: '',
          } as never;
        }
        return { status: 1, stdout: '', stderr: '' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });
      expect(entries).toEqual([expect.objectContaining({
        path: wrapperPath,
        windowsLauncherUpgradeNeeded: true,
      })]);
    });
  });

  it('recognizes a healthy native launcher action from the schtasks LIST fallback', async () => {
    await withTempDir('happier-discover-native-launcher-list-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      const wrapperPath = join(happierHomeDir, 'services', 'happier-daemon.default.ps1');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });
      writeFileSync(wrapperPath, renderWindowsScheduledTaskWrapperPs1({
        workingDirectory: homeDir,
        programArgs: ['node.exe', 'daemon', 'start-sync'],
        env: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        },
      }));
      const launcher = resolveInstalledWindowsServiceLauncherPaths({
        definitionPath: wrapperPath,
        label: 'happier-daemon.default',
        version: resolveDaemonWindowsServiceLauncherInstallSpec().version,
      });
      mkdirSync(dirname(launcher.launcherPath), { recursive: true });
      writeFileSync(launcher.launcherPath, createWindowsServiceLauncherPeFixture());
      // A full `schtasks /FO LIST /V` report: the action is one field among many (labels are localized).
      const listReport = [
        '',
        'Folder: \\Happier',
        'HostName:                             HOST',
        'TaskName:                             \\Happier\\happier-daemon.default',
        'Status:                               Running',
        `Task To Run:                          ${launcher.launcherPath} --wrapper "${wrapperPath}" --diagnostic-log "${launcher.diagnosticLogPath}"`,
        'Start In:                             N/A',
        'Comment:                              N/A',
        '',
      ].join('\r\n');

      spawnSyncMock.mockImplementation((command, args) => {
        if (isHappierTaskFolderListing(command, args)) return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        if (command === 'schtasks' && args?.includes('/XML')) return { status: 1, stdout: '', stderr: 'unavailable' } as never;
        if (command === 'schtasks' && args?.includes('LIST')) return { status: 0, stdout: listReport, stderr: '' } as never;
        return { status: 1, stdout: '', stderr: '' } as never;
      });

      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      });
      expect(entries).toEqual([expect.objectContaining({
        path: wrapperPath,
        windowsLauncherUpgradeNeeded: false,
      })]);
    });
  });

  it('uses schtasks LIST fallback wrapper path when XML task export is unavailable', async () => {
    await withTempDir('happier-discover-service-entry-windows-list-fallback-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      spawnSyncMock.mockImplementation((command, args) => {
        if (isHappierTaskFolderListing(command, args)) {
          return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        }
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
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

  it('names an unreadable Windows task instead of claiming an empty inventory', async () => {
    await withTempDir('happier-discover-service-entry-windows-unresolved-task-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      spawnSyncMock.mockImplementation((command, args) => {
        if (isHappierTaskFolderListing(command, args)) {
          return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        }
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
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

      await expect(discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      })).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining('happier-daemon.default') });
    });
  });

  it('enumerates Scheduler without a local wrapper directory and retains foreign tasks', async () => {
    await withTempDir('happier-discover-task-no-directory-', async (homeDir) => {
      const wrapper = String.raw`C:\Other\.happier\services\happier-daemon.company.ps1`;
      spawnSyncMock.mockImplementation((command, args) => (isHappierTaskFolderListing(command, args)
        ? happierTaskFolderListing(['\\Happier\\happier-daemon.company'])
        : { status: 0, stdout: args?.includes('/XML') ? `<Task><Actions><Exec><Arguments>-File "${wrapper}"</Arguments></Exec></Actions></Task>` : '', stderr: '' } as never));
      const entries = await discoverInstalledDaemonServiceEntries({ platform: 'win32', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} });
      expect(entries).toEqual([expect.objectContaining({ serverId: 'company', path: wrapper })]);
    });
  });

  it('names the task when the OS process boundary throws during inspection', async () => {
    readdirSyncMock.mockReturnValue([]);
    spawnSyncMock.mockReturnValueOnce(happierTaskFolderListing(['\\Happier\\happier-daemon.company']))
      .mockImplementationOnce(() => { throw new Error('OS process unavailable'); });
    await expect(discoverInstalledDaemonServiceEntries({ platform: 'win32', userHomeDir: '/unused', happierHomeDir: '/unused/.happier', mode: 'user', serversById: {} }))
      .rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining('happier-daemon.company') });
  });

  it('omits a task only after a successful Scheduler enumeration proves it disappeared', async () => {
    await withTempDir('happier-discover-task-disappeared-', async (homeDir) => {
      mkdirSync(join(homeDir, '.happier', 'services'), { recursive: true });
      spawnSyncMock.mockReturnValueOnce(happierTaskFolderListing(['\\Happier\\happier-daemon.company']))
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' } as never)
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' } as never)
        .mockReturnValueOnce(happierTaskFolderListing([]));
      await expect(discoverInstalledDaemonServiceEntries({ platform: 'win32', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} })).resolves.toEqual([]);
      expect(ranFullScheduledTaskEnumeration()).toBe(false);
    });
  });

  it('reports an unreadable Happier task folder instead of an empty inventory', async () => {
    await withTempDir('happier-discover-task-folder-unreadable-', async (homeDir) => {
      mkdirSync(join(homeDir, '.happier', 'services'), { recursive: true });
      spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'Access is denied.' } as never);
      await expect(discoverInstalledDaemonServiceEntries({ platform: 'win32', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} }))
        .rejects.toMatchObject({ code: 'service_inventory_unavailable' });
    });
  });

  it.each(['', ' \r\n', 'not-json'])('rejects an unproven inventory from status-zero output %j', async (stdout) => {
    readdirSyncMock.mockReturnValue([]);
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout, stderr: '' } as never);
    await expect(discoverInstalledDaemonServiceEntries({
      platform: 'win32', userHomeDir: '/unused', happierHomeDir: '/unused/.happier', mode: 'user', serversById: {},
    })).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
  });

  it('does not infer a task disappeared from blank output after its detail reads failed', async () => {
    readdirSyncMock.mockReturnValue([]);
    spawnSyncMock.mockReturnValueOnce(happierTaskFolderListing(['\\Happier\\happier-daemon.company']))
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' } as never)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' } as never)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as never);
    await expect(discoverInstalledDaemonServiceEntries({
      platform: 'win32', userHomeDir: '/unused', happierHomeDir: '/unused/.happier', mode: 'user', serversById: {},
    })).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
  });

  it('applies a timeout to Windows schtasks discovery calls', async () => {
    await withTempDir('happier-discover-service-entry-windows-timeout-', async (homeDir) => {
      const happierHomeDir = join(homeDir, '.happier');
      mkdirSync(join(happierHomeDir, 'services'), { recursive: true });

      const observedTimeouts: number[] = [];
      spawnSyncMock.mockImplementation((command, args, options) => {
        observedTimeouts.push(Number((options as { timeout?: number } | undefined)?.timeout ?? 0));
        if (isHappierTaskFolderListing(command, args)) {
          return happierTaskFolderListing(['\\Happier\\happier-daemon.default']);
        }
        if (command !== 'schtasks') {
          return { status: 1, stdout: '', stderr: '' } as never;
        }
        const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
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
