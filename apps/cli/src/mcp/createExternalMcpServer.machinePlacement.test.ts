import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { ACTION_IDS, getActionSpec, isApprovalRequiredByActionsSettings, normalizeActionsSettingsV1, RPC_METHODS, SOCKET_RPC_EVENTS, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { createExternalMcpServer } from './createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createLocalServiceActionConfirmationNonceV1, LocalServiceActionRequestV1Schema,
  LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { configuration } from '@/configuration';
import { daemonPost } from '@/daemon/controlHttp';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

// test-policy-boundary: authenticated local-daemon HTTP is the Computer effect boundary. MCP admission,
// policy, runtime dispatch and control-envelope validation stay real.
vi.mock('@/daemon/controlHttp', async original => ({
  ...await original<typeof import('@/daemon/controlHttp')>(), daemonPost: vi.fn(),
}));

// HTTP and Socket.IO are the Home/daemon system boundary. MCP, placement,
// target reconciliation, Machine codec and RPC client all run unchanged.
describe('standalone MCP machine placement', () => {
  it.each([
    ['localServices.launcher.start', 'localServices_launcher_start'],
    ['localServices.actions.stopManaged', 'localServices_actions_stopManaged'],
    ['computer.targets.list', 'action_execute'],
  ] as const)('routes named %s through current Machine transport under an explicit Account MCP approval setting', async (actionId, toolName) => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const approvalRequests: ApprovalRequestV2[] = [];
    let approvalArtifact: Readonly<{ id: string; header: string; body: string; dataEncryptionKey: string;
      ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; headerVersion: number; bodyVersion: number;
      seq: number; createdAt: number; updatedAt: number }> | null = null;
    const review = DaemonLocalServiceLauncherStartResponseV1Schema.parse({ protocolVersion: 1, machineId: 'addressed-machine',
      targetId: 'project-service:selected', status: 'denied', reasonCode: 'project_service_effect_review_required',
      reviewedEffect: { command: 'current remote declaration' }, reviewedEffectDigest: 'a'.repeat(64),
      snapshot: { v: 1, machineId: 'addressed-machine', updatedAt: 1, targets: [] } });
    const stopped = LocalServiceActionResultV1Schema.parse({ v: 1, requestId: 'stop-selected', action: 'stop_managed',
      status: 'denied', reasonCode: 'managed_service_stop_unavailable', auditEvents: [] });
    const targetsOutputSchema = getActionSpec('computer.targets.list').outputSchema;
    if (!targetsOutputSchema) throw new Error('Computer targets must declare their public output');
    const receipt = actionId === 'computer.targets.list'
      ? targetsOutputSchema.parse({ targets: [], grants: { capture: 'granted', input: 'granted' } })
      : actionId === 'localServices.launcher.start' ? review : stopped;
    vi.mocked(daemonPost).mockReset();
    if (actionId === 'computer.targets.list') vi.mocked(daemonPost).mockResolvedValue({ result: receipt });
    const http = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/machines/addressed-machine') {
        response.end(JSON.stringify({ machine: { id: 'addressed-machine', kind: 'persistent', storageMode: 'plain',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } }));
      } else if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
      } else if (request.url === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      } else if (request.method === 'POST' && request.url === '/v1/artifacts') {
        // Genuine HTTP persistence/decision boundary. The codec, approval
        // header/body validation, policy and deferred request stay real.
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const written = z.looseObject({ id: z.string(), header: z.string(), body: z.string(),
          dataEncryptionKey: z.literal(ARTIFACT_PLAIN_DATA_KEY_MARKER) })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const decoded = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(written.body));
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(decoded.body));
        approvalRequests.push(approval);
        const rejected = ApprovalRequestV2Schema.parse({ ...approval, status: 'rejected',
          updatedAtMs: approval.updatedAtMs + 1, decision: { kind: 'reject', decidedAtMs: approval.updatedAtMs + 1 } });
        approvalArtifact = { id: written.id,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected)),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }),
          dataEncryptionKey: written.dataEncryptionKey, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
          headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 };
        response.end(JSON.stringify({ id: written.id, headerVersion: 1, bodyVersion: 1 }));
      } else if (request.method === 'GET' && approvalArtifact && request.url === `/v1/artifacts/${approvalArtifact.id}`) {
        response.end(JSON.stringify(approvalArtifact));
      } else { response.statusCode = 404; response.end('{}'); }
    });
    const daemon = new Server(http, { path: '/v1/updates/' });
    daemon.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (request, ack) => {
      requests.push(request); ack({ ok: true, result: receipt });
    }));
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Home address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);
    // A supported, explicit per-Action Account choice, not a test-only global bypass.
    env.patch({ HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({ v: 1,
      approvalWaivedSurfaces: { [actionId]: ['mcp'] },
      actions: Object.fromEntries(ACTION_IDS.map(id => [id, { enabled: id === actionId, toolExposureModes: { mcp: 'direct' } }])) }) });
    const createStandaloneServer = () => runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({
      credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null, credentialProvenance: 'stored_session' },
      machineId: 'other-local-machine', daemonControlTarget: null,
      serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
          actions: { enabled: true }, managed: { enabled: true } },
        browser: { enabled: true, viewTargets: { enabled: true } },
        computer: { enabled: true },
      }, capabilities: {} }) },
    }));
    const { mcp } = createStandaloneServer();
    const client = new Client({ name: 'service-machine-placement-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      const startInput = { machineId: 'addressed-machine', targetId: 'project-service:selected',
        workspace: { serverId: configuration.activeServerId, machineId: 'addressed-machine', workspaceId: 'accepted', rootPath: '/accepted' },
        declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'web' } } };
      const reviewedStop = LocalServiceActionRequestV1Schema.parse({ requestId: 'stop-selected', action: 'stop_managed',
        confirmationNonce: 'placeholder', target: { kind: 'managed_service', managedServiceId: 'actual-owned-instance',
          machineId: 'addressed-machine', workspaceId: 'accepted', cwd: '/accepted/web',
          declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'web' } } } });
      const input = actionId === 'computer.targets.list' ? { machineId: 'addressed-machine' }
        : actionId === 'localServices.launcher.start' ? startInput
        : { ...reviewedStop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(reviewedStop) };
      const result = CallToolResultSchema.parse(await client.callTool({ name: toolName,
        arguments: actionId === 'computer.targets.list' ? { actionId, input } : input }));
      const content = result.content.find(entry => entry.type === 'text');
      expect(result.isError, content?.type === 'text' ? content.text : JSON.stringify(result)).not.toBe(true);
      expect(content?.type === 'text' ? JSON.parse(content.text) : null).toEqual(receipt);
      if (actionId === 'computer.targets.list') {
        expect(daemonPost).toHaveBeenCalledWith('/browser/runtime-actions/execute', expect.objectContaining({ actionId, input }), expect.anything());
        expect(requests).toEqual([]);
      } else expect(requests).toEqual([expect.objectContaining({ method: `addressed-machine:${getActionSpec(actionId).bindings?.rpcMethod}`,
        params: { v: 1, kind: 'targeted_action_rpc', input, target: { kind: 'machine', machineId: 'addressed-machine' },
          defaultSessionId: 'cli-global' } })]);
      if (actionId !== 'localServices.launcher.start') {
        // A newly constructed standalone host captures the current Account
        // settings. Tool exposure must not waive the Action's default approval.
        env.patch({ HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({ v: 1,
          actions: Object.fromEntries(ACTION_IDS.map(id => [id, { enabled: id === actionId }])) }) });
        const { mcp: askFirstMcp } = createStandaloneServer();
        const askFirstClient = new Client({ name: 'service-machine-approval-test', version: '1' });
        const [askFirstServerTransport, askFirstClientTransport] = InMemoryTransport.createLinkedPair();
        await askFirstMcp.connect(askFirstServerTransport); await askFirstClient.connect(askFirstClientTransport);
        try {
          const pending = CallToolResultSchema.parse(await askFirstClient.callTool({ name: 'action_execute', arguments: { actionId, input } }));
          const pendingContent = pending.content.find(entry => entry.type === 'text');
          const publicPending: unknown = pendingContent?.type === 'text' ? JSON.parse(pendingContent.text) : null;
          // Owner 2026-10-12/29: the real external MCP entry must share the
          // settings owner's agent default, while the explicit waiver above wins.
          expect.soft(isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1 }), { surface: 'mcp' })).toBe(true);
          expect(pending.isError, JSON.stringify(publicPending)).not.toBe(true);
          expect(publicPending, JSON.stringify(publicPending)).toMatchObject({
            kind: 'approval_request_created', actionId, artifactId: expect.any(String),
          });
          expect(approvalRequests).toHaveLength(1);
          expect(approvalRequests[0]).toMatchObject({ actionId, status: 'open', requestedSurface: 'mcp' });
          expect(approvalRequests[0]?.actionArgs).toEqual(input);
          expect(approvalRequests[0]?.executionOriginV1).toMatchObject({
            serverId: configuration.activeServerId, machineId: 'addressed-machine', actionId,
          });
          expect(requests).toHaveLength(actionId === 'computer.targets.list' ? 0 : 1);
          if (actionId === 'computer.targets.list') expect(daemonPost).toHaveBeenCalledTimes(1);
        } finally {
          await askFirstClient.close(); await askFirstMcp.close();
        }
      }
    } finally {
      await client.close(); await mcp.close();
      await new Promise<void>(resolve => daemon.close(() => resolve())); env.restore();
    }
  });
  it.each(['sessions.external.candidates.list', 'sessions.external.candidate.delete', 'sessions.external.transcript.page', 'sessions.external.operation.status.get'] as const)(
    'delivers %s to the addressed daemon, even with another local Machine', async actionId => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const history = { ok: true, candidates: [], nextCursor: 'history-next', contentCoverage: 'partial' };
    const deleted = { ok: true, deleted: true };
    const transcript = { ok: true, items: [], hasMore: false, nextCursor: null };
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
        response.end(JSON.stringify({ machine: { id: 'addressed-machine', kind: 'persistent', storageMode: 'plain',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
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
          : method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE) ? transcript
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
        toolExposureModes: { mcp: 'direct' },
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
          ? { searchTerm: 'needle', searchTarget: 'content' } : { remoteSessionId: 'external-1',
            ...(actionId === 'sessions.external.transcript.page' ? { direction: 'older' } : {}) }) };
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      const result = CallToolResultSchema.parse(await client.callTool({ name: spec.bindings!.mcpToolName!, arguments: input }));
      const content = result.content.find(entry => entry.type === 'text');
      expect(content?.type === 'text' ? JSON.parse(content.text) : null).toEqual(actionId.endsWith('.list') ? history
        : actionId === 'sessions.external.candidate.delete' ? deleted
        : actionId === 'sessions.external.transcript.page' ? transcript
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
        toolExposureModes: { mcp: 'direct' },
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
