import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { ACTION_IDS, encodeBase64, getActionSpec, normalizeActionsSettingsV1, RPC_METHODS, SOCKET_RPC_EVENTS, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { createExternalMcpServer } from './createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';

// HTTP and Socket.IO are the Home/daemon system boundary. MCP, placement,
// target reconciliation, Machine codec and RPC client all run unchanged.
describe('standalone MCP machine placement', () => {
  it('retains canonical approval refusal before the Machine effect when no approval carrier is available', async () => {
    const credentials = { token: 'test-account', encryption: null, credentialProvenance: 'stored_session' } as const;
    const { executor } = createCliActionExecutorHarness({
      credentials, token: credentials.token, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'approval-home', serverHttpBaseUrl: 'http://127.0.0.1:1',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
    });
    await expect(executor.execute('sessions.external.candidate.delete', {
      machineId: 'addressed-machine', agentId: 'claude', source: { kind: 'claudeConfig', configDir: '/repo' },
      remoteSessionId: 'external-1',
    }, { surface: 'mcp', authority: 'account_automation' })).resolves.toMatchObject({
      ok: false, errorCode: 'approvals_not_supported',
    });
  });
  it.each(['sessions.external.candidates.list', 'sessions.external.candidate.delete', 'sessions.external.operation.status.get'] as const)(
    'delivers %s to the addressed daemon, even with another local Machine', async actionId => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const history = { ok: true, candidates: [], nextCursor: 'history-next', contentCoverage: 'partial' };
    const deleted = { ok: true, deleted: true };
    const operationRef = { sessionId: 'c1234567890123456789012345', operationId: 'operation-1', revision: 4 };
    const operation = { ok: true, progress: {
      v: 1, operationId: operationRef.operationId, revision: operationRef.revision,
      request: { plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null },
      timeline: ['validating', 'staging', 'importing', 'publishing'], status: 'running', phase: 'validating', updatedAtMs: 10,
      priorStableStorage: { state: 'machine_only' }, currentStorageState: 'machine_only',
      checkpoint: { sourcePagesRead: 1, stagedItemCount: 2, importedItemCount: 1,
        requiredItemFailures: { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false } },
      fence: { kind: 'none' },
    } };
    const files = { ok: true, files: [{ path: 'remote.txt', matches: [
      { line: 2, column16: 1, length16: 6, text: 'needle', before: [], after: [] },
    ] }], hasMore: false, coverage: 'complete' };
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/machines/addressed-machine') {
        response.end(JSON.stringify({ machine: { id: 'addressed-machine', kind: 'persistent',
          dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
        } }));
      } else if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, updatedAt: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null }));
      } else if (request.url === `/v2/sessions/${operationRef.sessionId}`) {
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session: {
          id: operationRef.sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          encryptionMode: 'plain', metadataVersion: 1, metadata: JSON.stringify({ machineId: 'addressed-machine' }),
          dataEncryptionKey: null, agentState: null, agentStateVersion: 1,
        } })));
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    const daemon = new Server(http, { path: '/v1/updates/' });
    daemon.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.CALL, (request, ack) => {
        requests.push(request);
        const method = String(request.method);
        ack({ ok: true, result: method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) ? history
          : method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSION_CANDIDATE_DELETE) ? deleted
          : method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET) ? operation : files });
      });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Home address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);
    env.patch({ HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({ v: 1,
      approvalWaivedSurfaces: { 'sessions.external.candidate.delete': ['mcp'] },
      actions: Object.fromEntries(ACTION_IDS.map(id => [id, {
        enabled: id === actionId || id === 'workspace.files.search',
      }])) }) });
    const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({
      credentials: { token: 'test-account', encryption: null, credentialProvenance: 'stored_session' },
      machineId: 'other-local-machine', daemonControlTarget: null,
    }));
    const client = new Client({ name: 'machine-placement-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const input = actionId === 'sessions.external.operation.status.get' ? operationRef : { machineId: 'addressed-machine', agentId: 'claude',
        source: { kind: 'claudeConfig', configDir: '/tmp/test-claude' },
        ...(actionId === 'sessions.external.candidates.list'
          ? { searchTerm: 'needle', searchTarget: 'content' } : { remoteSessionId: 'external-1' }) };
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      const result = CallToolResultSchema.parse(await client.callTool({ name: spec.bindings!.mcpToolName!, arguments: input }));
      const content = result.content.find(entry => entry.type === 'text');
      expect(content?.type === 'text' ? JSON.parse(content.text) : null).toEqual(actionId.endsWith('.list') ? history
        : actionId === 'sessions.external.candidate.delete' ? deleted
        : { ok: true, operation: operationRef, presentation: { v: 1, operationId: 'operation-1', revision: 4,
          kind: 'materialize', status: 'running', phase: 'validating' } });
      expect(result.isError).not.toBe(true);
      const search = CallToolResultSchema.parse(await client.callTool({ name: 'workspace_files_search', arguments: {
        machineId: 'addressed-machine', rootPath: '/tmp/test-workspace', query: 'needle',
      } }));
      const searchContent = search.content.find(entry => entry.type === 'text');
      expect(searchContent?.type === 'text' ? JSON.parse(searchContent.text) : null).toEqual(files);
      expect(search.isError).not.toBe(true);
      expect(requests).toEqual([
        expect.objectContaining({ method: `addressed-machine:${spec.bindings!.rpcMethod}`, params: input }),
        expect.objectContaining({ method: `addressed-machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`, params: {
          rootPath: '/tmp/test-workspace', query: 'needle',
        } }),
      ]);
    } finally {
      await client.close(); await mcp.close();
      await new Promise<void>(resolve => daemon.close(() => resolve()));
      env.restore();
    }
  });

  it('does not advertise a bound-Session presentation command from a standalone host', async () => {
    const env = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);
    env.patch({ HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({ v: 1,
      actions: Object.fromEntries(ACTION_IDS.map(id => [id, {
        enabled: id === 'session.presentation.apply' || id === 'sessions.external.candidates.list',
      }])) }) });
    const { mcp, toolNames } = createExternalMcpServer({
      credentials: { token: 'test-account', encryption: null, credentialProvenance: 'stored_session' },
      daemonControlTarget: null,
    });
    const client = new Client({ name: 'unbound-placement-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      expect(toolNames).toContain('sessions_external_candidates_list');
      expect(toolNames).not.toContain('session_presentation_apply');
      const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'session.presentation.apply', input: { intent: { kind: 'board.open', mode: 'beside_chat' } },
      } }));
      const content = response.content.find(entry => entry.type === 'text');
      expect(content?.type === 'text' ? JSON.parse(content.text) : null).toMatchObject({ errorCode: 'action_disabled' });
    } finally { await client.close(); await mcp.close(); env.restore(); }
  });
});
