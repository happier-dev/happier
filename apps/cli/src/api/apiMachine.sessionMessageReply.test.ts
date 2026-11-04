import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { SessionMessageReplyMachineMutationV1Schema, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  MachineUpdateOperationProtocolCapabilitiesRequestV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { StoredCredentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, bindApiSessionSocketSequenceMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_SERVER_START_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { DiscussionAgentPostRequestV1Schema, DiscussionMachinePublicationV2Schema,
  DISCUSSION_AGENT_POST_EVENT_V1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { configuration } from '@/configuration';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { admitRequesterSessionBootstrap, createRequesterSessionRuntimeContextResolver,
  releaseUnretainedRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import type { TrackedSession } from '@/daemon/types';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { createProductionFreshWorkflowSessionConversation, createProductionWorkflowSessionStepExecutor } from '@/daemon/workflows/sessionStepExecutor';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import fs from 'node:fs/promises';

const os = vi.hoisted(() => ({ identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
  credentials: null as StoredCredentials | null }));
const io = vi.hoisted(() => vi.fn());
// Only Socket.IO and the persisted installation/credential files are replaced.
vi.mock('socket.io-client', () => ({ io }));
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
  readStoredCredentialsForServerId: async () => os.credentials }));
vi.mock('@/daemon/identity/store', async original => ({ ...await original<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => os.identity }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); io.mockReset(); os.identity = null; os.credentials = null; });

function installControlRegistrations(client: ApiMachineClient) {
  const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
  for (const method of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW, RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE, RPC_METHODS.STOP_SESSION,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1, RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET]) {
    // These real registrations prove listener readiness; native controls are never invoked here.
    manager.registerHandler(method, async () => { throw new Error('Unexpected native control invocation'); });
  }
}

function acknowledgeRegistrations(socket: ReturnType<typeof createApiSessionSocketStub>) {
  for (const [event, raw] of socket.emit.mock.calls) {
    if (event === SOCKET_RPC_EVENTS.REGISTER && raw && typeof raw === 'object' && 'method' in raw) {
      socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: raw.method });
    }
  }
}

function acknowledgeRegistration(event: string, args: unknown[], socket: ReturnType<typeof createApiSessionSocketStub>) {
  const raw = args[0];
  if (event === SOCKET_RPC_EVENTS.REGISTER && raw && typeof raw === 'object' && 'method' in raw) {
    queueMicrotask(() => socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: raw.method }));
  }
}

it('carries an accepted Workflow terminal return through the Machine publication schema without a live Session', async () => {
  const client = new ApiMachineClient('token', { id: 'machine', encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  onTestFinished(() => client.shutdown());
  const packets: unknown[] = [];
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
    if (event !== DISCUSSION_AGENT_POST_EVENT_V1) throw new Error('Unexpected transport operation');
    const packet = DiscussionMachinePublicationV2Schema.parse(raw);
    packets.push(packet);
    return { v: 1, ok: false, error: 'discussions_unavailable' };
  } });
  Reflect.set(client, 'socket', socket);
  const reply = { v: 1 as const, sessionId: 'c123456789012345678901234', discussionId: 'discussion', terminalReturn: true as const,
    replyReturn: { serverId: 'home', requestLocalId: 'original', acceptedTurnId: 'turn',
      workflow: { runId: 'run', invocationRecordId: 'leaf', invocationAttempt: '0' } },
    request: { localId: 'reply', content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Accepted result' }] } },
      mentionedAccountIds: [], replyTarget: { kind: 'message' as const, messageId: 'question' } } };
  expect(await client.postAgentDiscussionMessage(reply)).toMatchObject({ ok: false, error: 'discussions_unavailable' });
  expect(packets).toHaveLength(1);
  expect(packets[0]).toMatchObject({ v: 2, operation: 'terminal_return', machineId: 'machine', publication: reply });
  expect(await client.postAgentDiscussionMessage({ ...reply, replyReturn: { ...reply.replyReturn, workflow: undefined } }))
    .toMatchObject({ ok: false, error: 'discussion_post_denied' });
  expect(packets).toHaveLength(1);
  expect(await client.postAgentDiscussionMessage({ ...reply, draftReview: { artifactId: 'approved', decidingAccountId: 'account' } }))
    .toMatchObject({ ok: false, error: 'discussions_unavailable' });
  expect(packets[1]).toMatchObject({ v: 1, operation: 'approved_replay' });
});

it.each(['refused_advertisement', 'late_feature_snapshot'] as const)('admits the first fresh Workflow input after %s without a target update', async scenario => {
  vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
  const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
  os.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
  const credentials = { token: 'owner-token', encryption: null };
  os.credentials = credentials;
  const sessionId = 'c' + '9'.repeat(24);
  let published: ReturnType<typeof MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse>['capabilities'] = {};
  let refuseAdvertisement = scenario === 'refused_advertisement';
  let refused = false;
  let holdFeatures = false;
  let releaseFeatures: () => void = () => {};
  let earlierPublication: Promise<void> | undefined;
  let publishEarlier: (() => Promise<void>) | undefined;
  let birth: ReturnType<typeof buildCommittedLaunchMetadata> | undefined;
  let localId = '';
  const admitted: unknown[] = [];
  // Home HTTP/Socket.IO and native process launch are the substituted boundaries.
  // Capability lifecycle, fresh Session creation, Workflow input authoring and
  // exact reply observation run through their real CLI owners. The enqueue
  // transport below models the server's capability refusal, not its admission service.
  const socket = createApiSessionSocketStub({ emit: acknowledgeRegistration, emitWithAck: (event, raw) => {
    if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
      const request = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(raw);
      if (request.capabilities.sessionMessageReply && refuseAdvertisement) {
        refused = true;
        return { v: 1, result: 'error', code: 'internal_error' };
      }
      published = request.capabilities;
      return { v: 1, result: 'success', revision: 2 };
    }
    if (event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) {
      const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
      if (!published.sessionMessageReply) return { v: 1, result: { status: 'rejected', code: 'session_input_target_update_required' } };
      admitted.push(request);
      localId = request.localId;
      return { v: 1, result: { status: 'accepted', localId } };
    }
    return { result: 'success', version: 1, daemonState: raw && typeof raw === 'object' && 'daemonState' in raw ? raw.daemonState : null };
  } });
  io.mockImplementation((_url: string, options: { auth?: { clientType?: string } }) =>
    options.auth?.clientType === 'machine-scoped' ? socket : createApiSessionSocketStub());
  const session = () => createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
    machineId: 'target-machine', metadata: JSON.stringify({ machineId: 'target-machine', path: '/repo', ...birth }) });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) {
      if (scenario === 'late_feature_snapshot' && !earlierPublication) {
        holdFeatures = true;
        earlierPublication = publishEarlier!();
        holdFeatures = false;
      }
      return { status: 200, data: { v: 1, entries: [], nextAfter: null } };
    }
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.endsWith('/v1/machines/target-machine')) return { status: 200, data: { machine: { id: 'target-machine',
      revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 2, operationProtocolCapabilities: published } } };
    if (url.endsWith(`/v2/sessions/${sessionId}/messages/reply-capability`)) return { status: 200, data: { v: 1, protocolVersions: [1] } };
    if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'leaf-turn', outcome: { kind: 'pass' } } } };
    if (url.endsWith(`/v2/sessions/${sessionId}/pending`)) return { status: 200, data: { pending: localId ? [{ localId, status: 'queued' }] : [] } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: session() } };
    return { status: 200, data: { id: 'owner', settings: null, settingsVersion: 0 } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url) => {
    if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: birth ? [session()] : [] } };
    throw new Error('Unexpected Workflow HTTP write');
  });
  vi.spyOn(fs, 'access').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'owner' }), { status: 200 })));
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async ({ method, request }) => {
    if (method !== RPC_METHODS.SPAWN_HAPPY_SESSION) throw new Error('Unexpected native launch');
    const spawn = SpawnDaemonSessionRequestSchema.parse(request);
    birth = buildCommittedLaunchMetadata({ options: spawn, directory: '/repo', accountSettings: {} });
    return { type: 'success', sessionId, sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
  });
  const client = new ApiMachineClient(credentials.token, { id: 'target-machine', encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, {
      resolveServerFeaturesSnapshot: async () => {
        if (holdFeatures) await new Promise<void>(resolve => { releaseFeatures = resolve; });
        return undefined;
      },
    });
  publishEarlier = () => client.setProjectFiniteExecutionLive(true);
  client.setRPCHandlers({ spawnSession: async () => { throw new Error('Launch uses the exact Machine process boundary'); },
    sessionSpawnV1OutcomeRequired: true,
    resolveSpawnSessionByNonce: async () => { throw new Error('No replacement launch'); },
    stopSession: async () => true, requestShutdown: () => {} });
  installControlRegistrations(client);
  try {
    client.connect();
    if (scenario === 'refused_advertisement') {
      await vi.waitFor(() => expect(refused).toBe(true));
      expect(published.sessionMessageReply).toBeUndefined();
      refuseAdvertisement = false;
    }
    // The existing publication scheduler must recover without a new Session,
    // reconnect, input hint or caller retry to manufacture another opportunity.
    await vi.waitFor(() => expect(published.sessionMessageReply).toEqual({ protocolVersions: [1] }), { timeout: 5_000 });
    // A publication started before reply readiness must not overwrite the
    // acknowledged target while its Home feature read was in flight.
    releaseFeatures();
    await earlierPublication;
    const machineAdmissionTransport = client.enqueueSessionPendingByMachine.bind(client);
    const execute = createProductionWorkflowSessionStepExecutor({ credentials, machineId: 'target-machine', machineAdmissionTransport,
      createFreshConversation: createProductionFreshWorkflowSessionConversation({ credentials,
        serverId: configuration.activeServerId, machineId: 'target-machine', workDepth: 0, originRunId: 'run-1', machineAdmissionTransport }),
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => null });
    const stepInput: Parameters<typeof execute>[0] = { runId: 'run-1', step: { kind: 'step', id: 'work', document: { text: 'Review', references: [], attachments: [] },
      input: [], result: { kind: 'text' } }, invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1' },
      input: { text: 'Review', references: [], attachments: [], values: [] },
      execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'target-machine', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {} };
    const result = await execute(stepInput);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'completed', result: '' });
    expect(birth).toBeDefined();
    expect(admitted).toEqual([expect.objectContaining({ sessionId, targetMachineId: 'target-machine', reply: { mode: 'wait',
      workflow: { purpose: 'invocation', runId: stepInput.runId, invocationRecordId: stepInput.invocation.logicalInvocationRecordId } } })]);
  } finally { releaseFeatures(); await client.shutdown(); }
});

it.each([false, true])('recovers a Discussion result through the actual Session publisher without admitting a new Session input (hosted requester: %s)', async hostedRequester => {
  vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
  const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
  os.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
  os.credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.fixture`, encryption: null };
  const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
    approvalWaivedSurfaces: { 'discussion.reply': ['agent'] } } });
  const ownerSettings = hostedRequester ? AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
    actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } } }) : settings;
  setActiveAccountSettingsSnapshot({ source: 'network', settings: ownerSettings, settingsVersion: 1,
    loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken(os.credentials.token) });
  const requestSessionId = 'c' + '7'.repeat(24);
  const otherSessionId = 'c' + '8'.repeat(24);
  const requesterCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.fixture`, encryption: null };
  let requesterCurrent = true;
  let requesterReads = 0;
  let installedReads = 0;
  const discussion = { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1,
    participantSessionId: requestSessionId };
  let returned = false;
  const progress = () => ({ v: 1, mode: 'return', disposition: returned ? 'returned' : 'return_pending',
    acceptedTurnId: 'accepted-turn', discussion, outcome: { kind: 'pass' } });
  const accountId = hostedRequester ? 'bob' : 'owner';
  const actionRequestAttributionV1 = materializeActionRequestAttributionV1({ requestRef: 'original',
    requester: { serverId: configuration.activeServerId, accountId },
    persona: { serverId: configuration.activeServerId, sessionId: requestSessionId },
    origin: { kind: 'discussion', discussion: { serverId: configuration.activeServerId, discussionId: discussion.discussionId }, messageId: discussion.messageId } });
  const summary = DiscussionSummaryV1Schema.parse({ id: discussion.discussionId, ownerAccountId: accountId, encryptionMode: 'plain', anchor: null,
    access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'create-1',
    titleContent: { t: 'plain', v: { v: 1, title: 'Discussion' } }, messageSeq: 1, lastReadSeq: 0,
    unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
    latestMessage: { id: discussion.messageId, localId: 'question', seq: 1, authorAccountId: accountId,
      accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 1 },
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
      sendToSession: true, manageAccess: true, leave: false } });
  const publications: unknown[] = [];
  const publicationMethods: string[] = [];
  const publicationWarnings = vi.spyOn(logger, 'warnLocalFile');
  const settingsResponse = { status: 200, data: { id: 'owner', settings: JSON.stringify(ownerSettings), settingsVersion: 1 } };
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const requester = options?.headers?.Authorization === `Bearer ${requesterCredentials.token}`;
    if (url.includes('/session-message-replies/pending')) {
      if (requester) requesterReads++; else installedReads++;
      return { status: 200, data: { v: 1,
        entries: returned || hostedRequester && !requester ? [] : [
          ...(hostedRequester ? [{ requestSessionId: otherSessionId, requestLocalId: 'must-not-open',
            progress: { ...progress(), discussion: { ...discussion, participantSessionId: otherSessionId } } }] : []),
          { requestSessionId, requestLocalId: 'original', progress: progress() }], nextAfter: null } };
    }
    if (url.includes('/by-local-id/must-not-open')) throw new Error('A requester context cannot read another Session original');
    if (url.endsWith('/by-local-id/original/reply')) {
      if (hostedRequester) expect(requester).toBe(true);
      return { status: 200, data: { v: 1, status: 'available', progress: { ...progress(), actionRequestAttributionV1 } } };
    }
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.includes(`/v2/sessions/${requestSessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: requestSessionId, encryptionMode: 'plain', active: true, share: null,
      metadata: JSON.stringify({ machineId: 'target-machine', path: '/repo' }),
    }) } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: requester ? settings : ownerSettings }, version: 1 } };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (requester && url.endsWith('/profile')) return { status: 200, data: { id: 'bob', settings: JSON.stringify(settings), settingsVersion: 1 } };
    return settingsResponse;
  });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    if (config.method === 'GET' && config.url?.endsWith('/v1/discussions/discussion-1/participants')) return { status: 200,
      data: DiscussionParticipantsListResponseV1Schema.parse({ discussionId: discussion.discussionId, ownerAccountId: accountId,
        access: 'owner', grants: [], participants: [{ participant: { kind: 'session', sessionId: requestSessionId },
          answerPolicy: 'when_addressed', createdAt: 1 }] }) };
    if (config.method === 'GET' && config.url?.endsWith('/v1/discussions/discussion-1')) {
      if (hostedRequester) expect(config.headers?.Authorization).toBe(`Bearer ${requesterCredentials.token}`);
      return { status: 200, data: { discussion: summary } };
    }
    throw new Error('Unexpected resource write: ' + config.method + ' ' + config.url);
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {
    sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } },
  }, capabilities: { serverIdentity: { serverIdentityId: 'srv_reply_home' } } }), { status: 200 })));
  const machineSocket = createApiSessionSocketStub({ emit: acknowledgeRegistration, emitWithAck: (event, raw) => {
    if (event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 || event === SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)
      throw new Error('Discussion return cannot create or mark a Session return');
    return event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1
      ? { v: 1, result: 'success', revision: 1 }
      : { result: 'success', version: 1, daemonState: (raw as { daemonState: string }).daemonState };
  } });
  const publisherSocket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected publisher event: ' + event);
    const call = raw as { method: string; params: unknown };
    publicationMethods.push(call.method);
    expect(call.method).toBe(`${requestSessionId}:discussion.agentPost.v1`);
    const body = call.params as { request: unknown; witness?: unknown };
    expect(body.witness).toBeUndefined();
    const request = DiscussionAgentPostRequestV1Schema.parse(body.request);
    publications.push(request);
    expect(request.replyReturn).toEqual({ serverId: 'srv_reply_home', requestLocalId: 'original', acceptedTurnId: 'accepted-turn' });
    expect(request.request.replyTarget).toEqual({ kind: 'message', messageId: 'question-1' });
    returned = true;
    return { ok: true, result: { v: 1, ok: true, value: { messageSeq: 2, message: {
      id: 'returned-pass', discussionId: discussion.discussionId, localId: request.request.localId, seq: 2,
      authorAccountId: accountId, accountActor: { v: 1, accountId, profile: null },
      producerV1: { v: 1, kind: 'agent', sessionId: requestSessionId }, content: request.request.content,
      mentionedAccountIds: [], createdAt: 1,
    } } } };
  } });
  if (hostedRequester) bindApiSessionSocketMock(io, createApiSessionSocketStub());
  else bindApiSessionSocketSequenceMock(io, [machineSocket, publisherSocket]);
  const directory = hostedRequester ? await mkdtemp(join(tmpdir(), 'requester-discussion-return-')) : null;
  let requesterRuntime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let requesterHost: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  onTestFinished(async () => {
    await requesterRuntime?.dispose();
    await requesterHost?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const trackedSessions = new Map<number, TrackedSession>();
  if (directory) {
    const serverId = configuration.activeServerId, serverHttpBaseUrl = resolveServerHttpBaseUrl();
    const registry = new ConnectedServiceRuntimeRegistry();
    requesterHost = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId, serverHttpBaseUrl, machineId: 'target-machine', custodianAccountId: 'owner', credentials: os.credentials,
      connectedServicesMaterializationBaseDir: join(directory, 'materialized'), registry, trackedSessions,
      getRequester: () => requesterRuntime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    // The authenticated Machine ingress is the boundary; requester Account,
    // settings/currentness, runtime and tracked-context resolver remain real.
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester',
      credentials: { token: requesterCredentials.token } }, existingSessionId: requestSessionId,
      boundary: { serverId, serverHttpBaseUrl, happyHomeDir: directory }, context: { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'owner', machineId: 'target-machine',
          installationId: os.identity!.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => requesterCurrent } });
    if (!admitted) throw new Error('Missing real requester bootstrap');
    requesterRuntime = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: admitted.admitted, activeServerDir: directory,
      connectedServicesMaterializationBaseDir: join(directory, 'materialized'), resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'target-machine', machineIdProvider: () => 'target-machine', runtimeId: 'return-runtime',
        happyHomeDir: directory, logger: { debug() {}, info() {}, warn() {} },
        processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: requesterHost.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!requesterRuntime) throw new Error('Missing real requester runtime');
    expect(requesterRuntime.readAccountSettingsSnapshot().settings.actionsSettingsV1.approvalWaivedSurfaces?.['discussion.reply']).toEqual(['agent']);
    trackedSessions.set(process.pid, { pid: process.pid, happySessionId: requestSessionId, startedBy: 'daemon',
      requesterWorkAttributionV1: requesterRuntime.bootstrap.attribution, requesterSessionRuntimeContext: requesterRuntime });
  }
  const requesterResolver = createRequesterSessionRuntimeContextResolver({ trackedSessions,
    getCreateRuntime: () => null, recoverBootstrap: async () => null });
  const acquired: unknown[] = [], released: unknown[] = [];
  if (hostedRequester) bindApiSessionSocketSequenceMock(io, [machineSocket, publisherSocket]);
  const client = new ApiMachineClient(os.credentials.token, { id: 'target-machine', encryptionMode: 'plain',
    metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, {
      ...(hostedRequester ? { requesterSessionRuntime: { serverId: configuration.activeServerId,
        resolve: async sessionId => { const context = await requesterResolver(sessionId); if (context) acquired.push(context); return context; },
        release: async context => { await releaseUnretainedRequesterSessionRuntimeContext(context,
          [...trackedSessions.values()].map(tracked => tracked.requesterSessionRuntimeContext)); released.push(context); } } } : {}),
    });
  installControlRegistrations(client);
  try {
    client.connect();
    if (hostedRequester) {
      await vi.waitFor(() => expect(installedReads).toBeGreaterThan(0));
      machineSocket.trigger('ephemeral', { type: 'session-message-reply-pending-v1', v: 1,
        sessionId: requestSessionId, requestLocalId: 'original' });
    }
    await vi.waitFor(() => expect(publicationMethods, JSON.stringify({ warnings: publicationWarnings.mock.calls,
      publisherEvents: publisherSocket.emitWithAck.mock.calls.map(([event]) => event),
      resourceReads: vi.mocked(axios.request).mock.calls.map(([request]) => ({ method: request.method, url: request.url })),
    })).toHaveLength(1));
    expect(publicationMethods).toEqual([`${requestSessionId}:discussion.agentPost.v1`]);
    await vi.waitFor(() => expect(publications, JSON.stringify({ warnings: publicationWarnings.mock.calls,
      publisherEvents: publisherSocket.emitWithAck.mock.calls.map(([event]) => event),
      resourceReads: vi.mocked(axios.request).mock.calls.map(([request]) => ({ method: request.method, url: request.url })),
    })).toHaveLength(1));
    expect(returned).toBe(true);
    if (hostedRequester) {
      expect(requesterReads).toBeGreaterThan(0);
      await Reflect.get(client, 'sessionMessageReplyRecovery')?.promise;
      expect(acquired).toEqual([requesterRuntime]);
      expect(released).toEqual([requesterRuntime]);
      requesterCurrent = false;
      returned = false;
      const beforeRevocation = requesterReads;
      await client.requestSessionMessageReplyRecoveryForSession(requestSessionId);
      expect(requesterReads).toBe(beforeRevocation);
      expect(publications).toHaveLength(1);
      expect(returned).toBe(false);
      requesterCurrent = true;
      await requesterRuntime!.dispose();
      const before = installedReads, priorRequesterReads = requesterReads;
      returned = false;
      machineSocket.trigger('ephemeral', { type: 'session-message-reply-pending-v1', v: 1,
        sessionId: requestSessionId, requestLocalId: 'original' });
      await vi.waitFor(() => expect(installedReads).toBeGreaterThan(before));
      expect(requesterReads).toBe(priorRequesterReads);
      expect(publications).toHaveLength(1);
      expect(returned).toBe(false);
    }
  } finally {
    await client.shutdown();
  }
});

it('rejoins a lost return receipt after daemon restart and observes hints without a Session publisher', async () => {
  vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
  const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
  os.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
  os.credentials = { token: 'owner-token', encryption: null };
  const requestSessionId = 'c' + '2'.repeat(24);
  const sourceSessionId = 'c' + '3'.repeat(24);
  let disposition: 'return_pending' | 'returned' = 'return_pending';
  const progress = () => ({ v: 1, mode: 'return', disposition, acceptedTurnId: 'accepted-turn',
    sourceSession: { sourceSessionId, sourceTurnId: 'source-turn', via: 'action' }, outcome: { kind: 'pass' } });
  const admitted: string[] = [];
  const mutations: unknown[] = [];
  let lostReceipt = true;
  let reads = 0;
  let stateVersion = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) {
      reads++;
      return { status: 200, data: { v: 1, entries: disposition === 'return_pending'
        ? [{ requestSessionId, requestLocalId: 'original', progress: progress() }] : [], nextAfter: null } };
    }
    if (url.endsWith('/by-local-id/original/reply')) return { status: 200, data: { v: 1, status: 'available', progress: progress() } };
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.includes(`/v2/sessions/${sourceSessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sourceSessionId, encryptionMode: 'plain', active: true, metadata: JSON.stringify({ machineId: 'source-machine', path: '/repo' }),
    }) } };
    return { status: 200, data: { id: 'owner', settings: null, settingsVersion: 0 } };
  });
  const answer = (event: string, raw: unknown) => {
    if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { v: 1, result: 'success', revision: 1 };
    if (event === 'machine-update-state') return { result: 'success', version: ++stateVersion,
      daemonState: (raw as { daemonState: string }).daemonState };
    if (event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) {
      const request = raw as { localId: string };
      admitted.push(request.localId);
      return { v: 1, result: { status: 'accepted', localId: request.localId } };
    }
    if (event === SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1) {
      const request = SessionMessageReplyMachineMutationV1Schema.parse(raw);
      mutations.push(request);
      if (lostReceipt) { lostReceipt = false; throw new Error('lost_return_receipt'); }
      disposition = 'returned';
      return { v: 1, ok: true, progress: progress() };
    }
    return { result: 'success', version: 1 };
  };
  const initialSocket = createApiSessionSocketStub({ emitWithAck: answer });
  const socket = createApiSessionSocketStub({ id: 'restarted', emitWithAck: answer });
  bindApiSessionSocketSequenceMock(io, [initialSocket, socket]);
  const createClient = () => {
    const client = new ApiMachineClient('owner-token', { id: 'target-machine', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    installControlRegistrations(client);
    return client;
  };
  let client = createClient();
  try {
    client.connect();
    await vi.waitFor(() => expect(initialSocket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)).toBe(true));
    initialSocket.trigger('ephemeral', { type: 'session-message-reply-pending-v1', v: 1,
      sessionId: requestSessionId, requestLocalId: 'original' });
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toBe(0);
    acknowledgeRegistrations(initialSocket);
    await vi.waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ machineId: 'target-machine', requestSessionId, requestLocalId: 'original',
      operation: { kind: 'returned', returnedInputLocalId: admitted[0] } });
    await client.shutdown();
    client = createClient();
    client.connect();
    await vi.waitFor(() => expect(socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)).toBe(true));
    acknowledgeRegistrations(socket);
    await vi.waitFor(() => expect(mutations).toHaveLength(2));
    expect(admitted).toHaveLength(2);
    expect(admitted[1]).toBe(admitted[0]);
    const capabilities = socket.emitWithAck.mock.calls.filter(([event]) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1)
      .map(([, payload]) => MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload).capabilities);
    expect(capabilities.some(value => value.sessionMessageReply?.protocolVersions.includes(1))).toBe(true);
    const startupReads = reads;
    socket.trigger('ephemeral', { type: 'session-message-reply-pending-v1', v: 1, sessionId: requestSessionId, requestLocalId: 'original' });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(startupReads));
    expect(admitted).toHaveLength(2);
    os.credentials = { token: 'replacement-token', encryption: null };
    const currentReads = reads;
    disposition = 'return_pending';
    socket.trigger('ephemeral', { type: 'session-message-reply-pending-v1', v: 1, sessionId: requestSessionId, requestLocalId: 'original' });
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toBe(currentReads);
    expect(admitted).toHaveLength(2);
  } finally { await client.shutdown(); }
});

it('keeps ordinary Machine publication usable when an older Home has no reply inventory', async () => {
  vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
  const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
  os.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
  os.credentials = { token: 'owner-token', encryption: null };
  let inventories = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.includes('/session-message-replies/pending')) { inventories++; return { status: 404, data: {} }; }
    return { status: 200, data: { id: 'owner', settings: null, settingsVersion: 0 } };
  });
  const socket = createApiSessionSocketStub({ emit: acknowledgeRegistration, emitWithAck: (event, raw) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1
    ? { v: 1, result: 'success', revision: 1 } : { result: 'success', version: 1, daemonState: (raw as { daemonState: string }).daemonState } });
  bindApiSessionSocketSequenceMock(io, [socket]);
  const client = new ApiMachineClient('owner-token', { id: 'target-machine', encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  installControlRegistrations(client);
  try {
    client.connect();
    await vi.waitFor(() => expect(inventories).toBe(1));
    await new Promise(resolve => setImmediate(resolve));
    const publications = socket.emitWithAck.mock.calls.filter(([event]) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1)
      .map(([, payload]) => MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload).capabilities);
    expect(publications.length).toBeGreaterThan(0);
    expect(publications.every(value => value.sessionMessageReply === undefined)).toBe(true);
    expect(socket.connected).toBe(true);
    expect(socket.emitWithAck.mock.calls.some(([event]) => event === SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)).toBe(false);
  } finally { await client.shutdown(); }
});

it('aborts an in-flight custody read on shutdown and ignores its late response', async () => {
  vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
  const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
  os.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
  os.credentials = { token: 'owner-token', encryption: null };
  let pendingSignal: Readonly<{ aborted: boolean }> | undefined;
  let finishRead: () => void = () => { throw new Error('Inventory read did not start'); };
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    if (url.includes('/session-message-replies/pending')) {
      pendingSignal = options?.signal;
      return new Promise<{ status: number; data: { v: 1; entries: never[]; nextAfter: null } }>(resolve => {
        finishRead = () => resolve({ status: 200, data: { v: 1, entries: [], nextAfter: null } });
      });
    }
    return { status: 200, data: { id: 'owner', settings: null, settingsVersion: 0 } };
  });
  const socket = createApiSessionSocketStub({ emit: acknowledgeRegistration, emitWithAck: (event, raw) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1
    ? { v: 1, result: 'success', revision: 1 } : { result: 'success', version: 1, daemonState: (raw as { daemonState: string }).daemonState } });
  bindApiSessionSocketSequenceMock(io, [socket]);
  const client = new ApiMachineClient('owner-token', { id: 'target-machine', encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  installControlRegistrations(client);
  let stopped = false;
  try {
    client.connect();
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    await client.shutdown();
    stopped = true;
    expect(pendingSignal?.aborted).toBe(true);
    finishRead();
    await new Promise(resolve => setImmediate(resolve));
    const publications = socket.emitWithAck.mock.calls.filter(([event]) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1)
      .map(([, payload]) => MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload).capabilities);
    expect(publications.every(value => value.sessionMessageReply === undefined)).toBe(true);
  } finally { finishRead(); if (!stopped) await client.shutdown(); }
});
