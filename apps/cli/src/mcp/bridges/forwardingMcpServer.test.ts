import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it, vi } from 'vitest';

import { createForwardingMcpServer } from './forwardingMcpServer';

describe('transparent MCP discovery', () => {
  it('forwards descriptors, pages and aliased calls without compiling upstream output schemas', async () => {
    // The SDK validator is the external compilation boundary. Use its real AJV implementation.
    const validator = new AjvJsonSchemaValidator();
    const compile = vi.spyOn(validator, 'getValidator');
    const upstreamClient = new Client({ name: 'relay-upstream', version: '1' }, { jsonSchemaValidator: validator });
    const source = new McpServer({ name: 'source', version: '1' });
    source.server.registerCapabilities({ tools: {} });
    const tools = ['short_name', 'plugin_' + 'long_name_'.repeat(9)].map(name => ({
      name, title: `Title for ${name}`, description: 'Complete upstream descriptor',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      annotations: { readOnlyHint: true },
    } satisfies Tool));
    source.server.setRequestHandler(ListToolsRequestSchema, async request => request.params?.cursor === 'second'
      ? { tools: [tools[1]!] } : { tools: [tools[0]!], nextCursor: 'second' });
    let calledName: string | undefined;
    source.server.setRequestHandler(CallToolRequestSchema, async request => {
      calledName = request.params.name;
      return { content: [{ type: 'text', text: String(request.params.arguments?.value) }],
        structuredContent: { value: request.params.arguments?.value } };
    });
    const relay = createForwardingMcpServer({ upstream: async operation => await operation(upstreamClient),
      toolNameMaxLength: 40, forwardResources: false });
    const client = new Client({ name: 'agent', version: '1' });
    const [upstreamTransport, sourceTransport] = InMemoryTransport.createLinkedPair();
    const [agentTransport, relayTransport] = InMemoryTransport.createLinkedPair();
    try {
      await source.connect(sourceTransport);
      await upstreamClient.connect(upstreamTransport);
      await relay.connect(relayTransport);
      await client.connect(agentTransport);
      const first = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
      expect(first).toEqual({ tools: [tools[0]], nextCursor: 'second' });
      expect(compile).not.toHaveBeenCalled();
      const second = await client.request({ method: 'tools/list', params: { cursor: first.nextCursor } }, ListToolsResultSchema);
      const alias = second.tools[0]!.name;
      expect(alias).not.toBe(tools[1]!.name);
      expect(alias.length).toBeLessThanOrEqual(40);
      expect(second.tools[0]).toEqual({ ...tools[1], name: alias });
      expect(await client.callTool({ name: alias, arguments: { value: 'preserved' } })).toEqual({
        content: [{ type: 'text', text: 'preserved' }], structuredContent: { value: 'preserved' } });
      expect(calledName).toBe(tools[1]!.name);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await relay.close();
      await upstreamClient.close();
      await source.close();
    }
  });
});
