import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectProviderMcpServers,
  type PluginMcpDiscoveryProviderEntry,
} from './detectProviderMcpServers';

type PluginMcpDiscoveryProviderRegistration =
  PluginMcpDiscoveryProviderEntry['registration'];

const runtimeLeaseMocks = vi.hoisted(() => ({
  acquireAuthoritativePluginRuntimeRegistryLease: vi.fn(),
  resolveExecutablePluginRuntimeRegistry: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease,
}));

vi.mock('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
  resolveExecutablePluginRuntimeRegistry: runtimeLeaseMocks.resolveExecutablePluginRuntimeRegistry,
}));

describe('detectProviderMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the authoritative plugin runtime registry lease for discovered providers when no providers are injected', async () => {
    const release = vi.fn(async () => {});
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'config',
      discover: async () => [{
        id: 'pi.config.docs',
        name: 'docs',
        transport: {
          kind: 'http',
          url: 'https://mcp.pi.example.test/http',
        },
      }],
    };
    const discoverMcpServersForDetection = vi.fn(async (
      input: Readonly<{ input: Parameters<typeof piDiscovery.discover>[0] }>,
    ) => await piDiscovery.discover(input.input));
    runtimeLeaseMocks.resolveExecutablePluginRuntimeRegistry.mockRejectedValue(
      new Error('direct executable registry must not be resolved'),
    );
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoveryProviders: [{
            pluginId: 'happier.agent.pi',
            definition: {
              id: 'config',
              title: 'Pi MCP discovery',
              metadata: { agentId: 'pi' },
            },
          }],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
    });

    expect(runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease).toHaveBeenCalledTimes(1);
    expect(runtimeLeaseMocks.resolveExecutablePluginRuntimeRegistry).not.toHaveBeenCalled();
    expect(discoverMcpServersForDetection).toHaveBeenCalledWith({
      pluginId: 'happier.agent.pi',
      localId: 'config',
      input: expect.objectContaining({ directory: '/tmp/project' }),
      signal: expect.any(AbortSignal),
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.servers).toEqual([expect.objectContaining({
      provider: 'pi',
      name: 'docs',
    })]);
  });

  it('does not bind an unowned declaration to another plugin registration with the same local id', async () => {
    const release = vi.fn(async () => {});
    const discover = vi.fn(async () => [{
      id: 'pi.config.foreign',
      name: 'foreign',
      transport: { kind: 'http' as const, url: 'https://foreign.example.test/mcp' },
    }]);
    const discoverMcpServersForDetection = vi.fn(async () => []);
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoveryProviders: [{
            definition: {
              id: 'pi.synthetic',
              title: 'Unowned Pi MCP discovery',
              metadata: { agentId: 'pi' },
            },
          }],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
    });

    expect(discoverMcpServersForDetection).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({
      provider: 'pi',
      code: 'read_failed',
      path: 'plugin:pi.synthetic',
      detail: 'Plugin MCP discovery provider is unavailable',
    })]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('activates every declared discovery-provider owner when detection has no provider filter', async () => {
    const release = vi.fn(async () => {});
    const registrations: Record<string, PluginMcpDiscoveryProviderRegistration> = {
      pi: {
        id: 'pi.synthetic',
        discover: async () => [],
      },
      opencode: {
        id: 'opencode.synthetic',
        discover: async () => [],
      },
    };
    const discoverMcpServersForDetection = vi.fn(async (request: Readonly<{
      localId: string;
      input: Parameters<PluginMcpDiscoveryProviderRegistration['discover']>[0];
    }>) => {
      const agentId = request.localId.split('.')[0];
      const registration = agentId ? registrations[agentId] : undefined;
      return await registration?.discover(request.input) ?? [];
    });
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoveryProviders: [
            {
              pluginId: 'happier.agent.pi',
              definition: { id: 'pi.synthetic', title: 'Pi MCP discovery', metadata: { agentId: 'pi' } },
            },
            {
              pluginId: 'happier.agent.opencode',
              definition: { id: 'opencode.synthetic', title: 'OpenCode MCP discovery', metadata: { agentId: 'opencode' } },
            },
          ],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: null,
      providers: [],
      env: {},
    });

    expect(discoverMcpServersForDetection).toHaveBeenCalledTimes(2);
    expect(discoverMcpServersForDetection).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: 'happier.agent.pi',
        localId: 'pi.synthetic',
    }));
    expect(discoverMcpServersForDetection).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: 'happier.agent.opencode',
        localId: 'opencode.synthetic',
    }));
    expect(result.warnings).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fans out over plugin MCP discovery providers and applies provider filtering generically', async () => {
    const calls: string[] = [];
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
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
    const openCodeDiscovery: PluginMcpDiscoveryProviderRegistration = {
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
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
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

  it('bounds a hung plugin discovery provider and continues detecting other providers', async () => {
    let timedOutSignal: AbortSignal | undefined;
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'pi.synthetic',
      discover: async () => await new Promise(() => {}),
    };
    const openCodeDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'opencode.synthetic',
      discover: async () => [{
        id: 'opencode.config.workspace',
        name: 'workspace',
        transport: {
          kind: 'sse',
          url: 'https://mcp.opencode.example.test/sse',
        },
      }],
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi', 'opencode'],
      env: {},
      discoveryTimeoutMs: 5,
      mcpDiscoveryProviders: [
        {
          pluginId: 'happier.agent.pi',
          registration: piDiscovery,
          discover: async (_input, signal) => {
            timedOutSignal = signal;
            return await new Promise(() => {});
          },
        },
        { pluginId: 'happier.agent.opencode', registration: openCodeDiscovery },
      ],
    });

    expect(result.warnings).toEqual([{
      provider: 'pi',
      code: 'read_failed',
      detail: 'Plugin MCP discovery timed out',
    }]);
    expect(timedOutSignal?.aborted).toBe(true);
    expect(result.servers).toEqual([{
      provider: 'opencode',
      name: 'workspace',
      transport: 'sse',
      remote: {
        url: 'https://mcp.opencode.example.test/sse',
        headers: [],
      },
      envKeys: [],
      enabled: null,
      source: {
        kind: 'project',
        path: 'plugin:opencode.synthetic',
      },
    }]);
  }, 1_000);

  it('accepts discovery stdio env key placeholders without leaking env values', async () => {
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.env',
          name: 'env',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'env-mcp',
              args: ['--stdio'],
              env: {
                API_TOKEN: '',
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

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([{
      provider: 'pi',
      name: 'env',
      transport: 'stdio',
      stdio: {
        command: 'env-mcp',
        args: ['--stdio'],
      },
      envKeys: ['API_TOKEN'],
      enabled: null,
      source: {
        kind: 'project',
        path: 'plugin:pi.synthetic',
      },
    }]);
    expect(JSON.stringify(result)).not.toContain('API_TOKEN:');
  });

  it('drops plugin discovery servers that contain raw secret-shaped runtime material', async () => {
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
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

  it('drops remote discovery servers with benign URL fragments at the canonical MCP URL boundary', async () => {
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.fragment',
          name: 'fragment',
          transport: {
            kind: 'http',
            url: 'https://mcp.pi.example.test/http#section',
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
  });

  it('drops plugin discovery servers that contain raw env values', async () => {
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.env-secret',
          name: 'env-secret',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'env-secret-mcp',
              args: ['--stdio'],
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
    expect(JSON.stringify(result)).not.toContain('secret-env-value');
  });

  it('drops plugin discovery servers that expose malformed env key placeholders', async () => {
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.env-malformed',
          name: 'env-malformed',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'env-malformed-mcp',
              args: ['--stdio'],
              env: {
                'API_TOKEN=secret-env-value': '',
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
    expect(JSON.stringify(result)).not.toContain('secret-env-value');
  });

  it('drops plugin discovery servers that expose oversized env key placeholders', async () => {
    const longEnvKey = `API_${'A'.repeat(200)}`;
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        servers: [{
          id: 'pi.config.env-long',
          name: 'env-long',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'env-long-mcp',
              args: ['--stdio'],
              env: {
                [longEnvKey]: '',
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
    expect(JSON.stringify(result)).not.toContain(longEnvKey);
  });

  it('drops plugin discovery servers that contain sensitive stdio argv flags', async () => {
    const piDiscovery: PluginMcpDiscoveryProviderRegistration = {
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
