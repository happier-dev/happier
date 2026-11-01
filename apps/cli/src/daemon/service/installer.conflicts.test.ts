import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createWindowsServiceLauncherPeFixture } from '@/testkit/fs/windowsServiceLauncherFixture';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceInstallPlan } from './plan';

const {
  planDaemonServiceInstallMock,
  planDaemonServiceUninstallMock,
  applyDaemonServiceInstallPlanMock,
  applyDaemonServiceUninstallPlanMock,
  resolveDaemonServiceInstallRuntimeTargetMock,
  discoverInstalledDaemonServiceEntriesMock,
} = vi.hoisted(() => ({
  planDaemonServiceInstallMock: vi.fn<() => DaemonServiceInstallPlan>(() => ({
    platform: 'linux',
    files: [],
    commands: [],
  })),
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
  // No managed shim installed in these fixtures: no runtime replacement is ever proposed.
  resolveManagedDaemonServiceShimPath: async () => null,
}));

vi.mock('./discoverInstalledDaemonServiceEntries', async () => {
  // Spread the real module: only discovery is faked here, and the installer also
  // reads the installed definition's autostart declaration from this owner.
  const actual = await vi.importActual<typeof import('./discoverInstalledDaemonServiceEntries')>(
    './discoverInstalledDaemonServiceEntries',
  );
  return {
    ...actual,
    discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
  };
});

describe('installDaemonService conflict handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock('./resolveDaemonServiceDiscoveryTargets');
    vi.doUnmock('./resolveLinuxSystemUserPaths');
    vi.unmock('./resolveDaemonServiceDiscoveryTargets');
    vi.unmock('./resolveLinuxSystemUserPaths');
    vi.resetModules();
  });

  it('skips reinstalling when the exact target service already exists', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
        platform: 'darwin',
        happierHomeDir: '/Users/tester/.happier',
        releaseChannel: 'stable',
        label: 'com.happier.cli.daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'darwin',
      uid: 501,
      userHomeDir: '/Users/tester',
      happierHomeDir: '/Users/tester/.happier',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
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

  it('treats trailing slashes in happierHomeDir as the same home when checking installed definition match', async () => {
    const installedPath = '/tmp/happier-daemon.default.service';
    mkdirSync(dirname(installedPath), { recursive: true });
    writeFileSync(installedPath, 'expected', 'utf8');

    planDaemonServiceInstallMock.mockImplementationOnce(() => ({
      platform: 'linux',
      files: [{ path: installedPath, content: 'expected', mode: 0o644 }],
      commands: [],
    }));
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: installedPath,
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier/',
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
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate exact-target services instead of silently treating them as converged', async () => {
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
      {
        serverId: 'default',
        name: 'Default background service duplicate',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.duplicate.service',
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.default.duplicate',
        targetMode: 'default-following',
      },
    ]);

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
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('rewrites an exact target service when the installed definition does not match the expected plan', async () => {
    const installedPath = '/tmp/happier-installer-mismatch/happier-daemon.default.service';
    mkdirSync(dirname(installedPath), { recursive: true });
    writeFileSync(installedPath, '[Unit]\nDescription=stale\n', 'utf8');
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: installedPath,
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);
    planDaemonServiceInstallMock.mockReturnValueOnce({
      platform: 'linux',
      files: [{ path: installedPath, content: '[Unit]\nDescription=expected\n', mode: 0o644 }],
      commands: [],
    });

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      instanceId: 'default',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
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

    await expect(installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      instanceId: 'default',
      strategy: 'add',
      runCommands: true,
      commandFailureMode: 'strict',
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('blocks replacing a default-following service from another Happier home', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        happierHomeDir: '/home/tester/.happier-other',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-ring',
      runCommands: true,
      commandFailureMode: 'strict',
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('replaces a same-mode default-following service from another Happier home with replace-all', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
        platform: 'darwin',
        mode: 'user',
        happierHomeDir: '/Users/tester/.happier/stacks/repo-dev-old/cli',
        releaseChannel: 'stable',
        label: 'com.happier.cli.daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'darwin',
      uid: 501,
      userHomeDir: '/Users/tester',
      happierHomeDir: '/Users/tester/.happier',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'darwin',
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      installedPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
    }));
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('blocks replacing a default-following service with missing Happier home metadata', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Legacy default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-ring',
      runCommands: true,
      commandFailureMode: 'strict',
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('replaces a same-mode default-following service with missing Happier home metadata with replace-all', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Legacy default background service',
        installed: true,
        path: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
        platform: 'darwin',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'com.happier.cli.daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'darwin',
      uid: 501,
      userHomeDir: '/Users/tester',
      happierHomeDir: '/Users/tester/.happier',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'darwin',
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      installedPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
    }));
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting installed services by default', async () => {
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

    await expect(installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: false,
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('rejects conflicting installed services from another mode by default on linux', async () => {
    discoverInstalledDaemonServiceEntriesMock
      .mockResolvedValueOnce([
        {
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        },
      ])
      .mockResolvedValueOnce([]);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'linux',
      uid: 0,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'system',
      systemUser: 'happier',
      channel: 'preview',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: false,
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      platform: 'linux',
      mode: 'user',
    }));
    expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      platform: 'linux',
      mode: 'system',
    }));
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('uses the invoking user home for cross-mode user discovery during system installs', async () => {
    vi.stubEnv('SUDO_USER', 'sudo-user');
    vi.resetModules();
    vi.doMock('./resolveLinuxSystemUserPaths', async () => {
      const actual = await vi.importActual<typeof import('./resolveLinuxSystemUserPaths')>('./resolveLinuxSystemUserPaths');
      return {
        ...actual,
        resolveLinuxSystemUserPaths: vi.fn(({ systemUser }: { systemUser: string }) => ({
          userHomeDir: systemUser === 'happier' ? '/srv/happier' : '/home/sudo-user',
          happierHomeDir: systemUser === 'happier' ? '/srv/happier/.happier' : '/home/sudo-user/.happier',
        })),
      };
    });
    discoverInstalledDaemonServiceEntriesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 0,
      userHomeDir: '/srv/happier',
      happierHomeDir: '/srv/happier/.happier',
      mode: 'system',
      systemUser: 'happier',
      channel: 'preview',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'add',
      runCommands: false,
    });

    expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      platform: 'linux',
      mode: 'user',
      userHomeDir: '/home/sudo-user',
      happierHomeDir: '/home/sudo-user/.happier',
    }));
    expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      platform: 'linux',
      mode: 'system',
      userHomeDir: '/srv/happier',
      happierHomeDir: '/srv/happier/.happier',
    }));
  });

  it('preserves unrelated pinned services when replacing a default-following install', async () => {
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

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceUninstallPlanMock).not.toHaveBeenCalled();
    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('removes a competing service using that service mode when replacing across linux modes', async () => {
    discoverInstalledDaemonServiceEntriesMock
      .mockResolvedValueOnce([
        {
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        },
      ])
      .mockResolvedValueOnce([]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 0,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'system',
      systemUser: 'happier',
      channel: 'preview',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'user',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
    }));
  });

  it('does not treat pinned services as replaceable competitors for default-following installs', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
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
      {
        serverId: 'preview-company',
        name: 'Preview Company',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.preview.preview-company.service',
        platform: 'linux',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.preview-company',
        targetMode: 'pinned',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-ring',
      runCommands: false,
    });

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('installs a pinned service for one relay beside the pinned service of another relay on the same ring', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'personal',
        activeServerId: 'personal',
        name: 'Personal',
        relayUrl: 'https://personal.example.test',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.personal.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.personal',
        targetMode: 'pinned',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      targetMode: 'pinned',
      instanceId: 'company',
      activeServerId: 'company',
      serverUrl: 'https://company.example.test',
      webappUrl: 'https://company.example.test',
      publicServerUrl: 'https://company.example.test',
      runCommands: false,
    });

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('keeps same-instance pinned services from other release channels when replacing the ring target', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'stack-a',
        name: 'Stack A stable',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.stack-a.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.stable.stack-a',
        targetMode: 'pinned',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'preview',
      targetMode: 'pinned',
      instanceId: 'stack-a',
      strategy: 'replace-ring',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy default-following services from other release channels when replacing the ring target', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.dev.default.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/home/tester/.happier',
        releaseChannel: 'publicdev',
        label: 'happier-daemon.dev.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'preview',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-ring',
      runCommands: true,
      commandFailureMode: 'strict',
    });

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, 1],
    [false, 0],
  ])('reinstalls a Windows task with an unchanged wrapper when its launcher upgrade is needed (%s)', async (upgradeNeeded, applies) => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-installer-launcher-upgrade-'));
    const installedPath = join(homeDir, '.happier', 'services', 'happier-daemon.default.ps1');
    mkdirSync(dirname(installedPath), { recursive: true });
    writeFileSync(installedPath, 'expected wrapper', 'utf8');
    planDaemonServiceInstallMock.mockReturnValueOnce({
      platform: 'win32',
      files: [{ path: installedPath, content: 'expected wrapper', mode: 0o644 }],
      commands: [],
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: installedPath,
        platform: 'win32',
        happierHomeDir: join(homeDir, '.happier'),
        releaseChannel: 'stable',
        label: 'Happier\\happier-daemon.default',
        targetMode: 'default-following',
        windowsLauncherUpgradeNeeded: upgradeNeeded,
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'win32',
      userHomeDir: homeDir,
      happierHomeDir: join(homeDir, '.happier'),
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: false,
    });

    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(applies);
  });

  it('rejects different launcher bytes at the planned destination before removing a competing service', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-installer-launcher-destination-'));
    const sourcePath = join(homeDir, 'package', 'happier-service-launcher.exe');
    const destinationPath = join(homeDir, '.happier', 'services', 'happier-daemon.default', 'launcher-1-abc', 'happier-service-launcher.exe');
    mkdirSync(dirname(sourcePath), { recursive: true });
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(sourcePath, createWindowsServiceLauncherPeFixture());
    writeFileSync(destinationPath, Buffer.concat([createWindowsServiceLauncherPeFixture(), Buffer.from('different build')]));
    planDaemonServiceInstallMock.mockReturnValueOnce({
      platform: 'win32',
      files: [{ path: join(homeDir, '.happier', 'services', 'happier-daemon.default.ps1'), content: 'expected wrapper', mode: 0o644 }],
      copies: [{ sourcePath, destinationPath, validation: 'windows-service-launcher-x64-v1' }],
      commands: [],
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: join(homeDir, 'other-home', 'services', 'happier-daemon.default.ps1'),
        platform: 'win32',
        mode: 'user',
        happierHomeDir: join(homeDir, 'other-home'),
        releaseChannel: 'stable',
        label: 'Happier\\happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);
    const beforeApply = vi.fn(async () => undefined);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'win32',
      userHomeDir: homeDir,
      happierHomeDir: join(homeDir, '.happier'),
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: false,
      beforeApply,
    })).rejects.toThrow(/refusing to replace a different versioned Windows service launcher/u);

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceUninstallPlanMock).not.toHaveBeenCalled();
    expect(beforeApply).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('rejects an unreadable launcher destination before removing a competing service', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-installer-launcher-destination-dir-'));
    const sourcePath = join(homeDir, 'package', 'happier-service-launcher.exe');
    const destinationPath = join(homeDir, '.happier', 'services', 'happier-daemon.default', 'launcher-1-abc', 'happier-service-launcher.exe');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, createWindowsServiceLauncherPeFixture());
    // A directory occupies the destination: it cannot be read as the launcher nor replaced by it.
    mkdirSync(destinationPath, { recursive: true });
    planDaemonServiceInstallMock.mockReturnValueOnce({
      platform: 'win32',
      files: [{ path: join(homeDir, '.happier', 'services', 'happier-daemon.default.ps1'), content: 'expected wrapper', mode: 0o644 }],
      copies: [{ sourcePath, destinationPath, validation: 'windows-service-launcher-x64-v1' }],
      commands: [],
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: join(homeDir, 'other-home', 'services', 'happier-daemon.default.ps1'),
        platform: 'win32',
        mode: 'user',
        happierHomeDir: join(homeDir, 'other-home'),
        releaseChannel: 'stable',
        label: 'Happier\\happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);
    const beforeApply = vi.fn(async () => undefined);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'win32',
      userHomeDir: homeDir,
      happierHomeDir: join(homeDir, '.happier'),
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: false,
      beforeApply,
    })).rejects.toMatchObject({ code: 'EISDIR' });

    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalled();
    expect(beforeApply).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid packaged launcher before stopping the current owner', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-installer-launcher-preflight-'));
    const installedPath = join(homeDir, '.happier', 'services', 'happier-daemon.default.ps1');
    mkdirSync(dirname(installedPath), { recursive: true });
    writeFileSync(installedPath, 'stale wrapper', 'utf8');
    planDaemonServiceInstallMock.mockReturnValueOnce({
      platform: 'win32',
      files: [{ path: installedPath, content: 'expected wrapper', mode: 0o644 }],
      copies: [{
        sourcePath: join(homeDir, 'missing', 'happier-service-launcher.exe'),
        destinationPath: join(homeDir, '.happier', 'services', 'happier-daemon.default', 'launcher-1', 'happier-service-launcher.exe'),
        validation: 'windows-service-launcher-x64-v1',
      }],
      commands: [],
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([]);
    const beforeApply = vi.fn(async () => undefined);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'win32',
      userHomeDir: homeDir,
      happierHomeDir: join(homeDir, '.happier'),
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: false,
      beforeApply,
    })).rejects.toThrow(/launcher is unavailable/u);

    expect(beforeApply).not.toHaveBeenCalled();
    expect(applyDaemonServiceUninstallPlanMock).not.toHaveBeenCalled();
    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });
});
