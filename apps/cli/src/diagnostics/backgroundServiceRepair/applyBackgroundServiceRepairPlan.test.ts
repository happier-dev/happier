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
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      strategy: 'replace-ring',
      runCommands: true,
    }));
    expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.not.objectContaining({
      nodePath: expect.anything(),
      entryPath: expect.anything(),
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
    installDaemonServiceMock
      .mockRejectedValueOnce(replacementError)
      .mockResolvedValueOnce(undefined);

    await expect(applyBackgroundServiceRepairPlan(plan, {
      platform: 'linux',
      systemUser: '',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
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
    expect(uninstallDaemonServiceMock).toHaveBeenNthCalledWith(2, {
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: true,
    });
    expect(installDaemonServiceMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'preview',
      targetMode: 'default-following',
      strategy: 'replace-ring',
      runCommands: true,
    }));
    expect(installDaemonServiceMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'publicdev',
      targetMode: 'default-following',
      runCommands: true,
    }));

    const rollbackReplacementRemovalOrder = uninstallDaemonServiceMock.mock.invocationCallOrder[1];
    const restoredServiceOrder = installDaemonServiceMock.mock.invocationCallOrder[1];
    expect(rollbackReplacementRemovalOrder).toBeLessThan(restoredServiceOrder);
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
    })).rejects.toThrow(replacementError);

    expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
    expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
  });

  it('keeps the repaired default target installed when a later action fails after replacing an existing default service', async () => {
    const plan: BackgroundServiceRepairPlan = {
      currentReleaseChannel: 'preview',
      existingServices: [
        {
          serverId: 'default',
          name: 'happier-daemon.default.service',
          installed: true,
          installedDefinitionMatchesExpected: false,
          path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/tester/.happier',
          releaseChannel: 'preview',
          label: 'happier-daemon.default',
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
        {
          kind: 'remove-service',
          service: {
            label: 'happier-daemon.preview.server-2',
            installedPath: '/home/tester/.config/systemd/user/happier-daemon.preview.server-2.service',
            mode: 'user',
            releaseChannel: 'preview',
            targetMode: 'pinned',
            instanceId: 'server-2',
          },
        },
      ],
    };

    const laterFailure = new Error('later removal failed');
    installDaemonServiceMock.mockResolvedValueOnce(undefined);
    uninstallDaemonServiceMock.mockRejectedValueOnce(laterFailure);

    await expect(applyBackgroundServiceRepairPlan(plan, {
      platform: 'linux',
      systemUser: '',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
    })).rejects.toThrow(laterFailure);

    expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
    expect(uninstallDaemonServiceMock).toHaveBeenCalledTimes(1);
    expect(uninstallDaemonServiceMock).toHaveBeenCalledWith({
      platform: 'linux',
      uid: 501,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      mode: 'user',
      channel: 'preview',
      targetMode: 'pinned',
      instanceId: 'server-2',
      installedPath: '/home/tester/.config/systemd/user/happier-daemon.preview.server-2.service',
      runCommands: true,
    });
  });
});
