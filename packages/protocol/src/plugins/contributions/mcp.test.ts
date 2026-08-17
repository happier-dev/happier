import { describe, expect, it } from 'vitest';

import {
  PluginMcpContributesV1Schema,
} from './mcp.js';

describe('MCP plugin contribution schemas', () => {
  it('defaults absent MCP contributions to empty arrays', () => {
    expect(PluginMcpContributesV1Schema.parse(undefined)).toEqual({
      servers: [],
      discoverySources: [],
    });
  });

  it('does not retain the provider-named discovery declaration alias', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      discoveryProviders: [],
    }).success).toBe(false);
  });

  it('rejects retired discovery ownership fields', () => {
    for (const retiredField of ['providerId', 'agentId']) {
      expect(PluginMcpContributesV1Schema.safeParse({
        discoverySources: [{
          id: 'discovery',
          title: 'Discovery',
          [retiredField]: 'acme',
        }],
      }).success).toBe(false);
    }
  });

  it('rejects retired backend-client and direct-tool descriptor families', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      backendClients: [{ id: 'client' }],
    }).success).toBe(false);

    expect(PluginMcpContributesV1Schema.safeParse({
      tools: [{ id: 'tool' }],
    }).success).toBe(false);
  });

  it('rejects raw or referenced credential fields outside the strict transport contract', () => {
    for (const headers of [
      { Authorization: 'Bearer raw-value' },
      { 'x-api-key': { t: 'valueRef', ref: 'acme.api-key' } },
    ]) {
      expect(PluginMcpContributesV1Schema.safeParse({
        servers: [{
          id: 'remote',
          title: 'Remote',
          kind: 'static',
          transport: {
            kind: 'http',
            url: 'https://mcp.example.test',
            headers,
          },
        }],
      }).success).toBe(false);
    }
  });

  it('rejects credential-bearing remote MCP URLs', () => {
    for (const url of [
      'https://user:pass@mcp.example.test',
      'https://mcp.example.test?token=raw-token',
      'https://mcp.example.test?api_key=raw-key',
      'https://mcp.example.test?client-secret=raw-secret',
      'https://mcp.example.test?proxyAuthorization=raw-authorization',
      'https://mcp.example.test?credentials=raw-credentials',
      'https://mcp.example.test?pat=raw-pat',
      'https://mcp.example.test?authorization=Bearer%20raw-token',
      'https://mcp.example.test?session=Bearer%20raw-token',
      'https://mcp.example.test#access_token=raw-token',
      'https://mcp.example.test#refresh-token=raw-token',
      'https://mcp.example.test#session=Bearer%20raw-token',
    ]) {
      expect(PluginMcpContributesV1Schema.safeParse({
        servers: [{
          id: 'remote',
          title: 'Remote',
          kind: 'static',
          transport: { kind: 'http', url },
        }],
      }).success).toBe(false);
    }
  });

  it('rejects every remote MCP URL fragment because no transport consumer uses fragments', () => {
    expect(PluginMcpContributesV1Schema.safeParse({
      servers: [{
        id: 'remote',
        title: 'Remote',
        kind: 'static',
        transport: {
          kind: 'http',
          url: 'https://mcp.example.test/tools#section',
        },
      }],
    }).success).toBe(false);
  });

  it('accepts a credential-free remote MCP URL', () => {
    for (const url of [
      'https://mcp.example.test/tools?locale=en',
      'https://mcp.example.test/tools?author=alice',
      'https://mcp.example.test/tools?authority=central',
      'https://mcp.example.test/tools?authored_by=alice',
      'https://mcp.example.test/tools?tokenizer=standard',
      'https://mcp.example.test/tools?secretary=alice',
      'https://mcp.example.test/tools?passwordless=true',
      'https://mcp.example.test/tools?client_id=public-client&public_key=public-key',
    ]) {
      expect(PluginMcpContributesV1Schema.safeParse({
        servers: [{
          id: 'remote',
          title: 'Remote',
          kind: 'static',
          transport: { kind: 'http', url },
        }],
      }).success).toBe(true);
    }
  });

  it('returns a failed safeParse result for an invalid remote URL without throwing', () => {
    const parse = () => PluginMcpContributesV1Schema.safeParse({
      servers: [{
        id: 'remote',
        title: 'Remote',
        kind: 'static',
        transport: {
          kind: 'http',
          url: 'not a URL',
        },
      }],
    });

    expect(parse).not.toThrow();
    expect(parse().success).toBe(false);
  });
});
