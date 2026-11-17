import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpServer } from './createHappierMcpServer';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

it('the real Session MCP factory advertises subscriptions and refuses unsupported passive feeds', async () => {
  const { mcp, toolNames } = createHappierMcpServer({
    sessionId: 'session',
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain' }),
    updateMetadata() {},
    getMetadataSnapshot: () => createTestMetadata(),
    getWorkDepth: () => 0,
    getHostTurnWorkDepth: () => 0,
    getActiveTurnPermissionWitness: () => ({ turnId: 'watch-turn', causalPermissionAuthority: {
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo',
    } }),
    getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.example.test' }),
    getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
    }),
  }, { authorityScope: 'session', sessionCredentials: { token: 'restricted-token', encryption: null } });
  const client = new Client({ name: 'session-watch-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  await client.connect(b);
  try {
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
    expect(toolNames).toContain('watch');
    expect((await client.request({ method: 'tools/list' }, ListToolsResultSchema)).tools.map(tool => tool.name).sort())
      .toEqual([...toolNames].sort());
    const result = await client.callTool({ name: 'watch', arguments: {
      target: { kind: 'execution_run', serverId: 'home', sessionId: 'session', machineId: 'machine', runId: 'run' },
      condition: { kind: 'idle' },
    } });
    const text = CallToolResultSchema.parse(result).content.find((entry) => entry.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Missing text result');
    expect(JSON.parse(text.text)).toMatchObject({ disposition: 'unsupported_condition' });
  } finally { await client.close(); await mcp.close(); }
});
