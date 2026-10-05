import { mkdirSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLaunchdPlistXml, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

import { withTempDir } from '@/testkit/fs/tempDir';

import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import { planDaemonServiceInstall } from './plan';
import { resolveDaemonServiceInstallConflictPlan } from './daemonInstallConflict';
import { buildBackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair/buildBackgroundServiceRepairPlan';
import { describeDaemonServiceInstallConflict } from './installer';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn<typeof import('node:child_process').spawnSync>(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

// Filesystem read denial is an OS boundary; the shared parser and discovery remain real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('discoverInstalledDaemonServiceEntries', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
  });

  it('preserves shared definition read failures instead of independently publishing the service', async () => {
    await withTempDir('happier-discover-shared-reader-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      const path = join(servicesDir, 'happier-daemon.company.service');
      writeFileSync(path, renderSystemdServiceUnit({ description: 'Happier daemon', execStart: ['/usr/local/bin/happier', 'daemon', 'start-sync'], env: { HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' }, wantedBy: 'default.target' }));
      const reader = vi.mocked(fsPromises.readFile).mockRejectedValue(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      try {
        await expect(discoverInstalledDaemonServiceEntries({ platform: 'linux', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} })).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining('happier-daemon.company') });
      } finally {
        reader.mockReset();
      }
    });
  });

  it.each(['linux', 'darwin', 'win32'] as const)('honours the explicit pinned declaration on a default-named %s definition', async (platform) => {
    await withTempDir('happier-discover-pinned-default-', async (homeDir) => {
      const plan = planDaemonServiceInstall({ platform, channel: 'stable', targetMode: 'pinned', instanceId: 'default', activeServerId: 'default', uid: 501, userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), serverUrl: 'https://relay.test', publicServerUrl: 'https://relay.test', webappUrl: 'https://relay.test', nodePath: '/usr/local/bin/happier', entryPath: '' });
      const file = plan.files[0]!;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
      expect(await discoverInstalledDaemonServiceEntries({ platform, userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} })).toEqual([expect.objectContaining({ serverId: 'default', targetMode: 'pinned', path: file.path })]);
    });
  });

  it('keeps a stable pinned instance named dev distinct from the dev release ring', async () => {
    await withTempDir('happier-discover-ring-named-instance-', async (homeDir) => {
      const plan = planDaemonServiceInstall({ platform: 'linux', channel: 'stable', targetMode: 'pinned', instanceId: 'dev', activeServerId: 'dev', uid: 501, userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), serverUrl: 'https://relay.test', publicServerUrl: 'https://relay.test', webappUrl: 'https://relay.test', nodePath: '/usr/local/bin/happier', entryPath: '' });
      const file = plan.files[0]!;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
      await expect(discoverInstalledDaemonServiceEntries({ platform: 'linux', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} })).resolves.toEqual([expect.objectContaining({ serverId: 'dev', releaseChannel: 'stable', targetMode: 'pinned', path: file.path })]);
    });
  });

  it.each(['exit', 'error', 'throw'] as const)('preserves top-level Scheduler %s failures', async (failure) => {
    await withTempDir('happier-discover-task-error-', async (homeDir) => {
      if (failure === 'throw') spawnSyncMock.mockImplementationOnce(() => { throw new Error('Scheduler denied'); });
      else spawnSyncMock.mockReturnValueOnce({ status: failure === 'exit' ? 1 : null, error: failure === 'error' ? new Error('Scheduler unavailable') : undefined, stdout: '', stderr: 'Access denied' } as never);
      await expect(discoverInstalledDaemonServiceEntries({ platform: 'win32', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} })).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
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

  it.each([
    { label: 'happier-daemon.service-instance', instanceId: 'service-instance' },
    { label: 'happier-daemon.preview.company.profile', instanceId: 'company.profile' },
  ])('keeps explicit pinned service identity $instanceId separate from the active relay profile id', async ({ label, instanceId }) => {
    await withTempDir('happier-discover-service-entry-pinned-active-profile-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      const path = join(servicesDir, `${label}.service`);
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
          serverId: instanceId,
          activeServerId: 'company-profile',
          name: 'Company profile',
          relayUrl: 'https://company.example.test',
          targetMode: 'pinned',
          path,
        }),
      ]);
    });
  });

  it('ignores unparsable darwin launch-agent files that only match by filename', async () => {
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

  it.each([
    { execStart: ['/usr/bin/env', 'bash', '-lc', 'echo not-happier'] },
    { execStart: ['/usr/local/bin/happier', 'daemon', 'status', 'start-sync'] },
  ])('retains unverified linux units that do not launch happier daemon start-sync ($execStart)', async ({ execStart }) => {
    await withTempDir('happier-discover-service-entry-linux-invalid-', async (homeDir) => {
      const servicesDir = join(homeDir, '.config', 'systemd', 'user');
      mkdirSync(servicesDir, { recursive: true });
      writeFileSync(
        join(servicesDir, 'happier-daemon.default.service'),
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart,
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

      expect(entries).toEqual([expect.objectContaining({ installed: true, verification: 'candidate' })]);
    });
  });

  it('retains a candidate when a launchd definition label differs from its installed path', async () => {
    await withTempDir('happier-discover-launchd-label-', async (homeDir) => {
      const path = join(homeDir, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.company.plist');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buildLaunchdPlistXml({ label: 'com.happier.cli.daemon.other', programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'], env: { HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' }, stdoutPath: '/tmp/daemon.out', stderrPath: '/tmp/daemon.err' }));
      await expect(discoverInstalledDaemonServiceEntries({ platform: 'darwin', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user', serversById: {} })).resolves.toEqual([expect.objectContaining({ path, installed: true, verification: 'candidate' })]);
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
          verification: 'verified',
          targetMode: 'default-following',
          releaseChannel: 'preview',
          path,
        }),
      ]);
    });
  });

  it.each(['conflict', 'repair'] as const)('discovers Windows scheduled tasks even when the wrapper file is missing (%s)', async (consumer) => {
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
          verification: 'candidate',
          path: 'C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1',
        }),
      ]);
      if (consumer === 'conflict') {
        const conflict = resolveDaemonServiceInstallConflictPlan({ target: { platform: 'win32', mode: 'user', targetMode: 'default-following', ring: 'stable', instanceId: null, happierHomeDir: 'C:\\Users\\tester\\.happier' }, strategy: 'replace-all', services: entries });
        expect(conflict.exactTargetExists).toBe(true);
        expect(conflict.exactTargetIsConverged).toBe(false);
        expect(conflict.servicesToRemove).toEqual([]);
        expect(describeDaemonServiceInstallConflict({ exactTargetExists: conflict.exactTargetExists, strategy: 'replace-all', conflictPlan: conflict })).toMatchObject({ blocking: true });
      } else {
        const repair = buildBackgroundServiceRepairPlan({ currentReleaseChannel: 'stable', currentServerId: 'cloud', preferredMode: 'user', currentHappierHomeDir: 'C:\\Users\\tester\\.happier', services: entries });
        expect(repair.existingServices).toEqual(entries);
        expect(repair.actions).toEqual([]);
        expect(repair.manualWarnings).toEqual([expect.stringContaining('Happier\\happier-daemon.default')]);
      }
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

  it('names an unreadable Windows task instead of claiming an empty inventory', async () => {
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

      await expect(discoverInstalledDaemonServiceEntries({
        platform: 'win32',
        userHomeDir: homeDir,
        happierHomeDir,
        mode: 'user',
        serversById: {},
      })).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining('happier-daemon.default') });
    });
  });

  it('names the task when its OS inspection throws, and confirms absence only with a successful listing', async () => {
    await withTempDir('happier-discover-task-throw-', async (homeDir) => {
      const params = { platform: 'win32' as const, userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), mode: 'user' as const, serversById: {} };
      const listing = { status: 0, stdout: '"\\Happier\\happier-daemon.company","N/A"\r\n', stderr: '' };
      spawnSyncMock.mockReturnValueOnce(listing as never)
        .mockImplementationOnce(() => { throw new Error('OS process unavailable'); })
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'inspection unavailable' } as never)
        .mockReturnValueOnce(listing as never);
      await expect(discoverInstalledDaemonServiceEntries(params)).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining('happier-daemon.company') });
      spawnSyncMock.mockReturnValueOnce(listing as never)
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' } as never)
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' } as never)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as never);
      await expect(discoverInstalledDaemonServiceEntries(params)).resolves.toEqual([]);
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
