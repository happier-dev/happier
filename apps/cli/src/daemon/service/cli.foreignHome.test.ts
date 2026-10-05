import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { planDaemonServiceInstall } from './plan';

// Service manager invocations are the OS boundary; definitions and attribution remain real.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_PLATFORM', 'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE', 'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
]);

afterEach(() => { envScope.restore(); vi.resetModules(); spawnSyncMock.mockReset(); });

describe('service definition home attribution', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('refuses foreign default definitions on %s', async (platform) => {
    await withTempDir('w23-foreign-service-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, 'qa-home');
      const foreignHomeDir = join(userHomeDir, 'foreign-home');
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: platform,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      });
      const foreignPlan = planDaemonServiceInstall({
        platform, mode: 'user', channel: 'stable', targetMode: 'default-following',
        instanceId: 'cloud', activeServerId: 'cloud', userHomeDir, happierHomeDir: foreignHomeDir,
        nodePath: process.execPath, entryPath: '/opt/happier/index.mjs', uid: 501,
        serverUrl: 'https://relay.example.test', webappUrl: 'https://relay.example.test',
        publicServerUrl: 'https://relay.example.test', autostart: 'at-login',
      });
      const definition = foreignPlan.files[0]!;
      mkdirSync(dirname(definition.path), { recursive: true });
      writeFileSync(definition.path, definition.content);
      spawnSyncMock.mockImplementation((command: string, args: readonly string[]) => ({
        status: 0, stderr: '', stdout: args.includes('/XML')
          ? `<Task><Actions><Exec><Arguments>-File &quot;${definition.path}&quot;</Arguments></Exec></Actions></Task>`
          : args.includes('CSV') ? '"\\Happier\\happier-daemon.default","N/A","Ready"'
            : command === 'systemctl' ? 'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled'
              : command === 'launchctl' ? '"com.happier.cli.daemon.default" => false'
                : command === 'powershell.exe' ? JSON.stringify({ exists: true, enabled: true, active: false, autostart: false }) : '',
      }));
      const cli = await import('./cli');
      expect(cli.resolveDaemonServiceInstallationSnapshotFromEnv()).toMatchObject({ installed: false, autostart: null });
      for (const action of ['stop', 'start', 'restart', 'uninstall'] as const) {
        await expect(cli.runDaemonServiceCliCommand({ argv: [action, '--json'] })).rejects.toMatchObject({ code: 'foreign_home_service' });
      }
      expect(spawnSyncMock.mock.calls.every(([, args]) => args.includes('/Query'))).toBe(true);
      const runtime = cli.resolveDaemonServiceCliRuntimeFromEnv();
      mkdirSync(foreignHomeDir, { recursive: true });
      writeFileSync(join(foreignHomeDir, 'settings.json'), JSON.stringify({
        activeServerId: 'cloud', servers: { cloud: { id: 'cloud', serverUrl: runtime.serverUrl } },
      }));
      const { resolveInstalledDaemonServiceInventoryForCurrentRelay, hasInstalledBackgroundServiceConflictForCurrentInstallation } = await import('../ownership/daemonServiceInventory');
      expect(await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime)).toEqual([]);
      expect(hasInstalledBackgroundServiceConflictForCurrentInstallation({
        runtime, services: await cli.resolveDaemonServiceListEntries(runtime),
      })).toBe(false);
      const { planServiceDaemonsRestartAfterUpdate } = await import('../../cli/runtime/update/restartServiceDaemonAfterUpdate');
      const ownerBeforeUpdate: DaemonOwnerEvaluation = {
        kind: 'compatible',
        owner: {
          status: 'running', source: 'state', currentCliVersion: '1.0.0',
          currentPublicReleaseChannel: 'stable', versionMatches: true, releaseChannelMatches: true,
          serviceManaged: true, startupSource: 'background-service',
          state: {
            pid: process.pid, httpPort: 43150, startedAt: Date.now(), startedWithCliVersion: '1.0.0',
            startedWithPublicReleaseChannel: 'stable', startupSource: 'background-service',
            serviceLabel: cli.resolveDaemonServicePaths(runtime).label,
          },
        },
      };
      expect(await planServiceDaemonsRestartAfterUpdate({
        channel: 'stable', ownerBeforeUpdate, includeOtherServices: true,
      })).toMatchObject({ plan: { kind: 'unmanaged' }, otherLabels: [], restart: null });
      const ownPlan = planDaemonServiceInstall({
        platform, mode: 'user', channel: 'stable', targetMode: 'default-following',
        instanceId: runtime.instanceId, activeServerId: runtime.activeServerId,
        userHomeDir, happierHomeDir, nodePath: process.execPath, entryPath: '/opt/happier/index.mjs',
        uid: 501, serverUrl: runtime.serverUrl, webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl, autostart: 'on-demand',
      });
      if (platform === 'win32') {
        const localDefinition = ownPlan.files[0]!;
        mkdirSync(dirname(localDefinition.path), { recursive: true });
        writeFileSync(localDefinition.path, localDefinition.content);
        // An old valid local wrapper cannot authorize an unrelated registered job.
        writeFileSync(definition.path, 'Write-Output "unrelated scheduled task"');
        for (const action of ['stop', 'start', 'restart', 'uninstall'] as const) {
          await expect(cli.runDaemonServiceCliCommand({ argv: [action, '--json', '--dry-run'] }))
            .rejects.toMatchObject({ code: 'foreign_home_service' });
        }
      }
      // On Windows the registered wrapper remains authoritative over a local candidate.
      writeFileSync(definition.path, ownPlan.files[0]!.content);
      expect(cli.resolveDaemonServiceInstallationSnapshotFromEnv()).toMatchObject({ installed: true, autostart: 'on-demand' });
      expect(await planServiceDaemonsRestartAfterUpdate({
        channel: 'stable', ownerBeforeUpdate, includeOtherServices: false,
      })).toMatchObject({ plan: { kind: 'restart' } });
    });
  });
});
