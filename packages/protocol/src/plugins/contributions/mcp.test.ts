import { describe, expect, it } from 'vitest';

import {
  PluginMcpContributesV1Schema,
} from './mcp.js';

describe('MCP plugin contribution schemas', () => {
  it('defaults absent MCP contributions to empty arrays', () => {
    expect(PluginMcpContributesV1Schema.parse(undefined)).toEqual({
      servers: [],
      discoveryProviders: [],
    });
  });

  it('accepts static MCP server and discovery-provider descriptors', () => {
    const parsed = PluginMcpContributesV1Schema.parse({
      servers: [
        {
          id: 'acme.hosted',
          kind: 'mcp.server',
          version: '1.0.0',
          name: 'acme-hosted',
          transport: 'hosted',
          displayKey: 'plugins.acme.mcp.hosted.title',
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
    });

    expect(parsed.servers.map((server) => server.name)).toEqual(['acme-hosted']);
    expect(parsed.discoveryProviders.map((provider) => provider.providerId)).toEqual(['acme']);
  });

  it('rejects retired static MCP backend-client and direct-tool descriptors', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      backendClients: [
        {
          id: 'acme.backendClient',
          kind: 'mcp.backendClient',
          version: '1.0.0',
          serverName: 'acme-hosted',
          toolNamespace: 'ext.acme',
        },
      ],
    }).success).toBe(false);

    expect(PluginMcpContributesV1Schema.safeParse({
      tools: [
        {
          id: 'acme.tool',
          kind: 'mcp.tool',
          version: '1.0.0',
          name: 'ext.acme.search',
        },
      ],
    }).success).toBe(false);
  });

  it('rejects raw credential-shaped fields in plugin MCP descriptors', () => {
    const result = PluginMcpContributesV1Schema.safeParse({
      servers: [
        {
          id: 'acme.remote',
          kind: 'mcp.server',
          version: '1.0.0',
          name: 'acme-remote',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: {
            Authorization: {
              token: 'raw-value',
            },
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects raw MCP token and secret fields that are not authorization headers', () => {
    const result = PluginMcpContributesV1Schema.safeParse({
      servers: [
        {
          id: 'acme.remote',
          kind: 'mcp.server',
          version: '1.0.0',
          name: 'acme-remote',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: {
            'x-api-key': 'raw-key',
            'X-GitHub-Token': 'raw-token',
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects credential-bearing remote MCP descriptor URLs', () => {
    for (const url of [
      'https://user:pass@mcp.example.test',
      'https://mcp.example.test?token=raw-token',
      'https://mcp.example.test?api_key=raw-key',
      'https://mcp.example.test#access_token=raw-token',
    ]) {
      expect(PluginMcpContributesV1Schema.safeParse({
        servers: [
          {
            id: 'acme.remote',
            kind: 'mcp.server',
            version: '1.0.0',
            name: 'acme-remote',
            transport: 'http',
            url,
          },
        ],
      }).success).toBe(false);
    }
  });

  it('allows MCP token and secret fields when they use value references', () => {
    const result = PluginMcpContributesV1Schema.safeParse({
      servers: [
        {
          id: 'acme.remote',
          kind: 'mcp.server',
          version: '1.0.0',
          name: 'acme-remote',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: {
            'x-api-key': { t: 'valueRef', ref: 'acme.apiKey' },
            'X-GitHub-Token': { t: 'valueRef', ref: 'acme.githubToken' },
          },
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects nested authorization material while allowing value-reference descriptors', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      servers: [
        {
          id: 'acme.remote',
          kind: 'mcp.server',
          version: '1.0.0',
          name: 'acme-remote',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: {
            Authorization: 'Bearer raw-value',
          },
        },
      ],
    }).success).toBe(false);

    expect(PluginMcpContributesV1Schema.safeParse({
      servers: [
        {
          id: 'acme.remote',
          kind: 'mcp.server',
          version: '1.0.0',
          name: 'acme-remote',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: {
            Authorization: {
              t: 'valueRef',
              ref: 'acme.remote.authorization',
            },
          },
        },
      ],
    }).success).toBe(true);
  });

  it('rejects nested raw authorization material in discovery-provider descriptors', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      discoveryProviders: [
        {
          id: 'acme.discovery',
          kind: 'mcp.discoveryProvider',
          version: '1.0.0',
          providerId: 'acme',
          headers: {
            Authorization: 'Bearer raw-value',
          },
        },
      ],
    }).success).toBe(false);
  });
});
