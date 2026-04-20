import { describe, expect, it } from 'vitest';

import {
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  ExtensionProjectionV2Schema,
} from './daemonContributionRegistryProjection.js';
import * as protocol from './index.js';

describe('daemon contribution registry projection (wire)', () => {
  it('parses a minimal v1 describe request/response payload', () => {
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'm1' })).toEqual({
      machineId: 'm1',
    });

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 1,
        providersById: {
          custom: { id: 'custom', title: 'Custom', channel: 'plugin' },
        },
        backendsById: {
          b1: { id: 'b1', providerId: 'custom' },
        },
      },
    });
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(1);
    expect(parsed.projection.providersById.custom?.id).toBe('custom');
    expect(parsed.projection.backendsById.b1?.providerId).toBe('custom');
  });

  it('parses a v2 describe response payload that carries the authoritative extension projection', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 2,
        generation: 7,
        installedPackagesById: {
          'acme.extension': {
            id: 'acme.extension',
            displayName: 'Acme Extension',
            version: '1.2.3',
            enabled: true,
            source: {
              kind: 'path',
              locator: '/tmp/acme',
            },
            digest: 'sha256:manifest',
          },
        },
        providersById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        hooksById: {},
        resourcesById: {},
        uiDescriptorsById: {},
        diagnostics: [],
      },
    });

    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(2);
    expect(parsed.projection.installedPackagesById['acme.extension']?.displayName).toBe('Acme Extension');
  });

  it('parses v2 extension projection descriptors without executable handler internals', () => {
    expect(typeof ExtensionProjectionV2Schema?.parse).toBe('function');
    expect(typeof (protocol as { ExtensionProjectedHookV2Schema?: unknown }).ExtensionProjectedHookV2Schema).toBe('object');

    const parsed = ExtensionProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      installedPackagesById: {
        'acme.extension': {
          id: 'acme.extension',
          displayName: 'Acme Extension',
          version: '1.2.3',
          enabled: true,
          source: {
            kind: 'path',
            locator: '/tmp/acme',
          },
        },
      },
      actionsById: {
        'acme.extension.refresh': {
          id: 'acme.extension.refresh',
          pluginId: 'acme.extension',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['settings'],
          placement: 'primary',
          dangerLevel: 'safe',
          available: true,
        },
      },
      toolsById: {
        'acme.extension.search': {
          id: 'acme.extension.search',
          pluginId: 'acme.extension',
          title: 'Search Acme',
          exposesToAgent: true,
        },
      },
      commandsById: {
        'acme.extension.reload': {
          id: 'acme.extension.reload',
          pluginId: 'acme.extension',
          title: 'Reload Acme',
          surfaces: ['agentSlash'],
          tokens: ['acme-reload'],
        },
      },
      hooksById: {
        'acme.extension.spawn-env': {
          id: 'acme.extension.spawn-env',
          pluginId: 'acme.extension',
          eventId: 'spawn.augmentEnv',
          priority: 10,
        },
      },
      resourcesById: {
        'acme.extension.prompt': {
          id: 'acme.extension.prompt',
          pluginId: 'acme.extension',
          resourceKind: 'prompt',
          path: 'resources/prompt.md',
          digest: 'sha256:abc123',
        },
      },
      uiDescriptorsById: {
        'acme.extension.settings': {
          id: 'acme.extension.settings',
          pluginId: 'acme.extension',
          surface: 'settings',
          title: 'Acme Settings',
          order: 10,
          tone: 'info',
          featureGate: 'features.acme.settings.enabled',
          helpUrl: 'https://example.com/acme/settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
              description: 'Turn on Acme',
              order: 2,
              groupId: null,
              featureGate: null,
              options: [],
            },
            {
              id: 'runRefresh',
              type: 'action',
              title: 'Run refresh',
              actionId: 'acme.extension.refresh',
              order: 1,
              groupId: 'actions',
              featureGate: 'features.acme.refresh.enabled',
              options: [],
            },
          ],
        },
      },
      diagnostics: [
        {
          severity: 'warning',
          code: 'extension.futureCapability',
          message: 'Unsupported future capability',
          pluginId: 'acme.extension',
        },
      ],
    });

    expect(parsed.generation).toBe(7);
    expect(parsed.actionsById['acme.extension.refresh']?.available).toBe(true);
    expect(parsed.hooksById?.['acme.extension.spawn-env']?.eventId).toBe('spawn.augmentEnv');
    expect(parsed.uiDescriptorsById['acme.extension.settings']?.surface).toBe('settings');
    expect(parsed.uiDescriptorsById['acme.extension.settings']?.order).toBe(10);
    expect(parsed.uiDescriptorsById['acme.extension.settings']?.tone).toBe('info');
    expect(parsed.uiDescriptorsById['acme.extension.settings']?.helpUrl).toBe('https://example.com/acme/settings');
    expect(parsed.uiDescriptorsById['acme.extension.settings']?.fields[0]).toMatchObject({
      id: 'enabled',
      type: 'boolean',
      title: 'Enabled',
    });
    expect(parsed.uiDescriptorsById['acme.extension.settings']?.fields[1]).toMatchObject({
      id: 'runRefresh',
      type: 'action',
      actionId: 'acme.extension.refresh',
    });

    expect(ExtensionProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      actionsById: {
        'acme.extension.refresh': {
          id: 'acme.extension.refresh',
          pluginId: 'acme.extension',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['settings'],
          placement: 'primary',
          dangerLevel: 'safe',
          handler: {
            target: 'daemon',
            exportName: 'refreshAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(ExtensionProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      executableRegistryPath: '/tmp/acme/registry.json',
    }).success).toBe(false);

    expect(ExtensionProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      providersById: {
        acme: {
          id: 'acme',
          title: 'Acme',
          handler: {
            target: 'daemon',
            exportName: 'loadAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(ExtensionProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      backendsById: {
        'acme.backend': {
          id: 'acme.backend',
          providerId: 'acme',
          handler: {
            target: 'daemon',
            exportName: 'launchAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(ExtensionProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      uiDescriptorsById: {
        'acme.extension.settings': {
          id: 'acme.extension.settings',
          pluginId: 'acme.extension',
          surface: 'settings',
          title: 'Acme Settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
              componentModule: './SettingsPanel.js',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(ExtensionProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.extension.spawn-env': {
          id: 'acme.extension.spawn-env',
          pluginId: 'acme.extension',
          eventId: 'spawn.augmentEnv',
          handler: {
            target: 'daemon',
            exportName: 'augmentSpawnEnv',
          },
        },
      },
    }).success).toBe(false);
  });
});
