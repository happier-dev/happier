import { describe, expect, it } from 'vitest';

import {
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  PluginProjectionV2Schema,
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

  it('parses a v2 describe response payload that carries the authoritative plugin projection', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 2,
        generation: 7,
        installedPackagesById: {
          'acme.plugin': {
            id: 'acme.plugin',
            displayName: 'Acme Plugin',
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
    expect(parsed.projection.installedPackagesById['acme.plugin']?.displayName).toBe('Acme Plugin');
  });

  it('parses v2 plugin projection descriptors without executable handler internals', () => {
    expect(typeof PluginProjectionV2Schema?.parse).toBe('function');
    expect(typeof (protocol as { PluginProjectedHookV2Schema?: unknown }).PluginProjectedHookV2Schema).toBe('object');
    expect((protocol as { ExtensionProjectionV2Schema?: unknown }).ExtensionProjectionV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectedHookV2Schema?: unknown }).ExtensionProjectedHookV2Schema).toBeUndefined();

    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      installedPackagesById: {
        'acme.plugin': {
          id: 'acme.plugin',
          displayName: 'Acme Plugin',
          version: '1.2.3',
          enabled: true,
          source: {
            kind: 'path',
            locator: '/tmp/acme',
          },
        },
      },
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['settings'],
          placement: 'primary',
          dangerLevel: 'safe',
          available: true,
        },
      },
      toolsById: {
        'acme.plugin.search': {
          id: 'acme.plugin.search',
          pluginId: 'acme.plugin',
          title: 'Search Acme',
          exposesToAgent: true,
        },
      },
      commandsById: {
        'acme.plugin.reload': {
          id: 'acme.plugin.reload',
          pluginId: 'acme.plugin',
          title: 'Reload Acme',
          surfaces: ['agentSlash'],
          tokens: ['acme-reload'],
        },
      },
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'spawn.augmentEnv',
          priority: 10,
        },
      },
      resourcesById: {
        'acme.plugin.prompt': {
          id: 'acme.plugin.prompt',
          pluginId: 'acme.plugin',
          resourceKind: 'prompt',
          path: 'resources/prompt.md',
          digest: 'sha256:abc123',
        },
      },
      uiDescriptorsById: {
        'acme.plugin.settings': {
          id: 'acme.plugin.settings',
          pluginId: 'acme.plugin',
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
              actionId: 'acme.plugin.refresh',
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
          code: 'plugin.futureCapability',
          message: 'Unsupported future capability',
          pluginId: 'acme.plugin',
        },
      ],
    });

    expect(parsed.generation).toBe(7);
    expect(parsed.actionsById['acme.plugin.refresh']?.available).toBe(true);
    expect(parsed.hooksById?.['acme.plugin.spawn-env']?.eventId).toBe('spawn.augmentEnv');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.surface).toBe('settings');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.order).toBe(10);
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.tone).toBe('info');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.helpUrl).toBe('https://example.com/acme/settings');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.fields[0]).toMatchObject({
      id: 'enabled',
      type: 'boolean',
      title: 'Enabled',
    });
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.fields[1]).toMatchObject({
      id: 'runRefresh',
      type: 'action',
      actionId: 'acme.plugin.refresh',
    });

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
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

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      executableRegistryPath: '/tmp/acme/registry.json',
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
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

    expect(PluginProjectionV2Schema.safeParse({
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

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      uiDescriptorsById: {
        'acme.plugin.settings': {
          id: 'acme.plugin.settings',
          pluginId: 'acme.plugin',
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

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'spawn.augmentEnv',
          handler: {
            target: 'daemon',
            exportName: 'augmentSpawnEnv',
          },
        },
      },
    }).success).toBe(false);
  });

  it('parses sibling-owned non-agent family projections without changing core projection fields', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              id: 'github',
              pluginId: 'acme.scm',
              title: 'GitHub',
              hostPattern: 'github.com',
            },
          },
        },
      },
    });

    expect(parsed.familiesById.scmHostingProviders?.entriesById.github).toEqual({
      id: 'github',
      pluginId: 'acme.scm',
      title: 'GitHub',
      hostPattern: 'github.com',
    });
    expect(parsed.providersById).toEqual({});
    expect(parsed.backendsById).toEqual({});
  });
});
