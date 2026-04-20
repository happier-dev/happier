import { describe, expect, it } from 'vitest';

import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';

describe('buildBackgroundServiceRepairPlan', () => {
  it('migrates a pinned current-channel service to one default background service', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentServerId: 'company',
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
      currentServerId: 'company',
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

  it('reinstalls the compatible default service when its definition does not match the expected contents', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      currentServerId: 'default',
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
        installedDefinitionMatchesExpected: false,
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'install-default-following-service',
        releaseChannel: 'stable',
        mode: 'user',
      }),
    ]);
  });

  it('migrates a raw legacy daemon service to the canonical default service', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentHappierHomeDir: '/home/test/.happier',
      currentServerId: 'default',
      preferredMode: 'user',
      services: [{
        serverId: 'default',
        name: 'Legacy default background service',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/home/test/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon',
        targetMode: 'default-following',
        installedDefinitionMatchesExpected: false,
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon',
          installedPath: '/home/test/.config/systemd/user/happier-daemon.service',
          mode: 'user',
          targetMode: 'default-following',
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

  it('keeps the preferred-mode compatible default service and removes the duplicate from the other mode', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      currentServerId: 'default',
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

  it('keeps pinned services for other servers when repairing the current server', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      currentHappierHomeDir: '/tmp/user/.happier',
      currentServerId: 'company',
      preferredMode: 'user',
      services: [{
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.company.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.company',
        targetMode: 'pinned',
      }, {
        serverId: 'partner',
        name: 'Partner',
        installed: true,
        path: '/tmp/happier-daemon.partner.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.partner',
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
      expect.objectContaining({
        kind: 'install-default-following-service',
        releaseChannel: 'stable',
        mode: 'user',
      }),
    ]);
  });

  it('repairs a foreign-home default service while migrating current-server pinned services', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentHappierHomeDir: '/tmp/user/.happier',
      currentServerId: 'company',
      preferredMode: 'user',
      services: [{
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.preview.company.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.company',
        targetMode: 'pinned',
      }, {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/other/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }],
    });

    expect(plan.manualWarnings).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.default',
          installedPath: '/tmp/happier-daemon.default.service',
          mode: 'user',
          targetMode: 'default-following',
          releaseChannel: 'preview',
        }),
      }),
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

  it('does not remove or replace services from another Happier home when a foreign pinned service targets the current server', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentHappierHomeDir: '/tmp/user/.happier',
      currentServerId: 'company',
      preferredMode: 'user',
      services: [{
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.preview.company.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.company',
        targetMode: 'pinned',
      }, {
        serverId: 'company',
        name: 'Foreign pinned company',
        installed: true,
        path: '/tmp/happier-daemon.preview.company.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/other/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.company',
        targetMode: 'pinned',
      }],
    });

    expect(plan.actions).toEqual([]);
    expect(plan.manualWarnings).toEqual([
      expect.stringContaining('/tmp/other/.happier'),
    ]);
  });

  it('repairs a compatible default service with missing home metadata', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentHappierHomeDir: '/tmp/user/.happier',
      currentServerId: 'company',
      preferredMode: 'user',
      services: [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
        happierHomeDir: null,
      }],
    });

    expect(plan.manualWarnings).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.default',
          installedPath: '/tmp/happier-daemon.default.service',
          mode: 'user',
          targetMode: 'default-following',
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

  it('fails closed when a pinned current-server service has missing home metadata', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentHappierHomeDir: '/tmp/user/.happier',
      currentServerId: 'company',
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
        happierHomeDir: null,
      }],
    });

    expect(plan.actions).toEqual([]);
    expect(plan.manualWarnings.length).toBeGreaterThan(0);
  });

  it('treats Windows home dir variants as the same home for foreign-home detection', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentHappierHomeDir: 'C:\\Users\\Alice\\.happier\\',
      currentServerId: 'company',
      preferredMode: 'user',
      services: [{
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/tmp/happier-daemon.preview.company.service',
        platform: 'win32',
        mode: 'user',
        happierHomeDir: 'c:/users/alice/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.company',
        targetMode: 'pinned',
      }, {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.ps1',
        platform: 'win32',
        mode: 'user',
        happierHomeDir: 'c:/Users/Alice/.happier/',
        releaseChannel: 'preview',
        label: 'happier\\happier-daemon.default',
        targetMode: 'default-following',
      }],
    });

    expect(plan.manualWarnings).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.preview.company',
        }),
      }),
    ]);
  });

  it('keeps the canonical default-following service when duplicates exist in the same mode', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'stable',
      currentServerId: 'default',
      preferredMode: 'user',
      services: [{
        serverId: 'default',
        name: 'Legacy default background service',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.stable.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.stable.default',
        targetMode: 'default-following',
      }, {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }],
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'remove-service',
        service: expect.objectContaining({
          label: 'happier-daemon.stable.default',
          mode: 'user',
          targetMode: 'default-following',
        }),
      }),
    ]);
  });
});
