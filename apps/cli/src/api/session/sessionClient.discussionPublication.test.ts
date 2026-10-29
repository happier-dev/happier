import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionAgentPostRequestV1Schema, DiscussionAgentPostPublicationV1Schema, DiscussionAgentCreateRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { createApiSessionSocketStub, createSessionTranscriptHomeStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { ApiSessionClient } from './sessionClient';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { SessionBroadcastContainerSchema } from '@happier-dev/protocol/updates';

const clients = new Set<ApiSessionClient>();
afterEach(async () => {
  await Promise.allSettled([...clients].map(client => client.close()));
  clients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['failed', 'cancelled'] as const)('publishes an Account Action and its exact %s return through the current Session publisher', async terminalKind => {
  const sessionId = 'cmv3discussionparticipant';
  const profileId = 'device-local-discussion-profile';
  const credentials = { token: 'discussion-owner', encryption: null };
  const features = await fetchServerFeaturesSnapshot({ serverUrl: 'https://discussion-home.test', token: credentials.token,
    fetchImpl: async () => Response.json(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: 'srv_discussion_home' } },
    })),
  });
  expect(features).toMatchObject({ status: 'ready', provenance: 'authenticated' });
  const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'A participant answer' }] };
  let terminalReturned = false;
  let explicitlyReturned = false;
  const summary = { id: 'discussion-1', ownerAccountId: 'owner', encryptionMode: 'plain', anchor: null,
    access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'create-1',
    titleContent: { t: 'plain', v: { v: 1, title: 'Discussion' } },
    latestMessage: { id: 'question-1', localId: 'question-1', seq: 1, authorAccountId: 'owner',
      accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: null, createdAt: 1 }, messageSeq: 1,
    lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
      sendToSession: true, manageAccess: true, leave: false } };
  // HTTP and Socket.IO are the only replaced boundaries. Action execution,
  // resource crypto, current-turn matching and the actual client stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/messages/by-local-id/input-1/reply')) return { status: 200, data: {
      v: 1, status: 'available', progress: { v: 1, mode: 'return', disposition: 'observing', acceptedTurnId: 'turn-1',
        discussion: { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1, participantSessionId: sessionId } },
    } };
    if (String(url).endsWith('/messages/by-local-id/original/reply')) return { status: 200, data: {
      v: 1, status: 'available', progress: { v: 1, mode: 'return', disposition: terminalReturned ? 'returned' : 'return_pending', acceptedTurnId: 'turn-1',
        discussion: { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1, participantSessionId: sessionId },
        outcome: explicitlyReturned ? { kind: 'answer', publicationRef: { kind: 'discussion',
          discussion: { serverId: 'srv_discussion_home', discussionId: 'discussion-1' }, messageId: 'committed-explicit' } }
          : terminalKind === 'cancelled' ? { kind: 'cancelled', result: { sessionId, messageId: 'stopped-partial' } } : { kind: 'failed' } },
    } };
    if (String(url).endsWith('/messages/by-local-id/original')) return { status: 200, data: { message: {
      id: 'original-row', localId: 'original', seq: 1, createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Question' } } },
    } } };
    if (String(url).includes('/messages?')) return { status: 200, data: { messages: [{ id: 'stopped-partial', localId: 'partial',
      seq: 2, createdAt: 2, updatedAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'acp',
        agentId: 'codex', data: { type: 'text', text: 'Stopped partial answer' } } } } },
      { id: 'unrelated-later', localId: 'later', seq: 3, createdAt: 3, updatedAt: 3,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'Later answer' } } } } }] } };
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (String(url).endsWith('/v1/discussions/discussion-1')) return { status: 200, data: { discussion: summary } };
    return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain' }) } };
  });
  const requests: string[] = [];
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    requests.push(String(config.url));
    if (config.method === 'GET' && config.url?.endsWith('/v1/discussions/discussion-1/participants'))
      return { status: 200, data: { discussionId: summary.id, ownerAccountId: 'owner', access: 'owner', grants: [],
        participants: [{ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 }] } };
    if (config.method === 'GET' && config.url?.endsWith('/v1/discussions/discussion-1'))
      return { status: 200, data: { discussion: summary } };
    if (config.method === 'GET' && config.url?.endsWith('/v1/account/encryption/currentness'))
      return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    throw new Error('Unexpected Discussion HTTP effect');
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: 'srv_discussion_home' }, session: {
    pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
  } } }), { status: 200 })));
  const publications: unknown[] = [];
  const home = createSessionTranscriptHomeStub();
  const activityHome = createSessionRuntimeActivityHomeStub({ machineId: 'participant-machine' });
  const defaults = createApiSessionSocketStub();
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
    if (event === DISCUSSION_AGENT_POST_EVENT_V1) {
      if (payload && typeof payload === 'object' && 'operation' in payload && payload.operation === 'create') {
        const raw = DiscussionAgentCreateRequestV1Schema.parse(payload);
        publications.push(payload);
        return { v: 1, ok: true, value: { discussion: { ...summary, creationLocalId: raw.request.creationLocalId }, firstMessage: {
          id: 'committed-first', discussionId: summary.id, localId: raw.request.firstMessage.localId, seq: 1,
          authorAccountId: 'owner', accountActor: { v: 1, accountId: 'owner', profile: null },
          producerV1: { v: 1, kind: 'agent', sessionId }, content: raw.request.firstMessage.content, mentionedAccountIds: [], createdAt: 1,
        } } };
      }
      const request = DiscussionAgentPostPublicationV1Schema.parse(payload);
      publications.push(request);
      return { v: 1, ok: true, value: { messageSeq: 2, message: {
        id: 'committed-answer', discussionId: request.discussionId, localId: request.request.localId, seq: 2,
        authorAccountId: 'owner', accountActor: { v: 1, accountId: 'owner', profile: null },
        producerV1: { v: 1, kind: 'agent', sessionId }, content: request.request.content,
        mentionedAccountIds: [], createdAt: 1,
      } } };
    }
    return home.answer(event, payload) ?? activityHome.answer(event, payload) ?? defaults.emitWithAck(event, payload);
  } });
  const fixture = createPlainSessionFixture({ id: sessionId });
  const followReobservations: unknown[] = [];
  const client = new ApiSessionClient(credentials.token, { ...fixture, metadata: { ...fixture.metadata, machineId: 'participant-machine' } }, {
    localMachineId: 'participant-machine',
    metadataAuthority: { kind: 'owner', credentials },
    onSessionFollowInvalidated: () => { followReobservations.push(client.getServerFeaturesSnapshot()); },
    transport: { serverId: profileId, serverUrl: 'https://discussion-home.test',
      createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
  });
  clients.add(client);
  const witness = { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1],
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 }, workDepth: 0 };
  let active = true;
  let currentWitness: AgentInvocationTurnAdmissionWitness = witness;
  const hostTurnAbort = new AbortController();
  const runtimeLifetimeAbort = new AbortController();
  applyRunnerMcpSessionContext(client, {
    getActiveTurnAdmissionWitness: () => active ? currentWitness : null,
    getHostTurnAbortSignal: () => hostTurnAbort.signal,
    getRuntimeLifetimeSignal: () => runtimeLifetimeAbort.signal,
  });
  const admittedRequest = DiscussionAgentPostRequestV1Schema.parse({ v: 1, sessionId,
    discussionId: 'discussion-1', request: { localId: 'answer-1', content: { t: 'plain', v: content }, mentionedAccountIds: [] } });
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: admittedRequest, witness }))
    .toMatchObject({ ok: true, value: { message: { id: 'committed-answer' } } });
  for (const invalid of [
    { request: admittedRequest, witness: { ...witness, turnId: 'unrelated-turn' } },
    { request: { ...admittedRequest, sessionId: 'foreign-session' }, witness },
    { request: admittedRequest, witness, producer: { sessionId } },
  ]) expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', invalid))
    .toEqual({ v: 1, ok: false, error: 'discussion_post_denied' });
  expect(publications).toHaveLength(1);
  expect(publications[0]).toMatchObject({ sourceSession: { sourceSessionId: sessionId, sourceTurnId: witness.turnId,
    sourceInputId: witness.inputId, via: 'action' } });
  expect(publications[0]).not.toHaveProperty('terminalReturn');
  const addressing = { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1, participantSessionId: sessionId };
  currentWitness = { ...witness, discussionAddressing: addressing };
  // Use the real connection's public feature observation from this exact
  // transport origin, not a profile alias or an injected Home accessor.
  await vi.waitFor(() => expect(client.getServerFeaturesSnapshot()).toMatchObject({ status: 'ready', provenance: 'public',
    features: { capabilities: { serverIdentity: { serverIdentityId: 'srv_discussion_home' } } } }));
  // The incumbent exact-Session invalidation is a real re-observation trigger;
  // no polling or second feature identity reader is needed after recovery.
  socket.trigger('session', SessionBroadcastContainerSchema.parse({
    id: 'home-context-recovered', createdAt: 1, body: { t: 'session-changed', sessionId },
  }));
  await vi.waitFor(() => expect(followReobservations).toContainEqual(expect.objectContaining({ status: 'ready',
    features: expect.objectContaining({ capabilities: expect.objectContaining({
      serverIdentity: { serverIdentityId: 'srv_discussion_home' },
    }) }),
  })));
  const activeReply = { ...admittedRequest,
    request: { ...admittedRequest.request, replyTarget: { kind: 'message' as const, messageId: addressing.messageId } },
    replyReturn: { serverId: 'foreign-home', requestLocalId: 'foreign-input', acceptedTurnId: 'foreign-turn' } };
  publications.length = 0;
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: activeReply, witness: currentWitness }))
    .toMatchObject({ ok: true });
  expect(publications[0]).toMatchObject({ replyReturn: { serverId: 'srv_discussion_home', requestLocalId: witness.inputId, acceptedTurnId: witness.turnId } });
  expect(publications[0]).toMatchObject({ request: { localId: deriveSessionMessageReplyReturnLocalIdV1({
    sessionId, localId: witness.inputId, acceptedTurnId: witness.turnId,
  }) } });
  for (const mismatch of [
    { ...activeReply, discussionId: 'other-discussion' },
    { ...activeReply, request: { ...activeReply.request, replyTarget: { kind: 'message', messageId: 'other-parent' } } },
  ]) {
    publications.length = 0;
    expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: mismatch, witness: currentWitness }))
      .toMatchObject({ ok: true });
    expect(publications[0]).not.toHaveProperty('replyReturn');
    expect(publications[0]).toMatchObject({ request: { localId: admittedRequest.request.localId } });
  }
  currentWitness = { ...witness, discussionAddressing: { ...addressing, participantSessionId: 'foreign-participant' } };
  publications.length = 0;
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: activeReply, witness: currentWitness }))
    .toMatchObject({ ok: true });
  expect(publications[0]).not.toHaveProperty('replyReturn');
  currentWitness = witness;
  publications.length = 0;
  const execute = createDaemonSessionAccountActionExecutor({
    serverId: profileId, serverHttpBaseUrl: 'https://discussion-home.test', token: credentials.token, credentials,
    postAgentDiscussionMessage: async (request, admittedWitness, options) => await client.rpcHandlerManager.invokeLocal(
      'discussion.agentPost.v1', { request, witness: admittedWitness }, options,
    ),
    createExecutor: (_depth, _current, postAgentDiscussionMessage) => {
      return createCliActionExecutor({
      token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: profileId, serverHttpBaseUrl: 'https://discussion-home.test',
      resolveServerFeaturesSnapshot: () => features, postAgentDiscussionMessage,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'discussion.post': ['agent'], 'discussion.create': ['agent'] } }) },
      });
    },
  });
  const operation = { kind: 'action.execute' as const, requestId: 'tool-1', actionId: 'discussion.post' as const,
    input: { discussionId: 'discussion-1', localId: 'answer-1', content }, witness };
  expect(await execute(operation, { sessionId, isCurrent: async () => true })).toMatchObject({
    ok: true, result: { message: { id: 'committed-answer', content, producerV1: { sessionId } } },
  });
  expect(publications).toHaveLength(1);
  const createInput = { creationLocalId: 'create-by-agent', title: 'Created by actual Session', firstMessage: { localId: 'first-by-agent', content } };
  expect(await execute({ ...operation, requestId: 'create-tool', actionId: 'discussion.create', input: createInput },
    { sessionId, isCurrent: async () => true })).toMatchObject({ ok: true });
  expect(publications).toHaveLength(2);
  expect(publications[1]).toMatchObject({ operation: 'create', request: {
    creationLocalId: createInput.creationLocalId,
    firstMessage: { content: { t: 'plain', v: content } },
  } });
  // This test owns the current Session publisher. Actual approved MCP replay
  // uses the real Artifact store in sessionClient.discussionApprovalReplay.test.ts.
  const created = await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
    request: { v: 1, operation: 'create', sessionId, toolCallId: 'create-tool', request: {
      creationLocalId: createInput.creationLocalId, titleContent: { t: 'plain', v: { v: 1, title: createInput.title } },
      firstMessage: { localId: createInput.firstMessage.localId, content: { t: 'plain', v: content }, mentionedAccountIds: [] },
    } }, witness,
  }, { rpcContext: { callerAuthority: 'present_user' } });
  expect(created).toMatchObject({ ok: true, value: {
    firstMessage: { id: 'committed-first', producerV1: { sessionId } },
  } });
  expect(publications).toHaveLength(3);
  expect(requests.every(url => !url.includes('/sessions/'))).toBe(true);
  active = false;
  hostTurnAbort.abort();
  expect(await execute(operation, { sessionId, isCurrent: async () => true })).toMatchObject({ ok: false });
  expect(publications).toHaveLength(3);
  const terminalRequest = { ...admittedRequest,
    request: { ...admittedRequest.request, localId: deriveSessionMessageReplyReturnLocalIdV1({
      sessionId, localId: 'original', acceptedTurnId: witness.turnId }),
      replyTarget: { kind: 'message' as const, messageId: 'question-1' } },
    replyReturn: { serverId: 'srv_discussion_home', requestLocalId: 'original', acceptedTurnId: witness.turnId } };
  // The Account owner can reach this RPC, but cannot author a terminal outcome.
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminalRequest }))
    .toEqual({ v: 1, ok: false, error: 'discussion_post_denied' });
  terminalRequest.request.content = { t: 'plain', v: { v: 1, parts: [{ t: 'text',
    text: terminalKind === 'cancelled' ? 'Stopped partial answer' : 'The requested session failed.' }] } };
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminalRequest }))
    .toMatchObject({ ok: true, value: { message: { id: 'committed-answer' } } });
  expect(publications).toHaveLength(4);
  expect(publications[3]).toMatchObject({ terminalReturn: true });
  terminalReturned = true;
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminalRequest }))
    .toMatchObject({ ok: true, value: { message: { id: 'committed-answer' } } });
  expect(publications).toHaveLength(5);
  explicitlyReturned = true;
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request: terminalRequest }))
    .toEqual({ v: 1, ok: false, error: 'discussion_post_denied' });
  for (const request of [
    admittedRequest,
    { ...admittedRequest, replyReturn: { serverId: 'srv_discussion_home', requestLocalId: 'original', acceptedTurnId: witness.turnId } },
    { ...admittedRequest, sessionId: 'foreign-session', request: { ...admittedRequest.request,
      replyTarget: { kind: 'message', messageId: 'question-1' } },
      replyReturn: { serverId: 'srv_discussion_home', requestLocalId: 'original', acceptedTurnId: witness.turnId } },
    { ...admittedRequest, request: { ...admittedRequest.request, replyTarget: { kind: 'message', messageId: 'question-1' } },
      replyReturn: { serverId: 'foreign-home', requestLocalId: 'original', acceptedTurnId: witness.turnId } },
  ]) expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', { request }))
    .toEqual({ v: 1, ok: false, error: 'discussion_post_denied' });
  runtimeLifetimeAbort.abort();
  expect(await client.rpcHandlerManager.invokeLocal('discussion.agentPost.v1', {
    request: { ...admittedRequest, request: { ...admittedRequest.request, replyTarget: { kind: 'message', messageId: 'question-1' } },
      replyReturn: { serverId: 'srv_discussion_home', requestLocalId: 'original', acceptedTurnId: witness.turnId } },
  })).toEqual({ v: 1, ok: false, error: 'discussion_post_denied' });
  expect(publications).toHaveLength(5);
});
