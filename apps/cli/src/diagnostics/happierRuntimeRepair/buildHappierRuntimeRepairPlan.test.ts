import { describe, expect, it } from 'vitest';

import { buildHappierRuntimeRepairPlan } from './buildHappierRuntimeRepairPlan';

function createSnapshot(params: Readonly<{
  services?: Array<{
    id: string;
    label: string;
    ring?: 'stable' | 'preview' | 'dev' | null;
    instanceId?: string | null;
  }>;
}> = {}) {
  return {
    capturedAt: '2026-04-07T00:00:00.000Z',
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://api.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    },
    settings: {
      activeServerId: 'cloud',
      servers: [],
      knownAccountIds: [],
    },
    installations: {
      happier: {
        activeInvocation: null,
        installations: [
          {
            id: 'managed:stable:cli',
            source: 'firstPartyManaged',
            ring: 'stable',
            version: '1.2.3',
            path: '/Users/test/.happier/cli/current/happier',
            realPath: '/Users/test/.happier/cli/versions/1.2.3/happier',
            components: ['happier-cli'],
            onPath: true,
            isActiveInvocation: false,
            pathEntries: [],
          },
        ],
      },
    },
    services: {
      happier: {
        services: (params.services ?? []).map((service) => ({
          id: service.id,
          label: service.label,
          platform: 'darwin',
          serviceType: 'daemon',
          backend: 'launchd',
          scope: 'user',
          verification: 'verified',
          installed: true,
          running: true,
          ring: service.ring ?? 'stable',
          instanceId: service.instanceId ?? null,
          definitionPath: `/Users/test/Library/LaunchAgents/${service.label}.plist`,
          executablePath: `/tmp/${service.label}`,
        })),
      },
    },
    warnings: [],
  };
}

describe('buildHappierRuntimeRepairPlan', () => {
  it('uses a targeted uninstall command for a single orphan daemon service', () => {
    const plan = buildHappierRuntimeRepairPlan(createSnapshot({
      services: [
        {
          id: 'launchd:com.happier.cli.daemon.custom',
          label: 'com.happier.cli.daemon.custom',
          ring: 'stable',
          instanceId: 'custom',
        },
      ],
    }) as never);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'uninstall-daemon-services',
        command: 'happier daemon service uninstall --ring stable --instance custom --yes',
      }),
    ]);
  });

  it('uses doctor repair for multi-service orphan cleanup instead of a broad uninstall command', () => {
    const plan = buildHappierRuntimeRepairPlan(createSnapshot({
      services: [
        {
          id: 'launchd:com.happier.cli.daemon.custom',
          label: 'com.happier.cli.daemon.custom',
          ring: 'stable',
          instanceId: 'custom',
        },
        {
          id: 'launchd:com.happier.cli.daemon.dev.other',
          label: 'com.happier.cli.daemon.dev.other',
          ring: 'dev',
          instanceId: 'other',
        },
      ],
    }) as never);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'uninstall-daemon-services',
        command: 'happier doctor repair --yes',
      }),
    ]);
  });
});
