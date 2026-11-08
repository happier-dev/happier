import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('native MCP Doc diagnostics', () => {
  it('carries Doc read operand paths through native MCP without rejected input content', async () => {
    const spec = getActionSpec('doc.read');
    const rejected = { ref: { kind: 'doc', artifactId: { secret: 'private-document-input' } } };
    const parsed = spec.inputSchema.safeParse(rejected);
    if (parsed.success) throw new Error('Malformed document identity must fail');
    const refusal = actionInputValidationFailure(parsed.error);
    // The authenticated Artifact read is the boundary; native MCP registration,
    // Action admission, forwarding and failure framing remain real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), artifactAction: async () => refusal });
    const bridge = createActionToolExecutorBridge({ surface: 'mcp', executor: {
      execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, serverId: 'home' }),
    } });
    const server = new McpServer({ name: 'doc-read-diagnostics', version: '1' });
    const catalog = createHappierToolInventory({ surface: 'mcp' });
    registerHappierMcpBuiltInTools(server, { sessionId: '', surface: 'mcp',
      toolInventory: prepareHappierMcpToolInventory({ sessionId: '', inventory: {
        ...catalog, tools: catalog.tools.filter(tool => tool.name === 'action_execute'),
      } }),
      deps: { ...bridge, changeTitle: async () => ({ success: true }),
        resolveActionOptions: args => bridge.resolveActionOptions(args, '') },
    });
    const client = new Client({ name: 'doc-read-diagnostics', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const input of [rejected, { ref: { kind: 'doc', artifactId: 'document', serverId: 'home' } }]) {
        const result = await client.callTool({ name: 'action_execute', arguments: { actionId: 'doc.read', input } });
        expect(result.isError).toBe(true);
        const content = result.content;
        if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected structured Doc refusal');
        expect(JSON.parse(content[0].text)).toMatchObject({ errorCode: 'invalid_parameters', details: {
          issues: [expect.objectContaining({ code: 'invalid_type', path: ['ref', 'artifactId'] })],
        } });
        expect(content[0].text).not.toContain('private-document-input');
      }
    } finally { await client.close(); await server.close(); }
  });

});
