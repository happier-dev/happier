import { describe, expect, it, vi } from 'vitest';

// Observe the third-party SDK module boundary while retaining its real schemas
// and transports. Startup must not evaluate them merely to register services.
const evaluated = vi.hoisted(() => new Set<string>());
vi.mock('@modelcontextprotocol/sdk/types.js', async (importOriginal) => {
  evaluated.add('types');
  return await importOriginal<typeof import('@modelcontextprotocol/sdk/types.js')>();
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', async (importOriginal) => {
  evaluated.add('client');
  return await importOriginal<typeof import('@modelcontextprotocol/sdk/client/index.js')>();
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => {
  evaluated.add('stdio');
  return await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>();
});
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => {
  evaluated.add('http');
  return await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>();
});

describe('daemon MCP import demand', () => {
  it('registers idle services without evaluating the SDK and validates the first resource result', async () => {
    const [{ createStablePluginMcpHost }, { createStableDeclaredMcpTransportConnector }] = await Promise.all([
      import('@/plugins/runtime/invocation/services/mcp'),
      import('@/plugins/runtime/invocation/services/mcpDeclaredTransport'),
      import('@/mcp/servers/probeMcpStdioServerTools'),
      import('../computer/driver/nativeTransport'),
    ]);
    createStableDeclaredMcpTransportConnector();
    const ref = { pluginId: 'fixture.plugin', localId: 'resources' };
    let resource = { uri: 'file:///guide', name: 'guide' };
    const host = createStablePluginMcpHost({
      servers: [{
        provenance: 'external', source: { kind: 'path' }, pluginId: ref.pluginId,
        manifestPath: '/fixture/plugin.json', daemonEntryPath: '/fixture/daemon.js',
        definition: { id: ref.localId, title: 'Resources', kind: 'dynamic' },
      }],
      discoverySources: [], activateOnDemand: async () => {},
      readServer: () => ({
        occurrenceId: 'fixture-occurrence', qualifiedId: 'fixture.plugin/resources', isCurrent: () => true,
        listTools: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
        callTool: async (_request, _seed, _options, project) => project(null, value => value),
        listResources: async (_request, _seed, _options, project) => project({ items: [resource] }, value => value),
        listResourceTemplates: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
        readResource: async ({ uri }, _seed, _options, project) => project({ contents: [{ uri, text: '' }] }, value => value),
        subscribeResource: async () => ({ dispose: async () => {} }),
        listPrompts: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
        getPrompt: async (_request, _seed, _options, project) => project({ messages: [] }, value => value),
      }),
      readDiscoverySource: () => null,
    });
    expect([...evaluated]).toEqual([]);
    const service = host.bind({
      plugin: { id: 'fixture.caller', version: '1.0.0' },
      contribution: { id: 'action', qualifiedId: 'fixture.caller/actions/action' },
      occurrenceId: 'fixture-occurrence', correlationId: 'fixture-request', surface: 'agent',
      signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    });
    const client = await service.connect(ref, { elicitation: { mode: 'reject' } });
    expect([...evaluated]).toEqual([]);
    await expect(client.listResources()).resolves.toEqual({ items: [{ uri: 'file:///guide', name: 'guide' }] });
    expect(evaluated.has('types')).toBe(true);
    resource = Object.assign(resource, { unexpected: true });
    await expect(client.listResources()).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
    await host.dispose();
  });
});
