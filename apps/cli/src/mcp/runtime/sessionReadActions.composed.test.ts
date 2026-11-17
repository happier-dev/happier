import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { accountSettingsParse, normalizeActionsSettingsV1, FeaturesResponseSchema, SessionListQueryV1Schema, SessionListQueryResponseV1Schema, SessionReadBatchRequestV1Schema } from '@happier-dev/protocol';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol/sessions/fork';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createCompactSessionListRowFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionDaemonAuthorityFixture } from './sessionDaemonAuthority.testkit';

// Only OS inspection and network transports are substituted. MCP, Session
// routing, credentialed execution, Session opening and projection stay real.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(['session.status.get', 'session.messages.recent.get', 'session.transcript.get', 'session.stop', 'session.archive',
  'session.unarchive', 'session.fork', 'session.open'] as const)(
  'executes through the real Session MCP envelope and credentialed owner: %s', async actionId => {
  const exactSource = actionId === 'session.transcript.get';
  const read = exactSource || actionId === 'session.status.get' || actionId === 'session.messages.recent.get';
  const ledLifecycle = actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive';
  const sessionId = 'c123456789012345678901230';
  const children = ['c123456789012345678901231', 'c123456789012345678901232'];
  const serverId = 'session-read-home';
  const serverHttpBaseUrl = 'https://session-read.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-read-account' })).toString('base64url')}.signature`, encryption: null };
  const settings = accountSettingsParse({});
  const startContext = resolveCliAgentStartContextV1({ sessionId, machineId: 'read-machine', directory: '/workspace',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, metadata: {},
    starterDepth: 0, turnDepth: 0, callerPermissionMode: read ? 'read-only' : 'default', settings, roles: {} });
  if (!startContext || 'ok' in startContext) throw new Error('Missing canonical caller context fixture');
  const members = new Set(exactSource ? [] : children);
  let sourceReadable = true;
  let sourceQuestionSeq = 1;
  const discussionAddressing = { discussionId: 'source-discussion', messageId: 'question', throughSeq: 1, participantSessionId: sessionId };
  const sourceMessageId = `message-${children[0]}`;
  const managerOf = new Map<string, string>();
  const connectedServices = { v: 2 as const, bindingsByServiceId: {
    'acme.auth/subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'self-non-default' },
  } };
  const row = (id: string) => ({ ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const,
    metadata: JSON.stringify({ machineId: 'read-machine', path: '/workspace', ...(id === sessionId ? { connectedServices } : {}) }), active: read || actionId === 'session.open',
    ...(actionId === 'session.stop' || id === sessionId && actionId === 'session.status.get' ? { metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }), ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1,
        workspace: { machineId: 'read-machine', path: '/workspace' }, connectedServices: { connectedServices },
      }) } : {}),
    manager: { sessionId: managerOf.get(id) ?? sessionId } });
  const httpReads: string[] = [];
  const queryRequests: unknown[] = [];
  const boundaryFailures: string[] = [];
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    const url = new URL(String(request.url));
    if (exactSource && url.pathname === `/v1/discussions/${discussionAddressing.discussionId}`) return { status: 200, data: { discussion: DiscussionSummaryV1Schema.parse({
      id: discussionAddressing.discussionId, ownerAccountId: 'session-read-account', encryptionMode: 'plain',
      anchor: { kind: 'session', sessionId: children[0], messageId: sourceMessageId }, access: 'owner', keyReadiness: true,
      dataEncryptionKey: null, creationLocalId: 'create-source', titleContent: { t: 'plain', v: { v: 1, title: 'Source' } },
      latestMessage: { id: 'question', localId: 'question', seq: 1, authorAccountId: 'session-read-account',
        accountActor: { v: 1, accountId: 'session-read-account', profile: null }, producerV1: null, createdAt: 1 },
      messageSeq: 1, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: ['session-read-account'], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    }) } };
    if (exactSource && url.pathname === `/v1/discussions/${discussionAddressing.discussionId}/messages`) {
      expect(url.searchParams.get('messageId')).toBe('question');
      expect(url.searchParams.get('throughSeq')).toBe('1');
      return sourceReadable ? { status: 200, data: { messages: [{ id: 'question', discussionId: discussionAddressing.discussionId,
        localId: 'question', seq: sourceQuestionSeq, authorAccountId: 'session-read-account', accountActor: { v: 1, accountId: 'session-read-account', profile: null },
        producerV1: null, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Read the source' }] } },
        mentionedAccountIds: [], createdAt: 1 }], messageSeq: 1, hasMoreOlder: false } }
        : { status: 403, data: { error: 'discussion_access_forbidden' } };
    }
    throw new Error(`Unexpected Discussion source read: ${url.pathname}`);
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
    const pathname = new URL(String(url)).pathname;
    httpReads.push(pathname);
    if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    if (pathname === '/v1/machines/read-machine' && actionId === 'session.status.get') return { status: 200, data: { machine: {
      id: 'read-machine', kind: 'persistent', active: false, revokedAt: null, replacedByMachineId: null,
    } } };
    const target = [sessionId, ...children].find(id => pathname === `/v2/sessions/${id}`);
    if (target) return { status: 200, data: { session: row(target) } };
    const transcript = children.find(id => pathname === `/v1/sessions/${id}/messages`);
    if (transcript) return { status: 200, data: { messages: [{ id: `message-${transcript}`, seq: 1,
      localId: null, sidechainId: null, createdAt: 1, updatedAt: 1, messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Ready ${transcript}` } } },
    }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
    boundaryFailures.push(`Unexpected Session read: ${pathname}`);
    throw new Error(`Unexpected Session read: ${pathname}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/v2/sessions/read-batch') {
      const demand = SessionReadBatchRequestV1Schema.parse(body);
      if (demand.underSessionId !== undefined) expect(demand.underSessionId).toBe(sessionId);
      const visible = [sessionId, ...children].filter(id => demand.underSessionId === undefined || id === sessionId || members.has(id));
      return { status: 200, data: createSessionReadBatchResponseFixture({ request: demand, sessions: visible.map(row) }) };
    }
    if ([sessionId, ...children].some(id => pathname === `/v2/sessions/${id}/archive` || pathname === `/v2/sessions/${id}/unarchive`)) {
      return { status: 200, data: { success: true, archivedAt: pathname.endsWith('/unarchive') ? null : 123 } };
    }
    queryRequests.push({ url: String(url), body });
    expect(new URL(String(url)).pathname).toBe('/v2/sessions/query');
    const query = SessionListQueryV1Schema.parse(body);
    expect(query.underSessionId).toBe(sessionId);
    const response = SessionListQueryResponseV1Schema.safeParse({
      sessions: query.storage === 'active' ? [...members].map(id => createCompactSessionListRowFixture(row(id))) : [],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    });
    if (!response.success) {
      boundaryFailures.push(JSON.stringify(response.error.issues));
      throw response.error;
    }
    return { status: 200, data: response.data };
  });
  // A led child's Stop first records the explicit-stop intent in its metadata.
  const metadataPatches: string[] = [];
  vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
    const patch = SessionMetadataOwnerPatchV1Schema.parse(body);
    expect(patch.ownerMetadata).toMatchObject({ t: 'plain', v: { runtime: {
      sessionExplicitStopV1: { cause: 'explicit_stop', managerSessionId: sessionId },
    } } });
    metadataPatches.push(new URL(String(url)).pathname);
    return { status: 200, data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 1 } } };
  });
  // Machine RPC is a process/network boundary. Its strict fork input is read
  // by the real receiving schema; an inactive stop is confirmed by the Home row.
  const stop = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'not_found' });
  const machineRequests: unknown[] = [];
  const stopRequests: unknown[] = [];
  let approvalRequired = false;
  const daemon = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
    serverId, serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process',
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
    }) }),
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      ...(approvalRequired ? { actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } } : {}) }) },
    machineActionDirectTargetTransport: { machineId: 'read-machine', invoke: async (method, request) => {
      // The exact local Machine is reached by its direct transport, never the Home relay.
      if (method === RPC_METHODS.STOP_SESSION) { stopRequests.push(request); return { status: 'not_found' }; }
      expect(method).toBe(RPC_METHODS.SESSION_FORK);
      const parsed = SessionForkRpcParamsSchema.parse(request);
      machineRequests.push(parsed);
      return { ok: true, childSessionId: children[0] };
    } },
  });
  const forwarded: string[] = [];
  const daemonAuthority = await createSessionDaemonAuthorityFixture({ sessionId, execute: async operation => {
    expect(getActionSpec(operation.actionId).inputSchema.safeParse(operation.input).success).toBe(true);
    forwarded.push(operation.actionId);
    const outcome = await daemon.execute(operation.actionId, operation.input, { surface: 'agent',
      authority: 'account_automation', defaultSessionId: sessionId, actionCaller: operation.witness.agentStartCaller,
      ...(exactSource ? { sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: operation.witness.turnId,
        sourceInputId: operation.witness.inputId, via: 'action', discussionAddressing: operation.witness.discussionAddressing } } : {}),
      serverId, agentStartContext: startContext, actionRequestId: operation.requestId });
    return outcome;
  } });
  const witness = { turnId: 'read-turn', inputId: 'read-input', userMessageSeq: 1, userMessageSeqs: [1],
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 }, ...(exactSource ? { discussionAddressing } : {}) };
  let admissionAvailable = true;
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getActiveTurnAdmissionWitness: () => admissionAvailable ? witness : null,
    getActiveTurnPermissionWitness: () => ({ ...witness,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: read ? 'read-only' : 'default' } }),
  }, { authorityScope: 'session',
    actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({ v: 1 })) });
  const client = new Client({ name: 'session-read', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    // An Agent may archive its own Session but never Stop it (self_stop_forbidden).
    const targets = exactSource ? [children[0]!] : actionId === 'session.status.get' ? [sessionId, ...children]
      : read || actionId === 'session.stop' ? children : ledLifecycle ? [sessionId, ...children] : [sessionId];
    for (const child of targets) {
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId, input: { sessionId: child,
          ...(exactSource ? { messageId: sourceMessageId } : {}),
          ...(actionId === 'session.status.get' ? { readiness: true } : {}),
          ...(actionId === 'session.open' ? { intent: 'resume', serverId } : {}) } } }));
      const content = result.content.find(block => block.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing MCP Action result');
      const value: unknown = JSON.parse(content.text);
      expect(result.isError, JSON.stringify({ content, forwarded, httpReads, queryRequests, boundaryFailures })).not.toBe(true);
      expect(value).toMatchObject(actionId === 'session.status.get'
        ? { ok: true, session: { id: child }, awareness: { sessionId: child },
          ...(child === sessionId ? { connectedServices } : {}),
          readiness: { configured: true, status: 'unavailable', cause: 'machine', machine: { status: 'offline' } } }
        : exactSource ? { ok: true, sessionId: child, items: [{ id: sourceMessageId, text: `Ready ${child}` }] }
        : actionId === 'session.messages.recent.get'
          ? { ok: true, sessionId: child, items: [{ kind: 'user_message', text: `Ready ${child}` }] }
          : actionId === 'session.fork' ? { ok: true, childSessionId: children[0] }
          : actionId === 'session.open' ? { ok: true, status: 'opened', sessionId: child }
          : actionId === 'session.stop' ? { ok: true, sessionId: child,
            stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' } }
          : actionId === 'session.archive' ? { success: true, sessionId: child, archivedAt: 123 }
          : { ok: true, sessionId: child, archivedAt: null });
    }
    expect(forwarded).toEqual(targets.map(() => actionId));
    if (exactSource) {
      const page = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId, input: { sessionId: children[0], limit: 20 } } }));
      expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
      for (const input of [{ sessionId: children[1], messageId: sourceMessageId }]) {
        const denied = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
        expect(denied.isError).toBe(true);
      }
      const sourceReads = httpReads.filter(path => path === `/v1/sessions/${children[0]}/messages`).length;
      sourceQuestionSeq = 2;
      const beyondCutoff = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId, input: { sessionId: children[0], messageId: sourceMessageId } } }));
      expect(beyondCutoff.isError).toBe(true);
      expect(httpReads.filter(path => path === `/v1/sessions/${children[0]}/messages`)).toHaveLength(sourceReads);
      sourceQuestionSeq = 1;
    }
    if (actionId === 'session.fork') expect(machineRequests).toMatchObject([{ parentSessionId: sessionId, forkPoint: { type: 'latest' } }]);
    if (actionId === 'session.stop') expect(metadataPatches).toEqual(targets.map(target => `/v2/sessions/${target}`));
    if (actionId === 'session.stop') {
      expect(stopRequests).toEqual(targets.map(target => ({ sessionId: target })));
      expect(stop).not.toHaveBeenCalled();
    }
    if (actionId === 'session.messages.recent.get') {
      for (const child of children) expect(httpReads).toContain(`/v1/sessions/${child}/messages`);
    }
    // Captured facts cannot retain read/lifecycle authority after relationship
    // loss. Fork stays current-Session-only; headless open resumes only the
    // caller's direct managed child, so a child another Session manages is refused.
    if (read || ledLifecycle) members.delete(children[0]!);
    if (exactSource) sourceReadable = false;
    if (actionId === 'session.open') managerOf.set(children[0]!, children[1]!);
    httpReads.length = 0;
    const refused = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: children[0],
        ...(exactSource ? { messageId: sourceMessageId } : {}),
        ...(actionId === 'session.open' ? { intent: 'resume', serverId } : {}) } } }));
    const refusal = refused.content.find(block => block.type === 'text');
    expect(refused.isError).toBe(true);
    expect(refusal?.type === 'text' ? JSON.parse(refusal.text) : null).toMatchObject({ errorCode: 'unsupported_action' });
    expect(httpReads).not.toContain(`/v2/sessions/${children[0]}`);
    if (!read) {
      // Forwarding cannot turn a configured Ask-first Action into a direct
      // effect. This host has no approval Artifact owner, so it must refuse.
      approvalRequired = true;
      // Subtree membership and snapshot batches are Home reads; other POSTs and metadata PATCHes are effects.
      const effects = () => ({ stop: stopRequests.length, fork: machineRequests.length, patches: metadataPatches.length,
        posts: vi.mocked(axios.post).mock.calls.filter(([url]) => !['/v2/sessions/query', '/v2/sessions/read-batch'].includes(new URL(String(url)).pathname)).length });
      const effectsBefore = effects();
      const denied = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId, input: { sessionId: actionId === 'session.stop' ? children[1] : sessionId,
          ...(actionId === 'session.open' ? { intent: 'resume', serverId } : {}) } } }));
      expect(denied.isError, JSON.stringify(denied.content)).toBe(true);
      expect(effects()).toEqual(effectsBefore);
    }
    admissionAvailable = false;
    const forwardedBefore = [...forwarded];
    const unbound = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: read ? children[1] : sessionId,
        ...(actionId === 'session.open' ? { intent: 'resume', serverId } : {}) } } }));
    const unavailable = unbound.content.find(block => block.type === 'text');
    expect(unbound.isError).toBe(true);
    expect(unavailable?.type === 'text' ? JSON.parse(unavailable.text) : null).toMatchObject({ errorCode: 'target_unavailable' });
    expect(forwarded).toEqual(forwardedBefore);
    expect(boundaryFailures).toEqual([]);
  } finally {
    await client.close();
    await runtime.mcp.close();
    await daemonAuthority.close();
  }
});
