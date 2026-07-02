import { describe, expect, it } from 'vitest';
import { normalizePluginBackendCapabilitiesV1 } from '@happier-dev/protocol';

import { buildPluginContributionRegistry } from './package';

describe('buildPluginContributionRegistry', () => {
  it('flattens loaded plugin contributes while preserving plugin ownership metadata', () => {
    const registry = buildPluginContributionRegistry({
      loadedPlugins: [
        {
          pluginId: 'acme.ohmypi',
          pluginRootPath: '/plugins/acme-ohmypi',
          manifestPath: '/plugins/acme-ohmypi/.happier-plugin/plugin.json',
          manifestDigest: 'sha256:abc123',
          daemonEntryPath: '/plugins/acme-ohmypi/daemon.js',
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
            runtime: {
              apiVersion: 1,
              capabilities: ['agents', 'backends', 'actions', 'hooks'],
            },
            targets: {
              daemon: {
                entry: './daemon.js',
              },
            },
            permissions: [],
            optionalPermissions: [],
            contributes: {
              providers: [
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
              backends: [
                {
                  kindVersion: 1,
                  id: 'ohMyPi.acp',
                  providerId: 'ohMyPi',
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
                  surfaces: ['cli'],
                  placement: 'commandPalette',
                  dangerLevel: 'safe',
                  permissions: [],
                  handler: {
                    target: 'daemon',
                    exportName: 'startReview',
                  },
                },
              ],
              tools: [],
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
                    providerId: 'acme.ohmypi',
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
                  id: 'backend.resolveRuntimePrerequisites',
                  category: 'decision',
                  scope: 'backend',
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

    expect(registry.providers).toHaveLength(1);
    expect(registry.backends).toHaveLength(1);
    expect(registry.actions).toHaveLength(1);
    expect(registry.hooks).toHaveLength(1);
    expect(registry.uiDescriptors).toHaveLength(1);
    expect(registry.notifications).toHaveLength(1);
    expect(registry.notificationChannels).toHaveLength(1);
    expect(registry.events).toHaveLength(1);
    expect(registry.executionRunProfiles).toHaveLength(1);
    expect(registry.requestInterceptors).toHaveLength(1);
    expect(registry.mcpServers).toHaveLength(1);
    expect(registry.mcpDiscoveryProviders).toHaveLength(1);
    expect(registry.providers[0]).toMatchObject({
      pluginId: 'acme.ohmypi',
      definition: {
        id: 'ohMyPi',
      },
    });
    expect(registry.backends[0]).toMatchObject({
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
            runtime: {
              apiVersion: 1,
              capabilities: ['resources'],
            },
            targets: {
              daemon: {
                entry: './daemon.js',
              },
            },
            permissions: [],
            optionalPermissions: [],
            contributes: {
              providers: [],
              backends: [],
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
});
