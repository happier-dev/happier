import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { DaemonServiceInstallPlan } from './plan';
import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';

type InstalledServiceIdentity = Pick<InstalledDaemonServiceEntry, 'label' | 'path' | 'serverId' | 'activeServerId'>;

type Preview = Readonly<{
  ok: boolean;
  plan: DaemonServiceInstallPlan;
  installConflict?: Readonly<{
    blocking: boolean;
    competingServices: readonly InstalledServiceIdentity[];
    servicesToRemove: readonly InstalledServiceIdentity[];
  }>;
}>;

// Only the service manager is outside the process. Files, inventory, conflict
// policy, runtime target resolution and the install planner remain real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') })),
}));

async function withInstallFixture(
  platform: 'linux' | 'darwin',
  run: (cli: typeof import('./cli'), home: string) => Promise<void>,
) {
  await withTempDir('happier-service-install-conflict-', async (home) => {
    const env = createEnvKeyScope([
      'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_DAEMON_SERVICE_PLATFORM',
      'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_SERVICE_INSTANCE_ID', 'HAPPIER_DAEMON_SERVICE_CHANNEL',
      'HAPPIER_DAEMON_SERVICE_TARGET_MODE', 'HAPPIER_DAEMON_SERVICE_NODE_PATH',
      'HAPPIER_DAEMON_SERVICE_ENTRY_PATH', 'HAPPIER_PUBLIC_RELEASE_CHANNEL',
      'HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY',
    ]);
    try {
      env.patch({
        HAPPIER_HOME_DIR: join(home, '.happier'),
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_PLATFORM: platform,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: home,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(home, '.happier'),
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
        HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY: undefined,
      });
      vi.resetModules();
      await run(await import('./cli'), home);
    } finally {
      env.restore();
    }
  });
}

async function installDefinition(
  cli: typeof import('./cli'), channel: 'stable' | 'preview',
  targetMode: 'pinned' | 'default-following',
) {
  const runtime = cli.resolveDaemonServiceCliRuntimeFromEnv({ channel, targetMode, processEnv: process.env });
  const { planDaemonServiceInstall, resolveDaemonServiceSystemdUnitLabel } = await import('./plan');
  const plan = planDaemonServiceInstall({ ...runtime, uid: runtime.uid ?? undefined });
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf8');
  }
  const paths = cli.resolveDaemonServicePaths(runtime);
  return {
    ...paths,
    label: runtime.platform === 'linux'
      ? resolveDaemonServiceSystemdUnitLabel(runtime.instanceId, runtime.channel, runtime.targetMode)
      : paths.label,
  };
}

async function previewInstall(cli: typeof import('./cli'), flags: readonly string[] = []) {
  const output = captureStdoutJsonOutput<Preview>();
  try {
    await cli.runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json', ...flags] });
    return output.json();
  } finally {
    output.restore();
  }
}

describe('runDaemonServiceCliCommand install conflict preflight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
  });

  it('fails closed by default when another verified background service is already installed', async () => {
    await withInstallFixture('linux', async (cli) => {
      const existing = await installDefinition(cli, 'stable', 'pinned');
      const result = await previewInstall(cli);
      expect(result.installConflict).toMatchObject({
        blocking: true,
        competingServices: [expect.objectContaining({
          label: existing.label, path: existing.installedPath,
          serverId: 'default', activeServerId: 'cloud',
        })],
      });
    });
  });

  it('allows explicit add semantics when --yes is provided', async () => {
    await withInstallFixture('linux', async (cli) => {
      const existing = await installDefinition(cli, 'stable', 'pinned');
      const result = await previewInstall(cli, ['--yes']);
      expect(result.installConflict).toMatchObject({
        blocking: false,
        competingServices: [expect.objectContaining({
          label: existing.label, path: existing.installedPath,
          serverId: 'default', activeServerId: 'cloud',
        })],
        servicesToRemove: [],
      });
      expect(result.plan.commands.some(command => command.args.includes('disable') && command.args.includes(existing.unitName))).toBe(false);
    });
  });

  it('plans removal of the competing service when replace-all is explicitly requested', async () => {
    await withInstallFixture('linux', async (cli) => {
      const existing = await installDefinition(cli, 'stable', 'pinned');
      const result = await previewInstall(cli, ['--replace-existing=all', '--yes']);
      expect(result.installConflict).toMatchObject({
        blocking: false,
        servicesToRemove: [expect.objectContaining({
          label: existing.label, path: existing.installedPath,
          serverId: 'default', activeServerId: 'cloud',
        })],
      });
    });
  });

  it('uses the same stale-daemon restart decision for install dry-run planning', async () => {
    await withInstallFixture('darwin', async (cli) => {
      const paths = await installDefinition(cli, 'preview', 'default-following');
      const { writeDaemonState } = await import('@/persistence');
      const owner = spawnSleepyDetachedProcess(['/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync']);
      try {
        await writeDaemonState({
          pid: owner.pid, httpPort: 43122, startedAt: Date.now(),
          startedWithCliVersion: '0.0.0-other', startedWithPublicReleaseChannel: 'dev',
          startupSource: 'background-service', serviceLabel: paths.label,
        });
        const result = await previewInstall(cli);
        expect(result.ok).toBe(true);
        expect(result.plan.commands.some(command => command.args[0] === 'bootstrap')).toBe(true);
      } finally {
        await owner.kill();
      }
    });
  });
});
