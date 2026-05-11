import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from './normalize';

describe('readCanonicalPluginManifest', () => {
  it('preserves surviving static MCP contribution families from v2 manifests', () => {
    const manifest = readCanonicalPluginManifest({
      schemaVersion: 2,
      id: 'acme.mcp',
      version: '1.0.0',
      displayName: 'Acme MCP',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1, capabilities: ['mcp'] },
      capabilities: { permissions: [] },
      targets: {},
      contributes: {
        mcp: {
          servers: [
            {
              id: 'acme.hosted',
              kind: 'mcp.server',
              version: '1.0.0',
              name: 'acme-hosted',
              transport: 'hosted',
            },
          ],
          discoveryProviders: [
            {
              id: 'acme.discovery',
              kind: 'mcp.discoveryProvider',
              version: '1.0.0',
              providerId: 'acme',
            },
          ],
        },
      },
    });

    expect(manifest?.contributes.mcp?.servers.map((server) => server.name)).toEqual(['acme-hosted']);
    expect(manifest?.contributes.mcp?.discoveryProviders.map((provider) => provider.providerId)).toEqual(['acme']);
  });
});
