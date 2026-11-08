import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import { renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';
import { spawnStoppableHttpDaemon } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

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
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
] as const;

type SpawnCall = Readonly<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; windowsHide: boolean | undefined }>;

async function loadWithSpawnRecorder(options: Readonly<{ onRestart?: (env: NodeJS.ProcessEnv | undefined) => void; status?: number }> = {}): Promise<Readonly<{
  calls: SpawnCall[];
  restart: (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; beforeRestart?: () => void; onUnowned?: (message: string) => void }>) => Promise<unknown>;
  writeDaemonState: typeof import('@/persistence').writeDaemonState;
  writeServerDaemonState: (serverId: string, state: Record<string, unknown>) => void;
  installService: (params: Readonly<{ targetMode: 'default-following' | 'pinned'; serverId?: string; launcher?: readonly string[] }>) => string;
  serviceLabel: string;
}>> {
  const calls: SpawnCall[] = [];
  const tasks = new Map<string, string>();
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
      ...actual,
      spawnSync: vi.fn((command: string, args: readonly string[] = [], spawnOptions?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
        calls.push({ command, args, env: spawnOptions?.env, windowsHide: spawnOptions?.windowsHide });
        if (command === 'powershell.exe') return { status: 0, stdout: JSON.stringify([...tasks.keys()]), stderr: '' };
        if (command === 'schtasks') {
          const task = tasks.get(String(args[args.indexOf('/TN') + 1]));
          return { status: task ? 0 : 1, stdout: task ? `<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>-File &quot;${task}&quot;</Arguments></Exec></Actions></Task>` : '', stderr: '' };
        }
        if (args.join(' ') === 'daemon service restart') options.onRestart?.(spawnOptions?.env);
        return { status: options.status ?? 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      }),
    };
  });
  const [
    { planServiceDaemonsRestartAfterUpdate },
    { writeDaemonState },
    { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
    { planDaemonServiceInstall },
    { configuration },
  ] = await Promise.all([
    import('./restartServiceDaemonAfterUpdate'),
    import('@/persistence'),
    import('@/daemon/service/cli'),
    import('@/daemon/service/plan'),
    import('@/configuration'),
  ]);
  const serviceLabel = resolveDaemonServicePaths(resolveDaemonServiceCliRuntimeFromEnv({
    channel: 'stable',
    targetMode: 'default-following',
  })).label;
  const installService = (params: Readonly<{ targetMode: 'default-following' | 'pinned'; serverId?: string; launcher?: readonly string[] }>) => {
    const serverId = params.serverId ?? 'default';
    const windows = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM === 'win32';
    const label = `happier-daemon.${serverId}`;
    const plan = windows ? { files: [{
      path: join(configuration.happyHomeDir, 'services', `${label}.ps1`),
      content: renderWindowsScheduledTaskWrapperPs1({
        workingDirectory: String(process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR),
        programArgs: [...(params.launcher ?? ['/user/own/happier.exe']), 'daemon', 'start-sync', '--takeover'],
        env: { HAPPIER_HOME_DIR: configuration.happyHomeDir, HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service', HAPPIER_DAEMON_SERVICE_TARGET_MODE: params.targetMode, HAPPIER_DAEMON_SERVICE_AUTOSTART: 'on-demand', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop', HAPPIER_ACTIVE_SERVER_ID: serverId, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable' },
      }),
    }] } : planDaemonServiceInstall({
      platform: 'linux',
      channel: 'stable',
      targetMode: params.targetMode,
      instanceId: serverId,
      activeServerId: serverId,
      userHomeDir: String(process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR),
      happierHomeDir: configuration.happyHomeDir,
      serverUrl: `https://${serverId}.example.test`,
      webappUrl: `https://${serverId}.example.test`,
      publicServerUrl: `https://${serverId}.example.test`,
      nodePath: '/usr/local/bin/happier',
      entryPath: '',
    });
    const file = plan.files[0]!;
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf-8');
    if (windows) tasks.set(`Happier\\${label}`, file.path);
    return resolveDaemonServicePaths(resolveDaemonServiceCliRuntimeFromEnv({
      channel: 'stable',
      targetMode: params.targetMode,
      instanceId: serverId,
    })).label;
  };
  const writeServerDaemonState = (serverId: string, state: Record<string, unknown>) => {
    const dir = join(configuration.serversDir, serverId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.state.json'), JSON.stringify(state), 'utf-8');
  };
  // The update's two halves, as `self update` composes them: plan from what ran before the update,
  // then (after whatever the update stopped) restart onto the installed CLI and prove the version.
  const restart = async (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; beforeRestart?: () => void; onUnowned?: (message: string) => void }>) => {
    const plan = await planServiceDaemonsRestartAfterUpdate({
      channel: params.channel,
      ...(params.onUnowned ? { reportUnownedRestartFailure: params.onUnowned } : {}),
    });
    if (!plan.restart) return { kind: 'none', unmanagedMessage: plan.unmanagedMessage };
    params.beforeRestart?.();
    await plan.restart({ expectedVersion: params.updatedToVersion, phase: 'activated' });
    return { kind: 'restarted', labels: plan.labels };
  };
  return { calls, restart, writeDaemonState, writeServerDaemonState, installService, serviceLabel };
}

describe('service daemon restart after an update', { timeout: 240_000 }, () => {
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
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined,
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
    });
  }

  const serviceState = (version: string, label: string | undefined, pid = process.pid) => ({
    pid,
    httpPort: 43150,
    startedAt: Date.now(),
    startedWithCliVersion: version,
    startedWithPublicReleaseChannel: 'stable' as const,
    startupSource: label ? 'background-service' as const : 'manual' as const,
    ...(label ? { serviceLabel: label } : {}),
  });

  it('refuses update planning when an installed service publication has unverified authenticated presence', async () => {
    await withTempDir('happier-self-update-unverified-service-', async (homeDir) => {
      patchHome(homeDir);
      const { restart, writeDaemonState, installService } = await loadWithSpawnRecorder();
      const label = installService({ targetMode: 'default-following' });
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 500, { controlToken: 'owned-token', pingStatus: 500 });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        writeDaemonState({ ...serviceState('1.0.0', label, child.pid), httpPort: port, controlToken: 'owned-token' });
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(restart({ channel: 'stable', updatedToVersion: '1.1.0' })).rejects.toThrow(/unverified/);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it('restarts the channel service daemon through the updated binary so it runs the new version', async () => {
    await withTempDir('happier-self-update-restart-service-', async (homeDir) => {
      patchHome(homeDir);
      let defaultLabel = '';
      const { calls, restart, writeDaemonState, installService } = await loadWithSpawnRecorder({
        onRestart: () => writeDaemonState(serviceState('1.1.0', defaultLabel)),
      });
      defaultLabel = installService({ targetMode: 'default-following' });
      writeDaemonState(serviceState('1.0.0', defaultLabel));

      const result = await restart({ channel: 'stable', updatedToVersion: '1.1.0' });

      expect(result).toEqual({ kind: 'restarted', labels: [defaultLabel] });
      const restartCall = calls.find((call) => call.args.join(' ') === 'daemon service restart');
      expect(restartCall?.command).toMatch(/[\\/]cli[\\/]current[\\/]happier(?:\.exe)?$/);
      expect(restartCall?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE).toBe('default-following');
    });
  });

  it('restarts every relay\'s service daemon observed before an update that stopped them all (Windows quiesce)', async () => {
    await withTempDir('happier-self-update-restart-every-relay-', async (homeDir) => {
      patchHome(homeDir);
      const labels = { default: '', company: '' };
      const { calls, restart, writeServerDaemonState, installService } = await loadWithSpawnRecorder({
        onRestart: (env) => {
          const pinned = env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE === 'pinned';
          writeServerDaemonState(pinned ? String(env?.HAPPIER_ACTIVE_SERVER_ID) : 'cloud', serviceState('1.1.0', pinned ? labels.company : labels.default));
        },
      });
      labels.default = installService({ targetMode: 'default-following' });
      labels.company = installService({ targetMode: 'pinned', serverId: 'company' });
      writeServerDaemonState('cloud', serviceState('1.0.0', labels.default));
      writeServerDaemonState('company', serviceState('1.0.0', labels.company));

      const result = await restart({
        channel: 'stable',
        updatedToVersion: '1.1.0',
        // Windows `self update` stops every daemon of the payload before activating.
        beforeRestart: () => {
          writeServerDaemonState('cloud', serviceState('1.0.0', labels.default, 999_999));
          writeServerDaemonState('company', serviceState('1.0.0', labels.company, 999_999));
        },
      });

      expect(result).toEqual({ kind: 'restarted', labels: [labels.default, labels.company] });
      const restartEnvs = calls.filter((call) => call.args.join(' ') === 'daemon service restart').map((call) => call.env);
      expect(restartEnvs).toHaveLength(2);
      expect(restartEnvs[1]).toMatchObject({
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
        HAPPIER_ACTIVE_SERVER_ID: 'company',
      });
      expect(restartEnvs[0]?.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
    });
  });

  it.each(['external', 'managed'] as const)('repairs a legacy Windows action through install before restart while preserving pinned ownership (%s)', async (ownership) => {
    await withTempDir('happier-self-update-legacy-windows-', async (homeDir) => {
      patchHome(homeDir);
      envScope.patch({ HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32' });
      let label = '';
      const { calls, restart, installService, writeServerDaemonState } = await loadWithSpawnRecorder({
        onRestart: () => writeServerDaemonState('company', serviceState('1.1.0', label)),
      });
      const installation = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv: process.env });
      const oldBinary = join(installation.versionsDir, '0.2.17', 'happier.exe');
      const launcher = ownership === 'managed' ? [oldBinary] : ['/user/node.exe', '/user/cli.mjs'];
      label = installService({ targetMode: 'pinned', serverId: 'company', launcher });
      writeServerDaemonState('company', serviceState('1.0.0', label));
      await restart({ channel: 'stable', updatedToVersion: '1.1.0' });
      const controls = calls.filter((call) => call.args[0] === 'daemon');
      expect(controls.map((call) => call.args)).toEqual([['daemon', 'service', 'install', '--preserve-desktop-ownership'], ['daemon', 'service', 'restart']]);
      expect(controls.map((call) => call.windowsHide)).toEqual([true, true]);
      expect(controls[0]?.env).toMatchObject({
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company', HAPPIER_ACTIVE_SERVER_ID: 'company',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: ownership === 'managed' ? installation.binaryPath : launcher[0],
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: ownership === 'managed' ? '' : launcher[1],
      });
      // Compose the public installer preview with the arguments passed to the updated CLI.
      // The definition, rather than this update consumer, owns autostart and desktop metadata.
      const { previewDaemonServiceInstall } = await import('@/daemon/service/installer');
      const preview = await previewDaemonServiceInstall({
        platform: 'win32', mode: 'user', channel: 'stable', targetMode: 'pinned', instanceId: 'company', activeServerId: 'company',
        userHomeDir: homeDir, happierHomeDir: join(homeDir, '.happier'),
        nodePath: controls[0]?.env?.HAPPIER_DAEMON_SERVICE_NODE_PATH,
        entryPath: controls[0]?.env?.HAPPIER_DAEMON_SERVICE_ENTRY_PATH,
      });
      expect(preview.autostart).toBe('on-demand');
      expect(preview.plan.files[0]?.content).toContain('$env:HAPPIER_DAEMON_SERVICE_MANAGED_BY = "desktop"');
      const { readDaemonServiceDefinitionLauncher } = await import('@/daemon/service/readDaemonServiceDefinitionLauncher');
      expect(readDaemonServiceDefinitionLauncher({ platform: 'win32', contents: preview.plan.files[0]!.content })).toEqual(ownership === 'managed' ? [installation.binaryPath] : launcher);
      expect(preview.plan.commands.some((command) => command.args.some((arg) => arg.includes('<LogonTrigger>')))).toBe(false);
    });
  });

  it.each(['bare-token', 'wrapper'] as const)('reports a custom Windows launcher prefix without rewriting it (%s)', async (kind) => {
    await withTempDir('happier-self-update-custom-windows-', async (homeDir) => {
      patchHome(homeDir);
      envScope.patch({ HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32' });
      let label = '';
      const { calls, restart, installService, writeServerDaemonState } = await loadWithSpawnRecorder({
        onRestart: () => writeServerDaemonState('company', serviceState('1.1.0', label)),
      });
      const installation = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', channel: 'stable', processEnv: process.env });
      label = installService({ targetMode: 'pinned', serverId: 'company', launcher: kind === 'wrapper'
        ? ['/user/wrapper.exe', join(installation.versionsDir, '0.2.17', 'happier.exe')]
        : ['/user/cli.exe', '--custom', 'value'] });
      const path = join(homeDir, '.happier/services/happier-daemon.company.ps1');
      if (kind === 'bare-token') writeFileSync(path, readFileSync(path, 'utf8').replace('"--custom"', '--custom'));
      const originalDefinition = readFileSync(path, 'utf8');
      writeServerDaemonState('company', serviceState('1.0.0', label));
      const warnings: string[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { warnings.push(String(chunk)); return true; });
      try {
        await restart({ channel: 'stable', updatedToVersion: '1.1.0' });
        expect(calls.filter((call) => call.args[0] === 'daemon').map((call) => call.args)).toEqual([['daemon', 'service', 'restart']]);
        expect(warnings.join('')).toMatch(/repair.*Windows.*launcher|Windows.*launcher.*repair/i);
        expect(readFileSync(path, 'utf8')).toBe(originalDefinition);
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it('keeps the update when a pinned service the user installed does not come back, naming the command that restarts exactly it', async () => {
    await withTempDir('happier-self-update-restart-user-owned-', async (homeDir) => {
      patchHome(homeDir);
      const labels = { default: '', company: '' };
      const unowned: string[] = [];
      const { restart, writeServerDaemonState, installService } = await loadWithSpawnRecorder({
        // Only the default-following daemon comes back; the user's `company` service keeps the old version.
        onRestart: (env) => {
          if (env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE !== 'pinned') writeServerDaemonState('cloud', serviceState('1.1.0', labels.default));
        },
      });
      labels.default = installService({ targetMode: 'default-following' });
      labels.company = installService({ targetMode: 'pinned', serverId: 'company' });
      writeServerDaemonState('cloud', serviceState('1.0.0', labels.default));
      writeServerDaemonState('company', serviceState('1.0.0', labels.company));

      const result = await restart({ channel: 'stable', updatedToVersion: '1.1.0', onUnowned: (message) => unowned.push(message) });

      expect(result).toEqual({ kind: 'restarted', labels: [labels.default, labels.company] });
      expect(unowned).toHaveLength(1);
      expect(unowned[0]).toMatch(/the update was kept\. Start it with: \S+ --server company service restart --instance=company$/);
    });
  });

  it('leaves a manual daemon and another channel\'s service daemon running', async () => {
    await withTempDir('happier-self-update-restart-skip-', async (homeDir) => {
      patchHome(homeDir);
      const { calls, restart, writeDaemonState, installService } = await loadWithSpawnRecorder();
      const defaultLabel = installService({ targetMode: 'default-following' });
      writeDaemonState(serviceState('1.0.0', undefined));
      expect(await restart({ channel: 'stable', updatedToVersion: '1.1.0' })).toEqual({ kind: 'none', unmanagedMessage: null });

      writeDaemonState(serviceState('1.0.0', defaultLabel));
      expect(await restart({ channel: 'preview', updatedToVersion: '1.1.0-preview.1' })).toEqual({ kind: 'none', unmanagedMessage: null });
      expect(calls.some((call) => call.args.join(' ') === 'daemon service restart')).toBe(false);
    });
  });

  it('fails when the restarted service does not run the expected version, so the update can roll back', async () => {
    await withTempDir('happier-self-update-restart-unproven-', async (homeDir) => {
      patchHome(homeDir);
      const { restart, writeDaemonState, installService } = await loadWithSpawnRecorder();
      const defaultLabel = installService({ targetMode: 'default-following' });
      writeDaemonState(serviceState('1.0.0', defaultLabel));
      // `daemon service restart` exited 0, but the owner still runs the old version.
      await expect(restart({ channel: 'stable', updatedToVersion: '1.1.0' })).rejects.toThrow(/runs 1\.0\.0 instead of 1\.1\.0/);
    });
  });
});
