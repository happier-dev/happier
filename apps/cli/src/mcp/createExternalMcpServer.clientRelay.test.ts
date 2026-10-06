import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACTION_IDS, getActionSpec, normalizeActionsSettingsV1, SignedRootActionIdSchema, UiActionDispatchRequestV1Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { configuration } from '@/configuration';
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
    let clientAvailable = connected;
    let primarySessionId: string | null = 'canonical-session';
    // The Home HTTP service is a network boundary. Session parsing, Account
    // mode and daemon locality resolution use their real canonical owners.
    const home = createServer((request, response) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.setHeader('content-type', 'application/json');
      if (path === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, updatedAt: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null }));
      } else if (path.startsWith('/v2/sessions/')) {
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session: {
          id: decodeURIComponent(path.slice('/v2/sessions/'.length)), seq: 1, createdAt: 1, updatedAt: 1,
          active: true, activeAt: 1, encryptionMode: 'plain', metadataVersion: 1,
          metadata: JSON.stringify({ machineId: 'mcp-machine' }), dataEncryptionKey: null,
          agentState: null, agentStateVersion: 1,
        } })));
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: 'Unexpected test Home route' })); }
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const homeAddress = home.address();
    if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing Home address');
    // The connected-client RPC is the network boundary. Admission, placement,
    // reverse dispatch, daemon HTTP and MCP SDK execution remain real.
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => clientAvailable,
      callConnectedClientRpc: async (_method, raw, options) => {
        const request = UiActionDispatchRequestV1Schema.parse(raw);
        admitted.push(request);
        options.onIssued();
        const result = request.actionId === 'widgets.instance.inputs.get' ? {
          ref: typeof request.input === 'object' && request.input !== null ? Reflect.get(request.input, 'ref') : undefined,
          bindings: {},
        }
          : request.actionId === 'ui.find' ? { status: 'idle' }
          : request.actionId === 'session.pending.next' ? { status: 'none' }
          : request.actionId === 'session.target.primary.set' ? { ok: true, status: 'ok',
            sessionId: primarySessionId, serverId: primarySessionId ? configuration.activeServerId : null,
            address: primarySessionId ? { sessionId: primarySessionId, serverId: configuration.activeServerId } : null } : workspace;
        return { ok: true, result: { v: 1, execution: { ok: true, result } } };
      },
    }));
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'mcp-home',
      serverHttpBaseUrl: `http://127.0.0.1:${homeAddress.port}`,
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
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: `http://127.0.0.1:${homeAddress.port}` }),
      },
    });
    app.addHook('preHandler', async request => {
      if (request.url === '/actions/root/execute') daemonAdmissions.push(request.body);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon address');
    const { mcp } = createExternalMcpServer({ credentials, defaultSessionId: 'mcp-session-active', machineId: 'mcp-machine',
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
      const ref = { surface: { serverId: configuration.activeServerId, accountId: 'viewer',
        owner: { kind: 'companion', sessionId: 'mcp-session-active' } }, instanceId: 'checks' };
      const companion = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'widgets.instance.inputs.get', input: { ref },
      } }));
      const companionText = companion.content.find(entry => entry.type === 'text');
      if (!companionText || companionText.type !== 'text') throw new Error('Missing Companion result');
      expect(JSON.parse(companionText.text)).toMatchObject(connected ? { ref, bindings: {} } : { errorCode: 'unavailable' });
      if (connected) expect(admitted.at(-1)).toMatchObject({ actionId: 'widgets.instance.inputs.get', context: { defaultSessionId: 'mcp-session-active' } });
      if (connected) for (const request of admitted) expect(request).toMatchObject({ context: {
        surface: 'mcp', authority: 'account_automation', defaultSessionId: 'mcp-session-active', defaultSessionMachineId: 'mcp-machine',
      } });
      const approval = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'session.draft.delete', input: { draftId: '11111111-1111-4111-8111-111111111111' },
      } }));
      const approvalText = approval.content.find(entry => entry.type === 'text');
      if (!approvalText || approvalText.type !== 'text') throw new Error('Missing approval refusal');
      expect(JSON.parse(approvalText.text)).toMatchObject({ errorCode: 'approvals_not_supported' });
      expect(daemonAdmissions).toContainEqual(expect.objectContaining({ actionId: 'session.draft.delete', surface: 'mcp' }));
      expect(admitted).toHaveLength(connected ? 4 : 0);
      if (connected) {
        const selected = CallToolResultSchema.parse(await client.callTool({ name: 'session_target_primary_set', arguments: {
          sessionId: 'requested-session', serverId: configuration.activeServerId,
        } }));
        expect(selected.isError).not.toBe(true);
        expect(admitted.at(-1)).toMatchObject({ actionId: 'session.target.primary.set', context: { defaultSessionId: 'requested-session' } });
        await client.callTool({ name: 'ui_find', arguments: { op: 'read' } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'ui.find', context: { defaultSessionId: 'canonical-session' } });
        clientAvailable = false;
        await client.callTool({ name: 'session_target_primary_set', arguments: {
          sessionId: 'unaccepted-session', serverId: configuration.activeServerId,
        } });
        clientAvailable = true;
        await client.callTool({ name: 'ui_find', arguments: { op: 'read' } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'ui.find', context: { defaultSessionId: 'canonical-session' } });
        primarySessionId = null;
        await client.callTool({ name: 'session_target_primary_set', arguments: { sessionId: null } });
        expect(admitted.at(-1)).toMatchObject({ actionId: 'session.target.primary.set' });
        expect(UiActionDispatchRequestV1Schema.parse(admitted.at(-1)).context).not.toHaveProperty('defaultSessionId');
        await client.callTool({ name: 'ui_find', arguments: { op: 'read' } });
        expect(UiActionDispatchRequestV1Schema.parse(admitted.at(-1)).context).not.toHaveProperty('defaultSessionId');
      }
    } finally {
      await client.close(); await mcp.close(); await app.close();
      home.closeAllConnections();
      await new Promise<void>(resolve => home.close(() => resolve()));
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
