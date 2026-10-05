import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACTION_IDS, getActionSpec, normalizeActionsSettingsV1, SignedRootActionIdSchema, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { createExternalMcpServer } from './createExternalMcpServer';

const credentials = { token: 'mcp-test-token', encryption: null, credentialProvenance: 'stored_session' } as const;
const workspace = { ok: true, tabs: [], groups: [], splits: [], rootNodeId: 'main', focusedGroupId: 'main', maximizedGroupId: null };

describe('standalone MCP client Action admission', () => {
  it('keeps every MCP client Action in the existing signed Account admission vocabulary', () => {
    const ids = ACTION_IDS.filter(id => getActionSpec(id).executionPlacement === 'client' && getActionSpec(id).surfaces.mcp);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter(id => !SignedRootActionIdSchema.safeParse(id).success)).toEqual([]);
  });

  it.each([true, false])('delivers through the exact daemon and preserves MCP authority (connected=%s)', async connected => {
    const admitted: unknown[] = [];
    const daemonAdmissions: unknown[] = [];
    // The connected-client RPC is the network boundary. Admission, placement,
    // reverse dispatch, daemon HTTP and MCP SDK execution remain real.
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => connected,
      callConnectedClientRpc: async (_method, raw, options) => {
        const request = UiActionDispatchRequestV1Schema.parse(raw);
        admitted.push(request);
        options.onIssued();
        const result = request.actionId === 'ui.find' ? { status: 'idle' }
          : request.actionId === 'session.pending.next' ? { status: 'none' } : workspace;
        return { ok: true, result: { v: 1, execution: { ok: true, result } } };
      },
    }));
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'mcp-home',
      // A reviewed runtime with no Account approval carrier fails closed for
      // danger Actions, without reaching an external service in this test.
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
    }, { clientActionExecute });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'mcp-machine', controlToken: 'private-mcp-control',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'mcp-home', executor,
        verifyPat: async () => { throw new Error('Account MCP must not use PAT admission'); },
        resolveTarget: async ({ target }) => target ?? { kind: 'machine', machineId: 'mcp-machine' },
      },
    });
    app.addHook('preHandler', async request => {
      if (request.url === '/actions/root/execute') daemonAdmissions.push(request.body);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    const { mcp } = createExternalMcpServer({ credentials, defaultSessionId: 'mcp-session', machineId: 'mcp-machine',
      daemonControlTarget: { pid: process.pid, httpPort: address.port, controlToken: 'private-mcp-control' },
    });
    const client = new Client({ name: 'standalone-client-relay-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const [name, args, connectedResult, absentResult] of [
        ['ui_find', { op: 'read' }, { status: 'idle' }, { status: 'unavailable', reason: 'noClient' }],
        ['session_pending_next', {}, { status: 'none' }, { status: 'unavailable' }],
        ['workspace_tabs_list', {}, workspace, { errorCode: 'unavailable', error: 'noClient' }],
      ] as const) {
        const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
        const text = response.content.find(entry => entry.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing MCP text result');
        expect(JSON.parse(text.text)).toEqual(connected ? connectedResult : absentResult);
      }
      expect(admitted).toHaveLength(connected ? 3 : 0);
      if (connected) for (const request of admitted) expect(request).toMatchObject({ context: {
        surface: 'mcp', authority: 'account_automation', defaultSessionId: 'mcp-session', defaultSessionMachineId: 'mcp-machine',
      } });
      const approval = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'session.draft.delete', input: { draftId: '11111111-1111-4111-8111-111111111111' },
      } }));
      const approvalText = approval.content.find(entry => entry.type === 'text');
      if (!approvalText || approvalText.type !== 'text') throw new Error('Missing approval refusal');
      expect(JSON.parse(approvalText.text)).toMatchObject({ errorCode: 'approvals_not_supported' });
      expect(daemonAdmissions).toContainEqual(expect.objectContaining({ actionId: 'session.draft.delete', surface: 'mcp' }));
      expect(admitted).toHaveLength(connected ? 3 : 0);
    } finally {
      await client.close(); await mcp.close(); await app.close();
    }
  });

  it('returns typed noClient when the captured Home has no daemon', async () => {
    const { mcp } = createExternalMcpServer({ credentials, daemonControlTarget: null });
    const client = new Client({ name: 'absent-daemon-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      const response = CallToolResultSchema.parse(await client.callTool({ name: 'ui_find', arguments: { op: 'read' } }));
      const text = response.content.find(entry => entry.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing MCP text result');
      expect(JSON.parse(text.text)).toEqual({ status: 'unavailable', reason: 'noClient' });
    } finally { await client.close(); await mcp.close(); }
  });
});
