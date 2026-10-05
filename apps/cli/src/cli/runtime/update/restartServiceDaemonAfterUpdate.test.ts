import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';

vi.mock('@/daemon/doctor', async (importOriginal) => {
  const [{ withCurrentProcessAsDaemonLifecycleOwner }, actual] = await Promise.all([
    import('@/testkit/process/daemonLifecycleOwner'),
    importOriginal<typeof import('@/daemon/doctor')>(),
  ]);
  return withCurrentProcessAsDaemonLifecycleOwner(actual);
});

const SCOPED_ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
] as const;

type SpawnCall = Readonly<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }>;

async function loadWithSpawnRecorder(options: Readonly<{ onRestart?: (env: NodeJS.ProcessEnv | undefined) => void; status?: number }> = {}): Promise<Readonly<{
  calls: SpawnCall[];
  restart: (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; ownerBeforeUpdate?: DaemonOwnerEvaluation }>) => Promise<unknown>;
  writeDaemonState: typeof import('@/persistence').writeDaemonState;
  serviceLabel: string;
}>> {
  const calls: SpawnCall[] = [];
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
      ...actual,
      spawnSync: vi.fn((command: string, args: readonly string[] = [], spawnOptions?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: spawnOptions?.env });
        if (args.join(' ') === 'service restart') options.onRestart?.(spawnOptions?.env);
        return { status: options.status ?? 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      }),
    };
  });
  const [
    { planServiceDaemonRestartAfterUpdate, restartServiceDaemonOntoInstalledCli },
    { writeDaemonState },
    { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
    { evaluateCurrentDaemonOwner },
  ] = await Promise.all([
    import('./restartServiceDaemonAfterUpdate'),
    import('@/persistence'),
    import('@/daemon/service/cli'),
    import('@/daemon/ownership/evaluateCurrentDaemonOwner'),
  ]);
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    channel: 'stable',
    targetMode: 'default-following',
  });
  const serviceLabel = resolveDaemonServicePaths(runtime).label;
  const { planDaemonServiceInstall } = await import('@/daemon/service/plan');
  // Owner metadata describes the prior process; only its installed same-home definition
  // authorizes the update to restart that global service name.
  const definition = planDaemonServiceInstall({
    platform: runtime.platform, channel: runtime.channel, targetMode: runtime.targetMode,
    instanceId: runtime.instanceId, activeServerId: runtime.activeServerId,
    userHomeDir: runtime.userHomeDir, happierHomeDir: runtime.happierHomeDir,
    serverUrl: runtime.serverUrl, webappUrl: runtime.webappUrl, publicServerUrl: runtime.publicServerUrl,
    nodePath: process.execPath, entryPath: '/opt/happier/index.mjs', uid: runtime.uid ?? undefined,
  }).files[0]!;
  mkdirSync(dirname(definition.path), { recursive: true });
  writeFileSync(definition.path, definition.content);
  // The update's two halves, as `self update` composes them: plan from the owner observed before
  // the update, then restart onto the installed CLI and prove the version.
  const restart = async (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; ownerBeforeUpdate?: DaemonOwnerEvaluation }>) => {
    const plan = planServiceDaemonRestartAfterUpdate({
      channel: params.channel,
      ownerBeforeUpdate: params.ownerBeforeUpdate ?? await evaluateCurrentDaemonOwner(),
    });
    if (plan.kind !== 'restart') return plan;
    await restartServiceDaemonOntoInstalledCli({ plan, expectedVersion: params.updatedToVersion });
    return { kind: 'restarted' };
  };
  return { calls, restart, writeDaemonState, serviceLabel };
}

describe('service daemon restart after an update', { timeout: 300_000 }, () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(SCOPED_ENV_KEYS);
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  function patchHome(homeDir: string): void {
    const happierHomeDir = `${homeDir}/.happier`;
    envScope.patch({
      HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: undefined,
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
    });
  }

  it('restarts the channel service daemon through the updated binary so it runs the new version', async () => {
    await withTempDir('happier-self-update-restart-service-', async (homeDir) => {
      patchHome(homeDir);
      const writeState = (version: string, label: string) => ({
        pid: process.pid,
        httpPort: 43150,
        startedAt: Date.now(),
        startedWithCliVersion: version,
        startedWithPublicReleaseChannel: 'stable' as const,
        startupSource: 'background-service' as const,
        serviceLabel: label,
      });
      let restartedLabel = '';
      const { calls, restart, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder({
        onRestart: () => writeDaemonState(writeState('1.1.0', restartedLabel)),
      });
      restartedLabel = serviceLabel;
      writeDaemonState(writeState('1.0.0', serviceLabel));

      const result = await restart({ channel: 'stable', updatedToVersion: '1.1.0' });

      expect(result).toEqual({ kind: 'restarted' });
      const restartCall = calls.find((call) => call.args.join(' ') === 'service restart');
      expect(restartCall?.command).toMatch(/[\\/]cli[\\/]current[\\/]happier(?:\.exe)?$/);
      expect(restartCall?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE).toBe('default-following');
    });
  });

  it('restarts the service daemon observed before an update that stopped it (Windows quiesce)', async () => {
    await withTempDir('happier-self-update-restart-quiesced-', async (homeDir) => {
      patchHome(homeDir);
      const { calls, restart, serviceLabel, writeDaemonState } = await loadWithSpawnRecorder({
        onRestart: () => writeDaemonState({
          pid: process.pid,
          httpPort: 43153,
          startedAt: Date.now(),
          startedWithCliVersion: '1.1.0',
          startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service',
          serviceLabel,
        }),
      });
      const ownerBeforeUpdate = {
        kind: 'compatible' as const,
        owner: {
          status: 'running' as const,
          source: 'state' as const,
          state: {
            pid: 999999,
            httpPort: 43153,
            startedAt: Date.now(),
            startedWithCliVersion: '1.0.0',
            startedWithPublicReleaseChannel: 'stable' as const,
            startupSource: 'background-service' as const,
            serviceLabel,
          },
          currentCliVersion: '1.0.0',
          currentPublicReleaseChannel: 'stable' as const,
          versionMatches: true,
          releaseChannelMatches: true,
          serviceManaged: true,
          startupSource: 'background-service' as const,
        },
      };

      expect(await restart({ channel: 'stable', updatedToVersion: '1.1.0', ownerBeforeUpdate })).toEqual({ kind: 'restarted' });
      expect(calls.some((call) => call.args.join(' ') === 'service restart')).toBe(true);
    });
  });

  it('leaves a manual daemon and another channel\'s service daemon running', async () => {
    await withTempDir('happier-self-update-restart-skip-', async (homeDir) => {
      patchHome(homeDir);
      const { calls, restart, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: process.pid,
        httpPort: 43151,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'manual',
      });
      expect(await restart({ channel: 'stable', updatedToVersion: '1.1.0' })).toEqual({ kind: 'skip', reason: 'not-service-managed' });

      writeDaemonState({
        pid: process.pid,
        httpPort: 43152,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel,
      });
      expect(await restart({ channel: 'preview', updatedToVersion: '1.1.0-preview.1' })).toEqual({ kind: 'skip', reason: 'other-channel' });
      expect(calls.some((call) => call.args.join(' ') === 'service restart')).toBe(false);
    });
  });
  it('fails when the restarted service does not run the expected version, so the update can roll back', async () => {
    await withTempDir('happier-self-update-restart-unproven-', async (homeDir) => {
      patchHome(homeDir);
      const { restart, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: process.pid,
        httpPort: 43154,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel,
      });
      // `service restart` exited 0, but the owner still runs the old version.
      await expect(restart({ channel: 'stable', updatedToVersion: '1.1.0' })).rejects.toThrow(/runs 1\.0\.0 instead of 1\.1\.0/);
    });
  });

  // One daemon per server (R15): on Windows the update's quiesce stops every daemon of the payload,
  // so each service daemon of this home and ring that was running comes back; only the invoking
  // server's own service judges (and can roll back) the update.
  it('restarts every service daemon the update stopped, and names another server\'s service that does not come back without failing the update', async () => {
    await withTempDir('happier-self-update-restart-all-', async (homeDir) => {
      patchHome(homeDir);
      const happierHomeDir = `${homeDir}/.happier`;
      const profile = (id: string, url: string) => ({ id, name: id, serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
      mkdirSync(happierHomeDir, { recursive: true });
      writeFileSync(join(happierHomeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 6,
        activeServerId: 'cloud',
        servers: {
          cloud: profile('cloud', 'https://api.happier.dev'),
          personal: profile('personal', 'https://personal.example.test'),
          company: profile('company', 'https://company.example.test'),
        },
      }), 'utf-8');
      const { planDaemonServiceInstall, resolveDaemonServiceLaunchdLabel } = await import('@/daemon/service/plan');
      const writeServiceDefinition = (targetMode: 'pinned' | 'default-following', serverId: string, serverUrl: string, managedBy: 'desktop' | null = null) => {
        const file = planDaemonServiceInstall({
          platform: 'linux',
          channel: 'stable',
          targetMode,
          managedBy,
          instanceId: serverId,
          activeServerId: serverId,
          userHomeDir: homeDir,
          happierHomeDir,
          serverUrl,
          webappUrl: serverUrl,
          publicServerUrl: serverUrl,
          nodePath: '/usr/local/bin/happier',
          entryPath: '',
        }).files[0]!;
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content, 'utf-8');
      };
      writeServiceDefinition('default-following', 'default', 'https://api.happier.dev');
      writeServiceDefinition('pinned', 'personal', 'https://personal.example.test', 'desktop');
      writeServiceDefinition('pinned', 'company', 'https://company.example.test');
      const personalLabel = resolveDaemonServiceLaunchdLabel('personal', 'stable', 'pinned');
      const companyLabel = resolveDaemonServiceLaunchdLabel('company', 'stable', 'pinned');
      const writeServerDaemonState = (serverId: string, version: string, label: string) => {
        const path = join(happierHomeDir, 'servers', serverId, 'daemon.state.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({
          pid: process.pid,
          httpPort: 43160,
          startedAt: Date.now(),
          startedWithCliVersion: version,
          startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service',
          serviceLabel: label,
        }), 'utf-8');
      };

      let defaultLabel = '';
      const { calls, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder({
        onRestart: (env) => {
          // The default service and `personal` come back on the new version; `company` does not.
          if (env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID === 'personal') writeServerDaemonState('personal', '1.1.0', personalLabel);
          else if (env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE === 'default-following') writeServerDaemonState('cloud', '1.1.0', defaultLabel);
        },
      });
      defaultLabel = serviceLabel;
      writeDaemonState({
        pid: process.pid,
        httpPort: 43161,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel,
      });
      writeServerDaemonState('personal', '1.0.0', personalLabel);
      writeServerDaemonState('company', '1.0.0', companyLabel);

      const { planServiceDaemonsRestartAfterUpdate } = await import('./restartServiceDaemonAfterUpdate');
      const { evaluateCurrentDaemonOwner } = await import('@/daemon/ownership/evaluateCurrentDaemonOwner');
      const unowned: string[] = [];
      const planned = await planServiceDaemonsRestartAfterUpdate({
        channel: 'stable',
        ownerBeforeUpdate: await evaluateCurrentDaemonOwner(),
        includeOtherServices: true,
        reportUnownedRestartFailure: (message) => unowned.push(message),
      });

      expect(planned.plan.kind).toBe('restart');
      expect([...planned.otherLabels].sort()).toEqual([companyLabel, personalLabel].sort());
      await expect(planned.restart?.({ expectedVersion: '1.1.0', phase: 'activated' })).resolves.toBeUndefined();
      const restarted = calls.filter((call) => call.args.join(' ') === 'service restart');
      expect(restarted.map((call) => call.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE === 'default-following'
        ? 'default-following'
        : call.env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID).sort())
        .toEqual(['company', 'default-following', 'personal'].sort());
      // Each pinned restart is addressed to its own server, never to the invoking scope.
      expect(restarted.find((call) => call.env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID === 'company')?.env?.HAPPIER_ACTIVE_SERVER_ID).toBe('company');
      expect(unowned).toHaveLength(1);
      expect(unowned[0]).toContain(companyLabel);
      expect(unowned[0]).toContain('happier --server company service restart --instance=company');

      // A service the desktop manages is the update's own (with the default-following one): when it
      // does not come back, the step fails naming it, so the transaction rolls back (N7).
      writeServerDaemonState('personal', '1.0.0', personalLabel);
      const replanned = await planServiceDaemonsRestartAfterUpdate({
        channel: 'stable',
        ownerBeforeUpdate: await evaluateCurrentDaemonOwner(),
        includeOtherServices: true,
        reportUnownedRestartFailure: (message) => unowned.push(message),
      });
      writeServerDaemonState('personal', '1.0.0', personalLabel);
      await expect(replanned.restart?.({ expectedVersion: '1.2.0', phase: 'activated' })).rejects.toThrow(personalLabel);
    });
  });

  it('leaves other servers\' service daemons alone when the update did not stop them', async () => {
    await withTempDir('happier-self-update-restart-own-only-', async (homeDir) => {
      patchHome(homeDir);
      const { writeDaemonState, serviceLabel } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: process.pid,
        httpPort: 43162,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel,
      });
      const { planServiceDaemonsRestartAfterUpdate } = await import('./restartServiceDaemonAfterUpdate');
      const { evaluateCurrentDaemonOwner } = await import('@/daemon/ownership/evaluateCurrentDaemonOwner');
      const planned = await planServiceDaemonsRestartAfterUpdate({
        channel: 'stable',
        ownerBeforeUpdate: await evaluateCurrentDaemonOwner(),
        includeOtherServices: false,
        reportUnownedRestartFailure: () => {},
      });
      expect(planned.otherLabels).toEqual([]);
      expect(planned.restart).not.toBeNull();
    });
  });
});
