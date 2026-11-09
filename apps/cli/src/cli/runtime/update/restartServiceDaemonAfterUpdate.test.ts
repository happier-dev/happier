import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { spawnDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import { renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

let daemonOwner: ReturnType<typeof spawnDaemonLifecycleOwner> | undefined;

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
  'HAPPIER_FIRST_PARTY_INSTALL_HOME',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_AUTOSTART',
  'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
  'HAPPIER_DAEMON_SERVICE_BUNDLE_ID',
] as const;

type SpawnCall = Readonly<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; windowsHide?: boolean }>;

async function loadWithSpawnRecorder(options: Readonly<{ onRestart?: (env: NodeJS.ProcessEnv | undefined) => void; status?: number; legacyLauncher?: readonly string[]; installStatus?: number }> = {}): Promise<Readonly<{
  calls: SpawnCall[];
  restart: (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; ownerBeforeUpdate?: DaemonOwnerEvaluation }>) => Promise<unknown>;
  writeDaemonState: typeof import('@/persistence').writeDaemonState;
  serviceLabel: string;
  daemonPid: number;
  installWindowsService: (instanceId: string, launcher: readonly string[]) => string;
}>> {
  const calls: SpawnCall[] = [];
  const tasks = new Map<string, string>();
  daemonOwner = spawnDaemonLifecycleOwner();
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
      ...actual,
      spawnSync: vi.fn((command: string, args: readonly string[] = [], spawnOptions?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
        calls.push({ command, args, env: spawnOptions?.env, windowsHide: spawnOptions?.windowsHide });
        if (command === 'powershell.exe') return { status: 0, stdout: args.some((arg) => arg.includes('.GetFolder(')) ? JSON.stringify([...tasks.keys()]) : '{"exists":true,"active":true,"enabled":true}', stderr: '' };
        if (command === 'schtasks') {
          const wrapper = tasks.get(String(args[args.indexOf('/TN') + 1]));
          return { status: wrapper ? 0 : 1, stdout: wrapper ? `<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>-File &quot;${wrapper}&quot;</Arguments></Exec></Actions></Task>` : '', stderr: '' };
        }
        if (args[0] === 'service' && args[1] === 'install') return { status: options.installStatus ?? 0, stdout: '', stderr: '' };
        if (args.join(' ') === 'service restart') options.onRestart?.(spawnOptions?.env);
        return { status: options.status ?? 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      }),
    };
  });
  // These owners import one another. Load their common update entrypoint
  // before reading companion namespaces instead of racing cold module graphs.
  const { planServiceDaemonRestartAfterUpdate, restartServiceDaemonOntoInstalledCli } =
    await import('./restartServiceDaemonAfterUpdate');
  const { writeDaemonState } = await import('@/persistence');
  const { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } =
    await import('@/daemon/service/cli');
  const { evaluateCurrentDaemonOwner } = await import('@/daemon/ownership/evaluateCurrentDaemonOwner');
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    channel: 'stable',
    targetMode: 'default-following',
  });
  const serviceLabel = resolveDaemonServicePaths(runtime).label;
  const { planDaemonServiceInstall, resolveDaemonServiceLaunchdLabel } = await import('@/daemon/service/plan');
  // Owner metadata describes the prior process; only its installed same-home definition
  // authorizes the update to restart that global service name.
  const installWindowsService = (instanceId: string, launcher: readonly string[]) => {
    const label = `happier-daemon.${instanceId}`;
    const targetMode = instanceId === 'default' ? 'default-following' : 'pinned';
    const daemonLabel = resolveDaemonServiceLaunchdLabel(instanceId, 'stable', targetMode);
    const path = join(runtime.happierHomeDir, 'services', `${label}.ps1`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: runtime.userHomeDir,
      programArgs: [...launcher, 'daemon', 'start-sync', '--takeover'],
      env: {
        HAPPIER_HOME_DIR: runtime.happierHomeDir, HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: targetMode, HAPPIER_DAEMON_SERVICE_LABEL: daemonLabel,
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: instanceId, HAPPIER_ACTIVE_SERVER_ID: instanceId === 'default' ? 'cloud' : instanceId,
        HAPPIER_DAEMON_SERVICE_AUTOSTART: 'on-demand', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop',
        HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.happier.desktop', HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      },
    }));
    tasks.set(`Happier\\${label}`, path);
    return daemonLabel;
  };
  if (runtime.platform === 'win32') {
    installWindowsService('default', options.legacyLauncher ?? ['/user/happier.exe']);
  } else {
    const definition = planDaemonServiceInstall({
      platform: runtime.platform, channel: runtime.channel, targetMode: runtime.targetMode,
      instanceId: runtime.instanceId, activeServerId: runtime.activeServerId,
      userHomeDir: runtime.userHomeDir, happierHomeDir: runtime.happierHomeDir,
      serverUrl: runtime.serverUrl, webappUrl: runtime.webappUrl, publicServerUrl: runtime.publicServerUrl,
      nodePath: process.execPath, entryPath: '/opt/happier/index.mjs', uid: runtime.uid ?? undefined,
    }).files[0]!;
    mkdirSync(dirname(definition.path), { recursive: true });
    writeFileSync(definition.path, definition.content);
  }
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
  return { calls, restart, writeDaemonState, serviceLabel, daemonPid: daemonOwner.pid, installWindowsService };
}

describe('service daemon restart after an update', { timeout: 300_000 }, () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(async () => {
    if (daemonOwner) {
      expect(await daemonOwner.kill()).toBe(true);
      daemonOwner = undefined;
    }
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
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_FIRST_PARTY_INSTALL_HOME: join(homeDir, 'managed'),
    });
  }

  it('restarts the channel service daemon through the updated binary so it runs the new version', async () => {
    await withTempDir('happier-self-update-restart-service-', async (homeDir) => {
      patchHome(homeDir);
      const writeState = (version: string, label: string) => ({
        pid: daemonPid,
        httpPort: 43150,
        startedAt: Date.now(),
        startedWithCliVersion: version,
        startedWithPublicReleaseChannel: 'stable' as const,
        startupSource: 'background-service' as const,
        serviceLabel: label,
      });
      let restartedLabel = '';
      const { calls, restart, writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder({
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
      const { calls, restart, serviceLabel, writeDaemonState, daemonPid } = await loadWithSpawnRecorder({
        onRestart: () => writeDaemonState({
          pid: daemonPid,
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

  it.each(['managed', 'external'] as const)('repairs legacy Windows actions before restart and preserves their CLI and ownership (%s)', async (kind) => {
    await withTempDir('happier-self-update-windows-migration-', async (homeDir) => {
      patchHome(homeDir);
      envScope.patch({ HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32' });
      const installation = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv: process.env });
      const launcher = kind === 'managed' ? [join(installation.versionsDir, '0.2.17', 'happier.exe')] : ['/user/node.exe', '/user/cli.mjs'];
      const { calls, restart, writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder({
        legacyLauncher: launcher,
        onRestart: () => writeDaemonState({ pid: daemonPid, httpPort: 43150, startedAt: Date.now(), startedWithCliVersion: '1.1.0', startedWithPublicReleaseChannel: 'stable', startupSource: 'background-service', serviceLabel }),
      });
      writeDaemonState({ pid: daemonPid, httpPort: 43150, startedAt: Date.now(), startedWithCliVersion: '1.0.0', startedWithPublicReleaseChannel: 'stable', startupSource: 'background-service', serviceLabel });
      envScope.patch({ HAPPIER_DAEMON_SERVICE_NODE_PATH: '/inherited/wrong', HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '/inherited/wrong.mjs', HAPPIER_DAEMON_SERVICE_AUTOSTART: 'at-login', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop', HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'wrong' });
      const { discoverInstalledDaemonServiceEntries } = await import('@/daemon/service/discoverInstalledDaemonServiceEntries');
      const installed = await discoverInstalledDaemonServiceEntries({ platform: 'win32', mode: 'user', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), serversById: {} });
      expect(installed).toEqual([expect.objectContaining({ serverId: 'default', targetMode: 'default-following', releaseChannel: 'stable', happierHomeDir: join(homeDir, '.happier'), windowsLauncherUpgradeNeeded: true })]);
      await restart({ channel: 'stable', updatedToVersion: '1.1.0' });
      const controls = calls.filter((call) => call.args[0] === 'service');
      expect(controls.map((call) => call.args)).toEqual([['service', 'install', '--preserve-desktop-ownership'], ['service', 'restart']]);
      expect(controls.map((call) => call.windowsHide)).toEqual([true, true]);
      expect(controls[0]?.env).toMatchObject({ HAPPIER_DAEMON_SERVICE_NODE_PATH: kind === 'managed' ? installation.binaryPath : launcher[0], HAPPIER_DAEMON_SERVICE_ENTRY_PATH: kind === 'managed' ? '' : launcher[1] });
      const { previewDaemonServiceInstall } = await import('@/daemon/service/installer');
      const preview = await previewDaemonServiceInstall({ platform: 'win32', mode: 'user', channel: 'stable', targetMode: 'default-following', instanceId: 'default', activeServerId: 'cloud', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), nodePath: controls[0]?.env?.HAPPIER_DAEMON_SERVICE_NODE_PATH, entryPath: controls[0]?.env?.HAPPIER_DAEMON_SERVICE_ENTRY_PATH });
      expect(preview.plan.files[0]?.content).toContain('$env:HAPPIER_DAEMON_SERVICE_AUTOSTART = "on-demand"');
      expect(preview.plan.files[0]?.content).toContain('$env:HAPPIER_DAEMON_SERVICE_MANAGED_BY = "desktop"');
      expect(preview.plan.files[0]?.content).toContain('$env:HAPPIER_DAEMON_SERVICE_BUNDLE_ID = "dev.happier.desktop"');
      expect(preview.plan.commands.some((command) => command.args.some((arg) => arg.includes('<LogonTrigger>')))).toBe(false);
    });
  });

  it('leaves custom Windows wrapper prefixes intact with a repair warning', async () => {
    await withTempDir('happier-self-update-custom-windows-', async (homeDir) => {
      patchHome(homeDir);
      envScope.patch({ HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32' });
      const installation = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv: process.env });
      const { calls, restart, writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder({
        legacyLauncher: ['/user/wrapper.exe', join(installation.versionsDir, '0.2.17', 'happier.exe')],
        onRestart: () => writeDaemonState({ pid: daemonPid, httpPort: 43150, startedAt: Date.now(), startedWithCliVersion: '1.1.0', startedWithPublicReleaseChannel: 'stable', startupSource: 'background-service', serviceLabel }),
      });
      const path = join(homeDir, '.happier/services/happier-daemon.default.ps1');
      const before = readFileSync(path, 'utf8');
      writeDaemonState({ pid: daemonPid, httpPort: 43150, startedAt: Date.now(), startedWithCliVersion: '1.0.0', startedWithPublicReleaseChannel: 'stable', startupSource: 'background-service', serviceLabel });
      const warnings: string[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { warnings.push(String(chunk)); return true; });
      try {
        await restart({ channel: 'stable', updatedToVersion: '1.1.0' });
        expect(calls.filter((call) => call.args[0] === 'service').map((call) => call.args)).toEqual([['service', 'restart']]);
        expect(warnings.join('')).toMatch(/Windows.*launcher.*repair/i);
        expect(readFileSync(path, 'utf8')).toBe(before);
      } finally { stderr.mockRestore(); }
    });
  });

  it('leaves a manual daemon and another channel\'s service daemon running', async () => {
    await withTempDir('happier-self-update-restart-skip-', async (homeDir) => {
      patchHome(homeDir);
      const { calls, restart, writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: daemonPid,
        httpPort: 43151,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'manual',
      });
      expect(await restart({ channel: 'stable', updatedToVersion: '1.1.0' })).toEqual({ kind: 'skip', reason: 'not-service-managed' });

      writeDaemonState({
        pid: daemonPid,
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
      const { restart, writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: daemonPid,
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
          pid: daemonPid,
          httpPort: 43160,
          startedAt: Date.now(),
          startedWithCliVersion: version,
          startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service',
          serviceLabel: label,
        }), 'utf-8');
      };

      let defaultLabel = '';
      const { calls, writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder({
        onRestart: (env) => {
          // The default service and `personal` come back on the new version; `company` does not.
          if (env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID === 'personal') writeServerDaemonState('personal', '1.1.0', personalLabel);
          else if (env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE === 'default-following') writeServerDaemonState('cloud', '1.1.0', defaultLabel);
        },
      });
      defaultLabel = serviceLabel;
      writeDaemonState({
        pid: daemonPid,
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

  it.each([0, 23])('repairs another Windows service through its own scope and preserves repair failure (%s)', async (installStatus) => {
    await withTempDir('happier-self-update-other-windows-', async (homeDir) => {
      patchHome(homeDir);
      envScope.patch({ HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32' });
      const writeState = (version: string, label: string) => {
        const path = join(homeDir, '.happier', 'servers', 'personal', 'daemon.state.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ pid: daemonPid, httpPort: 43163, startedAt: Date.now(),
          startedWithCliVersion: version, startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service', serviceLabel: label,
        }));
      };
      let label = '';
      const { calls, daemonPid, installWindowsService } = await loadWithSpawnRecorder({
        installStatus, onRestart: () => writeState('1.1.0', label),
      });
      label = installWindowsService('personal', [join(homeDir, 'managed', 'cli', 'versions', '1.0.0', 'happier.exe')]);
      writeState('1.0.0', label);
      const { readDaemonStateForServerId } = await import('@/daemon/multiDaemon');
      expect(await readDaemonStateForServerId('personal')).toMatchObject({ running: true, state: { serviceLabel: label } });
      const { discoverInstalledDaemonServiceEntries } = await import('@/daemon/service/discoverInstalledDaemonServiceEntries');
      expect(await discoverInstalledDaemonServiceEntries({ platform: 'win32', mode: 'user', userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'), serversById: {} })).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: 'personal', releaseChannel: 'stable', happierHomeDir: join(homeDir, '.happier'), targetMode: 'pinned' })]));
      const { planServiceDaemonsRestartAfterUpdate } = await import('./restartServiceDaemonAfterUpdate');
      const planned = await planServiceDaemonsRestartAfterUpdate({
        channel: 'stable', ownerBeforeUpdate: { kind: 'none' }, includeOtherServices: true,
      });
      expect(planned.otherLabels).toEqual([label]);
      const result = planned.restart!({ expectedVersion: '1.1.0', phase: 'activated' });
      if (installStatus === 0) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow(/launcher repair failed/);
      const serviceCalls = calls.filter((call) => call.args[0] === 'service');
      expect(serviceCalls.map((call) => call.args)).toEqual(installStatus === 0
        ? [['service', 'install', '--preserve-desktop-ownership'], ['service', 'restart']] : [['service', 'install', '--preserve-desktop-ownership']]);
      expect(serviceCalls.every((call) => call.windowsHide && call.env?.HAPPIER_ACTIVE_SERVER_ID === 'personal'
        && call.env?.HAPPIER_DAEMON_SERVICE_INSTANCE_ID === 'personal')).toBe(true);
    });
  });

  it('leaves other servers\' service daemons alone when the update did not stop them', async () => {
    await withTempDir('happier-self-update-restart-own-only-', async (homeDir) => {
      patchHome(homeDir);
      const { writeDaemonState, serviceLabel, daemonPid } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: daemonPid,
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
