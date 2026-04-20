import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackgroundServiceRepairPlan } from './types';

const {
  installDaemonServiceMock,
  uninstallDaemonServiceMock,
} = vi.hoisted(() => ({
  installDaemonServiceMock: vi.fn(async () => undefined),
  uninstallDaemonServiceMock: vi.fn(async () => undefined),
}));

vi.mock('@/daemon/service/installer', () => ({
  installDaemonService: installDaemonServiceMock,
  uninstallDaemonService: uninstallDaemonServiceMock,
}));

import { applyBackgroundServiceRepairPlan } from './applyBackgroundServiceRepairPlan';

describe('applyBackgroundServiceRepairPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reinstalls the canonical default service with replace-ring semantics after removing stale services', async () => {
    const plan: BackgroundServiceRepairPlan = {
      currentReleaseChannel: 'preview',
      existingServices: [],
      manualWarnings: [],
      actions: [
        {
          kind: 'remove-service',
          service: {
            label: 'happier-daemon.dev.default',
            installedPath: '/home/tester/.config/systemd/user/happier-daemon.dev.default.service',
            mode: 'user',
            releaseChannel: 'publicdev',
            targetMode: 'default-following',
            instanceId: 'default',
          },
        },
        {
          kind: 'install-default-following-service',
          releaseChannel: 'preview',
          mode: 'user',
        },
      ],
    };

    await applyBackgroundServiceRepairPlan(plan, {
      platform: 'linux',
      systemUser: '',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      nodePath: '/home/tester/.happier/cli-preview/current/happier',
      entryPath: '',
    });

    expect(uninstallDaemonServiceMock).toHaveBeenCalledWith({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      installedPath: '/home/tester/.config/systemd/user/happier-daemon.dev.default.service',
      runCommands: true,
    });
    expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      nodePath: '/home/tester/.happier/cli-preview/current/happier',
      entryPath: '',
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      strategy: 'replace-ring',
      runCommands: true,
    }));

    const uninstallOrder = uninstallDaemonServiceMock.mock.invocationCallOrder[0];
    const installOrder = installDaemonServiceMock.mock.invocationCallOrder[0];
    expect(uninstallOrder).toBeLessThan(installOrder);
  });

  it('restores removed services if the replacement install fails', async () => {
    const plan: BackgroundServiceRepairPlan = {
      currentReleaseChannel: 'preview',
      existingServices: [],
      manualWarnings: [],
      actions: [
        {
          kind: 'remove-service',
          service: {
            label: 'happier-daemon.dev.default',
            installedPath: '/home/tester/.config/systemd/user/happier-daemon.dev.default.service',
            mode: 'user',
            releaseChannel: 'publicdev',
            targetMode: 'default-following',
            instanceId: 'default',
          },
        },
        {
          kind: 'install-default-following-service',
          releaseChannel: 'preview',
          mode: 'user',
        },
      ],
    };

    const replacementError = new Error('replacement install failed');
    installDaemonServiceMock.mockRejectedValueOnce(replacementError);

    await expect(applyBackgroundServiceRepairPlan(plan, {
      platform: 'linux',
      systemUser: '',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      nodePath: '/home/tester/.happier/cli-preview/current/happier',
      entryPath: '',
    })).rejects.toThrow(replacementError);

    expect(uninstallDaemonServiceMock).toHaveBeenCalledWith({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      installedPath: '/home/tester/.config/systemd/user/happier-daemon.dev.default.service',
      runCommands: true,
    });
    expect(installDaemonServiceMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      nodePath: '/home/tester/.happier/cli-preview/current/happier',
      entryPath: '',
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      strategy: 'replace-ring',
      runCommands: true,
    }));
    expect(uninstallDaemonServiceMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      runCommands: true,
    }));
    expect(installDaemonServiceMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      nodePath: '/home/tester/.happier/cli-preview/current/happier',
      entryPath: '',
      mode: 'user',
      channel: 'publicdev',
      targetMode: 'default-following',
      runCommands: true,
    }));
    const replacementInstallOrder = installDaemonServiceMock.mock.invocationCallOrder[0];
    const rollbackUninstallOrder = uninstallDaemonServiceMock.mock.invocationCallOrder[1];
    const restoreOrder = installDaemonServiceMock.mock.invocationCallOrder[1];
    expect(replacementInstallOrder).toBeLessThan(rollbackUninstallOrder);
    expect(rollbackUninstallOrder).toBeLessThan(restoreOrder);
  });

  it('does not uninstall a healthy existing default target when replacement install fails before mutating', async () => {
    const plan: BackgroundServiceRepairPlan = {
      currentReleaseChannel: 'preview',
      existingServices: [
        {
          serverId: 'default',
          name: 'happier-daemon.preview.default.service',
          installed: true,
          path: '/home/tester/.config/systemd/user/happier-daemon.preview.default.service',
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'preview',
          label: 'happier-daemon.preview.default',
          targetMode: 'default-following',
        },
      ],
      manualWarnings: [],
      actions: [
        {
          kind: 'install-default-following-service',
          releaseChannel: 'preview',
          mode: 'user',
        },
      ],
    };

    const replacementError = new Error('replacement install failed before mutation');
    installDaemonServiceMock.mockRejectedValueOnce(replacementError);

    await expect(applyBackgroundServiceRepairPlan(plan, {
      platform: 'linux',
      systemUser: '',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      nodePath: '/home/tester/.happier/cli-preview/current/happier',
      entryPath: '',
    })).rejects.toThrow(replacementError);

    expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
    expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
  });
});
