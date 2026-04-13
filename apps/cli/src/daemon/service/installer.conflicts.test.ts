import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import { withTempDir } from '../../testkit/fs/tempDir';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type TestDaemonServicePlan = Readonly<{
  files: Array<Readonly<{ path: string; content: string; mode: number }>>;
  commands: Array<Readonly<{ cmd: string; args: readonly string[] }>>;
}>;

const {
  planDaemonServiceInstallMock,
  planDaemonServiceUninstallMock,
  applyDaemonServiceInstallPlanMock,
  applyDaemonServiceUninstallPlanMock,
  resolveDaemonServiceInstallRuntimeTargetMock,
  discoverInstalledDaemonServiceEntriesMock,
} = vi.hoisted(() => ({
  planDaemonServiceInstallMock: vi.fn<() => TestDaemonServicePlan>(() => ({ files: [], commands: [] })),
  planDaemonServiceUninstallMock: vi.fn(() => ({ filesToRemove: [], commands: [] })),
  applyDaemonServiceInstallPlanMock: vi.fn(async () => undefined),
  applyDaemonServiceUninstallPlanMock: vi.fn(async () => undefined),
  resolveDaemonServiceInstallRuntimeTargetMock: vi.fn(async () => ({
    nodePath: '/managed/node',
    entryPath: '/opt/happier/package-dist/index.mjs',
  })),
  discoverInstalledDaemonServiceEntriesMock: vi.fn<() => Promise<readonly InstalledDaemonServiceEntry[]>>(async () => []),
}));

vi.mock('./plan', async () => {
  const actual = await vi.importActual<typeof import('./plan')>('./plan');
  return {
    ...actual,
    planDaemonServiceInstall: planDaemonServiceInstallMock,
    planDaemonServiceUninstall: planDaemonServiceUninstallMock,
  };
});

vi.mock('./apply', async () => {
  const actual = await vi.importActual<typeof import('./apply')>('./apply');
  return {
    ...actual,
    applyDaemonServiceInstallPlan: applyDaemonServiceInstallPlanMock,
    applyDaemonServiceUninstallPlan: applyDaemonServiceUninstallPlanMock,
  };
});

vi.mock('./resolveDaemonServiceInstallRuntimeTarget', () => ({
  resolveDaemonServiceInstallRuntimeTarget: resolveDaemonServiceInstallRuntimeTargetMock,
}));

vi.mock('./discoverInstalledDaemonServiceEntries', () => ({
  discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
}));

describe('installDaemonService conflict handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('defaults installs to the default-following target mode', async () => {
    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      instanceId: 'cloud',
      runCommands: false,
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledWith(expect.objectContaining({
      targetMode: 'default-following',
    }));
  });

  it('treats an existing implicit stable default-following service as the exact target', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      instanceId: 'default',
      runCommands: false,
    });

      expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
      expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('does not treat a same-lane default-following service from another Happier home as the exact target', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier-old',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      instanceId: 'default',
      strategy: 'add',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('defaults uninstalls to the default-following target mode', async () => {
    const { uninstallDaemonService } = await import('./installer');

    await uninstallDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      instanceId: 'cloud',
      runCommands: false,
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      targetMode: 'default-following',
    }));
  });

  it('keeps the exact target idempotent when the installed definition contents already match', async () => {
    await withTempDir('happier-daemon-install-conflict-match-', async (root) => {
      const installedPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.default.service');
      mkdirSync(join(root, '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(installedPath, 'expected installed service contents\n', 'utf8');

      discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
        {
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: installedPath,
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        },
      ]);
      planDaemonServiceInstallMock.mockReturnValueOnce({
        files: [{ path: installedPath, content: 'expected installed service contents\n', mode: 0o644 }],
        commands: [],
      });

      const { installDaemonService } = await import('./installer');

      await expect(installDaemonService({
        platform: 'linux',
        uid: 123,
        userHomeDir: '/home/tester',
        happierHomeDir: '/home/tester/.happier',
        channel: 'stable',
        targetMode: 'default-following',
        instanceId: 'default',
        runCommands: false,
      })).resolves.toBeUndefined();

      expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
      expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
    });
  });

  it('keeps a system install from treating a user-scoped linux service as the exact target', async () => {
    await withTempDir('happier-daemon-install-conflict-mode-', async (root) => {
      const installedPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.default.service');
      mkdirSync(join(root, '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(installedPath, 'expected installed service contents\n', 'utf8');

      discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
        {
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: installedPath,
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        },
      ]);
      planDaemonServiceInstallMock.mockReturnValueOnce({
        files: [{ path: '/etc/systemd/system/happier-daemon.default.service', content: 'expected installed service contents\n', mode: 0o644 }],
        commands: [],
      });

      const { installDaemonService } = await import('./installer');

      await installDaemonService({
        platform: 'linux',
        mode: 'system',
        systemUser: 'happier',
        uid: 123,
        userHomeDir: '/home/tester',
        happierHomeDir: '/home/tester/.happier',
        instanceId: 'default',
        runCommands: false,
      });

      expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
      expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
    });
  });

  it('refreshes a stale installed definition instead of treating it as the exact target', async () => {
    await withTempDir('happier-daemon-install-conflict-stale-', async (root) => {
      const installedPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.default.service');
      mkdirSync(join(root, '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(installedPath, 'stale installed service contents\n', 'utf8');

      discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
        {
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: installedPath,
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        },
      ]);
      planDaemonServiceInstallMock.mockReturnValueOnce({
        files: [{ path: installedPath, content: 'fresh installed service contents\n', mode: 0o644 }],
        commands: [],
      });

      const { installDaemonService } = await import('./installer');

      await installDaemonService({
        platform: 'linux',
        uid: 123,
        userHomeDir: '/home/tester',
        happierHomeDir: '/home/tester/.happier',
        instanceId: 'default',
        runCommands: false,
      });

      expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
      expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
    });
  });

  it('removes competing services without reinstalling the exact target when replace-all is requested', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'publicdev',
        label: 'happier-daemon.dev.default',
        targetMode: 'default-following',
      },
      {
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.company.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.company',
        targetMode: 'pinned',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledTimes(1);
    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'stable',
      targetMode: 'pinned',
      instanceId: 'company',
    }));
    expect(applyDaemonServiceUninstallPlanMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceUninstallPlanMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runCommands: true,
        commandFailureMode: 'strict',
      }),
    );
    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });
});
