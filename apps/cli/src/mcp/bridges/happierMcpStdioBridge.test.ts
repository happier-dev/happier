import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { clearTimeout, setTimeout } from 'node:timers';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createMcpActionEnablement } from '@/mcp/server/createMcpActionEnablement';
import { registerHappierMcpResources, HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI } from '@/mcp/resources/registerHappierMcpResources';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';

describe('Happier MCP stdio bridge', () => {
  it.each([undefined, 40])('preserves current upstream discovery and dispatch with tool-name budget %s', async (maxToolNameLength) => {
    let names = ['change_title', 'plugin_' + 'very_long_name_'.repeat(8), 'file.read', 'file_read', '日本語工具'];
    const forwarded: string[] = [];
    let discoveryAvailable = true;
    const accountSettings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: { 'session.list': { enabled: false } } } });
    const isActionEnabled = createMcpActionEnablement({ surface: 'mcp',
      actionSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettings, allowEnvironmentOverride: false }) });
    const upstream = createServer(async (request, response) => {
      const mcp = new McpServer({ name: 'test-title-upstream', version: '1.0.0' });
      mcp.server.registerCapabilities({ tools: {} });
      registerHappierMcpResources(mcp, { surface: 'mcp', isActionEnabled });
      mcp.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        if (!discoveryAvailable) throw new Error('discovery unavailable');
        const selected = request.params?.cursor === 'later-page' ? names.slice(1) : names;
        return {
        tools: selected.map(name => ({
          name,
          title: name,
          description: 'Change the title',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        })),
      };
      });
      mcp.server.setRequestHandler(CallToolRequestSchema, async (call) => {
        forwarded.push(call.params.name);
        return { content: [{ type: 'text', text: String(call.params.arguments?.title) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    });
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as AddressInfo).port));
    });
    const config = await resolveNodeBackedMcpServerCommand({
      distEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.mjs'],
      sourceEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.ts'],
      args: ['--url', `http://127.0.0.1:${port}/`, ...(maxToolNameLength === undefined ? [] : ['--tool-name-max-length', String(maxToolNameLength)])],
      preferSourceEntrypoint: true,
    });
    const client = new Client({ name: 'happier-bridge-title-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(new StdioClientTransport(config));
      const resource = await client.readResource({ uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI });
      const content = resource.contents[0];
      if (!content || !('text' in content) || typeof content.text !== 'string') throw new Error('Missing upstream Action resource');
      const specs: { actionSpecs: Array<{ id: string }> } = JSON.parse(content.text);
      expect(specs.actionSpecs.map(spec => spec.id)).not.toContain('session.list');
      expect(specs.actionSpecs.map(spec => spec.id)).toContain('action.spec.search');
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain('change_title');
      if (maxToolNameLength === undefined) {
        expect(catalog.tools.map(tool => tool.name)).toEqual(names);
      } else {
        expect(catalog.tools.every(tool => tool.name.length <= maxToolNameLength && /^[A-Za-z0-9_-]+$/.test(tool.name))).toBe(true);
        expect(new Set(catalog.tools.map(tool => tool.name)).size).toBe(names.length);
      }
      for (const tool of catalog.tools) {
        const result = await client.callTool({ name: tool.name, arguments: { title: 'MCP Title QA' } });
        expect(result).toMatchObject({ content: [{ type: 'text', text: 'MCP Title QA' }] });
      }
      expect(forwarded).toEqual(names);
      const page = await client.listTools({ cursor: 'later-page' });
      expect(page.tools.map(tool => tool.title)).toEqual(names.slice(1));
      discoveryAvailable = false;
      const ordinary = await client.callTool({ name: 'change_title', arguments: { title: 'Still available' } });
      expect(ordinary).toMatchObject({ content: [{ type: 'text', text: 'Still available' }] });
      discoveryAvailable = true;
      const retained = catalog.tools.find(tool => tool.title === names[1])!.name;
      names = [names[0]!, names[1]!, 'refreshed_' + 'long_tool_'.repeat(8)];
      const refreshed = await client.listTools();
      expect(refreshed.tools.find(tool => tool.title === names[1])!.name).toBe(retained);
      if (maxToolNameLength !== undefined) expect(refreshed.tools.every(tool => tool.name.length <= maxToolNameLength)).toBe(true);
      const added = refreshed.tools.find(tool => tool.title === names[2])!;
      await client.callTool({ name: added.name, arguments: { title: 'Refreshed' } });
      expect(forwarded.at(-1)).toBe(names[2]);
    } finally {
      await client.close().catch(() => undefined);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 30_000);

  it('answers stdio initialize while the HTTP upstream is unready', async () => {
    // An unready upstream is a real transport boundary. Claude's MCP connection
    // must not wait for a separate loopback connect and tools/list round trip.
    const upstream = createServer(() => undefined);
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as AddressInfo).port));
    });
    const config = await resolveNodeBackedMcpServerCommand({
      distEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.mjs'],
      sourceEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.ts'],
      args: ['--url', `http://127.0.0.1:${port}/`],
      preferSourceEntrypoint: true,
    });
    const transport = new StdioClientTransport(config);
    const client = new Client({ name: 'happier-bridge-startup-test', version: '1.0.0' }, { capabilities: {} });
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('stdio initialize waited for upstream')), 20_000);
        }),
      ]);
      expect(client.getServerVersion()?.name).toBe('Happier MCP Bridge');
    } finally {
      if (timer) clearTimeout(timer);
      await client.close().catch(() => undefined);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 30_000);
});
