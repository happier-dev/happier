import { describe, expect, it } from 'vitest';

import type { PluginApiMcpDiscoveryProviderRegistrationV1 } from '@happier-dev/plugin-sdk';

import { detectProviderMcpServers } from './detectProviderMcpServers';

describe('detectProviderMcpServers', () => {
  it('fans out over plugin MCP discovery providers and applies provider filtering generically', async () => {
    const calls: string[] = [];
    const piDiscovery: PluginApiMcpDiscoveryProviderRegistrationV1 = {
      id: 'pi.synthetic',
      discover: async (input) => {
        calls.push(`pi:${input?.directory ?? ''}`);
        return [{
          id: 'pi.config.docs',
          name: 'docs',
          transport: {
            kind: 'http',
            url: 'https://mcp.pi.example.test/http',
          },
        }];
      },
    };
    const openCodeDiscovery: PluginApiMcpDiscoveryProviderRegistrationV1 = {
      id: 'opencode.synthetic',
      discover: async () => {
        calls.push('opencode');
        return [{
          id: 'opencode.config.workspace',
          name: 'workspace',
          transport: {
            kind: 'sse',
            url: 'https://mcp.opencode.example.test/sse',
          },
        }];
      },
    };

    const params = {
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoveryProviders: [
        { pluginId: 'happier.agent.pi', registration: piDiscovery },
        { pluginId: 'happier.agent.opencode', registration: openCodeDiscovery },
      ],
    };
    const result = await detectProviderMcpServers(params);

    expect(calls).toEqual(['pi:/tmp/project']);
    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([{
      provider: 'pi',
      name: 'docs',
      transport: 'http',
      remote: {
        url: 'https://mcp.pi.example.test/http',
        headers: [],
      },
      envKeys: [],
      enabled: null,
      source: {
        kind: 'project',
        path: 'plugin:pi.synthetic',
      },
    }]);
  });

  it('propagates plugin discovery warnings from generic fanout results', async () => {
    const piDiscovery: PluginApiMcpDiscoveryProviderRegistrationV1 = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [],
        warnings: [{
          provider: 'pi',
          code: 'parse_failed',
          path: '/tmp/project/.pi/mcp.json',
        }],
      }),
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoveryProviders: [
        { pluginId: 'happier.agent.pi', registration: piDiscovery },
      ],
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([{
      provider: 'pi',
      code: 'parse_failed',
      path: '/tmp/project/.pi/mcp.json',
    }]);
  });

  it('drops plugin discovery servers that contain raw secret-shaped runtime material', async () => {
    const piDiscovery: PluginApiMcpDiscoveryProviderRegistrationV1 = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.secret',
          name: 'secret',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'secret-mcp',
              args: ['--auth', 'Bearer secret-token'],
              env: {
                API_TOKEN: 'secret-env-value',
              },
            },
          },
        }],
        warnings: [],
      }),
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoveryProviders: [
        { pluginId: 'happier.agent.pi', registration: piDiscovery },
      ],
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([{
      provider: 'pi',
      code: 'unsupported',
      path: 'plugin:pi.synthetic',
    }]);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('API_TOKEN');
    expect(JSON.stringify(result)).not.toContain('secret-env-value');
  });

  it('drops plugin discovery servers that contain sensitive stdio argv flags', async () => {
    const piDiscovery: PluginApiMcpDiscoveryProviderRegistrationV1 = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.argv',
          name: 'argv',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'argv-mcp',
              args: ['--token', 'raw-token-value'],
            },
          },
        }],
        warnings: [],
      }),
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoveryProviders: [
        { pluginId: 'happier.agent.pi', registration: piDiscovery },
      ],
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([{
      provider: 'pi',
      code: 'unsupported',
      path: 'plugin:pi.synthetic',
    }]);
    expect(JSON.stringify(result)).not.toContain('--token');
    expect(JSON.stringify(result)).not.toContain('raw-token-value');
  });
});
