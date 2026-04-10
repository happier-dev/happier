import { describe, expect, it } from 'vitest';

import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';

describe('buildBackgroundServiceRepairPlan', () => {
  it('migrates a pinned current-channel service to one default background service', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      preferredMode: 'user',
      services: [{
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.preview.company.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.company',
        targetMode: 'pinned',
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.preview.company',
          mode: 'user',
          targetMode: 'pinned',
          releaseChannel: 'preview',
        }),
      }),
      expect.objectContaining({
        kind: 'install-default-following-service',
        releaseChannel: 'preview',
        mode: 'user',
      }),
    ]);
  });

  it('keeps one compatible default background service and removes extras', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      preferredMode: 'user',
      services: [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }, {
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.company.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.company',
        targetMode: 'pinned',
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.company',
          mode: 'user',
          targetMode: 'pinned',
        }),
      }),
    ]);
  });

  it('keeps the preferred-mode compatible default service and removes the duplicate from the other mode', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      preferredMode: 'user',
      services: [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }, {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/etc/systemd/system/happier-daemon.default.service',
        platform: 'linux',
        mode: 'system',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.default',
          mode: 'system',
          targetMode: 'default-following',
          releaseChannel: 'stable',
        }),
      }),
    ]);
  });
});
