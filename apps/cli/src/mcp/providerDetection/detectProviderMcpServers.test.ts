import { AGENT_IDS } from '@happier-dev/agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectProviderMcpServers,
  type PluginMcpDiscoverySourceEntry,
} from './detectProviderMcpServers';

type PluginMcpDiscoverySourceRegistration =
  PluginMcpDiscoverySourceEntry['registration'];

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
    const piDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'config',
      discover: async () => ({
        endpoints: [{
          id: 'pi.config.docs',
          name: 'docs',
          kind: 'http',
          url: 'https://mcp.pi.example.test/http',
        }],
      }),
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
          mcpDiscoverySources: [{
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
      input: { directory: '/tmp/project' },
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
    const discover = vi.fn(async () => ({
      endpoints: [{
        id: 'pi.config.foreign',
        name: 'foreign',
        kind: 'http' as const,
        url: 'https://foreign.example.test/mcp',
      }],
    }));
    const discoverMcpServersForDetection = vi.fn(async () => ({ endpoints: [] }));
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: [{
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
      detail: 'Plugin MCP discovery source is unavailable',
    })]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('activates every declared discovery-provider owner when detection has no provider filter', async () => {
    const release = vi.fn(async () => {});
    const registrations: Record<string, PluginMcpDiscoverySourceRegistration> = {
      pi: {
        id: 'pi.synthetic',
        discover: async () => ({ endpoints: [] }),
      },
      opencode: {
        id: 'opencode.synthetic',
        discover: async () => ({ endpoints: [] }),
      },
    };
    const discoverMcpServersForDetection = vi.fn(async (request: Readonly<{
      localId: string;
      input: Parameters<PluginMcpDiscoverySourceRegistration['discover']>[0];
    }>) => {
      const agentId = request.localId.split('.')[0];
      const registration = agentId ? registrations[agentId] : undefined;
      return await registration?.discover(request.input) ?? { endpoints: [] };
    });
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: [
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
    const piDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'pi.synthetic',
      discover: async (input) => {
        calls.push(`pi:${input?.directory ?? ''}`);
        return {
          endpoints: [{
            id: 'pi.config.docs',
            name: 'docs',
            kind: 'http',
            url: 'https://mcp.pi.example.test/http',
          }],
          warnings: [],
        };
      },
    };
    const openCodeDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'opencode.synthetic',
      discover: async () => {
        calls.push('opencode');
        return {
          endpoints: [{
            id: 'opencode.config.workspace',
            name: 'workspace',
            kind: 'sse',
            url: 'https://mcp.opencode.example.test/sse',
          }],
          warnings: [],
        };
      },
    };

    const params = {
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoverySources: [
        { pluginId: 'happier.agent.pi', provider: 'pi', registration: piDiscovery },
        { pluginId: 'happier.agent.opencode', provider: 'opencode', registration: openCodeDiscovery },
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
    const piDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        endpoints: [],
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
      mcpDiscoverySources: [
        { pluginId: 'happier.agent.pi', provider: 'pi', registration: piDiscovery },
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
    const piDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'pi.synthetic',
      discover: async () => await new Promise(() => {}),
    };
    const openCodeDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'opencode.synthetic',
      discover: async () => ({
        endpoints: [{
          id: 'opencode.config.workspace',
          name: 'workspace',
          kind: 'sse',
          url: 'https://mcp.opencode.example.test/sse',
        }],
      }),
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi', 'opencode'],
      env: {},
      discoveryTimeoutMs: 5,
      mcpDiscoverySources: [
        {
          pluginId: 'happier.agent.pi',
          provider: 'pi',
          registration: piDiscovery,
          discover: async (_input, signal) => {
            timedOutSignal = signal;
            return await new Promise(() => {});
          },
        },
        { pluginId: 'happier.agent.opencode', provider: 'opencode', registration: openCodeDiscovery },
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

  it('rejects endpoint discovery rows that smuggle a transport specification', async () => {
    const endpointWithTransport = {
      id: 'pi.config.env',
      name: 'env',
      kind: 'http' as const,
      url: 'https://mcp.pi.example.test/http',
      transport: {
        kind: 'stdio',
        launch: {
          executable: { kind: 'systemTool', id: 'env-mcp' },
          env: { API_TOKEN: 'secret-value' },
        },
      },
    };
    const piDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        endpoints: [endpointWithTransport],
        warnings: [],
      }),
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoverySources: [
        { pluginId: 'happier.agent.pi', provider: 'pi', registration: piDiscovery },
      ],
    });

    expect(result.warnings).toEqual([{
      provider: 'pi',
      code: 'unsupported',
      path: 'plugin:pi.synthetic',
    }]);
    expect(result.servers).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('API_TOKEN');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('drops remote discovery servers with benign URL fragments at the canonical MCP URL boundary', async () => {
    const piDiscovery: PluginMcpDiscoverySourceRegistration = {
      id: 'pi.synthetic',
      discover: async () => ({
        endpoints: [{
          id: 'pi.config.fragment',
          name: 'fragment',
          kind: 'http',
          url: 'https://mcp.pi.example.test/http#section',
        }],
        warnings: [],
      }),
    };

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['pi'],
      env: {},
      mcpDiscoverySources: [
        { pluginId: 'happier.agent.pi', provider: 'pi', registration: piDiscovery },
      ],
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([{
      provider: 'pi',
      code: 'unsupported',
      path: 'plugin:pi.synthetic',
    }]);
  });

  it('detects MCP servers for every installed Agent, bundled or externally contributed', async () => {
    const release = vi.fn(async () => {});
    const externalAgentId = 'acme.cli';
    const installedAgentIds = [...AGENT_IDS, externalAgentId];
    const discoverMcpServersForDetection = vi.fn(async (request: Readonly<{
      pluginId: string;
      localId: string;
    }>) => ({
      endpoints: [{
        id: `${request.pluginId}.${request.localId}.docs`,
        name: 'docs',
        kind: 'http' as const,
        url: 'https://mcp.example.test/http',
      }],
    }));
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: installedAgentIds.map((agentId) => ({
            pluginId: `happier.agent.${agentId}`,
            definition: {
              id: 'config',
              title: `${agentId} MCP configuration`,
              metadata: { agentId },
            },
          })),
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: [],
      env: {},
    });

    expect(result.servers.map((server) => server.provider)).toEqual(installedAgentIds);
    expect(result.warnings).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('detects MCP servers for a single externally contributed Agent when it is the requested provider', async () => {
    const release = vi.fn(async () => {});
    const discoverMcpServersForDetection = vi.fn(async () => ({
      endpoints: [{
        id: 'acme.config.docs',
        name: 'docs',
        kind: 'http' as const,
        url: 'https://mcp.acme.example.test/http',
      }],
    }));
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: [
            {
              pluginId: 'happier.agent.acme',
              definition: { id: 'config', title: 'Acme MCP configuration', metadata: { agentId: 'acme.cli' } },
            },
            {
              pluginId: 'happier.agent.claude',
              definition: { id: 'config', title: 'Claude MCP configuration', metadata: { agentId: 'claude' } },
            },
          ],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['acme.cli'],
      env: {},
    });

    expect(discoverMcpServersForDetection).toHaveBeenCalledTimes(1);
    expect(result.servers).toEqual([expect.objectContaining({ provider: 'acme.cli', name: 'docs' })]);
    expect(result.warnings).toEqual([]);
  });

  it('warns instead of silently dropping a discovery source whose Agent id cannot be resolved', async () => {
    const release = vi.fn(async () => {});
    const discoverMcpServersForDetection = vi.fn(async () => ({ endpoints: [] }));
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: [{
            pluginId: 'happier.agent.acme',
            definition: { id: 'config', title: 'Acme MCP configuration' },
          }],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: [],
      env: {},
    });

    expect(discoverMcpServersForDetection).not.toHaveBeenCalled();
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([{
      code: 'unsupported',
      path: 'plugin:config',
      detail: 'Plugin MCP discovery source declares no Agent id (plugin happier.agent.acme)',
    }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never borrows an Agent identity from a discovery source local id', async () => {
    const release = vi.fn(async () => {});
    const discoverMcpServersForDetection = vi.fn(async () => ({
      endpoints: [{
        id: 'config.docs',
        name: 'docs',
        kind: 'http' as const,
        url: 'https://mcp.example.test/http',
      }],
    }));
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: [{
            pluginId: 'happier.agent.acme',
            definition: { id: 'config.servers', title: 'Acme MCP configuration' },
          }],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: [],
      env: {},
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings.map((warning) => warning.provider)).toEqual([undefined]);
  });

  it('does not turn an entirely unusable provider filter into an unfiltered detection', async () => {
    const release = vi.fn(async () => {});
    const discoverMcpServersForDetection = vi.fn(async () => ({ endpoints: [] }));
    runtimeLeaseMocks.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry: {
        contributes: {
          mcpDiscoverySources: [{
            pluginId: 'happier.agent.claude',
            definition: { id: 'config', title: 'Claude MCP configuration', metadata: { agentId: 'claude' } },
          }],
        },
        discoverMcpServersForDetection,
      },
      release,
    });

    const result = await detectProviderMcpServers({
      directory: '/tmp/project',
      providers: ['   '],
      env: {},
    });

    expect(discoverMcpServersForDetection).not.toHaveBeenCalled();
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([{
      code: 'unsupported',
      detail: 'MCP detection was asked for an unresolvable Agent id',
    }]);
  });

});
