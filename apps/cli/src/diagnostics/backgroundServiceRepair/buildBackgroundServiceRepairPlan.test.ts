import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// OS manager reads are the boundary; keep repair selection, metadata and preservation real.
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: (command: string) => ({ status: 0, stdout: command === 'systemctl'
    ? 'UnitFileState=enabled\nActiveState=inactive\n'
    : command === 'powershell.exe' ? JSON.stringify({ exists: true, enabled: true, active: false, autostart: true })
      : 'disabled services = {\n}', stderr: '' }),
}));

import type { IrohRelayEnvConfig } from '@happier-dev/iroh-native/node';

import { planDaemonServiceInstall, type DaemonServicePlatform } from '@/daemon/service/plan';
import { resolveDaemonServiceIrohRelayConfig } from '@/daemon/service/resolveDaemonServiceIrohRelayConfig';
import { resolveDaemonServiceHomeCarrierPolicy } from '@/daemon/service/resolveDaemonServiceHomeCarrierPolicy';
import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';

function installedServiceContents(
  platform: DaemonServicePlatform,
  processEnv: NodeJS.ProcessEnv,
): string {
  return planDaemonServiceInstall({
    platform,
    mode: 'user',
    channel: 'stable',
    targetMode: 'default-following',
    instanceId: 'default',
    userHomeDir: platform === 'win32' ? 'C:\\Users\\test' : '/home/test',
    happierHomeDir: platform === 'win32' ? 'C:\\Users\\test\\.happier' : '/home/test/.happier',
    serverUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    nodePath: platform === 'win32' ? 'C:\\bin\\happier.exe' : '/usr/bin/happier',
    entryPath: '',
    irohRelayConfig: resolveDaemonServiceIrohRelayConfig({ processEnv }),
    homeCarrierEligibility: resolveDaemonServiceHomeCarrierPolicy({ processEnv }),
  }).files[0]?.content ?? '';
}

describe('buildBackgroundServiceRepairPlan', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('carries prior service attribution and login preference through replacement and rollback on %s', (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'repair-preserved-options-'));
    try {
      const path = join(root, 'service-definition');
      const prior = planDaemonServiceInstall({
        platform, mode: 'user', channel: 'preview', targetMode: 'pinned', instanceId: 'company', activeServerId: 'company', uid: 501,
        userHomeDir: '/home/test', happierHomeDir: '/home/test/.happier',
        serverUrl: 'https://company.test', webappUrl: 'https://company.test', publicServerUrl: 'https://company.test',
        nodePath: '/usr/bin/happier', entryPath: '', autostart: 'on-demand', bundleId: 'dev.happier.preview', managedBy: 'desktop',
      });
      writeFileSync(path, prior.files[0]!.content);
      const plan = buildBackgroundServiceRepairPlan({
        currentReleaseChannel: 'preview', currentServerId: 'company', preferredMode: 'user',
        services: [{ serverId: 'company', name: 'Company', verification: 'verified' as const, installed: true, path, platform, mode: 'user',
          releaseChannel: 'preview', label: 'happier-daemon.preview.company', targetMode: 'pinned' }],
      });
      const preserved = { autostart: 'on-demand', bundleId: 'dev.happier.preview', managedBy: 'desktop' };
      expect(plan.actions).toEqual([
        expect.objectContaining({ kind: 'remove-service', service: expect.objectContaining(preserved) }),
        expect.objectContaining({ kind: 'install-default-following-service', ...preserved }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates a pinned current-channel service to one default background service', () => {
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview',
      currentServerId: 'company',
      preferredMode: 'user',
      services: [{
        serverId: 'company',
        name: 'Company',
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
        path: '/tmp/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }, {
        serverId: 'company',
        name: 'Company',
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }, {
        serverId: 'default',
        name: 'Default background service',
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
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
        verification: 'verified' as const, installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.stable.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.stable.default',
        targetMode: 'default-following',
      }, {
        serverId: 'default',
        name: 'Default background service',
        verification: 'verified' as const, installed: true,
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

  it.each([
    ['darwin', 'automatic', 'https://relay-b.example, https://relay-a.example'],
    ['linux', 'automatic', 'https://relay-b.example, https://relay-a.example'],
    ['win32', 'automatic', 'https://relay-b.example, https://relay-a.example'],
    ['darwin', 'disabled', undefined],
    ['linux', 'disabled', undefined],
    ['win32', 'disabled', undefined],
  ] as const)(
    'carries normalized %s repair relay configuration through the %s replacement renderer',
    (platform, relayPolicy, relayUrls) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'happier-service-repair-iroh-'));
      try {
        const installedPath = join(tempDir, platform === 'darwin'
          ? 'com.happier.cli.daemon.plist'
          : platform === 'win32'
            ? 'happier-daemon.ps1'
            : 'happier-daemon.service');
        writeFileSync(installedPath, installedServiceContents(platform, {
          HAPPIER_IROH_RELAY_POLICY: relayPolicy,
          HAPPIER_HOME_CARRIER_POLICY: 'standard_only',
          ...(relayUrls ? { HAPPIER_IROH_RELAY_URLS: relayUrls } : {}),
        }), 'utf8');

        const plan = buildBackgroundServiceRepairPlan({
          currentReleaseChannel: 'stable',
          currentHappierHomeDir: platform === 'win32' ? 'C:\\Users\\test\\.happier' : '/home/test/.happier',
          currentServerId: 'default',
          preferredMode: 'user',
          services: [{
            serverId: 'default',
            name: 'Legacy default background service',
            verification: 'verified' as const, installed: true,
            path: installedPath,
            platform,
            mode: 'user',
            happierHomeDir: platform === 'win32' ? 'C:\\Users\\test\\.happier' : '/home/test/.happier',
            releaseChannel: 'stable',
            label: platform === 'darwin'
              ? 'com.happier.cli.daemon'
              : platform === 'win32'
                ? 'Happier\\happier-daemon'
                : 'happier-daemon',
            targetMode: 'default-following',
            installedDefinitionMatchesExpected: false,
          }],
        });
        const installAction = plan.actions.find((action) => action.kind === 'install-default-following-service');
        const retained = (installAction as { irohRelayConfig?: IrohRelayEnvConfig } | undefined)?.irohRelayConfig;
        expect((installAction as { homeCarrierEligibility?: string } | undefined)?.homeCarrierEligibility).toBe('standard_only');
        const replacement = installedServiceContents(platform, {
          ...(retained?.explicitlyConfigured
            ? { HAPPIER_IROH_RELAY_POLICY: retained.relayPolicy }
            : {}),
          ...(retained?.relayUrls.length
            ? { HAPPIER_IROH_RELAY_URLS: retained.relayUrls.join(',') }
            : {}),
        });

        expect(retained).toEqual({
          relayPolicy,
          relayUrls: relayUrls ? ['https://relay-a.example', 'https://relay-b.example'] : [],
          explicitlyConfigured: true,
        });
        expect(replacement).toContain('HAPPIER_IROH_RELAY_POLICY');
        expect(replacement).toContain(relayPolicy);
        if (relayUrls) {
          expect(replacement).toContain('https://relay-a.example,https://relay-b.example');
        } else {
          expect(replacement).not.toContain('HAPPIER_IROH_RELAY_URLS');
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('never inherits relay configuration from a foreign-Happier-Home definition', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-service-repair-foreign-iroh-'));
    try {
      const localPath = join(tempDir, 'happier-daemon.company.service');
      const foreignPath = join(tempDir, 'happier-daemon.default.service');
      writeFileSync(localPath, installedServiceContents('linux', {
        HAPPIER_IROH_RELAY_POLICY: 'disabled',
        HAPPIER_HOME_CARRIER_POLICY: 'standard_only',
      }), 'utf8');
      writeFileSync(foreignPath, installedServiceContents('linux', {
        HAPPIER_IROH_RELAY_POLICY: 'automatic',
        HAPPIER_IROH_RELAY_URLS: 'https://foreign-relay.example',
        HAPPIER_HOME_CARRIER_POLICY: 'automatic',
      }), 'utf8');

      const plan = buildBackgroundServiceRepairPlan({
        currentReleaseChannel: 'stable',
        currentHappierHomeDir: '/home/test/.happier',
        currentServerId: 'company',
        preferredMode: 'user',
        services: [{
          serverId: 'company',
          name: 'Current Home pinned service',
          verification: 'verified' as const, installed: true,
          path: localPath,
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/test/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.company',
          targetMode: 'pinned',
        }, {
          serverId: 'default',
          name: 'Foreign Home default service',
          verification: 'verified' as const, installed: true,
          path: foreignPath,
          platform: 'linux',
          mode: 'user',
          happierHomeDir: '/home/other/.happier',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }],
      });
      const installAction = plan.actions.find((action) => action.kind === 'install-default-following-service');

      expect((installAction as { irohRelayConfig?: IrohRelayEnvConfig } | undefined)?.irohRelayConfig).toEqual({
        relayPolicy: 'disabled',
        relayUrls: [],
        explicitlyConfigured: true,
      });
      expect((installAction as { homeCarrierEligibility?: string } | undefined)?.homeCarrierEligibility).toBe('standard_only');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
