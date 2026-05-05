import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
}));

vi.mock('./discoverInstalledDaemonServiceEntries', () => ({
  discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
}));

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
});
