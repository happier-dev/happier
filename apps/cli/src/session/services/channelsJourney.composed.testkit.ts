import axios from 'axios';
import { expect, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  AccountEncryptionCurrentnessResponseSchema, V2SessionByIdResponseSchema, SessionOwnerMetadataV1Schema,
  createPlainSessionOwnerMetadataEnvelopeV1, FeaturesResponseSchema, accountSettingsParse,
  SessionInputRequestV1Schema, SessionMessageProvenanceV1Schema, settleSessionInputRequestV1,
  settleSessionMessageProvenanceV1, withSessionInputAuthorityV1,
  type SessionPendingEnqueueByMachineRequestV1, type SessionPendingExecutionRunEnqueueByMachineRequestV2,
  SessionTurnV1Schema, type SessionTurnV1,
} from '@happier-dev/protocol';
import {
  ConversationPollResultV1Schema, ConversationDeliveryInputV1Schema, ConversationProvidersContributionProtocolV1,
  type ConversationObservationV1, type ConversationDeliveryInputV1, ConversationBindingTargetV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture } from '@happier-dev/channels-protocol/testing/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createCliActionExecutorHarness } from '../actions/createCliActionExecutorHarness';
import { executePluginSessionMessageAction } from './executePluginSessionMessageAction';
import { createPluginSessionsInventory, type PluginSessionsInventoryParams } from './pluginSessionsInventory';
import { projectExternalShareableTranscriptPage } from './transcript/projectExternalShareableTranscriptPage';
import { createChannelsJourneyFixture } from '../../../../../packages/plugins/channels/src/testkit/channelsJourney';
import { createCurrentConversationConnectionFixture } from '../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from '../../../../../packages/plugins/channels/src/collections';
import { CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from '../../../../../packages/plugins/channels/src/manifest';
import { CHANNEL_FILE_ATTACHMENT_RUNTIME } from '../../../../../packages/plugins/channels/src/channelAttachmentRuntime';
import { createConversationSessionProjectionFrontierRow } from '../../../../../packages/plugins/channels/src/sessionProjection';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { registerPrivateSpawnSessionRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTargetComposerAttachmentRegistry } from '@/plugins/runtime/lifecycle/contributions/targetComposerAttachments';
import { SessionExternalShareableMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { createStablePluginSettingsHost, type StablePluginSettingsRecordStore } from '@/plugins/runtime/invocation/services/settings';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';

const pluginId = 'test.channel.journey';
const policy = { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } as const;
const endpoint = { kind: 'direct', audience: 'direct', id: 'mailbox' } as const;
const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
  signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

export async function createCliChannelsJourney(input: {
  machineId?: string;
  sessionId?: string;
  machineAdmissionTransport?: Parameters<typeof createCliActionExecutorHarness>[0]['machineAdmissionTransport'];
  settingsRecordStore?: StablePluginSettingsRecordStore;
  router?: boolean; socket?: boolean; wrongDelivery?: boolean; wrongSessionCaller?: boolean;
  ambiguousStart?: boolean; failedBirth?: boolean; refuseSecondCreation?: boolean;
} = {}) {
  const machineId = input.machineId ?? 'machine-1';
  const sessionId = input.sessionId ?? 'session-journey-1';
  const providerMaterialization = { pluginId, machineId, materializationId: 'journey-provider' };
  const channelMaterialization = { pluginId: 'happier.channels', machineId, materializationId: 'journey-core' };
  const pending: ConversationObservationV1[] = [];
  const delivered: ConversationDeliveryInputV1[] = [];
  const roles = ConversationProvidersContributionProtocolV1.operations;
  const definition = definePlugin({ id: pluginId, version: '0.0.0', actions: {
    setup: { title: 'Set up fixture provider', surfaces: roles.setup.declaration.surfaces, dangerLevel: roles.setup.declaration.dangerLevel,
      inputSchema: { type: 'object' }, resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
      run: async () => createConversationProviderSetupResultV1Fixture() },
    inspect: { title: 'Inspect fixture provider', surfaces: roles.connectionTest.declaration.surfaces,
      dangerLevel: roles.connectionTest.declaration.dangerLevel, inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema, run: async () => ({ kind: 'notReady', reason: 'network' }) },
    poll: { title: 'Poll fixture provider', surfaces: roles.observationsPoll.declaration.surfaces,
      dangerLevel: roles.observationsPoll.declaration.dangerLevel, inputSchema: roles.observationsPoll.declaration.input.schema.jsonSchema,
      resultSchema: roles.observationsPoll.declaration.resultSchema.jsonSchema,
      run: async request => {
        const batch = roles.observationsPoll.declaration.input.schema.parse(request).checkpoint === null ? [] : pending.splice(0);
        return ConversationPollResultV1Schema.parse(batch.length === 0
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: Date.now() } }
          : { kind: 'batch', observations: batch.map(observed => ({ observation: { kind: 'fullText', observation: observed }, eventCandidate: null })),
            checkpointAfterBatch: { cursor: Date.now() } });
      } },
    deliver: { title: 'Deliver fixture provider', surfaces: roles.messageDeliver.declaration.surfaces,
      dangerLevel: roles.messageDeliver.declaration.dangerLevel, inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema,
      run: async request => {
        if (input.wrongDelivery) roles.connectionTest.declaration.input.schema.parse(request);
        const value = ConversationDeliveryInputV1Schema.parse(request);
        delivered.push(value);
        if (value.newThread && input.ambiguousStart) return { kind: 'outcomeUnknown' };
        return { kind: 'delivered', providerMessageIds: [`receipt-${delivered.length}`],
          ...(value.newThread ? { endpoint: { kind: 'thread', audience: 'direct', id: 'thread-1', parentId: endpoint.id } } : {}) };
      } },
  }, contributesTo: { 'happier.channels': { providers: { fixture: ConversationProvidersContributionProtocolV1.contribute({ descriptor: { v: 1, displayName: 'Journey provider' }, operations: {
    setup: roles.setup.bind('setup'), connectionTest: roles.connectionTest.bind('inspect'), observationsPoll: roles.observationsPoll.bind('poll'),
    messageDeliver: roles.messageDeliver.bind('deliver'),
  } }) } } } });
  const provider = await createPluginTestkit({ manifest: definition.manifest, module: definition,
    resolveCurrentPluginMaterializationRef: () => providerMaterialization });
  const sessions = new Map<string, ReturnType<typeof V2SessionByIdResponseSchema.parse>['session']>();
  const rows: Parameters<typeof projectExternalShareableTranscriptPage>[0]['rows'][number][] = [];
  const rowSessions = new Map<unknown, string>();
  const turns: SessionTurnV1[] = [];
  const admissions: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
  const creations = new Map<string, string>();
  let refusedCreation = false;
  function addSession(id: string, attestedContext?: { externalPrincipalId: string; sourceMessageId: string }) {
    const session = V2SessionByIdResponseSchema.parse({ session: { id, seq: 0, createdAt: 1, updatedAt: 2,
      active: true, activeAt: 2, encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }), metadataVersion: 1, metadataLayoutVersion: 1,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1,
        workspace: { path: '/repo/channels', host: 'fixture', machineId: machineId }, system: attestedContext ? { attestedContext } : {} })),
      dataEncryptionKey: null, share: null, agentState: null, agentStateVersion: 1 } }).session;
    sessions.set(id, session);
    return session;
  }
  addSession(sessionId);
  const spawnRequests: ReturnType<typeof SpawnDaemonSessionRequestSchema.parse>[] = [];
  const transcriptPages: unknown[] = [];
  const diagnostics: unknown[] = [];
  const rpcRequests: string[] = [];
  const rpcBoundary = vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async request => {
    rpcRequests.push(request.method);
    if (!request.method.endsWith(':abort')) throw new Error(`Unexpected Session RPC ${request.method}`);
    // Native abort handlers acknowledge delivery without an application result.
    // The canonical CLI cancellation owner must project this acknowledgement.
    return undefined;
  });
  resetServerFeaturesClientForTests();
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
    capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })),
  { status: 200, headers: { 'content-type': 'application/json' } }));
  // HTTP and authenticated machine transport are genuine process boundaries.
  // The Session handle, Action adapter/executor, admission envelope and
  // transcript producer beneath these boundaries are the production owners.
  const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
    const messages = new URL(String(url));
    const messageSessionId = decodeURIComponent(messages.pathname.split('/')[3] ?? '');
    const sessionRows = rows.filter(row => rowSessions.get(row.id) === messageSessionId);
    if (messages.pathname.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (messages.pathname.includes('/messages/by-local-id/')) {
      const localId = decodeURIComponent(messages.pathname.split('/').at(-1)!);
      const message = sessionRows.find(row => row.localId === localId);
      if (!message) throw new axios.AxiosError('Message not found', 'ERR_BAD_REQUEST', undefined, undefined,
        { status: 404, statusText: 'Not Found', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: { error: 'Message not found' } });
      return { status: 200, data: { message: { ...message, updatedAt: message.createdAt } } };
    }
    if (messages.pathname.endsWith('/messages')) {
      const afterSeq = Number(messages.searchParams.get('afterSeq') ?? 0);
      return { status: 200, data: SessionExternalShareableMessagesPageV1Schema.parse({ messages: sessionRows.filter(row => Number(row.seq) > afterSeq), hasMore: false,
        externalShareableSnapshot: { turns, referencedUserRows: sessionRows.filter(row => row.messageRole === 'user')
          .map(({ sidechainId: _sidechainId, ...row }) => ({ ...row, updatedAt: row.createdAt })) } }) };
    }
    const id = [...sessions.keys()].find(candidate => String(url).includes(`/v2/sessions/${candidate}`));
    if (id) return { status: 200, data: { session: sessions.get(id) } };
    if (String(url).includes('/v1/access-keys/')) return { status: 200, data: { accessKey: 'existing' } };
    throw new Error(`Unexpected HTTP read ${String(url)}`);
  });
  // This boundary stores the real creator's row and indexes its tag. It does
  // not derive a creation identity, recipe, attestation or rejoin decision.
  const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const request = record(body ?? {});
    if (String(url).endsWith('/lookup-by-tags')) {
      const tags = Array.isArray(request.tags) ? request.tags : [];
      return { status: 200, data: { sessions: tags.flatMap(tag => {
        const id = creations.get(String(tag));
        return id ? [sessions.get(id)] : [];
      }) } };
    }
    if (String(url).endsWith('/v1/sessions')) {
      const tag = String(request.tag);
      if (input.refuseSecondCreation && creations.size === 1 && !refusedCreation) {
        refusedCreation = true;
        return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
      }
      const existingId = creations.get(tag);
      if (existingId) return { status: 200, data: { session: sessions.get(existingId), created: false } };
      const id = `session-born-${creations.size + 1}`;
      const shared = record(request.sharedMetadata);
      const created = V2SessionByIdResponseSchema.parse({ session: { ...addSession(id),
        active: false, metadata: shared.ciphertext, ownerMetadata: request.ownerMetadata } }).session;
      sessions.set(id, created); creations.set(tag, id);
      return { status: 200, data: { session: created, created: true } };
    }
    const id = [...sessions.keys()].find(candidate => String(url).includes(`/sessions/${candidate}/unarchive`));
    if (id) {
      const session = sessions.get(id)!;
      sessions.set(id, { ...session, archivedAt: null });
      return { status: 200, data: { success: true, archivedAt: null } };
    }
    throw new Error(`Unexpected HTTP write ${String(url)}`);
  });
  // The OS launch acknowledgement is the boundary. The private RPC settlement
  // remains real, including its advertised fresh-create outcome requirement.
  const privateSpawnHandlers = new Map<string, RpcHandler>();
  registerPrivateSpawnSessionRpcHandlers({
    rpcHandlerManager: { registerHandler(method, handler) { privateSpawnHandlers.set(method, handler); } },
    requireSessionCreationOutcome: true,
    spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({ spawnSession: async request => {
      if (!request.existingSessionId || !sessions.has(request.existingSessionId)) throw new Error('Expected committed Session');
      // Native initialization may fail after process-launch acknowledgement.
      if (input.failedBirth) return { type: 'success', sessionId: request.existingSessionId };
      const session = sessions.get(request.existingSessionId)!;
      sessions.set(session.id, { ...session, active: true, activeAt: Date.now() });
      return { type: 'success', sessionId: request.existingSessionId };
    } }),
  });
  let attachments: ReturnType<typeof createTargetComposerAttachmentRegistry> | undefined;
  const { executor } = createCliActionExecutorHarness({ token: 'journey-token', credentials: { token: 'journey-token', encryption: null },
    sessionId: sessionId, mode: 'plain', ctx: null, rawSession: {}, serverId: 'server-1', serverHttpBaseUrl: 'https://channels-home.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}) }),
    resolveComposerAttachmentSendPreparation: () => attachments ?? null,
    sessionSpawnDirectTargetTransport: { machineId: machineId,
      prepare: async () => ({ ok: true, directory: '/repo/channels', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
      spawnedSession: { spawn: async raw => {
        const request = SpawnDaemonSessionRequestSchema.parse(raw);
        spawnRequests.push(request);
        if (!request.existingSessionId || !sessions.has(request.existingSessionId)) throw new Error('Spawn must reach the real committed Session');
        return await privateSpawnHandlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)!(request);
      }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
    machineAdmissionTransport: async request => {
      const repeated = admissions.find(previous => previous.localId === request.localId);
      if (repeated) return { status: 'alreadyAccepted', localId: request.localId };
      admissions.push(request);
      if (input.machineAdmissionTransport) return await input.machineAdmissionTransport(request);
      if (request.content.t !== 'plain') throw new Error('Expected a plain fixture Account');
      const body = record(request.content.v);
      const meta = record(body.meta);
      const protectedRequest = SessionInputRequestV1Schema.parse(meta.happierInputRequestV1);
      const receipt = { v: 1, issuer: 'authenticatedMachine' };
      const authority = settleSessionInputRequestV1({ request: protectedRequest, currentSessionPermissionCeiling: 'read-only', inputAdmissionReceipt: receipt });
      const provenance = settleSessionMessageProvenanceV1({ request: protectedRequest,
        requestedProvenance: SessionMessageProvenanceV1Schema.parse(meta.happierProvenanceV1), inputAdmissionReceipt: receipt });
      rows.push({ id: `user-${rows.length + 1}`, seq: rows.length + 1, localId: request.localId, createdAt: Date.now(),
        messageRole: 'user', sidechainId: null, externalShareableActor: 'machine',
        content: { t: 'plain', v: { ...body, meta: { ...withSessionInputAuthorityV1(meta, authority), happierProvenanceV1: provenance } } } });
      rowSessions.set(rows.at(-1)!.id, request.sessionId);
      return { status: 'accepted', localId: request.localId };
    } });
  const unavailable = async (): Promise<never> => { throw new Error('This journey does not use external Session or system record boundaries'); };
  let activeCore: Awaited<ReturnType<typeof createChannelsJourneyFixture>> | undefined;
  const currentCore = () => {
    if (!activeCore) throw new Error('The Channels occurrence is unavailable');
    return activeCore.kit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF);
  };
  const isCoreCurrent = () => { try { currentCore(); return true; } catch { return false; } };
  const parsedChannels = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsedChannels.ok) throw new Error('Expected current Channels declarations');
  const settings = input.settingsRecordStore ? createStablePluginSettingsHost({
    declarations: parsedChannels.manifest.contributes.settings.map(contribution => ({ pluginId: 'happier.channels', contribution })),
    recordStore: input.settingsRecordStore, broker: createStablePluginEventsBroker(),
    onPluginSettingsUnavailable: ({ error }) => { throw error; },
  }).bind({ plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: { id: 'journey/poll', qualifiedId: 'happier.channels/actions/journey/poll' },
    get occurrenceId() { return currentCore().occurrenceId; }, get sourceCustody() { return currentCore().sourceCustody; },
    correlationId: 'journey-settings', surface: 'background', signal: new AbortController().signal, isOccurrenceCurrent: isCoreCurrent,
  }) : null;
  const inventory = createPluginSessionsInventory({ credentials: { token: 'journey-token', encryption: null }, signal: new AbortController().signal,
    currentSessionId: null, sessionScopes: [{ access: ['read', 'write'] }], isCurrent: isCoreCurrent,
    readStoragePolicy: async () => 'optional', readAccountEncryptionCurrentness: async () => currentness,
    fetchById: async ({ sessionId }) => sessions.get(sessionId) ?? null,
    external: { capabilities: unavailable, list: unavailable, closeList: unavailable, attach: unavailable,
      readTranscript: unavailable, followTranscript: unavailable, takeover: unavailable },
    createHandleCapabilities: () => ({ listSystemRecords: unavailable, upsertSystemRecord: unavailable,
      readSystemRecord: unavailable, deleteSystemRecord: unavailable }),
    executeMessageAction: params => executePluginSessionMessageAction({ ...params, execute: executor.execute,
      pluginId: input.wrongSessionCaller ? '' : 'happier.channels', contributionLocalId: 'journey/poll',
      occurrenceId: currentCore().occurrenceId, sourceCustody: currentCore().sourceCustody,
      resolveCallerMaterialization: () => channelMaterialization }),
  } satisfies PluginSessionsInventoryParams);
  const actions = createPluginInvocationActionsService({ seed: {
    plugin: { id: 'happier.channels', version: '0.0.0' }, contribution: { id: 'journey/poll', qualifiedId: 'happier.channels/actions/journey/poll' },
    get occurrenceId() { return currentCore().occurrenceId; }, get sourceCustody() { return currentCore().sourceCustody; }, surface: 'background',
    signal: new AbortController().signal, isOccurrenceCurrent: isCoreCurrent, resolveCurrentPluginMaterializationRef: () => channelMaterialization,
  }, actionExecutor: { async execute(action, value, context) {
    const result = await executor.execute(action, value, context);
    if (action === 'session.transcript.get') transcriptPages.push(result.ok ? result.result : result);
    return result;
  } }, invokeContributedAction: unavailable });
  const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1',
    ...(input.socket ? { transport: { kind: 'socket' as const }, replayContinuity: 'sessionBound' as const } : {}), authority: {
    providerPluginId: pluginId, providerContributionSelection: { contributionId: 'fixture' }, providerSetupInput: {}, credentialRef: null,
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: providerMaterialization },
    providerConnectionKey: 'fixture:provider', providerConfig: {}, integrationPrincipal: { id: 'fixture:integration' },
    routingIdentityKey: 'r'.repeat(43), authorityEpoch: 1 } });
  const binding = { id: 'binding-1', 'record-kind': 'binding', v: 1, 'connection-id': connection.id, 'binding-id': 'binding-1',
    'created-at': 1, 'updated-at': 1, payload: { endpoint, authorityEpoch: 1, enabled: true, deletionState: 'none',
      target: ConversationBindingTargetV1Schema.parse(input.router ? { kind: 'threadRouter', principalGroups: [{ id: 'brief', principalIds: ['sender-1'] }], routes: [{ id: 'intake',
        when: { group: 'brief', forwarded: 'any' }, policy, recipe: { executionTarget: { serverId: 'server-1', machineId: machineId },
          directory: { kind: 'path', path: '/repo/channels' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
          connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
          ...(input.failedBirth ? { permissionMode: 'read-only', allowedTools: [], unlistedTools: 'deny',
            configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'recipe-model', updatedAtMs: 1 },
              permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} } } : {}) } }] }
        : { kind: 'session', sessionId: sessionId, policy }), allowedPrincipalIds: ['sender-1'], allowBotSenders: false,
      inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off' } };
  const core = await createChannelsJourneyFixture({ provider, connection, binding, sessions: inventory, actions,
    ...(settings ? { settings } : {}),
    logger: { debug() {}, info: (_message, fields) => { diagnostics.push(fields); },
      warn: (_message, fields) => { diagnostics.push(fields); }, error() {}, diagnostic() {} },
    resolveCurrentProviderExecutionOrigin: () => ({ serverIdentityId: 'srv_plugin_testkit', materializationRef: providerMaterialization }),
    resolveCurrentPluginMaterializationRef: () => channelMaterialization }).catch(async error => {
      await provider.dispose(); http.mockRestore(); writes.mockRestore(); rpcBoundary.mockRestore();
      vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
      throw error;
    });
  activeCore = core;
  attachments = createTargetComposerAttachmentRegistry({
    declaredAttachments: (PLUGIN_MANIFEST.contributes?.composerAttachments ?? []).map(declaration => ({
      ...declaration, attachment: { pluginId: 'happier.channels', localId: declaration.id },
    })),
    targetRegistrations: [{ pluginId: 'happier.channels', occurrenceId: currentCore().occurrenceId,
      registration: { family: 'composerAttachments', localId: 'channel-file', value: CHANNEL_FILE_ATTACHMENT_RUNTIME } }],
    resolveOccurrenceLifecycle: () => ({ isCurrent: isCoreCurrent, retirementSignal: new AbortController().signal }),
    activateAttachmentOnDemand: async () => {},
    createInvocationContext: () => { throw new Error('Channel-file has no admission-phase callback'); },
  });
  if (!input.router) await core.state.put(createConversationSessionProjectionFrontierRow({ bindingId: binding.id,
    targetSessionId: sessionId, transcriptCursor: null, lastScannedSeq: 0, revision: 1, now: Date.now() }), { expectedRevision: 'absent' });
  function answer(text: string) {
    const user = rows.at(-1);
    if (!user) throw new Error('Answer requires an admitted input');
    const seq = rows.length + 1;
    rows.push({ id: `answer-${seq}`, seq, localId: null, createdAt: Date.now(), messageRole: 'agent', sidechainId: null,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text } } } });
    rowSessions.set(rows.at(-1)!.id, rowSessions.get(user.id)!);
    turns.push(SessionTurnV1Schema.parse({ turnId: `turn-${seq}`, status: 'completed', startedAt: 1, updatedAt: 2,
      transcriptAnchors: { startSeqInclusive: Number(user.seq), endSeqInclusive: seq, userMessageSeqs: [Number(user.seq)], finalAssistantMessageSeq: seq } }));
  }
  function validateWrites() {
    for (const [collection, schema] of [[core.state, CHANNEL_STATE_COLLECTION.schema], [core.deliveries, CHANNEL_DELIVERIES_COLLECTION.schema]] as const) {
      const compiled = compilePluginJsonSchema(schema);
      for (const row of collection.rows.values()) expect(isValidPluginJsonSchemaValue(compiled, row.value), row.rowId).toBe(true);
    }
  }
  return { ...core, pending, delivered, admissions, sessions, inventory, creations, spawnRequests, transcriptPages, diagnostics, answer, validateWrites, rpcRequests,
    async dispose() { await core.dispose(); await provider.dispose(); http.mockRestore(); writes.mockRestore(); rpcBoundary.mockRestore();
      activeCore = undefined;
      vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); } };
}

