import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createActionExecutor, FeaturesResponseSchema } from '@happier-dev/protocol';
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMutationV1Schema,
  SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1, SessionMessageReplySourceTurnReleaseV1Schema,
  type SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, SessionTranscriptObservationInputSchema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { createApiSessionSocketStub, createSessionTranscriptHomeStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { ApiSessionClient } from './sessionClient';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// HTTP and Socket.IO are substituted; reply publication, transcript commitment,
// original-input correlation, Action admission and projection stay real.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, ...http } };
});

const clients = new Set<ApiSessionClient>();
afterEach(async () => {
  await Promise.allSettled([...clients].map(client => client.close()));
  clients.clear();
  vi.unstubAllGlobals();
});

describe('Session reply publication through the real Action and publisher', () => {
  it.each(['bound', 'relay'] as const)('settles an exact pass through its protected current input and the real C2 publisher (%s)', async placement => {
    const sessionId = 'c' + '1'.repeat(24);
    const discussionAddressing = { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 3, participantSessionId: sessionId };
    const progress = { v: 1, mode: 'return', acceptedTurnId: 'discussion-turn', disposition: 'observing', discussion: discussionAddressing } as const;
    let originalAvailable = true;
    http.get.mockImplementation(async (url: string) => url.endsWith('/v1/auth/ping') ? { status: 200, data: {} }
      : url.endsWith('/v1/account/encryption/currentness') ? { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) }
      : url.endsWith('/messages/by-local-id/discussion-input/reply')
      ? { status: 200, data: originalAvailable ? { v: 1, status: 'available', progress } : { v: 1, status: 'none' } }
      : url.endsWith('/messages/reply-capability') ? { status: 200, data: { v: 1, protocolVersions: [1] } }
      : url.endsWith(`/v2/sessions/${sessionId}`) ? { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'discussion-machine', path: '/repo' }),
        dataEncryptionKey: null, agentState: null,
      }) } }
      : { status: 404, data: {} });
    const mutations: unknown[] = [];
    const publications: unknown[] = [];
    const fallback = createApiSessionSocketStub();
    const runtimeHome = createSessionRuntimeActivityHomeStub({ machineId: 'discussion-machine' });
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) publications.push(payload);
      if (event !== SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1) return runtimeHome.answer(event, payload) ?? fallback.emitWithAck(event, payload);
      const request = SessionMessageReplyMutationV1Schema.parse(payload);
      mutations.push(request);
      return { v: 1, ok: true, progress: { ...progress, outcome: { kind: 'pass' } } };
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { session: {
      pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
    } } }), { status: 200 })));
    const credentials = { token: 'editor-token', encryption: null };
    const client = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: sessionId }), {
      metadataAuthority: { kind: 'shared_editor' }, runtimePrincipalAccountId: 'editor-account',
      localMachineId: 'discussion-machine',
      durableMutationDeliveryInitiallyActive: false,
      transport: { serverId: 'discussion-home', serverUrl: 'https://discussion-home.test',
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
    });
    clients.add(client);
    client.observeHostTurnFacts({ turnId: 'discussion-turn', facts: { initiator: 'user', workDepth: 0 } });
    const executor = createActionExecutor(createCliActionDeps({ credentials, token: credentials.token,
      sessionId: placement === 'bound' ? sessionId : 'daemon-global',
      serverId: 'discussion-home', serverHttpBaseUrl: 'https://discussion-home.test',
      mode: 'plain', ctx: null,
      ...(placement === 'bound' ? { sessionMessageReplyPublisher: client } : {
        // The authenticated RPC transport is the boundary; registration, Action
        // admission, exact-turn publication and original custody remain real.
        sessionActionRpcTransport: async request => client.rpcHandlerManager.invokeLocal(request.method, request.input, {
          rpcContext: { callerAuthority: 'account_automation', sessionActionOrigin: request.origin },
        }),
      }) }));
    const source = { sourceSessionId: sessionId, sourceTurnId: 'discussion-turn', sourceInputId: 'discussion-input',
      via: 'action', discussionAddressing } as const;
    const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
      serverId: 'discussion-home', sessionInputSource: source, actionRequestId: 'reply-action',
      ...(placement === 'relay' ? { actionCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } } : {}) } as const;
    const executePass = (invocationContext: Parameters<typeof executor.execute>[2] = context) => placement === 'bound'
      ? executor.execute('discussion.pass', { discussionId: discussionAddressing.discussionId }, invocationContext)
      : executor.execute('session.message.reply', { sessionId, requestLocalId: source.sourceInputId, reply: { kind: 'pass' } }, invocationContext);
    const pass = await executePass();
    expect(pass.ok, JSON.stringify({ result: pass, socketConnected: socket.connected,
      connection: Reflect.get(client, 'currentConnectionState') })).toBe(true);
    expect(pass)
      .toMatchObject({ ok: true, result: { v: 1, ok: true, progress: { outcome: { kind: 'pass' } } } });
    expect(mutations).toEqual([{ v: 1, sessionId, requestSessionId: sessionId, requestLocalId: source.sourceInputId,
      operation: { kind: 'fulfill', turnId: source.sourceTurnId, outcome: { kind: 'pass' } } }]);
    expect(publications).toEqual([]);
    if (placement === 'bound') for (const [input, rejectedContext] of [
      [{ discussionId: 'another-discussion' }, context],
      [{ discussionId: discussionAddressing.discussionId }, { ...context, sessionInputSource: undefined }],
      [{ discussionId: discussionAddressing.discussionId }, { ...context, sessionInputSource: { ...source, sourceInputId: undefined } }],
      [{ discussionId: discussionAddressing.discussionId }, { ...context, defaultSessionId: 'other-participant' }],
      [{ discussionId: discussionAddressing.discussionId }, { ...context, sessionInputSource: { ...source,
        discussionAddressing: { ...discussionAddressing, participantSessionId: 'other-participant' } } }],
      [{ discussionId: discussionAddressing.discussionId, requestLocalId: 'authored-other-input' }, context],
    ] as const) expect(await executor.execute('discussion.pass', input, rejectedContext)).toMatchObject({ ok: false });
    expect(mutations).toHaveLength(1);
    expect(await executePass({
      ...context, sessionInputSource: { ...source, sourceTurnId: 'unrelated-turn' },
    })).toMatchObject({ result: { ok: false, error: 'conflict' } });
    originalAvailable = false;
    expect(await executePass())
      .toMatchObject({ result: { ok: false, error: 'unavailable' } });
    expect(mutations).toHaveLength(1);
    expect(publications).toEqual([]);
  });

  it('allows an authenticated shared editor publisher to pass without Account owner material', async () => {
    const progress = { v: 1, mode: 'wait', acceptedTurnId: 'editor-turn', disposition: 'observing' } as const;
    let originalAvailable = true;
    http.get.mockImplementation(async (url: string) => url.endsWith('/v1/auth/ping') ? { status: 200, data: {} }
      : url.endsWith('/messages/by-local-id/editor-original/reply')
      ? { status: 200, data: originalAvailable ? { v: 1, status: 'available', progress } : { v: 1, status: 'none' } }
      : url.endsWith('/messages/reply-capability') ? { status: 200, data: { v: 1, protocolVersions: [1] } }
      : { status: 404, data: {} });
    const fallback = createApiSessionSocketStub();
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
      if (event !== SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1) return fallback.emitWithAck(event, payload);
      const request = SessionMessageReplyMutationV1Schema.parse(payload);
      expect(request.operation).toEqual({ kind: 'fulfill', turnId: 'editor-turn', outcome: { kind: 'pass' } });
      return { v: 1, ok: true, progress: { ...progress, outcome: { kind: 'pass' } } };
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: {} }), { status: 200 })));
    const client = new ApiSessionClient('editor-token', createPlainSessionFixture({ id: 'shared-session' }), {
      metadataAuthority: { kind: 'shared_editor' }, runtimePrincipalAccountId: 'editor-account',
      localMachineId: 'editor-machine',
      durableMutationDeliveryInitiallyActive: false,
      transport: { serverId: 'shared-home', serverUrl: 'https://shared-home.test',
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
    });
    clients.add(client);
    const input = { sessionId: client.sessionId, requestLocalId: 'editor-original', reply: { kind: 'pass' } };
    const invoke = () => client.rpcHandlerManager.invokeLocal('session.message.reply', input, {
      rpcContext: { callerAuthority: 'present_user' },
    });
    expect(await invoke()).toMatchObject({ v: 1, ok: false, error: 'conflict' });
    client.observeHostTurnFacts({ turnId: 'editor-turn', facts: { initiator: 'user', workDepth: 0 } });
    expect(await invoke())
      .toMatchObject({ v: 1, ok: true, progress: { outcome: { kind: 'pass' } } });
    const origin = { v: 1, caller: { kind: 'session', sessionId: client.sessionId, starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'unrelated-turn', sourceInputId: input.requestLocalId, callerPermissionMode: null, requestId: 'reply-action' } as const;
    expect(await client.rpcHandlerManager.invokeLocal('session.message.reply', input, {
      rpcContext: { callerAuthority: 'account_automation', sessionActionOrigin: origin },
    })).toMatchObject({ v: 1, ok: false, error: 'conflict' });
    expect(await client.rpcHandlerManager.invokeLocal('session.message.reply', input, {
      rpcContext: { callerAuthority: 'account_automation' },
    })).toMatchObject({ ok: false, errorCode: 'role_rpc_origin_unavailable' });
    originalAvailable = false;
    expect(await invoke()).toMatchObject({ v: 1, ok: false, error: 'unavailable' });
  });

  it('releases only an actual source input and turn through its authenticated Session socket', async () => {
    const requests: unknown[] = [];
    const mutations: unknown[] = [];
    let capabilitySupported = false;
    const sourceSession = createPlainSessionFixture({ id: 'source-session' });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/auth/ping')) return { status: 200, data: {} };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v2/sessions/source-session')) return { status: 200, data: { session: createSessionRecordFixture({
        id: sourceSession.id, encryptionMode: 'plain', metadata: JSON.stringify(sourceSession.metadata),
        dataEncryptionKey: null, agentState: null,
      }) } };
      if (url.endsWith('/messages/reply-capability') && capabilitySupported) {
        return { status: 200, data: { v: 1, protocolVersions: [1] } };
      }
      return { status: 404, data: {} };
    });
    const fallback = createApiSessionSocketStub();
    const runtimeHome = createSessionRuntimeActivityHomeStub({ machineId: 'source-machine' });
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
      if (event === SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1) {
        mutations.push(SessionMessageReplyMutationV1Schema.parse(payload));
        return { v: 1, ok: true, progress: { v: 1, mode: 'wait', disposition: 'released' } };
      }
      if (event !== SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1) {
        return runtimeHome.answer(event, payload) ?? fallback.emitWithAck(event, payload);
      }
      requests.push(SessionMessageReplySourceTurnReleaseV1Schema.parse(payload));
      return { v: 1, ok: true };
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { session: {
      pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
    } } }), { status: 200 })));
    const client = new ApiSessionClient('source-token', sourceSession, {
      metadataAuthority: { kind: 'owner', credentials: { token: 'source-token', encryption: null } },
      localMachineId: 'source-machine',
      durableMutationDeliveryInitiallyActive: false,
      transport: { serverId: 'source-home', serverUrl: 'https://source-home.test',
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
    });
    clients.add(client);
    expect(await client.checkCurrentPublisherAuthority()).toBe(true);
    expect.soft(await client.mutateSessionMessageReply({ requestSessionId: 'receiver-session', requestLocalId: 'original-input',
      operation: { kind: 'release' } })).toEqual({ v: 1, ok: false, error: 'unavailable' });
    expect.soft(mutations).toEqual([]);
    expect.soft(await client.releaseSessionMessageReplySourceTurn({ sourceTurnId: 'actual-turn', sourceInputId: 'actual-input' }))
      .toEqual({ v: 1, ok: false, error: 'unavailable' });
    expect.soft(requests).toEqual([]);
    capabilitySupported = true;
    expect(await client.mutateSessionMessageReply({ requestSessionId: 'receiver-session', requestLocalId: 'original-input',
      operation: { kind: 'release' } })).toMatchObject({ v: 1, ok: true });
    expect(mutations).toEqual([{ v: 1, sessionId: 'source-session', requestSessionId: 'receiver-session',
      requestLocalId: 'original-input', operation: { kind: 'release' } }]);
    expect(await client.releaseSessionMessageReplySourceTurn({ sourceTurnId: 'actual-turn', sourceInputId: 'actual-input' }))
      .toEqual({ v: 1, ok: true });
    expect(requests).toEqual([{ v: 1, sessionId: 'source-session', sourceTurnId: 'actual-turn', sourceInputId: 'actual-input' }]);
    expect(http.get).toHaveBeenLastCalledWith('https://source-home.test/v2/sessions/source-session/messages/reply-capability', expect.anything());
    const observation = { requestSessionId: 'receiver-session', requestLocalId: 'original-input', operation: 'inline' } as const;
    const origin = { v: 1, caller: { kind: 'session', sessionId: sourceSession.id, starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'actual-turn', sourceInputId: 'actual-input', callerPermissionMode: null, requestId: 'source-action' } as const;
    expect(await client.rpcHandlerManager.invokeLocal('session.message.reply.observe.v1', observation, {
      rpcContext: { callerAuthority: 'account_automation', sessionActionOrigin: origin },
    })).toMatchObject({ v: 1, ok: true });
    expect(mutations.at(-1)).toEqual({ v: 1, sessionId: sourceSession.id, ...observation, operation: { kind: 'inline' } });
    for (const [request, sessionActionOrigin] of [
      [observation, undefined],
      [observation, { ...origin, caller: { ...origin.caller, sessionId: 'another-session' } }],
      [{ ...observation, operation: 'fulfill' }, origin],
      [{ ...observation, destination: 'authored-destination' }, origin],
    ] as const) {
      expect(await client.rpcHandlerManager.invokeLocal('session.message.reply.observe.v1', request, {
        rpcContext: { callerAuthority: 'account_automation', ...(sessionActionOrigin ? { sessionActionOrigin } : {}) },
      })).toMatchObject({ v: 1, ok: false });
    }
    expect(mutations).toHaveLength(2);
    const cancelled = new AbortController();
    http.get.mockImplementation(async () => {
      cancelled.abort();
      return { status: 200, data: { v: 1, protocolVersions: [1] } };
    });
    expect(await client.releaseSessionMessageReplySourceTurn({ sourceTurnId: 'actual-turn', sourceInputId: 'actual-input' },
      { signal: cancelled.signal })).toEqual({ v: 1, ok: false, error: 'unavailable' });
    expect(requests).toHaveLength(1);
  });

  it('commits the answer before fulfilling only its named original input and rejects an unrelated turn', async () => {
    const sessionId = 'cmv3replyreceiveraaaaaaaa';
    const receiverSession = createPlainSessionFixture({ id: sessionId });
    const credentials = { token: 'reply-owner', encryption: null };
    const cause = { requestRef: 'original-input', requester: { serverId: 'srv_reply_home', accountId: 'bob' },
      persona: { serverId: 'srv_reply_home', sessionId },
      origin: { kind: 'session' as const, session: { serverId: 'srv_reply_home', sessionId }, messageId: 'committed-original' } };
    let progress: SessionMessageReplyProgressV1 = { v: 1, mode: 'wait', acceptedTurnId: 'accepted-turn', disposition: 'observing',
    };
    const transcript = new Map<string, unknown>();
    const publications: unknown[] = [];
    const mutations: unknown[] = [];
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/auth/ping')) return { status: 200, data: {} };
      if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify(receiverSession.metadata),
        dataEncryptionKey: null, agentState: null,
      }) } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/messages/by-local-id/original-input/reply')) return { status: 200,
        data: { v: 1, status: 'available', progress } };
      if (url.endsWith('/messages/by-local-id/original-input')) return { status: 200, data: { message: {
        id: 'committed-original', seq: 1, localId: 'original-input', sidechainId: null,
        messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'bob', sessionRelationship: 'sharedEditor' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Question' }, meta: {
          happierInputRequestV1: { v: 1, producer: 'cli', caller: { kind: 'host' },
            permission: {}, actionRequestAttributionV1: { ...cause, requester: { serverId: 'reply-home', accountId: 'mallory' } }, replyIntent: { mode: 'wait' } },
        } } }, createdAt: 1, updatedAt: 1,
      } } };
      const localId = decodeURIComponent(url.split('/messages/by-local-id/')[1] ?? '');
      const message = transcript.get(localId);
      if (message) return { status: 200, data: { message } };
      throw new AxiosError('Message not found', undefined, undefined, undefined, { status: 404,
        statusText: 'Not Found', data: { error: 'Message not found' }, headers: {}, config: { headers: new AxiosHeaders() } });
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { session: {
      pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
    } } }), { status: 200 })));
    const home = createSessionTranscriptHomeStub();
    const runtimeHome = createSessionRuntimeActivityHomeStub({ machineId: 'receiver-machine' });
    const defaultSocket = createApiSessionSocketStub();
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event === SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1) {
        const request = SessionMessageReplyMutationV1Schema.parse(payload);
        mutations.push(request);
        if (request.operation.kind !== 'fulfill') throw new Error('Unexpected observation mutation');
        if (request.operation.outcome.kind === 'answer' && 'result' in request.operation.outcome) {
          expect([...transcript.values()]).toContainEqual(expect.objectContaining({ id: request.operation.outcome.result.messageId }));
        }
        progress = { ...progress, outcome: request.operation.outcome };
        return { v: 1, ok: true, progress };
      }
      const answer = home.answer(event, payload);
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        const observation = SessionTranscriptObservationInputSchema.parse(payload);
        publications.push(observation);
        transcript.set(observation.localId, { id: 'committed-answer', seq: 42, localId: observation.localId,
          sidechainId: observation.sidechainId ?? null, content: observation.content,
          createdAt: observation.createdAt, updatedAt: observation.updatedAt });
        return { ok: true, status: 'observed', id: 'committed-answer', seq: 42,
          localId: observation.localId, didWrite: true, ingestedAt: observation.updatedAt };
      }
      return answer ?? runtimeHome.answer(event, payload) ?? defaultSocket.emitWithAck(event, payload);
    } });
    const client = new ApiSessionClient(credentials.token, receiverSession, {
      metadataAuthority: { kind: 'owner', credentials },
      localMachineId: 'receiver-machine',
      initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
        sessionId, agentRuntimeApplicability: 'supported',
      })],
      getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_reply_home' }, session: {
          pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
        } } }) }),
      transport: { serverId: 'reply-home', serverUrl: 'https://reply-home.test',
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
    });
    clients.add(client);
    client.observeHostTurnFacts({ turnId: 'unrelated-turn', facts: { initiator: 'user', workDepth: 0 } });
    expect(await client.publishSessionMessageReply({ requestLocalId: 'original-input', reply: { kind: 'pass' } }))
      .toMatchObject({ v: 1, ok: false, error: 'conflict' });
    expect(mutations).toEqual([]);
    expect(publications).toEqual([]);
    client.observeHostTurnFacts({ turnId: 'accepted-turn', facts: { initiator: 'user', workDepth: 0 } });
    const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId,
      mode: 'plain', ctx: null, sessionMessageReplyPublisher: client });
    const input = { sessionId, requestLocalId: 'original-input', reply: { kind: 'answer' as const, message: '  Revision 42 is checked.\n' } };
    const publication = client.rpcHandlerManager.invokeLocal('session.message.reply', input, {
      rpcContext: { callerAuthority: 'present_user' },
    });
    await vi.waitFor(() => expect(socket.emitWithAck.mock.calls.map(([event]) => event))
      .toContain(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1), { timeout: 5000 });
    expect(await publication).toMatchObject({ v: 1, ok: true });
    expect(await client.rpcHandlerManager.invokeLocal('session.message.reply', input, {
      rpcContext: { callerAuthority: 'present_user' },
    })).toMatchObject({ v: 1, ok: true, progress: { outcome: {
      kind: 'answer', result: { sessionId, messageId: 'committed-answer' } } } });
    expect(mutations).toEqual([expect.objectContaining({ sessionId, requestSessionId: sessionId,
      requestLocalId: 'original-input', operation: { kind: 'fulfill', turnId: 'accepted-turn',
        outcome: { kind: 'answer', result: { sessionId, messageId: 'committed-answer' } } } }),
      expect.objectContaining({ requestLocalId: 'original-input', operation: { kind: 'fulfill', turnId: 'accepted-turn',
        outcome: { kind: 'answer', result: { sessionId, messageId: 'committed-answer' } } } })]);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ content: { t: 'plain', v: {
      content: { data: { message: input.reply.message } }, meta: { actionRequestAttributionV1: cause },
    } } });
    expect(await deps.sessionMessageReply!({ context: { surface: 'cli' }, ...input, sessionId: 'other-session' }))
      .toMatchObject({ v: 1, ok: false, error: 'forbidden' });
    expect(await deps.sessionMessageReply!({ ...input, context: { surface: 'agent', sessionInputSource: {
      sourceSessionId: sessionId, sourceTurnId: 'unrelated-turn', via: 'action',
    } } })).toMatchObject({ v: 1, ok: false, error: 'conflict' });
    expect(await deps.sessionMessageReply!({ ...input, context: { surface: 'agent', sessionInputSource: {
      sourceSessionId: sessionId,
    } } })).toMatchObject({ v: 1, ok: false, error: 'forbidden' });
    expect(mutations).toHaveLength(2);
    expect(await deps.sessionMessageReply!({ ...input, context: { surface: 'agent', sessionInputSource: {
      sourceSessionId: sessionId, sourceTurnId: 'accepted-turn', sourceInputId: 'original-input', via: 'action',
    } } })).toMatchObject({ v: 1, ok: true });
    expect(mutations).toHaveLength(3);
    expect(publications).toHaveLength(1);
  });
});
