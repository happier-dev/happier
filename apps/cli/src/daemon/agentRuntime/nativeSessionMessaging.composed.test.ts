import axios from 'axios';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as controlServer from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { machineUpdateHandler } from '../../../../server/sources/app/api/socket/machineUpdateHandler';
import { createFakeSocket, getSocketHandler, createSocketRoomDiscoveryHarness } from '../../../../server/sources/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { createSessionPublisherPresence } from '../../../../server/sources/app/presence/sessionPublisherPresence';
import { resolveCurrentSessionMachineFromServer } from '../../../../server/sources/app/api/socket/externalActionDispatcher';
import { getAccountSessionSocketRoom } from '../../../../server/sources/app/api/socketRooms';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { verifyExternalActionMachineRpcExecution } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { readSessionInputRequest, SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { sessionUpdateHandler } from '../../../../server/sources/app/api/socket/sessionUpdateHandler';
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMutationV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { registerSessionMessageRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionTurnMutationRoute } from '../../../../server/sources/app/api/routes/session/registerSessionTurnMutationRoute';
import { createSessionMessageFromPending } from '../../../../server/sources/app/session/pending/pendingMessageTranscriptCommit';
import { applySessionTurnMutation } from '../../../../server/sources/app/session/sessionWriteService';
import { inTx } from '../../../../server/sources/storage/inTx';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('admits runtime-bound native messaging through the production daemon composition', async () => {
  let installed: Parameters<typeof controlServer.startDaemonControlServer>[0] | null = null;
  // Only the daemon listener and Home HTTP are external boundaries.
  vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async input => {
    installed = input;
    return { port: 43129, stop: async () => {} };
  });
  const h = await createInstalledProjectAgentDaemonFixture(() => installed, undefined, true, undefined, undefined, {
    credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`, encryption: null },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_messaging', machineId: 'machine' }),
  });
  const destination = `c${'d'.repeat(24)}`;
  let grantAllowed = true;
  const admitted: ReturnType<typeof SessionPendingEnqueueByMachineRequestV1Schema.parse>[] = [];
  // The canonical Machine client still builds and signs the real wire request.
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
    if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) throw new Error(`Unexpected Machine event: ${event}`);
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
    expect(request.sessionId).toBe(destination);
    expect(request.content).toMatchObject({ t: 'plain', v: { meta: {
      happierProvenanceV1: { kind: 'happierSession', sourceSessionId: h.sessionId, callerDepth: 3 },
      happierInputRequestV1: { sourceSession: { sourceSessionId: h.sessionId, sourceTurnId: 'source-turn', sourceInputId: 'source-input' },
        permission: { requestedPermissionCeiling: 'default' } },
    } } });
    const proof = request.externalAction;
    expect(proof).toBeDefined();
    const { externalAction: _proof, ...unsigned } = request;
    expect(proof && verifyExternalActionMachineRpcRequestV1({ authorizationToken: proof.authorization.token,
      effectActionId: proof.effectActionId, target: proof.target, installationId: proof.installationId,
      event, method: event, requestId: proof.authorization.binding.requestId, params: unsigned,
      publicKey: decodeBase64(h.f.installation.publicKey, 'base64url'), signature: proof.machineSignature })).toBe(true);
    admitted.push(request);
    return { v: 1, result: { status: 'accepted', localId: request.localId } };
  } });
  Reflect.set(h.machine, 'socket', socket);
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    return homeRead(...args);
  });
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.message.send')) {
      return { status: 200, data: { ok: true } };
    }
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('session.message.send')) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      expect(request.sessionActionOrigin?.caller.sessionId).toBe(h.sessionId);
      expect(request.sessionActionSource).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
      if (!grantAllowed) return { status: 403, data: { error: 'credential_scope_denied' } };
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'messaging-proof', binding: {
        accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_messaging',
        machineId: 'machine', custodianAccountId: 'custodian', installationId: h.f.installation.installationId,
        actionId: 'session.message.send', requestId: request.envelope.requestId, target: request.envelope.target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    return homeWrite(...args);
  });
  const send = (reply: 'none' | 'wait' | 'return') => h.dispatch({ kind: 'action.execute', actionId: 'session.message.send',
    requestId: h.operationBase().requestId, input: { sessionId: destination, message: 'Native message', reply },
    witness: { turnId: 'source-turn', inputId: 'source-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 3,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 3, turnDepth: 1 },
      callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
  });
  grantAllowed = false;
  for (const mode of ['none', 'wait', 'return'] as const) {
    expect(await send(mode)).toMatchObject({ ok: true, result: { outcome: { ok: false,
      errorCode: 'target_unavailable', details: { reason: 'external_authorization_refused' } } } });
  }
  expect(admitted.length).toBe(0);
  grantAllowed = true;
  const reply = await send('none');
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true,
    result: { status: 'accepted' },
  } } });
  expect(admitted.length).toBe(1);
});

it('admits native messaging through the installed requester, real Home and Machine socket owner', async () => {
  const home = await createLightSqliteHarness({ tempDirPrefix: 'happier-n1-ab1-', initAuth: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
  const app = createAuthenticatedTestApp({ authentication: 'real' });
  let sourceClient: ApiSessionClient | undefined;
  try {
    const account = await db.account.create({ data: { id: 'requester', encryptionMode: 'plain', publicKey: 'ab1-public' } });
    const token = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
    const authenticated = await auth.verifyTokenForRoute(token);
    if (!authenticated) throw new Error('Missing authenticated Machine fixture');
    let installed: Parameters<typeof controlServer.startDaemonControlServer>[0] | null = null;
    vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async input => {
      installed = input;
      return { port: 43129, stop: async () => {} };
    });
    const homeId = await getOrCreateServerIdentityId();
    const credentials = { token, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => installed, undefined, true, undefined, undefined, {
      credentials, requesterCredentials: credentials,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    });
    await db.machine.create({ data: { id: 'machine', accountId: account.id,
      installationId: h.f.installation.installationId, installationPublicKey: decodeBase64(h.f.installation.publicKey, 'base64url'),
      metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      active: true, lastActiveAt: new Date(), operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
        sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
    } });
    const destination = `c${'e'.repeat(24)}`;
    for (const id of [h.sessionId, destination]) {
      await db.session.create({ data: { id, accountId: account.id, tag: id, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId: 'machine' }), active: true, lastActiveAt: new Date() } });
      await db.accessKey.create({ data: { accountId: account.id, machineId: 'machine', sessionId: id, data: 'opaque' } });
    }
    // Reply custody validates the actual source turn and its consumed input;
    // the none-only predecessor of this test did not need that original.
    await db.sessionMessage.create({ data: { sessionId: h.sessionId, localId: 'source-input', seq: 1,
      messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Native messaging request' } } },
      acceptedTurnId: 'source-turn' } });
    await db.session.update({ where: { id: h.sessionId }, data: { seq: 1 } });
    await db.sessionTurn.create({ data: { sessionId: h.sessionId, turnId: 'source-turn', status: 'in_progress',
      startedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      // Native input acceptance is durable before transcript anchors finish
      // publishing; the exact accepted input must remain usable in that window.
      transcriptAnchorsJson: JSON.stringify({}) } });
    const publisher = createFakeSocket({ id: 'source-publisher', data: {}, timeout: () => ({
      emitWithAck: async (_event, request) => {
        if (!sourceClient) throw new Error('Missing source publisher');
        return sourceClient.rpcHandlerManager.handleRequest(request);
      },
    }) });
    const presence = createSessionPublisherPresence();
    expect((await presence.registerPublisher({ socket: publisher,
      binding: { accountId: account.id, machineId: 'machine', sessionId: h.sessionId },
      completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
    let discoverPublisher = true;
    const sourceRoom = getAccountSessionSocketRoom(account.id, h.sessionId);
    const publisherReads: string[] = [];
    const io = createSocketRoomDiscoveryHarness(async room => {
      publisherReads.push(room);
      return discoverPublisher && (room === sourceRoom || room === publisher.id
        || room === `rpc:${account.id}:${h.sessionId}:session.message.reply.observe.v1`) ? [publisher] : [];
    });
    io.sockets.sockets.set(publisher.id, publisher as never);
    app.decorate('resolveCurrentSessionMachine', (input: Readonly<{ accountId: string; sessionId: string }>) =>
      resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
    registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Unexpected external relay'); } });
    registerSessionMessageRoutes(app);
    registerSessionTurnMutationRoute(app);
    let terminal: 'complete' | 'cancel' | undefined;
    const targetResults: Array<{ text: string; messageId: string }> = [];
    const finishTarget = async (request: ReturnType<typeof SessionPendingEnqueueByMachineRequestV1Schema.parse>) => {
      const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
        sessionId: destination, localId: request.localId,
      } } });
      const committed = await inTx(async tx => {
        const result = await createSessionMessageFromPending(tx, { sessionId: destination, sessionEncryptionMode: 'plain',
          storagePolicy: 'optional', localId: request.localId, content: request.content, messageRole: 'user',
          requestContentForEquality: request.content, inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(original.inputAdmissionReceipt),
          pendingRequestedAction: request.requestedAction });
        if (!result.ok) throw new Error('Target input materialization failed');
        await tx.sessionPendingMessage.delete({ where: { id: original.id } });
        return result.message;
      });
      const turnId = randomUUID();
      const authentication = createPresentUserSessionAccessAuthentication();
      const mutate = (mutation: Parameters<typeof applySessionTurnMutation>[0]['mutation']) =>
        applySessionTurnMutation({ actorUserId: account.id, authentication, mutation });
      expect(await mutate({ v: 1, sessionId: destination, turnId, mutationId: randomUUID(), action: 'begin',
        observedAt: Date.now(), transcriptAnchors: { userMessageSeqs: [committed.seq] } })).toMatchObject({ ok: true });
      const text = terminal === 'cancel' ? 'AF1 exact stopped partial' : 'AF1 exact inline answer';
      const final = await db.sessionMessage.create({ data: { sessionId: destination, seq: committed.seq + 1, messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text } } } } } });
      // This database boundary stands in for the native transcript writer;
      // retain its sequence frontier before the next real Pending admission.
      await db.session.update({ where: { id: destination }, data: { seq: final.seq } });
      const anchors = { startSeqInclusive: committed.seq, endSeqInclusive: final.seq, finalAssistantMessageSeq: final.seq };
      expect(await mutate({ v: 1, sessionId: destination, turnId, mutationId: randomUUID(), action: terminal!,
        observedAt: Date.now() + 1, ...(terminal === 'complete' ? { transcriptAnchors: anchors } : {}) })).toMatchObject({ ok: true });
      if (terminal === 'cancel') expect(await mutate({ v: 1, sessionId: destination, turnId, mutationId: randomUUID(),
        action: 'append_transcript_anchors', observedAt: Date.now() + 2, transcriptAnchors: anchors })).toMatchObject({ ok: true });
      targetResults.push({ text, messageId: final.id });
    };
    const network = createFakeSocket({ id: 'source-machine', nsp: { server: io }, data: { clientType: 'machine-scoped', machineId: 'machine',
      userId: authenticated.userId, authAuthority: authenticated.authority, authTokenKind: authenticated.authTokenKind,
      authTokenAuthenticationEvidence: authenticated.authenticationEvidence,
      verifiedMachineInstallationId: h.f.installation.installationId } });
    Object.assign(network, { handshake: { auth: { token } } });
    qualifyCurrentAccountStoredContentSocket(network);
    machineUpdateHandler(account.id, network as never, { sessionPublisherPresence: presence,
      resolveCurrentSessionMachine: app.resolveCurrentSessionMachine,
      operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
    registerSocketRpcHandlers({ userId: account.id, socket: network as never, io, sessionPublisherPresence: presence });
    const pending = getSocketHandler(network, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
    const packets: ReturnType<typeof SessionPendingEnqueueByMachineRequestV1Schema.parse>[] = [];
    const relayFacts: Array<{ ok: unknown; error: unknown; code: unknown }> = [];
    Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
      if (event === SOCKET_RPC_EVENTS.CALL) {
        let response: unknown;
        await getSocketHandler(network, event)(raw, (value: unknown) => { response = value; });
        const result = response && typeof response === 'object' ? response as Record<string, unknown> : {};
        relayFacts.push({ ok: result.ok, error: result.error, code: result.errorCode });
        return response;
      }
      if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) throw new Error('Unexpected Machine event');
      const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
      packets.push(request);
      let response: unknown;
      const priorReads = publisherReads.length;
      await pending(request, (value: unknown) => { response = value; });
      // Two fresh source fences are already owned by the verifier; there is
      // no Account inventory, polling or duplicated receiver enumeration.
      expect(publisherReads.slice(priorReads).every(room => room === sourceRoom)).toBe(true);
      expect(publisherReads.length - priorReads).toBeLessThanOrEqual(2);
      if (request.reply?.mode === 'wait' && terminal) await finishTarget(request);
      return SessionPendingEnqueueByMachineResponseV1Schema.parse(response);
    } }));
    // Replace HTTP delivery only. The existing bootstrap endpoints remain the
    // fixture's network boundary; Home mint/verify execute their real handlers.
    const oldPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (!path.includes('/execution-authorization')) return oldPost(...args);
      const response = await app.inject({ method: 'POST', url: path, payload: args[1],
        headers: Object.fromEntries(Object.entries(args[2]?.headers ?? {}).map(([key, value]) => [key, String(value)])) });
      return { status: response.statusCode, data: response.json() };
    });
    const oldGet = vi.mocked(axios.get).getMockImplementation()!;
    const resultReads: Array<{ path: string; status: number }> = [];
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const url = new URL(String(args[0]));
      const path = url.pathname;
      if (path.includes('/messages/by-local-id/') || path === `/v1/sessions/${destination}/messages`
        || path === `/v1/sessions/${destination}/turns`) {
        for (const [key, value] of Object.entries(args[1]?.params ?? {})) url.searchParams.set(key, String(value));
        const response = await app.inject({ method: 'GET', url: `${path}${url.search}`,
          headers: Object.fromEntries(Object.entries(args[1]?.headers ?? {}).map(([key, value]) => [key, String(value)])) });
        resultReads.push({ path, status: response.statusCode });
        return { status: response.statusCode, data: response.json() };
      }
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      const sessionId = path.match(/^\/v2\/sessions\/([^/]+)$/)?.[1];
      // Mirror the migrated Home rows: an available receiver must not take the
      // launch fixture's inactive/resume-failure path after durable admission.
      if (sessionId === h.sessionId || sessionId === destination) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine' }),
        dataEncryptionKey: null, share: null,
      }) } };
      if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
      if (path.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      return oldGet(...args);
    });
    const oldFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (...args) => new URL(String(args[0])).pathname === '/v1/features'
      ? Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId }, session: {
          pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
        } } }) : oldFetch(...args)));
    // The Machine relay, source RPC decoder/registration and source publisher
    // all remain real. Only Socket.IO delivery crosses this in-process boundary.
    // Socket.IO invokes every listener; its first acknowledgement wins. Retain
    // both production registrations instead of the single-handler test map.
    const publisherEvents = new EventEmitter();
    publisher.on = (event, handler) => { publisherEvents.on(event, handler); };
    Object.assign(publisher.data!, { ...network.data, clientType: 'session-scoped', sessionId: h.sessionId });
    sessionUpdateHandler(account.id, publisher as never, { connectionType: 'session-scoped', socket: publisher,
      userId: account.id, sessionId: h.sessionId } as never,
      { presence, binding: { accountId: account.id, machineId: 'machine', sessionId: h.sessionId } });
    machineUpdateHandler(account.id, publisher as never, { sessionPublisherPresence: presence,
      resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
    expect(publisherEvents.listenerCount(SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)).toBe(1);
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine' });
    const fallback = createApiSessionSocketStub();
    const sourceSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event !== SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1) return activity.answer(event, payload) ?? fallback.emitWithAck(event, payload);
      return await new Promise<unknown>(resolve => { publisherEvents.emit(event, payload, resolve); });
    } });
    sourceClient = new ApiSessionClient(token, createPlainSessionFixture({ id: h.sessionId }), {
      metadataAuthority: { kind: 'owner', credentials }, localMachineId: 'machine', durableMutationDeliveryInitiallyActive: false,
      transport: { serverId: 'session-home', serverUrl: 'http://localhost:3005', createSessionSocketTransport: () => ({
        socket: sourceSocket as never, transport: createSocketTransportAdapter(sourceSocket as never),
      }) },
    });
    await vi.waitFor(() => expect(sourceSocket.emit.mock.calls.some(([event, payload]) => event === SOCKET_RPC_EVENTS.REGISTER
      && payload && typeof payload === 'object' && 'method' in payload
      && payload.method === `${h.sessionId}:session.message.reply.observe.v1`)).toBe(true));
    const attribution = deriveSessionInputActionRequestAttributionV1({ requestRef: 'source-input',
      persona: { serverId: 'session-home', sessionId: h.sessionId }, messageRole: 'user', origin: null,
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: account.id, sessionRelationship: 'owner' } });
    expect(attribution?.requester?.accountId).toBe(account.id);
    const send = (reply: 'none' | 'wait' | 'return' = 'none') => h.dispatch({ kind: 'action.execute', actionId: 'session.message.send', requestId: h.operationBase().requestId,
      input: { sessionId: destination, message: 'Native Home input', reply, ...(reply === 'wait' ? { timeoutSeconds: 1 } : {}) },
      witness: { turnId: 'source-turn', inputId: 'source-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
        actionRequestAttributionV1: attribution,
        agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 },
        callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
    });
    const outcome = await send();
    // Inspect only bounded outcome facts: never render a signed packet on failure.
    expect(packets.length).toBe(1);
    expect(outcome).not.toMatchObject({ ok: true, result: { outcome: { ok: true,
      result: { status: 'rejected', code: 'session_input_unauthorized' } } } });
    expect(outcome).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true,
      result: { status: 'accepted' } } } });
    expect(await db.sessionPendingMessage.count({ where: { sessionId: destination } })).toBe(1);
    const retained = await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: destination }, select: { content: true } });
    const content = SessionPendingEnqueueByMachineRequestV1Schema.shape.content.parse(retained.content);
    if (content.t !== 'plain' || !content.v || typeof content.v !== 'object' || !('meta' in content.v)) {
      throw new Error('Missing retained plain input request');
    }
    expect(readSessionInputRequest(content.v.meta)?.actionRequestAttributionV1).toEqual(attribution);
    const returned = await send('return');
    expect(relayFacts).toEqual([{ ok: true, error: undefined, code: undefined }]);
    expect(returned).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true,
      result: { status: 'accepted' } } } });
    expect(packets.length).toBe(2);
    expect(packets.at(-1)?.reply?.mode).toBe('return');
    expect(sourceSocket.emitWithAck.mock.calls.filter(([event]) => event === SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)
      .map(([, payload]) => {
        const request = SessionMessageReplyMutationV1Schema.parse(payload);
        return { requestSessionId: request.requestSessionId, requestLocalId: request.requestLocalId, operation: request.operation };
      })).toEqual([{ requestSessionId: destination, requestLocalId: packets.at(-1)!.localId, operation: { kind: 'release' } }]);
    const returnedPacket = packets.at(-1)!;
    expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
      sessionId: destination, localId: returnedPacket.localId } }, select: { replyDisposition: true } }))
      .toEqual({ replyDisposition: 'return_pending' });
    // A competing accepted turn is authoritative even if old transcript
    // anchors happen to contain the same user row. Legacy unbound inputs
    // retain their original exact-anchor reader.
    await db.sessionTurn.update({ where: { sessionId_turnId: { sessionId: h.sessionId, turnId: 'source-turn' } },
      data: { transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1] }) } });
    await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: h.sessionId, localId: 'source-input' } },
      data: { acceptedTurnId: 'another-source-turn' } });
    expect(await sourceClient.mutateSessionMessageReply({ requestSessionId: destination, requestLocalId: returnedPacket.localId,
      operation: { kind: 'release' } })).toMatchObject({ ok: false, error: 'unavailable' });
    await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: h.sessionId, localId: 'source-input' } },
      data: { acceptedTurnId: null } });
    expect(await sourceClient.mutateSessionMessageReply({ requestSessionId: destination, requestLocalId: returnedPacket.localId,
      operation: { kind: 'release' } })).toMatchObject({ ok: true });
    await db.sessionTurn.update({ where: { sessionId_turnId: { sessionId: h.sessionId, turnId: 'source-turn' } },
      data: { transcriptAnchorsJson: null } });
    expect(await sourceClient.mutateSessionMessageReply({ requestSessionId: destination, requestLocalId: returnedPacket.localId,
      operation: { kind: 'release' } })).toMatchObject({ ok: false, error: 'unavailable' });
    await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: h.sessionId, localId: 'source-input' } },
      data: { acceptedTurnId: 'source-turn' } });
    // The same event also carries Machine recovery. That socket must reach its
    // own credential refusal, without a Session parser racing its response.
    const recoveryEvents = new EventEmitter();
    const recoverySocket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: 'machine' } });
    recoverySocket.on = (event, handler) => { recoveryEvents.on(event, handler); };
    sessionUpdateHandler(account.id, recoverySocket as never, { connectionType: 'machine-scoped', socket: recoverySocket,
      userId: account.id, machineId: 'machine' } as never);
    machineUpdateHandler(account.id, recoverySocket as never);
    expect(recoveryEvents.listenerCount(SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)).toBe(1);
    const recoveryResult = await new Promise<unknown>(resolve => { recoveryEvents.emit(SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, {
      v: 1, machineId: 'machine', requestSessionId: destination, requestLocalId: returnedPacket.localId,
      operation: { kind: 'returned', returnedInputLocalId: 'unadmitted-return' },
    }, resolve); });
    expect(recoveryResult).toEqual({ v: 1, ok: false, error: 'forbidden' });
    for (const action of ['complete', 'cancel'] as const) {
      terminal = action;
      const waited = await send('wait');
      expect(resultReads.filter(read => read.status !== 200)).toEqual([]);
      const expected = targetResults.at(-1)!;
      expect(waited).toMatchObject({ ok: true, result: { outcome: { ok: true, result: {
        status: 'replied', outcome: action === 'complete'
          ? { kind: 'answer', text: expected.text, messageRef: { messageId: expected.messageId } }
          : { kind: 'cancelled', partialText: expected.text, messageRef: { messageId: expected.messageId } },
      } } } });
    }
    const packet = packets[0]!;
    if (!packet.externalAction) throw new Error('Missing installed Machine proof');
    const { externalAction, ...unsigned } = packet;
    const unwiredSocket = createFakeSocket({ nsp: { server: io }, data: { ...network.data } });
    machineUpdateHandler(account.id, unwiredSocket as never, {
      operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
    });
    let unwiredResponse: unknown;
    await getSocketHandler(unwiredSocket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)(packet,
      (value: unknown) => { unwiredResponse = value; });
    expect(unwiredResponse).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    const proof = { event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, method: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
      requestId: externalAction.authorization.binding.requestId, params: unsigned,
      resolveCurrentSessionMachine: app.resolveCurrentSessionMachine };
    // This missing producer→consumer binding is the original refusal, even
    // with the genuine root and Machine signature that just committed input.
    expect(await verifyExternalActionMachineRpcExecution(externalAction, { ...proof, resolveCurrentSessionMachine: undefined }) === null).toBe(true);
    expect(await verifyExternalActionMachineRpcExecution(externalAction, proof) !== null).toBe(true);
    let substituted: unknown;
    await pending({ ...packet, localId: 'substituted-input' }, (value: unknown) => { substituted = value; });
    expect(substituted).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    discoverPublisher = false;
    let refused: unknown;
    await pending(packet, (value: unknown) => { refused = value; });
    expect(refused).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    discoverPublisher = true;
    await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
      accountId: account.id, machineId: 'machine', sessionId: h.sessionId,
    } } });
    await pending(packet, (value: unknown) => { refused = value; });
    expect(refused).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
    expect(await db.sessionPendingMessage.count({ where: { sessionId: destination } })).toBe(2);
  } finally {
    await sourceClient?.close();
    await app.close();
    await home.close();
  }
}, 120_000);
