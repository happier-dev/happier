import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { bindPublicProfileActionPorts } from '@happier-dev/protocol/actions/executor/publicProfileActions';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { normalizeAcpSessionMessageBody } from '@/api/session/sessionOutboundMessageNormalization';
import { projectCodexAppServerToolEventsFromNotification } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/projection/toolEvents';

import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

it('retains permitted Action outcomes through native MCP results with nullable structured content', async () => {
  // Account HTTP is the only substituted boundary. Preparation, dispatch, MCP,
  // native projection and the outbound observation owner remain real.
  const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context: {
    handle: 'payload_probe', identity: { name: 'Payload probe' }, service: null, urls: null,
  } });
  const homeDomainAction = async () => owner;
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), homeDomainAction,
    publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
  });
  const bridge = createActionToolExecutorBridge({ surface: 'agent', executor });
  const catalog = createHappierToolInventory({ surface: 'agent' });
  const server = new McpServer({ name: 'native-result', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId: 'probe', surface: 'agent',
    toolInventory: prepareHappierMcpToolInventory({ sessionId: 'probe', inventory: {
      ...catalog, tools: catalog.tools.filter(tool => tool.name === 'action_execute'),
    } }), deps: { ...bridge, changeTitle: async () => ({ success: true }),
      resolveActionOptions: args => bridge.resolveActionOptions(args, 'probe') },
  });
  const client = new Client({ name: 'native-result-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const args of [
      { actionId: 'account.public_profile.preview', input: {
        policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: Object.fromEntries(
          Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields).map(key => [key, key === 'bio']),
        ) },
        metadataSelection: { bio: 'private-draft-marker' },
        query: normalizeUsageQuery({ period: { relative: '30days' } }),
        layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      } },
      { actionId: 'action.spec.get', input: { id: 'account.public_profile.preview' } },
    ]) {
      const result = await client.callTool({ name: 'action_execute', arguments: args });
      expect(result.isError).toBe(false);
      const blocks = result.content;
      if (!Array.isArray(blocks) || blocks[0]?.type !== 'text') throw new Error('Expected MCP text payload');
      const payload: unknown = JSON.parse(blocks[0].text);
      if (args.actionId === 'account.public_profile.preview') {
        expect(payload).toMatchObject({ kind: 'ready' });
        expect(JSON.stringify(payload)).toContain('private-draft-marker');
      }
      for (const encoding of ['codex-text', 'codex-structured', 'claude-text'] as const) {
        // codex-cli 0.162.1 app-server generate-ts: McpToolCallResult has
        // required content and nullable structuredContent/_meta, unlike MCP.
        const output = encoding === 'claude-text' ? { content: result.content } : {
          content: result.content, _meta: null,
          structuredContent: encoding === 'codex-text' ? null : payload,
        };
        const events = projectCodexAppServerToolEventsFromNotification({ method: 'item/completed', notificationParams: {
          item: { id: 'probe-call', type: 'mcpToolCall', server: 'happier', tool: 'action_execute', arguments: args, result: output },
        } });
        if (!events.some(event => event.type === 'tool-result')) throw new Error('Expected native tool result');
        const caches = { toolCallCanonicalNameByProviderAndId: new Map(),
          permissionToolCallRawInputByProviderAndId: new Map(), toolCallInputByProviderAndId: new Map() };
        const provider = encoding === 'claude-text' ? 'claude' : 'codex';
        for (const event of events) {
          const { sidechainId: _sidechainId, ...body } = event;
          const observed = normalizeAcpSessionMessageBody({ ...caches, provider, body: { ...body, id: event.callId } });
          if (observed.type !== 'tool-result') continue;
          if (args.actionId === 'account.public_profile.preview') {
            expect(observed.output).toMatchObject({ kind: 'ready' });
            expect(JSON.stringify(observed)).not.toContain('private-draft-marker');
            expect(observed.output).not.toHaveProperty('view');
          } else {
            expect(observed.output).toMatchObject({ content: result.content });
          }
        }
      }
    }
  } finally { await client.close(); await server.close(); }
});
