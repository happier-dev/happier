import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionAgentPostRequestV1Schema, DiscussionAgentCreateRequestV1Schema,
  DiscussionAgentPostPublicationV1Schema, DiscussionAgentApprovedReplayPublicationV1Schema,
  DiscussionAgentPublisherResponseV1Schema, type DiscussionAgentPublisherPublicationV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionSummaryV1Schema, DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createApiSessionSocketStub, createSessionTranscriptHomeStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { createDiscussionReplyReturnPublisher } from '@/discussions/discussionReplyReturnPublisher';
import { createApprovedDiscussionAgentPublisher } from '@/discussions/approvedDiscussionAgentPublisher';
import { ApiMachineClient } from '@/api/apiMachine';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { logger } from '@/ui/logger';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createResourceDataKey, openResourceDataKey } from '@/api/encryption/resourceDataKey';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { openSessionStoredContent, sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import type { StoredCredentials } from '@/persistence';
import { writeStoredCredentialsForServerId } from '@/persistence';
import type { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ApiSessionClient } from './sessionClient';
import { readApprovedDiscussionPublication } from '@/discussions/approvedDiscussionPublication';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { prepareAnchoredDiscussionCreateV1, prepareSecondOpinionQuestionV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { runSessionLoopLifecycle } from '@/agent/runtime/session/loop/lifecycle';
import { createLifecycleParams } from '@/agent/runtime/session/loop/lifecycle.testkit';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const io = vi.hoisted(() => vi.fn());
// Socket.IO is the sole publication/absent-Session network boundary.
vi.mock('socket.io-client', async original => {
  const actual = await original<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => io.getMockImplementation()
    ? io(...args) : actual.io(...args) };
});
// The local daemon listener is an OS boundary; startup/replay composition stays real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async () => ({ port: 44324, stop: async () => {} }),
}));

afterEach(() => { resetInMemoryAccountSettingsContextForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); io.mockReset(); });

it.each([
  { mode: 'plain', scope: 'draft creation' }, { mode: 'e2ee', scope: 'draft creation' },
  { mode: 'plain', scope: 'completed then late Stop' },
  { mode: 'plain', scope: 'publication replay' }, { mode: 'e2ee', scope: 'publication replay' },
  { mode: 'plain', scope: 'satisfied return' }, { mode: 'e2ee', scope: 'satisfied return' },
  { mode: 'plain', scope: 'pending explicit' }, { mode: 'e2ee', scope: 'pending explicit' },
  { mode: 'plain', scope: 'inactive private Post' }, { mode: 'e2ee', scope: 'inactive private Post' },
  { mode: 'plain', scope: 'inactive host private Post' },
  { mode: 'plain', scope: 'unsigned native startup private Post' },
] as const)('Discussion $scope ($mode)', async ({ mode, scope }) => {
  const startupPost = scope === 'inactive host private Post' || scope === 'unsigned native startup private Post';
  const inactivePost = scope === 'inactive private Post' || startupPost;
  let phase = 'initialization';
  let failedPhase: string | undefined;
  onTestFailed(() => console.error('Discussion approval replay failed during:', mode, failedPhase ?? phase));
  const sessionId = 'cmv3discussionparticipant';
  const completedOutcome = { kind: 'answer' as const, result: { sessionId, messageId: 'native-final-message' } };
  const opinionSourceSessionId = sessionId;
  const serverId = 'discussion-approval-home';
  const machineId = 'participant-machine';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.fixture`;
  const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
    : { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
  const draftAccountSettings = accountSettingsParse({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
    approvalWaivedSurfaces: { 'discussion.reply': ['agent'] } }) });
  const key = await createResourceDataKey({ credentials, mode });
  const contentKeyFingerprint = credentials.encryption?.type === 'legacy'
    ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(computeContentPublicKeyFingerprint(
      libsodiumPublicKeyFromSecretKey(await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content'])),
    )) : null;
  const crypto = key.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
    : { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
  const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'An approved participant answer' }] };
  const summary = DiscussionSummaryV1Schema.parse({ id: 'discussion-1', ownerAccountId: 'owner', encryptionMode: mode,
    anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: key.dataEncryptionKey, creationLocalId: 'create-1',
    titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Discussion' } }),
    latestMessage: { id: 'question-1', localId: 'question-1', seq: 1, authorAccountId: 'owner',
      accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: null, createdAt: 1 }, messageSeq: 1,
    lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
      sendToSession: true, manageAccess: true, leave: false } });
  const artifacts = new Map<string, Record<string, unknown>>();
  const httpCalls: { method?: string; path: string }[] = [];
  let createdDiscussion: ReturnType<typeof DiscussionSummaryV1Schema.parse> | null = null;
  let createdFirstMessage: ReturnType<typeof DiscussionMessageV1Schema.parse> | null = null;
  let humanWrites = 0;
  let accountCurrent = true;
  let terminalReturned = false;
  let explicitReturned = false;
  let corruptNextAck = false;
  let participantPolicy = 'when_addressed';
  let publicationAuthority: 'present_user' | 'account_automation' = 'account_automation';
  // Real HTTP is the sole persistence boundary; Artifact encryption, approval
  // transitions, replay, registration and Discussion resource crypto stay real.
  const home = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    // This per-case Home owns its connections. Do not retain the bootstrap
    // socket across cold Session construction; pooled HTTP lifetime is not the
    // approval/publication contract exercised by this fixture.
    response.setHeader('Connection', 'close');
    const path = request.url?.split('?')[0] ?? '';
    httpCalls.push({ method: request.method, path });
    const reply = (body: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(body)); };
    if (mode === 'plain' && path === '/v2/account/settings') return reply({ version: 1,
      content: { t: 'plain', v: scope === 'draft creation' ? draftAccountSettings : {} } });
    if (mode === 'e2ee' && path === '/v2/account/settings') return reply({ version: 0, content: null });
    if (mode === 'plain' && path === '/v1/account/entity-rows/prompt-library') return reply({ status: 'listed',
      rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
    if (mode === 'plain' && path === '/v2/account/settings/history') return reply({ snapshots: [] });
    if (path === '/v1/account/encryption') return reply({ mode, updatedAt: 1 });
    if (path === '/v1/account/encryption/currentness') return reply({ mode, version: 1, updatedAt: 1,
      signingKeyFingerprint: mode === 'e2ee' ? 'a'.repeat(64) : null, contentKeyFingerprint });
    if (path === '/v1/account/profile') return reply({ id: accountCurrent ? 'owner' : 'revoked-owner' });
    if (path === `/v1/sessions/${opinionSourceSessionId}/messages`) return reply({ messages: [
      { id: 'source-answer', seq: 1, localId: 'source-answer', messageRole: 'agent', createdAt: 1,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Actual source answer' } } } },
    ], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
    if (path === `/v2/sessions/${opinionSourceSessionId}`) return reply({ session:
      createSessionRecordFixture({ id: opinionSourceSessionId, share: null, encryptionMode: 'plain',
        ...(inactivePost ? { active: false,
          metadata: JSON.stringify({ machineId, path: '/repo' }) } : {}) }) });
    if (path.endsWith('/messages/by-local-id/terminal-original/reply')
      || path.endsWith('/messages/by-local-id/forged-terminal-original/reply')) return reply({ v: 1, status: 'available',
      progress: { v: 1, mode: 'return', disposition: terminalReturned ? 'returned' : 'return_pending', acceptedTurnId: 'retired-turn',
        discussion: { discussionId: summary.id, messageId: 'question-1', participantSessionId: sessionId, throughSeq: 1 },
        outcome: { kind: 'failed' } } });
    if (path.endsWith('/messages/by-local-id/satisfied-original/reply')) return reply({ v: 1, status: 'available',
      progress: { v: 1, mode: 'return', disposition: explicitReturned ? 'returned' : 'return_pending', acceptedTurnId: 'retired-turn',
        discussion: { discussionId: summary.id, messageId: 'question-1', participantSessionId: sessionId, throughSeq: 1 },
        outcome: explicitReturned ? { kind: 'answer', publicationRef: { kind: 'discussion', discussion: { serverId, discussionId: summary.id },
          messageId: 'committed-answer' } } : { kind: 'failed' } } });
    if (path.includes('/messages/by-local-id/') && path.endsWith('/reply')) return reply({ v: 1, status: 'available',
      progress: { v: 1, mode: 'return', disposition: 'return_pending',
        acceptedTurnId: path.includes('/pending-original/') ? 'retired-turn' : 'native-draft-turn',
        discussion: { discussionId: summary.id, messageId: 'question-1', participantSessionId: sessionId, throughSeq: 1 },
        outcome: scope === 'completed then late Stop' ? completedOutcome : { kind: 'failed' } } });
    if (path.startsWith('/v2/sessions/')) return reply({ session: createSessionRecordFixture({ id: sessionId, share: null }) });
    if (path === '/v1/discussions/discussion-1' && request.method === 'GET') return reply({ discussion: summary });
    if (path === '/v1/discussions/created-discussion' && request.method === 'GET') return reply({ discussion: createdDiscussion });
    if (path === '/v1/discussions/created-discussion/messages' && request.method === 'GET') return reply({
      messages: createdFirstMessage ? [createdFirstMessage] : [], hasMoreOlder: false, messageSeq: 1 });
    if (path === '/v1/discussions/created-discussion/participants' && request.method === 'GET') return reply({
      discussionId: 'created-discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
      participants: [{ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 }],
    });
    if (path === '/v1/discussions/discussion-1/participants' && request.method === 'GET') return reply({
      discussionId: summary.id, ownerAccountId: 'owner', access: 'owner', grants: [],
      participants: [{ participant: { kind: 'session', sessionId }, answerPolicy: participantPolicy, createdAt: 1 }],
    });
    if (path === '/v1/discussions' && request.method === 'GET') return reply({ discussions: createdDiscussion ? [createdDiscussion] : [], nextCursor: null });
    if (path === '/v1/discussions/discussion-1/data-key/recipients') return reply({ discussionId: summary.id,
      ownerAccountId: 'owner', encryptionMode: mode, access: 'owner', dataEncryptionKey: key.dataEncryptionKey,
      callerDataEncryptionKey: key.dataEncryptionKey, recipients: [] });
    if (path.startsWith('/v1/artifacts')) {
      if (inactivePost && request.headers.authorization !== `Bearer ${token}`)
        return reply({ error: 'artifact_access_denied' }, 403);
      if (path === '/v1/artifacts' && request.method === 'GET') return reply(artifactListResponse(`http://localhost${request.url}`, [...artifacts.values()]));
      if (path === '/v1/artifacts/read' && request.method === 'POST') {
        let raw = ''; for await (const chunk of request) raw += chunk.toString();
        return reply(artifactReadResponse(JSON.parse(raw), artifactId => (artifacts.get(artifactId) as { id: string } | undefined) ?? null).data);
      }
      if (path.endsWith('/access/recipients')) {
        const artifactId = decodeURIComponent(path.split('/')[3] ?? '');
        const row = artifacts.get(artifactId);
        return row ? reply({ artifactId, ownerAccountId: 'owner', encryptionMode: mode, access: 'owner',
          dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [] })
          : reply({ error: 'artifact_not_found' }, 404);
      }
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      if (request.method === 'GET') return artifacts.has(id) ? reply(artifacts.get(id)) : reply({ error: 'not_found' }, 404);
      let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
      // This is an HTTP boundary fixture; canonical stores produce these bytes.
      const body = JSON.parse(bytes) as Record<string, unknown>;
      if (path === '/v1/artifacts' && typeof body.id === 'string') {
        artifacts.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode, publicAudience: 'none',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return reply({ id: body.id, headerVersion: 1, bodyVersion: 1 });
      }
      const row = artifacts.get(id);
      if (!row) return reply({ error: 'not_found' }, 404);
      if (row.headerVersion !== body.expectedHeaderVersion || row.bodyVersion !== body.expectedBodyVersion)
        return reply({ success: false, error: 'version-mismatch' });
      Object.assign(row, { header: body.header, body: body.body, headerVersion: Number(row.headerVersion) + 1,
        bodyVersion: Number(row.bodyVersion) + 1, seq: Number(row.seq) + 1, updatedAt: Number(row.updatedAt) + 1 });
      return reply({ success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion });
    }
    if (request.method === 'POST' && path.startsWith('/v1/discussions')) humanWrites++;
    return reply({ error: 'not_found' }, 404);
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing test Home address');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  let advertisedHomeId = 'srv_fixture_home';
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    httpCalls.push({ method: init?.method ?? 'GET', path: `fetch:${new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, serverUrl).pathname}` });
    return new Response(JSON.stringify({ features: { sessions: { enabled: true,
    conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {
    serverIdentity: { serverIdentityId: advertisedHomeId }, session: { pendingInput: { protocolVersion: 1 },
      runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 } } } }), { status: 200 });
  }));
  const publications: DiscussionAgentPublisherPublicationV1[] = [];
  const transcript = createSessionTranscriptHomeStub();
  const activity = createSessionRuntimeActivityHomeStub({ machineId });
  const defaults = createApiSessionSocketStub();
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
    if (event !== DISCUSSION_AGENT_POST_EVENT_V1) return transcript.answer(event, payload)
      ?? activity.answer(event, payload) ?? defaults.emitWithAck(event, payload);
    if (payload && typeof payload === 'object' && 'operation' in payload) {
      const parsed = DiscussionAgentCreateRequestV1Schema.parse(payload);
      publications.push(parsed);
      createdDiscussion = DiscussionSummaryV1Schema.parse({ ...summary, id: 'created-discussion',
        creationLocalId: parsed.request.creationLocalId, titleContent: parsed.request.titleContent,
        anchor: parsed.request.anchor ?? null,
        dataEncryptionKey: parsed.request.dataEncryptionKey ?? null,
        latestMessage: { ...summary.latestMessage, id: 'created-first', localId: parsed.request.firstMessage.localId } });
      createdFirstMessage = DiscussionMessageV1Schema.parse({ id: 'created-first',
        discussionId: createdDiscussion.id, localId: parsed.request.firstMessage.localId, seq: 1, authorAccountId: 'owner',
        accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: { v: 1, kind: 'agent', sessionId },
        content: parsed.request.firstMessage.content, mentionedAccountIds: [], createdAt: 1 });
      return { v: 1, ok: true, value: { discussion: createdDiscussion, firstMessage: createdFirstMessage } };
    }
    const parsed = DiscussionAgentPostPublicationV1Schema.parse(payload);
    publications.push(parsed);
    if (parsed.replyReturn?.requestLocalId === 'satisfied-original') explicitReturned = true;
    // Home committed the write, but the response is not usable by the caller.
    if (corruptNextAck) { corruptNextAck = false; return { committedButAcknowledgementUnavailable: true }; }
    return { v: 1, ok: true, value: { messageSeq: 2, message: { id: 'committed-answer', discussionId: summary.id,
      localId: parsed.request.localId, seq: 2, authorAccountId: 'owner', accountActor: { v: 1, accountId: 'owner', profile: null },
      producerV1: { v: 1, kind: 'agent', sessionId }, content: parsed.request.content, mentionedAccountIds: [], createdAt: 1 } } };
  } });
  if (mode === 'plain' || scope === 'publication replay' || inactivePost) await runWithServerHttpBaseUrl(serverUrl,
    () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking' }));
  if (inactivePost) {
    phase = scope;
    const privateContent = scope === 'inactive host private Post'
      ? { v: 1 as const, parts: [{ t: 'text' as const, text: 'The requested session failed.' }] } : content;
    participantPolicy = 'drafts_for_approval';
    const machinePublications: unknown[] = [];
    const absentSessionCalls: unknown[] = [];
    const missingSession = { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    const machineSocket = createApiSessionSocketStub({
      emit: (event, args) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        absentSessionCalls.push(args[0]);
        const callback = args.at(-1);
        if (typeof callback === 'function') callback(missingSession);
      },
      emitWithAck: async (event, payload) => {
        if (event === SOCKET_RPC_EVENTS.CALL) { absentSessionCalls.push(payload); return missingSession; }
        if (event === DISCUSSION_AGENT_POST_EVENT_V1) {
          machinePublications.push(payload);
          const { publication } = DiscussionAgentApprovedReplayPublicationV1Schema.parse(payload);
          return { v: 1, ok: true, value: { messageSeq: 2, message: { id: 'private-committed',
            discussionId: summary.id, localId: publication.request.localId, seq: 2, authorAccountId: 'owner',
            accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: { v: 1, kind: 'agent', sessionId },
            content: publication.request.content, mentionedAccountIds: [], createdAt: 1 } } };
        }
        return { result: 'success', version: 1 };
      },
    });
    // Each real transport gets its own boundary socket. Sharing the Machine
    // socket with the Account observer would make one owner's close retire both.
    io.mockReset();
    io.mockImplementation((_url: unknown, options: unknown) => {
      const auth = options && typeof options === 'object' && 'auth' in options ? options.auth : null;
      const clientType = auth && typeof auth === 'object' && 'clientType' in auth ? auth.clientType : null;
      if (clientType === 'machine-scoped') return machineSocket;
      if (clientType !== 'user-scoped') throw new Error('Unexpected inactive publication Socket scope');
      return createApiSessionSocketStub({
      emit: (event, args) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        absentSessionCalls.push(args[0]);
        const callback = args.at(-1);
        if (typeof callback === 'function') callback(missingSession);
      },
      emitWithAck: async (event, payload) => {
        if (event === SOCKET_RPC_EVENTS.CALL) { absentSessionCalls.push(payload); return missingSession; }
        return { result: 'success', version: 1 };
      },
      });
    });
    let machine: ApiMachineClient | null = null;
    let startupFixture: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
    let startupDirectory: string | undefined;
    try {
      if (startupPost) {
        startupDirectory = await mkdtemp(join(tmpdir(), 'happier-inactive-discussion-post-'));
        const { createRequesterSessionControlRuntimeFixture } = await import('@/daemon/testkit/requesterSessionControlRuntimeFixture');
        const { ConnectedServiceRuntimeRegistry } = await import('@/daemon/connectedServices/runtimeRegistry/registry');
        startupFixture = await createRequesterSessionControlRuntimeFixture({
          happyHomeDir: join(startupDirectory, 'home'), activeServerDir: join(startupDirectory, 'home', 'servers', serverId),
          serverId, serverHttpBaseUrl: serverUrl, machineId, custodianAccountId: 'owner', credentials,
          connectedServicesMaterializationBaseDir: join(startupDirectory, 'connected-services'),
          registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
          getApiMachineForSessions: () => machine, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
          beforeStartup: async () => { await writeStoredCredentialsForServerId(serverId, credentials); },
          startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: 'srv_fixture_home' }) },
        });
        await runWithServerHttpBaseUrl(serverUrl, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking' }));
      }
      machine = await runWithServerHttpBaseUrl(serverUrl, async () => {
        const client = new ApiMachineClient(token, { id: machineId, encryptionMode: 'plain',
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        client.connect();
        return client;
      });
      const connectedMachine = machine;
      // Match Socket.IO's autoConnect:false lifecycle so the real Account
      // observer receives its authenticated connection occurrence too.
      await vi.waitFor(() => expect(machineSocket.connect).toHaveBeenCalled());
      await runWithServerHttpBaseUrl(serverUrl, async () => {
        phase = `${scope}: Account mode boundary`;
        expect(await createConnectedServiceCredentialApi(credentials).getAccountEncryptionMode({ throwOnTransportError: true })).toBe(mode);
        phase = scope;
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
          machineId, serverId, serverApiUrl: serverUrl,
          // No runner remains: the existing lifecycle port has no live caller.
          isSessionCallerCurrent: async () => false });
        if (!currentness) throw new Error('Missing canonical inactive approval currentness');
        const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl: serverUrl });
        const post = createApprovedDiscussionAgentPublisher({ credentials, machineId, serverId, serverUrl,
          isApprovalExecutionOriginCurrent: currentness,
          publish: (publication, options) => connectedMachine.postAgentDiscussionMessage(publication, options) });
        // A different plaintext Account has no client Account encryption material
        // and cannot open the owner's private Artifact at this real HTTP boundary.
        const foreignCredentials: StoredCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'other-owner' })).toString('base64url')}.fixture`,
          encryption: null };
        const foreignPost = createApprovedDiscussionAgentPublisher({ credentials: foreignCredentials,
          machineId, serverId, serverUrl, isApprovalExecutionOriginCurrent: currentness,
          publish: (publication, options) => connectedMachine.postAgentDiscussionMessage(publication, options) });
        const refused: unknown[] = [];
        const deps = createDiscussionActionDeps({ credentials, serverId, serverHttpBaseUrl: serverUrl,
          postAgentMessage: async (request, options) => {
            if (!options?.approvedActionReplay) throw new Error('A private draft must be approved before publication');
            if ('operation' in request) throw new Error('Unexpected create from private Post');
            const reviewed = { ...options, approvedActionReplay: options.approvedActionReplay,
              callerAuthority: 'present_user' as const };
            refused.push(await post({ ...request, request: { ...request.request,
              content: sealSessionStoredContent({ ...crypto, payload: { v: 1, parts: [{ t: 'text', text: 'Unapproved replacement' }] } }) } }, reviewed));
            refused.push(await post(request, { ...reviewed, callerAuthority: 'account_automation' }));
            if (mode === 'plain') refused.push(await foreignPost(request, reviewed));
            expect(machinePublications).toEqual([]);
            return post(request, reviewed);
          } });
        const executor = createActionExecutor({ ...createCliActionDeps({ credentials, token, sessionId,
          serverId, serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null }), ...store, ...deps,
          isApprovalExecutionOriginCurrent: currentness });
        const source = { sourceSessionId: sessionId, sourceInputId: 'native-draft-input',
          sourceTurnId: 'native-draft-turn', via: 'action' as const, discussionAddressing: {
            discussionId: summary.id, messageId: 'question-1', throughSeq: 1, participantSessionId: sessionId } };
        if (scope === 'inactive host private Post') {
          await createDiscussionReplyReturnPublisher({ credentials, machineId, serverId, serverHttpBaseUrl: serverUrl,
            signal: new AbortController().signal, isCurrent: async () => true,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => draftAccountSettings,
              allowEnvironmentOverride: false }) })({ serverId, requestSessionId: sessionId,
            requestLocalId: source.sourceInputId, acceptedTurnId: source.sourceTurnId,
            discussion: source.discussionAddressing, outcome: { kind: 'failed' }, message: privateContent.parts[0]!.text });
        } else {
          const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
          const draftExecutor = createCliActionExecutor({ credentials, token, sessionId, serverId,
            serverIdentityId: 'srv_fixture_home', serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => draftAccountSettings,
              allowEnvironmentOverride: false }) });
          const draft = await draftExecutor.execute('discussion.reply', { discussionId: summary.id,
            localId: 'private-post', content: privateContent, replyTarget: { kind: 'message', messageId: 'question-1' } }, {
            serverId, serverIdentityId: 'srv_fixture_home', surface: 'agent', authority: 'account_automation',
            defaultSessionId: sessionId, defaultSessionMachineId: machineId, actionRequestId: 'private-post',
            actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, sessionInputSource: source });
          expect(draft, JSON.stringify(draft)).toMatchObject({ ok: true });
        }
        const open = await store.approvalsList({ serverId, status: 'open', limit: 10 });
        expect(open.items).toHaveLength(1);
        const artifactId = open.items[0]!.artifactId;
        const captured = await store.approvalsGet({ serverId, artifactId });
        expect(captured).toMatchObject({ v: 2, status: 'open', actionId: 'discussion.reply',
          discussionDraftReview: true, executionOriginV1: { machineId, sessionInputSource: source,
            discussionReplyReturn: { serverId: 'srv_fixture_home', requestLocalId: source.sourceInputId, acceptedTurnId: source.sourceTurnId } },
          actionArgs: { content: privateContent } });
        if (captured?.v !== 2) throw new Error('Missing actual private draft');
        if (scope === 'unsigned native startup private Post') {
          expect(captured.executionOriginV1.caller.kind).toBe('session');
          expect(captured.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
          expect(captured.requesterConfirmation).toBeUndefined();
          expect(requiresExactDaemonApprovalReplay(captured)).toBe(true);
        }
        expect(await store.approvalsUpdate({ artifactId, serverId, request: { ...captured, status: 'approved',
          updatedAtMs: captured.updatedAtMs + 1, decision: { kind: 'approve',
            decidedAtMs: captured.updatedAtMs + 1, authority: 'present_user' } } })).toMatchObject({ ok: true });
        const replay = () => {
          if (!startupPost)
            return executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
          const ingress = startupFixture?.runtime.externalActionIngressOwner;
          if (!ingress?.executor.replayApprovedApprovalRequest) throw new Error('Missing startup-composed approval executor');
          return ingress.executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
        };
        const result = await replay();
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(refused).toEqual(Array.from({ length: startupPost ? 0 : mode === 'plain' ? 3 : 2 },
          () => ({ v: 1, ok: false, error: 'discussion_post_denied' })));
        expect(absentSessionCalls).toEqual([]);
        expect(machinePublications).toHaveLength(1);
        expect(machinePublications[0]).toMatchObject({ v: 1, operation: 'approved_replay', machineId,
          publication: { v: 1, sessionId, discussionId: summary.id, sourceSession: source,
            draftReview: { artifactId, decidingAccountId: 'owner' } } });
        const { publication } = DiscussionAgentApprovedReplayPublicationV1Schema.parse(machinePublications[0]);
        expect(openSessionStoredContent({ ...crypto, content: publication.request.content })).toEqual(privateContent);
        await replay();
        expect(machinePublications).toHaveLength(1);
        expect(await store.approvalsGet({ artifactId, serverId })).toMatchObject({ status: 'executed' });
        expect(humanWrites).toBe(0);
      });
    } finally {
      await machine?.shutdown();
      await startupFixture?.dispose();
      if (startupDirectory) await rm(startupDirectory, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
    return;
  }
  const client = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId }), { localMachineId: machineId,
    metadataAuthority: { kind: 'owner', credentials }, transport: { serverId, serverUrl,
      createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) } });
  const lifetime = new AbortController();
  applyRunnerMcpSessionContext(client, { getActiveTurnAdmissionWitness: () => null,
    getRuntimeLifetimeSignal: () => lifetime.signal });
  try {
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
      machineId, serverId, serverApiUrl: serverUrl, isSessionCallerCurrent: ({ caller, signal }) =>
        caller.sessionId === sessionId && !lifetime.signal.aborted && !signal?.aborted });
    if (!currentness) throw new Error('Missing canonical currentness owner');
    const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl: serverUrl });
    const secondKeyResults: unknown[] = [];
    const draftAutomationResults: unknown[] = [];
    const nonhumanCreateResults: unknown[] = [];
    const reviewedActorStamps: unknown[] = [];
    let lastPublicationReplay: string | undefined;
    const deps = createDiscussionActionDeps({ credentials, serverId, serverHttpBaseUrl: serverUrl,
      postAgentMessage: async (request, options) => {
        lastPublicationReplay = options?.approvedActionReplay?.artifactId;
        if (!('operation' in request) && participantPolicy === 'when_addressed' && options?.approvedActionReplay) {
          const reviewed = await readApprovedDiscussionPublication({
            artifactId: options.approvedActionReplay.artifactId, request, credentials, sessionId, serverId, serverUrl,
            callerAuthority: 'present_user', isApprovalExecutionOriginCurrent: currentness,
          });
          reviewedActorStamps.push(reviewed?.draftReview);
        }
        // JSON transport omits absent optional fields; preserve that boundary
        // shape when invoking the actual registrar in-process.
        const replay = options?.approvedActionReplay ? { approvedActionReplay: options.approvedActionReplay } : {};
        if (participantPolicy === 'drafts_for_approval') {
          draftAutomationResults.push(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1',
            { request, ...replay }, { ...options, rpcContext: { callerAuthority: 'account_automation' } }));
          draftAutomationResults.push(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1',
            { request: { ...request, draftReview: { artifactId: 'forged-review', decidingAccountId: 'owner' } }, ...replay },
            { ...options, rpcContext: { callerAuthority: 'present_user' } }));
        }
        const alternateRequests = 'operation' in request ? [
          { ...request, request: { ...request.request, creationLocalId: 'second-unapproved-creation' } },
          { ...request, request: { ...request.request, firstMessage: { ...request.request.firstMessage, localId: 'second-unapproved-first' } } },
        ] : [{ ...request, request: { ...request.request, localId: 'second-unapproved-wire-key' } }];
        const message = 'operation' in request ? request.request.firstMessage : request.request;
        const requestKey = 'operation' in request
          ? await openResourceDataKey({ credentials, mode, dataEncryptionKey: request.request.dataEncryptionKey ?? null }) : key;
        const requestCrypto = requestKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
          : { mode: 'e2ee' as const, ctx: { encryptionKey: requestKey.dataKey, encryptionVariant: 'dataKey' as const } };
        const opened = DiscussionMessageContentV1Schema.parse(openSessionStoredContent({ ...requestCrypto, content: message.content }));
        // The original discussion.create Action requires a present person;
        // Doc comment/propose keep their own configurable posting authority.
        if ('operation' in request && !('kind' in opened)) nonhumanCreateResults.push(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
          request, approvedActionReplay: options?.approvedActionReplay,
        }, { ...options, rpcContext: { callerAuthority: 'account_automation' } }));
        if ('kind' in opened) {
          const marker = message.docEditProposal ? undefined : true as const;
          const markerSubstitution = 'operation' in request
            ? { ...request, request: { ...request.request, firstMessage: { ...request.request.firstMessage, docEditProposal: marker } } }
            : { ...request, request: { ...request.request, docEditProposal: marker } };
          secondKeyResults.push(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
            request: markerSubstitution, approvedActionReplay: options?.approvedActionReplay,
          }, options));
          if (opened.kind === 'workflow_result') throw new Error('Doc discussion fixture opened a workflow result');
          const changed = opened.kind === 'doc_passage_comment'
            ? { ...opened, content: { v: 1, parts: [{ t: 'text', text: 'Unreviewed comment' }] } }
            : { ...opened, proposal: { ...opened.proposal, after: 'Unreviewed replacement' } };
          const replaced = sealSessionStoredContent({ ...requestCrypto, payload: changed });
          const alternate = 'operation' in request
            ? { ...request, request: { ...request.request, firstMessage: { ...request.request.firstMessage, content: replaced } } }
            : { ...request, request: { ...request.request, content: replaced } };
          secondKeyResults.push(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
            request: alternate, approvedActionReplay: options?.approvedActionReplay,
          }, options));
        }
        for (const alternate of alternateRequests) secondKeyResults.push(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
          request: alternate, ...replay,
        }, options));
        return DiscussionAgentPublisherResponseV1Schema.parse(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1',
          { request, ...replay },
          { ...options, rpcContext: { callerAuthority: 'operation' in request ? 'present_user' : publicationAuthority } }));
      } });
    // The live Session is plain in both Account/Discussion encryption modes;
    // its Action ports must not reuse the independent Discussion resource key.
    const fresh = () => createActionExecutor({ ...createCliActionDeps({ credentials, token, sessionId,
      serverId, serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null }),
      ...store, ...deps, isApprovalExecutionOriginCurrent: currentness });
    const actionArgs = { discussionId: summary.id, content }; // Omitted generated localId is a valid approved input.
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId }, actionId: 'discussion.post', actionArgs,
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
        serverId, accountId: 'owner', machineId, sessionId, actionId: 'discussion.post', requestId: 'approved-tool',
        sessionInputSource: { sourceSessionId: sessionId, sourceInputId: 'original', sourceTurnId: 'retired-turn', via: 'action' } },
      summary: 'Publish approved answer', approval: { flow: 'deferred', result: 'required' } });
    const docTarget = { ref: { kind: 'doc' as const, artifactId: 'doc-1', serverId },
      revision: { headerVersion: 1, bodyVersion: 2 }, range: { start: 0, end: 3 }, quote: 'old' };
    const approve = async (operation: 'post' | 'create' | 'doc-root' | 'doc-proposal' = 'post') => {
      const proposal = operation === 'post' ? request : operation === 'create' ? ApprovalRequestV2Schema.parse({ ...request, actionId: 'discussion.create',
        createdBy: { surface: 'mcp', sessionId },
        actionArgs: { title: 'Created by approved Session', firstMessage: { content } },
        executionOriginV1: { ...request.executionOriginV1, surface: 'mcp', actionId: 'discussion.create', requestId: 'approved-create' } })
        : ApprovalRequestV2Schema.parse({ ...request,
          actionId: operation === 'doc-root' ? 'doc.comment.reply' : 'doc.edit.propose',
          actionArgs: operation === 'doc-root' ? { target: docTarget, localId: 'approved-doc-root', content }
            : { target: docTarget, localId: 'approved-doc-proposal', discussionRef: { serverId, discussionId: summary.id },
              baseRevision: docTarget.revision, before: 'old', after: 'new', reason: 'Clarify' },
          executionOriginV1: { ...request.executionOriginV1,
            actionId: operation === 'doc-root' ? 'doc.comment.reply' : 'doc.edit.propose', requestId: `approved-${operation}` } });
      const created = await store.approvalsCreate({ request: proposal, serverId });
      expect(await store.approvalsUpdate({ artifactId: created.artifactId, serverId, request: { ...proposal,
        status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } } })).toMatchObject({ ok: true });
      return created.artifactId;
    };
    await runWithServerHttpBaseUrl(serverUrl, async () => {
      if (scope === 'pending explicit') {
        phase = 'pending explicit approval and final fallback share original custody';
        const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
        const policy = createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}),
          allowEnvironmentOverride: false });
        const explicit = createCliActionExecutor({ credentials, token, sessionId, mode: 'plain', ctx: null,
          serverId, serverIdentityId: 'srv_fixture_home', serverHttpBaseUrl: serverUrl, actionsSettingsProvider: policy });
        const original = { serverId, requestSessionId: sessionId, requestLocalId: 'pending-original',
          acceptedTurnId: 'retired-turn', discussion: { discussionId: summary.id, messageId: 'question-1',
            throughSeq: 1, participantSessionId: sessionId }, message: 'A later final answer cannot replace the explicit draft',
          outcome: { kind: 'failed' as const } };
        await explicit.execute('discussion.reply', { discussionId: summary.id, localId: 'explicit-tool-local',
          replyTarget: { kind: 'message', messageId: 'question-1' }, content,
        }, { serverId, serverIdentityId: 'srv_fixture_home', surface: 'agent', authority: 'account_automation',
          defaultSessionId: sessionId, defaultSessionMachineId: machineId, actionRequestId: 'explicit-tool',
          actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
          sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'retired-turn', sourceInputId: 'pending-original',
            via: 'action', discussionAddressing: original.discussion } });
        expect(artifacts.size).toBe(1);
        const captured = structuredClone([...artifacts.entries()]);
        await createDiscussionReplyReturnPublisher({ credentials, machineId, serverId, serverHttpBaseUrl: serverUrl,
          signal: lifetime.signal, isCurrent: async () => true, actionsSettingsProvider: policy })(original);
        expect(artifacts.size).toBe(1);
        expect([...artifacts.entries()]).toEqual(captured);
        expect(publications).toEqual([]);
        expect(humanWrites).toBe(0);
        return;
      }
      if (scope === 'satisfied return') {
        phase = 'explicit publication wins before final Action admission';
        corruptNextAck = true;
        await expect(client.postAgentDiscussionMessage({ discussionId: summary.id,
          request: { localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId: 'satisfied-original', acceptedTurnId: 'retired-turn' }),
            content: sealSessionStoredContent({ ...crypto, payload: content }), mentionedAccountIds: [],
            replyTarget: { kind: 'message', messageId: 'question-1' },
            ...(key.mode === 'e2ee' ? { requestEqualityEvidenceV1: { kind: 'e2eeTag' as const,
              tag: deriveDiscussionMutationEqualityTagV1({ dataKey: key.dataKey,
                canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content,
                  mentionedAccountIds: [], mentionedSessionIds: [], replyTarget: { kind: 'message', messageId: 'question-1' } }) }) } } : {}) },
          replyReturn: { serverId, requestLocalId: 'satisfied-original', acceptedTurnId: 'retired-turn' },
        })).rejects.toThrow();
        expect(explicitReturned).toBe(true);
        const publish = createDiscussionReplyReturnPublisher({ credentials, machineId, serverId,
          serverHttpBaseUrl: serverUrl, signal: lifetime.signal, isCurrent: async () => true,
          actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}),
            allowEnvironmentOverride: false }),
        });
        // Recovery captured this terminal result before the explicit append
        // committed. The actual Home read now reports that same original as
        // satisfied; final Action admission must not create another approval.
        await publish({ serverId, requestSessionId: sessionId, requestLocalId: 'satisfied-original',
          acceptedTurnId: 'retired-turn', discussion: { discussionId: summary.id, messageId: 'question-1',
            throughSeq: 1, participantSessionId: sessionId }, message: 'The later final answer must not replace the explicit one',
          outcome: { kind: 'failed' } });
        expect(artifacts.size).toBe(0);
        expect(publications).toHaveLength(1);
        expect(humanWrites).toBe(0);
        expect(httpCalls).toContainEqual({ method: 'GET',
          path: `/v2/sessions/${sessionId}/messages/by-local-id/satisfied-original/reply` });
        return;
      }
      if (scope === 'completed then late Stop') {
        phase = 'completed native turn then idle host Stop';
        const restoreProjectHome = installEmptyProjectAccountRowsHttpBoundary();
        const base = createLifecycleParams({ policyAgentId: 'codex', runPermissionModePromptLoopFn: runPermissionModePromptLoop });
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
          mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
        let nativeListener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let abortRequested: (() => void | Promise<void>) | null | undefined;
        let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(async request => ({
          status: 'requested', turnId: request.turnId,
        }));
        // Only the native Agent and acknowledged Session transport are
        // boundaries. Host Stop, prompt loop, native turn state, ordered
        // transcript projection and the approval publisher remain real.
        const provider: AgentSessionRuntime = {
          async send() { throw new Error('This provider-owned turn has no host prompt'); },
          cancel,
          watch(listener) { nativeListener = listener; return { dispose() { nativeListener = undefined; } }; },
          dispose() {},
        };
        const lifecycleSession = Object.assign(base.session, {
          sessionId,
          getLastObservedMessageSeq: () => 42,
          getCommittedUserMessageSeq: (localId: string) => localId === 'native-draft-input' ? 40 : null,
          enqueueAgentMessageCommitted: vi.fn<NonNullable<typeof base.session.enqueueAgentMessageCommitted>>(async (_agent, body) => ({
            persisted: true, delivered: true, committedSequence: body.type === 'message' ? 42 : 43,
          })),
        });
        const declaration = readAgentCatalogSnapshot().agentDefinitionsById.get('codex');
        if (!declaration?.richDefinition || !declaration.pluginId) throw new Error('Missing Codex Agent declaration');
        const runtimeScope = new AbortController();
        const services = createUnavailablePluginServices();
        const contextFixture = createAcpSessionRuntimeContextFixture({
          agent: declaration.richDefinition.definition, pluginId: declaration.pluginId,
          sessionId, directory: '/workspace', signal: runtimeScope.signal, session: client, services,
          protocols: createPublicAcpRuntimeProtocols({ pluginId: declaration.pluginId, agentId: declaration.id,
            signal: runtimeScope.signal, isCurrent: () => !runtimeScope.signal.aborted, services }),
        });
        const runtime = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined, {
          context: contextFixture.context, cwd: '/workspace', connectedAccounts: [],
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
          cancellation: { declared: true, cancel }, configuration: { declared: false }, compaction: { capability: null },
        });
        const running = runSessionLoopLifecycle({
          ...base, session: lifecycleSession, runtime, hookRuntime: runtime,
          config: { ...base.config, startRuntimeBeforeFirstPrompt: true },
          permissionModeState: { ...base.permissionModeState, messageQueue: queue },
          setAbortRequestedCallback: callback => { abortRequested = callback; },
          deps: { ...base.deps,
            registerRunnerTerminationHandlersFn: options => {
              termination = registerRunnerTerminationHandlers({
                ...options, processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined,
              });
              return termination;
            },
          },
        });
        let sequence = 0;
        const emit = (event: Readonly<Record<string, unknown>>) => nativeListener?.(AgentSessionRuntimeEventV1Schema.parse({
          ...event, sessionId, sequence: ++sequence, emittedAtMs: Date.now(),
        }));
        try {
          phase = 'provider-owned runtime subscription';
          await vi.waitFor(() => { expect(nativeListener).toBeTypeOf('function'); expect(abortRequested).toBeTypeOf('function'); });
          emit({ kind: 'turn-start', turnId: 'native-draft-turn', startedBy: 'provider' });
          emit({ kind: 'input-accepted', inputIds: ['native-draft-input'], delivery: { kind: 'newTurn', turnId: 'native-draft-turn' } });
          emit({ kind: 'transcript-message-committed', turnId: 'native-draft-turn', messageId: completedOutcome.result.messageId,
            role: 'assistant', text: 'The complete answer survives a late Stop' });
          emit({ kind: 'turn-complete', turnId: 'native-draft-turn' });
          phase = 'ordered completed answer custody';
          await vi.waitFor(() => expect(lifecycleSession.enqueueSessionTurnMutation).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'complete', turnId: 'native-draft-turn' })));
          phase = 'idle host Stop';
          await abortRequested?.();
          const mutations = vi.mocked(lifecycleSession.enqueueSessionTurnMutation!).mock.calls.map(([mutation]) => mutation);
          expect(mutations.some(mutation => mutation.action === 'cancel' || mutation.action === 'fail')).toBe(false);
          expect(mutations.some(mutation => 'transcriptAnchors' in mutation
            && mutation.transcriptAnchors?.finalAssistantMessageSeq === 42)).toBe(true);
          expect(cancel).not.toHaveBeenCalled();
          const final = lifecycleSession.enqueueAgentMessageCommitted.mock.calls.find(([, body]) => body.type === 'message')?.[1];
          if (final?.type !== 'message') throw new Error('Missing committed completed answer');
          // The Home return read above is the server boundary. Its exact
          // completed result is consumed by the real daemon publication path.
          restoreProjectHome();
          const publish = createDiscussionReplyReturnPublisher({ credentials, machineId, serverId,
            serverHttpBaseUrl: serverUrl, signal: lifetime.signal, isCurrent: async () => true,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}),
              allowEnvironmentOverride: false }),
          });
          const original = { serverId, requestSessionId: sessionId, requestLocalId: 'native-draft-input',
            acceptedTurnId: 'native-draft-turn', discussion: { discussionId: summary.id, messageId: 'question-1',
              throughSeq: 1, participantSessionId: sessionId }, message: final.message, outcome: completedOutcome };
          phase = 'completed answer fallback approval';
          await publish(original);
          const first = await store.approvalsList({ status: 'open', limit: 10, serverId });
          expect(first.items).toHaveLength(1);
          const artifactId = first.items[0]!.artifactId;
          const approval = await store.approvalsGet({ artifactId, serverId });
          expect(approval).toMatchObject({ status: 'open', actionId: 'discussion.reply',
            actionArgs: { replyTarget: { kind: 'message', messageId: 'question-1' },
              content: { parts: [{ t: 'text', text: final.message }] } },
            executionOriginV1: { discussionReplyReturn: { requestLocalId: original.requestLocalId,
              acceptedTurnId: original.acceptedTurnId } } });
          phase = 'late Stop and return recovery rejoin';
          await abortRequested?.();
          await publish(original);
          expect((await store.approvalsList({ status: 'open', limit: 10, serverId })).items).toEqual(first.items);
          expect(await store.approvalsGet({ artifactId, serverId })).toEqual(approval);
          expect(publications).toEqual([]);
          expect(humanWrites).toBe(0);
        } catch (error) {
          failedPhase = phase;
          throw error;
        } finally {
          phase = 'completed turn fixture shutdown';
          emit({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
          termination?.requestTermination({ kind: 'killSession' });
          await running;
          runtimeScope.abort();
          await contextFixture.dispose();
          restoreProjectHome();
        }
        return;
      }
      if (scope === 'draft creation') {
        phase = 'native result private draft creation';
        participantPolicy = 'drafts_for_approval';
        const returnWarnings = vi.spyOn(logger, 'warnLocalFile');
        const publish = createDiscussionReplyReturnPublisher({ credentials, machineId, serverId,
          serverHttpBaseUrl: serverUrl, signal: lifetime.signal, isCurrent: async () => true,
          // Ordinary Action confirmation is waived; participant policy must
          // still retain the native result in the private approval store.
          // Use the same Account-backed policy owner as daemon recovery.
          // A runtime-only policy deliberately has no private Artifact authority.
          actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => draftAccountSettings,
            allowEnvironmentOverride: false }),
        });
        const original = { serverId, requestSessionId: sessionId, requestLocalId: 'native-draft-input',
          acceptedTurnId: 'native-draft-turn', discussion: { discussionId: summary.id, messageId: 'question-1',
            throughSeq: 1, participantSessionId: sessionId }, message: 'Actual private native answer',
          outcome: { kind: 'answer' as const, result: { sessionId, messageId: 'native-final-message' } } };
        advertisedHomeId = '';
        await publish(original);
        expect(artifacts.size).toBe(0);
        expect(publications).toEqual([]);
        advertisedHomeId = 'srv_fixture_home';
        await publish(original);
        const reopened = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl: serverUrl });
        const listed = await reopened.approvalsList({ status: 'open', limit: 10, serverId });
        expect(listed.items, JSON.stringify({ storedArtifacts: artifacts.size,
          warnings: returnWarnings.mock.calls, httpCalls })).toHaveLength(1);
        const artifactId = listed.items[0]!.artifactId;
        const privateDraft = await reopened.approvalsGet({ artifactId, serverId });
        expect(privateDraft).toMatchObject({ v: 2, status: 'open', discussionDraftReview: true,
          actionId: 'discussion.reply', actionArgs: { discussionId: summary.id,
            replyTarget: { kind: 'message', messageId: 'question-1' },
            content: { v: 1, parts: [{ t: 'text', text: original.message }] } },
          executionOriginV1: { serverId, serverIdentityId: 'srv_fixture_home', sessionId, machineId, accountId: 'owner', discussionReplyReturn: {
            serverId: 'srv_fixture_home', requestLocalId: original.requestLocalId, acceptedTurnId: original.acceptedTurnId } } });
        if (privateDraft?.v !== 2) throw new Error('Missing captured native return approval');
        if (mode === 'plain') {
          // Consume the actual persisted producer output through the incumbent
          // replay composition. A different local profile still reaches the
          // same portable Home; a genuinely different Home remains stale.
          const current = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId,
            serverId: 'reviewing-browser-profile', serverApiUrl: serverUrl });
          if (!current) throw new Error('Missing canonical approval currentness owner');
          expect(await current({ origin: privateDraft.executionOriginV1, request: privateDraft })).toBe(true);
          advertisedHomeId = 'srv_other_home';
          const staleReasons: string[] = [];
          expect(await current({ origin: privateDraft.executionOriginV1, request: privateDraft,
            reportStale: reason => staleReasons.push(reason) })).toBe(false);
          expect(staleReasons).toEqual(['home_changed']);
          advertisedHomeId = 'srv_fixture_home';
        }
        await publish({ ...original, message: 'A later retry cannot replace the captured draft' });
        expect((await reopened.approvalsList({ status: 'open', limit: 10, serverId })).items)
          .toEqual(listed.items);
        expect(await reopened.approvalsGet({ artifactId, serverId })).toEqual(privateDraft);
        expect(publications).toEqual([]);
        expect(humanWrites).toBe(0);
        return;
      }
      phase = 'approved post';
      const artifactId = await approve();
      expect(await fresh().replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(reviewedActorStamps).toEqual([{ artifactId, decidingAccountId: 'owner' }]);
      expect(secondKeyResults).toEqual([expect.objectContaining({ ok: false, error: 'discussion_post_denied' })]);
      expect(publications).toHaveLength(1);
      expect(publications[0]?.sourceSession).toEqual(request.executionOriginV1.sessionInputSource);
      expect(openSessionStoredContent({ ...crypto, content: DiscussionAgentPostRequestV1Schema.parse(publications[0]).request.content })).toEqual(content);
      expect(await fresh().replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(publications).toHaveLength(1);
      phase = 'private draft publication';
      participantPolicy = 'drafts_for_approval';
      const draft = ApprovalRequestV2Schema.parse({ ...request, actionId: 'discussion.reply',
        actionArgs: { ...actionArgs, localId: 'reviewed-draft', replyTarget: { kind: 'message', messageId: 'question-1' } },
        executionOriginV1: { ...request.executionOriginV1, actionId: 'discussion.reply', requestId: 'draft-tool' } });
      const createdDraft = await store.approvalsCreate({ request: draft, serverId });
      expect(await store.approvalsUpdate({ artifactId: createdDraft.artifactId, serverId, request: { ...draft,
        status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', decidingAccountId: 'forged-reviewer' } } }))
        .toMatchObject({ ok: true });
      publicationAuthority = 'present_user';
      expect(await fresh().replayApprovedApprovalRequest({ artifactId: createdDraft.artifactId, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(publications.at(-1)).toMatchObject({ draftReview: { artifactId: createdDraft.artifactId, decidingAccountId: 'owner' } });
      expect(DiscussionAgentPostRequestV1Schema.safeParse(publications.at(-1)).success).toBe(false);
      expect(draftAutomationResults).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ ok: false, error: 'discussion_post_denied' })));
      const afterDraft = publications.length;
      expect(await fresh().replayApprovedApprovalRequest({ artifactId: createdDraft.artifactId, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(publications).toHaveLength(afterDraft);
      participantPolicy = 'when_addressed';
      publicationAuthority = 'account_automation';
      const revoked = await approve(); accountCurrent = false;
      expect(await fresh().replayApprovedApprovalRequest({ artifactId: revoked, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale', effectAttempted: false } } });
      expect(publications).toHaveLength(afterDraft);
      expect(humanWrites).toBe(0);
      accountCurrent = true;
      secondKeyResults.length = 0;
      phase = 'approved atomic create';
      const createArtifactId = await approve('create');
      expect(await fresh().replayApprovedApprovalRequest({ artifactId: createArtifactId, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(nonhumanCreateResults).toEqual([expect.objectContaining({ ok: false, error: 'discussion_post_denied' })]);
      expect(secondKeyResults).toEqual([expect.objectContaining({ ok: false, error: 'discussion_post_denied' }),
        expect.objectContaining({ ok: false, error: 'discussion_post_denied' })]);
      const created = DiscussionAgentCreateRequestV1Schema.parse(publications.at(-1));
      expect(created.request.creationLocalId).not.toBe(created.request.firstMessage.localId);
      const createdKey = await openResourceDataKey({ credentials, mode, dataEncryptionKey: created.request.dataEncryptionKey ?? null });
      const createdCrypto = createdKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
        : { mode: 'e2ee' as const, ctx: { encryptionKey: createdKey.dataKey, encryptionVariant: 'dataKey' as const } };
      expect(openSessionStoredContent({ ...createdCrypto, content: created.request.firstMessage.content })).toEqual(content);
      phase = 'approved second opinion source binding';
      const source = { kind: 'session' as const, message: { kind: 'session' as const,
        session: { serverId, sessionId: opinionSourceSessionId }, messageId: 'source-answer' } };
      const reviewer = { selection: { kind: 'session' as const, session: { serverId, sessionId: 'cmv3secondopinionreviewer' } },
        sourceAccess: 'quote_only' as const };
      const preview = DiscussionSecondOpinionPreviewV1Schema.parse({ source, sourceAudienceAccountIds: ['owner'],
        sourceContentReady: true, discussionAudienceAccountIds: ['owner'], missingDiscussionSourceAccountIds: [],
        discussionDisclosure: { ok: true }, canGrantSource: true, reviewers: [{ ...reviewer,
          runtimeAccountId: 'owner', audienceAccountIds: ['owner'], missingSourceAccountIds: [],
          canGrantSource: true, disclosure: { ok: true } }] });
      const secondOpinion = { intent: 'ask' as const, source, title: 'Approved source review', question: 'Check this answer',
        reviewers: [reviewer], publisherSessionId: sessionId,
        retry: { creationLocalId: 'approved-opinion-create', quoteLocalId: 'approved-opinion-quote', questionLocalId: 'approved-opinion-question' },
        confirmedPreview: preview };
      const opinionApproval = ApprovalRequestV2Schema.parse({ ...request, actionId: 'discussion.second_opinion.start', actionArgs: secondOpinion,
        executionOriginV1: { ...request.executionOriginV1, actionId: 'discussion.second_opinion.start', requestId: 'approved-opinion' } });
      const opinionArtifact = await store.approvalsCreate({ request: opinionApproval, serverId });
      expect(await store.approvalsUpdate({ artifactId: opinionArtifact.artifactId, serverId, request: { ...opinionApproval,
        status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } } })).toMatchObject({ ok: true });
      expect(await store.approvalsUpdate({ artifactId: opinionArtifact.artifactId, serverId, request: { ...opinionApproval,
        status: 'executing', updatedAtMs: 3, decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } } })).toMatchObject({ ok: true });
      const sourceExecutor = createActionExecutor(createCliActionDeps({ credentials, token, sessionId,
        serverId, serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null }));
      const executeSourceAction = sourceExecutor.execute;
      const expectedCreate = prepareAnchoredDiscussionCreateV1({ source, title: secondOpinion.title, quote: 'Actual source answer',
        creationLocalId: secondOpinion.retry.creationLocalId, quoteLocalId: secondOpinion.retry.quoteLocalId });
      let capturedPublication: unknown;
      const producer = createDiscussionActionDeps({ credentials, serverId, serverHttpBaseUrl: serverUrl,
        postAgentMessage: async publication => {
          capturedPublication = publication;
          return { v: 1, ok: false, error: 'discussion_post_denied' };
        } }).discussionAction!;
      const opinionPublicationContext = { serverId, surface: 'agent' as const, authority: 'present_user' as const, defaultSessionId: sessionId,
        actionCaller: request.executionOriginV1.caller, approvedActionReplay: { artifactId: opinionArtifact.artifactId } };
      expect(await producer({ actionId: 'discussion.create', input: expectedCreate, context: opinionPublicationContext }))
        .toMatchObject({ ok: false, errorCode: 'discussion_post_denied' });
      const wireCreate = DiscussionAgentCreateRequestV1Schema.parse(capturedPublication);
      const opinionKey = await openResourceDataKey({ credentials, mode, dataEncryptionKey: wireCreate.request.dataEncryptionKey ?? null });
      const opinionCrypto = opinionKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
        : { mode: 'e2ee' as const, ctx: { encryptionKey: opinionKey.dataKey, encryptionVariant: 'dataKey' as const } };
      const verifyOpinion = (publication: typeof wireCreate) => readApprovedDiscussionPublication({
        artifactId: opinionArtifact.artifactId, request: publication, credentials, sessionId, serverId, serverUrl,
        callerAuthority: 'present_user', isApprovalExecutionOriginCurrent: currentness, executeSourceAction,
      });
      expect(await verifyOpinion(wireCreate)).toMatchObject({ sourceSession: request.executionOriginV1.sessionInputSource });
      expect(await verifyOpinion({ ...wireCreate, request: { ...wireCreate.request, firstMessage: { ...wireCreate.request.firstMessage,
        content: sealSessionStoredContent({ ...opinionCrypto, payload: content }) } } })).toBeNull();
      expect(await verifyOpinion({ ...wireCreate, request: { ...wireCreate.request, creationLocalId: 'unapproved-opinion' } })).toBeNull();
      if (mode === 'plain') {
        expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
          request: wireCreate, approvedActionReplay: { artifactId: opinionArtifact.artifactId },
        }, { rpcContext: { callerAuthority: 'present_user' } })).toMatchObject({ ok: true });
      }
      await client.postAgentDiscussionMessage({ operation: 'create', request: wireCreate.request,
        sourceSession: request.executionOriginV1.sessionInputSource ?? undefined });
      const expectedQuestion = prepareSecondOpinionQuestionV1({ discussionId: 'created-discussion',
        sessionId: reviewer.selection.session.sessionId, question: secondOpinion.question,
        questionLocalId: secondOpinion.retry.questionLocalId, quoteMessageId: 'created-first' });
      expect(await producer({ actionId: 'discussion.post', input: expectedQuestion, context: opinionPublicationContext }))
        .toMatchObject({ ok: false, errorCode: 'discussion_post_denied' });
      const questionRequest = DiscussionAgentPostRequestV1Schema.parse(capturedPublication);
      const verifyQuestion = (publication: typeof questionRequest) => readApprovedDiscussionPublication({
        artifactId: opinionArtifact.artifactId, request: publication, credentials, sessionId, serverId, serverUrl,
        callerAuthority: 'present_user', isApprovalExecutionOriginCurrent: currentness, executeSourceAction,
      });
      expect(await verifyQuestion(questionRequest)).toMatchObject({ sourceSession: request.executionOriginV1.sessionInputSource });
      expect(await verifyQuestion({ ...questionRequest, discussionId: summary.id })).toBeNull();
      expect(await verifyQuestion({ ...questionRequest, request: { ...questionRequest.request,
        replyTarget: { kind: 'message', messageId: 'other-source-quote' } } })).toBeNull();
      expect(await verifyQuestion({ ...questionRequest, request: { ...questionRequest.request,
        content: sealSessionStoredContent({ ...opinionCrypto, payload: content }) } })).toBeNull();
      for (const operation of ['doc-root', 'doc-proposal'] as const) {
        phase = operation;
        secondKeyResults.length = 0;
        const prior = publications.length;
        const docApproval = await approve(operation);
        const replay = await fresh().replayApprovedApprovalRequest({ artifactId: docApproval, callerAuthority: 'present_user' });
        expect(replay, JSON.stringify(replay))
          .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(publications).toHaveLength(prior + 1);
        expect(secondKeyResults).toEqual(Array.from({ length: operation === 'doc-root' ? 4 : 3 },
          () => expect.objectContaining({ ok: false, error: 'discussion_post_denied' })));
        const published = publications.at(-1)!;
        const message = 'operation' in published ? published.request.firstMessage : published.request;
        const publishedKey = 'operation' in published
          ? await openResourceDataKey({ credentials, mode, dataEncryptionKey: published.request.dataEncryptionKey ?? null }) : key;
        const publishedCrypto = publishedKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
          : { mode: 'e2ee' as const, ctx: { encryptionKey: publishedKey.dataKey, encryptionVariant: 'dataKey' as const } };
        expect(openSessionStoredContent({ ...publishedCrypto, content: message.content })).toMatchObject({
          kind: operation === 'doc-root' ? 'doc_passage_comment' : 'doc_edit_proposal',
        });
        expect(published.sourceSession).toEqual(request.executionOriginV1.sessionInputSource);
      }
      phase = 'terminal retry';
      const terminalContent = { v: 1 as const, parts: [{ t: 'text' as const, text: 'The requested session failed.' }] };
      const body = { localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId: 'terminal-original', acceptedTurnId: 'retired-turn' }),
        content: sealSessionStoredContent({ ...crypto, payload: terminalContent }), mentionedAccountIds: [],
        replyTarget: { kind: 'message' as const, messageId: 'question-1' },
        ...(key.mode === 'e2ee' ? { requestEqualityEvidenceV1: { kind: 'e2eeTag' as const,
          tag: deriveDiscussionMutationEqualityTagV1({ dataKey: key.dataKey, canonicalIntent: serializeDiscussionMutationEqualityIntentV1({
            kind: 'post', content: terminalContent, mentionedAccountIds: [], mentionedSessionIds: [],
            replyTarget: { kind: 'message', messageId: 'question-1' } }) }) } } : {}) };
      const terminal = { v: 1 as const, sessionId, discussionId: summary.id, request: body,
        replyReturn: { serverId: 'srv_fixture_home', requestLocalId: 'terminal-original', acceptedTurnId: 'retired-turn' } };
      corruptNextAck = true;
      await expect(client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminal })).rejects.toThrow();
      expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminal })).toMatchObject({ ok: true });
      terminalReturned = true;
      expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminal })).toMatchObject({ ok: true });
      expect(openSessionStoredContent({ ...crypto, content: DiscussionAgentPostPublicationV1Schema.parse(publications.at(-1)).request.content })).toEqual(terminalContent);
      phase = 'approved unknown acknowledgement';
      const unknownArtifactId = await approve();
      corruptNextAck = true;
      expect(await fresh().replayApprovedApprovalRequest({ artifactId: unknownArtifactId, callerAuthority: 'present_user' }))
        .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'outcome_unknown', effectAttempted: true } } });
      let lastHostApprovalArtifactId: string | undefined;
      const replayHostReturn = async (text: string, requestLocalId = 'terminal-original') => {
        const returnLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId: requestLocalId, acceptedTurnId: 'retired-turn' });
        const proposal = ApprovalRequestV2Schema.parse({ ...request, actionId: 'discussion.reply',
          actionArgs: { discussionId: summary.id, localId: returnLocalId,
            content: { v: 1, parts: [{ t: 'text', text }] }, replyTarget: { kind: 'message', messageId: 'question-1' } },
          executionOriginV1: { ...request.executionOriginV1, caller: { kind: 'host' }, sessionId,
            serverIdentityId: 'srv_fixture_home',
            // Retain the real fallback producer's complete origin, not the
            // formerly sparse host fixture that skipped policy/source checks.
            sessionAgentSpawnPolicyV1: accountSettingsParse({}).sessionAgentSpawnPolicyV1,
            sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'retired-turn', sourceInputId: requestLocalId,
              via: 'action', discussionAddressing: { discussionId: summary.id, messageId: 'question-1',
                throughSeq: 1, participantSessionId: sessionId } },
            discussionReplyReturn: { ...terminal.replyReturn, requestLocalId },
            actionId: 'discussion.reply', requestId: returnLocalId } });
        const { artifactId } = await store.approvalsCreate({ request: proposal, serverId });
        lastHostApprovalArtifactId = artifactId;
        expect(await store.approvalsUpdate({ artifactId, serverId, request: { ...proposal, status: 'approved', updatedAtMs: 2,
          decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } } })).toMatchObject({ ok: true });
        return fresh().replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
      };
      phase = 'approved host return';
      const beforeHost = publications.length;
      expect(await replayHostReturn('The requested session failed.')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(publications).toHaveLength(beforeHost + 1);
      expect(lastPublicationReplay).toBe(lastHostApprovalArtifactId);
      expect(publications.at(-1)).toMatchObject({ sessionId, replyReturn: terminal.replyReturn, terminalReturn: true });
      expect(await replayHostReturn('Invented success instead of failed original', 'forged-terminal-original')).toMatchObject({ ok: true,
        result: { status: 'failed', execution: { errorCode: 'discussion_post_denied' } } });
      expect(publications).toHaveLength(beforeHost + 1);
      expect(humanWrites).toBe(0);
    });
  } catch (error) {
    failedPhase = phase;
    throw error;
  } finally {
    phase = 'client cleanup';
    await client.close();
    phase = 'HTTP cleanup';
    await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
  }
});
