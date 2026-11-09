import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { listResolvedCustomHappierTools } from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';
import type { SessionMcpCustomToolsBridge } from './sessionMcpToolsBridge';
import { createDeferred } from '@/testkit/async/deferred';

it('retains typed built-in validation and unknown-tool refusals at the real MCP owner', async () => {
  const { mcp } = createHappierMcpServer({ sessionId: 'owning-session',
    getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'owning-session', encryptionMode: 'plain' }),
    updateMetadata: () => undefined,
  }, { authorityScope: 'session' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bridge-refusals', version: '1' });
  try {
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    const invalid = await client.callTool({ name: 'change_title', arguments: { title: 17 } });
    expect(invalid).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.any(String) }] });
    if (!('content' in invalid) || !Array.isArray(invalid.content) || invalid.content[0]?.type !== 'text') throw new Error('Missing tool refusal');
    expect(JSON.parse(invalid.content[0].text)).toMatchObject({ errorCode: 'invalid_parameters' });
    const unknown = await client.callTool({ name: 'not_a_happier_tool', arguments: {} });
    expect(unknown).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.any(String) }] });
    if (!('content' in unknown) || !Array.isArray(unknown.content) || unknown.content[0]?.type !== 'text') throw new Error('Missing tool refusal');
    expect(JSON.parse(unknown.content[0].text)).toMatchObject({ errorCode: 'unknown_tool' });
  } finally { await client.close(); await mcp.close(); }
});

it('dispatches the selected custom profile through the existing MCP list/call owners', async () => {
  const lifetime = new AbortController();
  // A real stdio process is the selected external MCP boundary. Host selection,
  // request registration and both existing custom-tool adapters stay real.
  const mcpServers = { selected: { command: process.execPath, args: ['-e', `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      if (request.method === 'tools/call' && request.params.arguments?.hold === true) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken: request.params._meta.progressToken, progress: 1 } }) + '\\n');
        return;
      }
      const result = request.method === 'initialize'
        ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'selected', version: '1' } }
        : request.method === 'tools/list'
          ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }], structuredContent: { echoed: request.params.arguments } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `] } };
  const bridge: SessionMcpCustomToolsBridge = {
    list: signal => listResolvedCustomHappierTools({ mcpServers, signal }),
    call: (input, signal) => callResolvedCustomHappierTool({ ...input, signal, mcpServers, operationContext: { isCurrent: async () => true } }),
  };
  const { mcp } = createHappierMcpServer({ sessionId: 'owning-session',
    getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'owning-session', encryptionMode: 'plain' }),
    updateMetadata: () => undefined,
  }, { authorityScope: 'session', sessionToolsBridge: bridge, toolExecutionSignal: lifetime.signal });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bridge-consumer', version: '1' });
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const native = await client.listTools();
    expect(native.tools.some(tool => tool.name === 'echo')).toBe(false);
    const listed = await client.listTools({ _meta: { 'happier/tool-sources': true } });
    expect(listed.tools.map(tool => ({ name: tool.name, source: tool._meta?.['happier/tool-source'] })))
      .toContainEqual({ name: 'echo', source: 'selected' });
    const called = await client.callTool({ name: 'echo', arguments: { value: 'payload' },
      _meta: { 'happier/tool-source': 'selected' } });
    expect(called.structuredContent).toMatchObject({ ok: true,
      result: { structuredContent: { echoed: { value: 'payload' } } } });
    const missing = await client.callTool({ name: 'echo', arguments: {},
      _meta: { 'happier/tool-source': 'not-selected' } });
    expect(missing.structuredContent).toMatchObject({ ok: false, errorCode: 'server_not_found' });
    const started = createDeferred<void>();
    const held = client.callTool({ name: 'echo', arguments: { hold: true },
      _meta: { 'happier/tool-source': 'selected' } }, undefined, { onprogress: () => started.resolve() });
    await started.promise;
    lifetime.abort();
    expect((await held).structuredContent).toMatchObject({ ok: false, errorCode: 'tool_call_failed' });
  } finally {
    await client.close();
    await mcp.close();
  }
});
