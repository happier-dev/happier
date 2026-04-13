import { describe, expect, it } from 'vitest';

import { buildPluginContributionRegistry } from './buildPluginContributionRegistry';

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
            schemaVersion: 1,
            id: 'acme.ohmypi',
            version: '1.0.0',
            displayName: 'Acme Oh My Pi',
            description: 'Adds Oh My Pi support',
            engines: {
              happier: '^0.2.0',
            },
            targets: {
              daemon: {
                entry: './daemon.js',
              },
            },
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
              hooks: [
                {
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
            },
          },
        },
      ],
    });

    expect(registry.providers).toHaveLength(1);
    expect(registry.backends).toHaveLength(1);
    expect(registry.hooks).toHaveLength(1);
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
  });
});
