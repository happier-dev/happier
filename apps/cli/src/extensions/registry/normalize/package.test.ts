import { describe, expect, it } from 'vitest';

import { buildPluginContributionRegistry } from './package';

describe('buildPluginContributionRegistry', () => {
  it('flattens loaded plugin contributions while preserving plugin ownership metadata', () => {
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
              capabilities: ['providers', 'backends', 'actions', 'hooks'],
            },
            targets: {
              daemon: {
                entry: './daemon.js',
              },
            },
            permissions: [],
            contributions: {
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
                  runtimeAdapters: [],
                  capabilities: {},
                },
              ],
              actions: [
                {
                  kind: 'action',
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
                  kind: 'uiDescriptor',
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
              hooks: [
                {
                  kind: 'hook',
                  hookApiVersion: 1,
                  id: 'backend.terminalRuntime.bindTranscript',
                  category: 'integration',
                  scope: 'backend',
                  executionKind: 'integrate',
                  handler: {
                    target: 'plugin',
                    exportName: 'bindTranscript',
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
            contributions: {
              providers: [],
              backends: [],
              actions: [],
              tools: [],
              commands: [],
              resources: [
                {
                  kind: 'resource',
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
