import { describe, expect, it } from 'vitest';

import { buildHappierRuntimeRepairPlan } from './buildHappierRuntimeRepairPlan';

function createSnapshot(params: Readonly<{
  services?: Array<{
    id: string;
    label: string;
    targetMode?: 'pinned' | 'default-following';
    ring?: 'stable' | 'preview' | 'dev' | null;
    instanceId?: string | null;
    serverUrl?: string | null;
    running?: boolean;
    executablePath?: string | null;
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
          running: service.running ?? true,
          targetMode: service.targetMode ?? 'pinned',
          ring: service.ring ?? 'stable',
          instanceId: service.instanceId ?? null,
          definitionPath: `/Users/test/Library/LaunchAgents/${service.label}.plist`,
          executablePath: service.executablePath ?? `/tmp/${service.label}`,
          serverUrl: service.serverUrl ?? null,
          publicServerUrl: service.serverUrl ?? null,
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
        command: 'happier service uninstall --ring stable --instance custom --yes',
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
        command: 'happier service repair --yes',
      }),
    ]);
  });

  it('falls back to service repair for a default-following orphan service', () => {
    const plan = buildHappierRuntimeRepairPlan(createSnapshot({
      services: [
        {
          id: 'launchd:com.happier.cli.daemon.default',
          label: 'com.happier.cli.daemon.default',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
        },
      ],
    }) as never);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'uninstall-daemon-services',
        command: 'happier service repair --yes',
      }),
    ]);
  });

  it('keeps one default-following service and removes duplicate verified defaults', () => {
    const plan = buildHappierRuntimeRepairPlan(createSnapshot({
      services: [
        {
          id: 'launchd:com.happier.cli.daemon.default.primary',
          label: 'com.happier.cli.daemon.default.primary',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          running: true,
          executablePath: '/Users/test/.happier/cli/current/happier',
        },
        {
          id: 'launchd:com.happier.cli.daemon.default.secondary',
          label: 'com.happier.cli.daemon.default.secondary',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          running: false,
          executablePath: '/Users/test/.happier/cli/current/happier',
        },
      ],
    }) as never);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'uninstall-daemon-services',
        services: [
          expect.objectContaining({
            id: 'launchd:com.happier.cli.daemon.default.secondary',
            targetMode: 'default-following',
          }),
        ],
      }),
    ]);
  });

  it('migrates a single pinned service for the active server to a default-following service', () => {
    const plan = buildHappierRuntimeRepairPlan(createSnapshot({
      services: [
        {
          id: 'launchd:com.happier.cli.daemon.cloud',
          label: 'com.happier.cli.daemon.cloud',
          targetMode: 'pinned',
          ring: 'stable',
          instanceId: 'cloud',
          serverUrl: 'https://api.happier.dev',
        },
      ],
    }) as never);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: 'install-default-following-service',
        command: 'happier service install --yes',
        targetServerUrl: 'https://api.happier.dev',
      }),
      expect.objectContaining({
        kind: 'uninstall-daemon-services',
        services: [
          expect.objectContaining({
            id: 'launchd:com.happier.cli.daemon.cloud',
            targetMode: 'pinned',
          }),
        ],
      }),
    ]);
  });
});
