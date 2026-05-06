import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from './normalize';

describe('readCanonicalPluginManifest', () => {
  it('preserves static MCP contribution families from v2 manifests', () => {
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
          backendClients: [
            {
              id: 'acme.client',
              kind: 'mcp.backendClient',
              version: '1.0.0',
              serverName: 'acme-hosted',
              toolNamespace: 'ext.acme',
            },
          ],
          tools: [
            {
              id: 'acme.tool',
              kind: 'mcp.tool',
              version: '1.0.0',
              name: 'ext.acme.search',
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
    expect(manifest?.contributes.mcp?.backendClients.map((client) => client.serverName)).toEqual(['acme-hosted']);
    expect(manifest?.contributes.mcp?.tools.map((tool) => tool.name)).toEqual(['ext.acme.search']);
    expect(manifest?.contributes.mcp?.discoveryProviders.map((provider) => provider.providerId)).toEqual(['acme']);
  });
});
