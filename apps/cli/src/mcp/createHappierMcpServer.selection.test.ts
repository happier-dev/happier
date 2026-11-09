import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHappierMcpServer } from './createHappierMcpServer';

describe('Session built-in Happier tools selection', () => {
  it('registers no built-in tools in the real MCP inventory after opt-out', async () => {
    const session = createMutableApiSessionClientFixture({ metadata: createTestMetadata({
      mcpSelectionV1: { v: 1, managedServersEnabled: false, happierToolsEnabled: false,
        forceIncludeServerIds: [], forceExcludeServerIds: [] },
    }) });
    const runtime = createHappierMcpServer(session);
    const client = new Client({ name: 'restricted-session', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([]);
      expect(runtime.toolNames).toEqual([]);
    } finally {
      await client.close();
      await runtime.mcp.close();
    }
  });
});
