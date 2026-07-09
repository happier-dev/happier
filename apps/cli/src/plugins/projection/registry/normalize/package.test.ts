import { describe, expect, it } from 'vitest';
import { normalizePluginBackendCapabilitiesV1 } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { buildPluginContributionRegistry } from './package';

function createLoadedPlugin(contributes: Partial<LoadedPlugin['manifest']['contributes']>): LoadedPlugin {
  return {
    pluginId: 'acme.lifecycle',
    pluginRootPath: '/plugins/acme-lifecycle',
    manifestPath: '/plugins/acme-lifecycle/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:lifecycle',
    daemonEntryPath: '/plugins/acme-lifecycle/daemon.js',
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: '/plugins/acme-lifecycle',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: {
      schemaVersion: 2,
      id: 'acme.lifecycle',
      version: '1.0.0',
      displayName: 'Acme Lifecycle',
      description: 'Adds lifecycle handlers',
      engines: {
        happier: '^0.2.0',
      },
      activationEvents: [],
      uses: ['lifecycle'],
      entrypoints: {
        main: './daemon.js',
      },
      permissions: [],
      optionalPermissions: [],
      contributes: {
        agents: [],
        agentRuntimes: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        uiDescriptors: [],
        hooks: [],
        lifecycleHandlers: [],
        ...contributes,
      },
    },
  };
}

describe('buildPluginContributionRegistry', () => {
  it('rejects lifecycle contributions without stable ids instead of synthesizing projection ids', () => {
    expect(() => buildPluginContributionRegistry({
      loadedPlugins: [
        createLoadedPlugin({
          lifecycleHandlers: [
            {
              event: 'activated',
              handler: { target: 'daemon', registrationId: 'activated' },
            },
          ],
        }),
      ],
    })).toThrow(/stable lifecycle handler id/);
  });

  it('flattens loaded plugin contributes while preserving plugin ownership metadata', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        {
          pluginId: 'acme.ohmypi',
          pluginRootPath: '/plugins/acme-ohmypi',
          manifestPath: '/plugins/acme-ohmypi/.happier-plugin/plugin.json',
          manifestDigest: 'sha256:abc123',
          daemonEntryPath: '/plugins/acme-ohmypi/daemon.js',
          devDaemonEntryPath: null,
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme-ohmypi',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          manifest: {
            schemaVersion: 2,
            id: 'acme.ohmypi',
            version: '1.0.0',
            displayName: 'Acme Oh My Pi',
            description: 'Adds Oh My Pi support',
            engines: {
              happier: '^0.2.0',
            },
            activationEvents: [],
            uses: ['agents', 'actions', 'hooks'],
            entrypoints: {
              main: './daemon.js',
            },
            permissions: [],
            optionalPermissions: [],
            contributes: {
              agents: [
                {
                  kindVersion: 1,
                  id: 'ohMyPi',
                  display: {
                    name: 'Oh My Pi',
                    tags: ['acp'],
                  },
                  ownedBackendIds: ['ohMyPi.acp'],
                },
              ],
              agentRuntimes: [
                {
                  kindVersion: 1,
                  id: 'ohMyPi.acp',
                  agentId: 'ohMyPi',
                  runtimeKind: 'acp',
                  surfaceHandlers: [],
                  capabilities: normalizePluginBackendCapabilitiesV1({ executionRun: { supported: true } }),
                },
              ],
              actions: [
                {
                  id: 'ohMyPi.review.start',
                  title: 'Start review',
                  description: 'Starts the plugin review flow',
                  scopes: ['global'],
                  surfaces: ['cli', 'mcp', 'agent'],
                  placement: 'commandPalette',
                  dangerLevel: 'safe',
                  permissions: [],
                  handler: {
                    target: 'daemon',
                    exportName: 'startReview',
                  },
                },
              ],
              tools: [
                {
                  id: 'ohMyPi.review.tool',
                  name: 'ohmypi_review_tool',
                  title: 'Review tool',
                  description: 'Runs review from the agent surface',
                  safety: 'safe',
                  surfaces: ['agent'],
                  promptSnippet: 'Use ohmypi_review_tool when the user requests an Oh My Pi review.',
                  promptGuidelines: [
                    'Do not call ohmypi_review_tool for unrelated code search.',
                    'Report only review facts returned by the tool.',
                  ],
                  handler: {
                    target: 'daemon',
                    registrationId: 'ohMyPi.review.tool',
                  },
                },
              ],
              commands: [],
              resources: [],
              uiDescriptors: [
                {
                  id: 'acme.ohmypi.settings',
                  surface: 'settings',
                  title: 'Oh My Pi settings',
                  description: 'Host-rendered plugin settings',
                  order: 4,
                  tone: 'warning',
                  featureGate: null,
                  helpUrl: 'https://example.com/ohmypi/docs',
                  fields: [
                    {
                      id: 'startReview',
                      type: 'action',
                      title: 'Start review',
                      description: 'Kick off review flow',
                      actionId: 'ohMyPi.review.start',
                      order: 1,
                      groupId: 'actions',
                      featureGate: null,
                      options: [],
                    },
                  ],
                },
              ],
              notifications: [
                {
                  id: 'acme.ohmypi.ready',
                  kind: 'activity',
                  title: 'Oh My Pi ready',
                  eventIds: ['ready'],
                  defaultChannelIds: [],
                },
              ],
              events: [
                {
                  id: 'review/ready',
                  payloadSchema: {
                    type: 'object',
                    properties: {
                      reviewId: { type: 'string' },
                    },
                  },
                  description: 'Review ready event',
                },
              ],
              notificationChannels: [
                {
                  id: 'acme.ohmypi.webhook',
                  kind: 'webhook',
                  title: 'Oh My Pi webhook',
                  configurable: false,
                  defaultEnabled: true,
                },
              ],
              executionRunProfiles: [
                {
                  id: 'acme.ohmypi.review',
                  kind: 'executionRun.profile',
                  version: '1.0.0',
                  intent: 'review',
                  displayKey: 'plugins.acme.ohmypi.executionRuns.review.label',
                  capabilityGates: [],
                  permissionGates: [],
                  redaction: 'none',
                  hidden: false,
                  actionIds: [],
                },
              ],
              requestInterceptors: [
                {
                  id: 'acme.ohmypi.egress',
                  order: 20,
                  targets: [
                    {
                      scope: 'plugin-fetch',
                      urlOrigins: ['https://api.example.test'],
                    },
                  ],
                },
              ],
              mcp: {
                servers: [
                  {
                    id: 'acme.ohmypi.mcp',
                    kind: 'mcp.server',
                    version: '1.0.0',
                    name: 'ohmypi-hosted',
                    transport: 'hosted',
                    capabilityGates: [],
                    permissionGates: [],
                    redaction: 'none',
                    hidden: false,
                    args: [],
                  },
                ],
                discoveryProviders: [
                  {
                    id: 'acme.ohmypi.mcp.discovery',
                    kind: 'mcp.discoveryProvider',
                    version: '1.0.0',
                    agentId: 'acme.ohmypi',
                    capabilityGates: [],
                    permissionGates: [],
                    redaction: 'none',
                    hidden: false,
                  },
                ],
              },
              hooks: [
                {
                  hookApiVersion: 1,
                  id: 'agent.resolvePrerequisites',
                  category: 'decision',
                  scope: 'agent',
                  executionKind: 'decide',
                  handler: {
                    target: 'plugin',
                    exportName: 'resolveTranscriptBinding',
                  },
                },
              ],
              lifecycleHandlers: [],
            },
          },
        },
      ],
    });

    expect(registry.agents).toHaveLength(1);
    expect(registry.agentRuntimes).toHaveLength(1);
    expect(registry.actions).toHaveLength(1);
    expect(registry.actions[0]?.definition.surfaces).toEqual(expect.objectContaining({
      cli: true,
      mcp: true,
      agent: true,
    }));
    const legacyAgentSurface = 'session_' + 'agent';
    expect(registry.actions[0]?.definition.surfaces).not.toHaveProperty(legacyAgentSurface);
    expect(registry.tools).toHaveLength(1);
    expect(registry.tools[0]?.definition.surfaces).toEqual({
      cli: false,
      mcp: false,
      agent: true,
    });
    expect(registry.tools[0]?.definition.surfaces).not.toHaveProperty(legacyAgentSurface);
    expect(registry.tools[0]?.definition).toMatchObject({
      promptSnippet: 'Use ohmypi_review_tool when the user requests an Oh My Pi review.',
      promptGuidelines: [
        'Do not call ohmypi_review_tool for unrelated code search.',
        'Report only review facts returned by the tool.',
      ],
      execution: {
        routing: 'daemon',
        handler: {
          target: 'daemon',
          registrationId: 'ohMyPi.review.tool',
        },
      },
    });
    expect(registry.hooks).toHaveLength(1);
    expect(registry.uiDescriptors).toHaveLength(1);
    expect(registry.notifications).toHaveLength(1);
    expect(registry.notificationChannels).toHaveLength(1);
    expect(registry.events).toHaveLength(1);
    expect(registry.executionRunProfiles).toHaveLength(1);
    expect(registry.requestInterceptors).toHaveLength(1);
    expect(registry.mcpServers).toHaveLength(1);
    expect(registry.mcpDiscoveryProviders).toHaveLength(1);
    expect(registry.agents[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'ohMyPi',
      },
    });
    expect(registry.agentRuntimes[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'ohMyPi.acp',
      },
    });
    expect(registry.uiDescriptors[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi.settings',
        surface: 'settings',
        title: 'Oh My Pi settings',
        description: 'Host-rendered plugin settings',
        order: 4,
        tone: 'warning',
        featureGate: null,
        helpUrl: 'https://example.com/ohmypi/docs',
        fields: [
          expect.objectContaining({
            id: 'startReview',
            kind: 'action',
            title: 'Start review',
            actionId: 'ohMyPi.review.start',
            order: 1,
            groupId: 'actions',
          }),
        ],
      },
    });
    expect(registry.notifications[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi.ready',
        kind: 'activity',
        title: 'Oh My Pi ready',
        eventIds: ['ready'],
      },
    });
    expect(registry.notificationChannels[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi.webhook',
        kind: 'webhook',
        title: 'Oh My Pi webhook',
      },
    });
    expect(registry.events[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi/review/ready',
        localId: 'review/ready',
        description: 'Review ready event',
      },
    });
    expect(registry.executionRunProfiles[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi.review',
        kind: 'executionRun.profile',
        intent: 'review',
      },
    });
    expect(registry.requestInterceptors[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi.egress',
        order: 20,
        targets: [
          {
            scope: 'plugin-fetch',
            urlOrigins: ['https://api.example.test'],
          },
        ],
      },
    });
    expect(registry.mcpServers[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'acme.ohmypi.mcp',
        name: 'ohmypi-hosted',
      },
    });
  });

  it('fails closed for plugin resources whose declared path escapes the package root', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        {
          pluginId: 'acme.resources',
          pluginRootPath: '/plugins/acme-resources',
          manifestPath: '/plugins/acme-resources/.happier-plugin/plugin.json',
          manifestDigest: 'sha256:resources',
          daemonEntryPath: '/plugins/acme-resources/daemon.js',
          devDaemonEntryPath: null,
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme-resources',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          manifest: {
            schemaVersion: 2,
            id: 'acme.resources',
            version: '1.0.0',
            displayName: 'Acme Resources',
            description: 'Adds prompt resources',
            engines: {
              happier: '^0.2.0',
            },
            activationEvents: [],
            uses: ['resources'],
            entrypoints: {
              main: './daemon.js',
            },
            permissions: [],
            optionalPermissions: [],
            contributes: {
              agents: [],
              agentRuntimes: [],
              actions: [],
              tools: [],
              commands: [],
              resources: [
                {
                  id: 'acme.prompt',
                  resourceKind: 'prompt',
                  path: '../outside.md',
                },
              ],
              uiDescriptors: [],
              hooks: [],
              lifecycleHandlers: [],
            },
          },
        },
      ],
    });

    expect(registry.resources).toEqual([]);
  });

  it('flattens plugin browser targets and actions with plugin ownership metadata', () => {
    const display = {
      title: 'Preview',
      iconToken: 'browser',
      tone: 'info',
    } as const;
    const target = {
      kind: 'hostedPluginWeb',
      targetId: 'target_1',
      pluginId: 'acme.browser',
      contributionId: 'preview-web',
      display,
    } as const;

    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        createLoadedPlugin({
          browserTargets: [
            {
              id: 'preview-target',
              target,
              display,
              featureGate: 'browser.viewTargets',
            },
          ],
          browserActions: [
            {
              id: 'open-preview',
              kind: 'openTarget',
              target,
              display,
              policy: {
                requiredFeatureIds: ['browser.viewTargets'],
                requiredPermissionIds: [],
                profileMode: 'session',
              },
            },
          ],
        }),
      ],
    });

    expect(registry.browserTargets).toHaveLength(1);
    expect(registry.browserActions).toHaveLength(1);
    expect(registry.browserTargets[0]).toMatchObject({
      pluginId: 'acme.lifecycle',
      definition: {
        id: 'preview-target',
        target: { kind: 'hostedPluginWeb', contributionId: 'preview-web' },
      },
    });
    expect(registry.browserActions[0]).toMatchObject({
      pluginId: 'acme.lifecycle',
      definition: {
        id: 'open-preview',
        kind: 'openTarget',
      },
    });
  });
});
