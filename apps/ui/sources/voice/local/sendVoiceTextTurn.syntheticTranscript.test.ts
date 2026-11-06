import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, createSessionMessagesFixture } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { t } from '@/text';
import { z } from 'zod/mini';
import { parseVoiceToolResultsFollowUp } from '@happier-dev/protocol/voice/toolResultsChannel';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { serveAccountHomes, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { writeVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { readStoredSessionMessages, type Message } from '@happier-dev/session-core/messages';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { readCanonicalVoiceTranscriptSnapshot } from '@/voice/transcript/voiceConversationTranscript';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunUserTranscriptCommitRequestSchema,
  ExecutionRunUserTranscriptCommitResponseSchema, type ExecutionRunTurnStreamEvent } from '@happier-dev/protocol/execution/runs/streaming';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { SpeechOptions } from 'expo-speech';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { NotificationChannelCatalogRecordV1Schema, NotificationChannelCatalogMutationV1Schema,
  NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

const conversationModeState: { current: 'agent' | 'direct_session' } = { current: 'agent' };
const speech = vi.hoisted(() => ({ speak: vi.fn<(text: string, options: SpeechOptions) => void>(), stop: vi.fn() }));
// The OS speech engine is the external boundary; admission, storage and playback stay real.
vi.mock('expo-speech', () => speech);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
let retainedAgent: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
installDisconnectedServerSocketBoundary(socket => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Expected canonical Voice RPC');
    const method = payload.method.slice(payload.method.indexOf(':') + 1);
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
      const resume = SessionResumeRequestV1Schema.parse(payload.params);
      expect(payload.method.slice(0, payload.method.indexOf(':'))).toBe('machine-1');
      expect(resume).toMatchObject({ type: 'resume-session',
        sessionId: conversationModeState.current === 'direct_session' ? 's1' : 'carrier-s1', directory: '/workspace/s1' });
      return { ok: true, result: { type: 'success', sessionId: resume.sessionId } };
    }
    return { ok: true, result: await retainedAgent.dispatch(method, payload.params) };
  });
});

await loadSyncSingletonForTests();
const restoreActionLoader = await installRealActionExecutorModuleLoader();
afterAll(() => restoreActionLoader());
const { storage } = await import('@/sync/domains/state/storage');
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const sessionMetadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
let account: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
const events: string[] = [];
const approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let directPendingEntered = createDeferred<void>();
type TurnReply = { assistantText: string; actions: VoiceAssistantAction[]; speechSegments?: string[] };
let turnReplies: (index: number, message: string) => TurnReply = () => ({ assistantText: 'Done.', actions: [] });
let turnIndex = 0;
let rejectStart = false;
let webhookCatalog = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [] });
let webhookRevision = 1;
const repliesByStream = new Map<string, TurnReply>();
async function answerVoiceAgentRpc(method: string, input: unknown): Promise<unknown> {
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1) {
    ExecutionRunUserTranscriptCommitRequestSchema.parse(input);
    return ExecutionRunUserTranscriptCommitResponseSchema.parse({ ok: true });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
    const request = ExecutionRunTurnStreamStartV2RequestSchema.parse(input);
    const streamId = 'transcript-turn-' + turnIndex;
    const admission = pendingWrites()[0]?.body;
    if (!admission || typeof admission !== 'object' || !('localId' in admission)) throw new Error('Dispatch preceded durable admission');
    if (turnIndex === 0) events.push('dispatch:' + admission.localId);
    if (rejectStart) return { error: 'send_failed' };
    if (turnIndex === 0) {
      const admitted = pendingRecords()[0];
      expect(admitted?.content.type).toBe('text');
      if (admitted?.content.type === 'text') expect(request.displayMessage ?? request.message).toBe(admitted.content.text);
    }
    repliesByStream.set(streamId, turnReplies(turnIndex++, request.message));
    return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
    const request = ExecutionRunTurnStreamReadRequestSchema.parse(input);
    const reply = repliesByStream.get(request.streamId);
    if (!reply) throw new Error('Unknown transcript stream');
    const outputs: ExecutionRunTurnStreamEvent[] = (reply.speechSegments ?? []).map((text, index) => ({
      t: 'voice_output', output: { v: 1, kind: 'speech_segment', turnId: request.streamId, seq: index,
        segmentId: `${request.streamId}:speech:${index}`, text },
    }));
    const effectOffset = outputs.length;
    outputs.push(...reply.actions.map((action, index): ExecutionRunTurnStreamEvent => ({
      t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: request.streamId, seq: effectOffset + index,
        effectId: `${request.streamId}:effect:${index}`, action },
    })));
    outputs.push({ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: request.streamId,
      seq: outputs.length, text: reply.assistantText } });
    return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: request.streamId,
      events: request.cursor === 0 ? outputs : [], nextCursor: outputs.length, done: true });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true });
  throw new Error('Unexpected Voice daemon method: ' + method);
}
function pendingWrites(sessionId = 'carrier-s1') {
  return account.requests.filter(request => request.method === 'POST' && request.path === `/v2/sessions/${sessionId}/pending`);
}
function pendingRecords(sessionId = 'carrier-s1') {
  return pendingWrites(sessionId).map(request => {
    if (!request.body || typeof request.body !== 'object' || !('content' in request.body)) throw new Error('Expected canonical pending content');
    const content = StrictSessionStoredMessageContentEnvelopeSchema.parse(request.body.content);
    if (content.t !== 'plain') throw new Error('Expected plain Account content');
    return RawRecordSchema.parse(content.v);
  });
}
function expectNoSyntheticTranscript() {
  expect(readCanonicalVoiceTranscriptSnapshot('carrier-s1')).toEqual([]);
  expect(readStoredSessionMessages(storage.getState(), 'carrier-s1')).toEqual([]);
}

function buildAccountSettings() {
  return settingsParse({
    ...settingsDefaults,
    ...normalizeVoiceSettingsLocalDelta({
    experiments: true,
    featureToggles: {
      ...settingsDefaults.featureToggles,
      voice: true, 'voice.agent': true, 'execution.runs': true,
    },
    voice: {
      ...settingsDefaults.voice,
      providerId: 'local_conversation',
      executionMachine: { mode: 'fixed', machineId: 'machine-1' },
      providers: {
        ...settingsDefaults.voice.providers,
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: conversationModeState.current,
            agent: { agentSource: 'session', prewarmOnConnect: false },
            tts: { autoSpeakReplies: false },
            streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 120 },
          },
        },
      },
    },
    }),
  });
}

async function loadSendVoiceTextTurnWithProductionBinding() {
  const [
    { createLocalConversationVoiceAdapter },
    { registerVoiceAdapters, resetVoiceAdapterRegistryForTests },
    { voiceSessionBindingManager },
    { voiceSessionBindingStore },
    localVoiceTextTurn,
  ] = await Promise.all([
    import('@/voice/adapters/localConversation/localConversationAdapter'),
    import('@/voice/session/voiceAdapterRegistry'),
    import('@/voice/binding/voiceConversationBindingRuntime'),
    import('@/voice/binding/voiceConversationBindingStore'),
    import('./sendVoiceTextTurn'),
  ]);

  resetVoiceAdapterRegistryForTests();
  registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
  for (const binding of voiceSessionBindingManager.list()) {
    voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
  }
  const binding = await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    requestedTargetSessionId: 's1',
  });
  expect(binding).toMatchObject({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    conversationSessionId: 'carrier-s1',
    transcriptMode: 'native_session',
    targetSessionAddress: { serverId: account.homes.voice!.id, sessionId: 's1' },
  });
  await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
  expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
  return localVoiceTextTurn;
}

describe('sendVoiceTextTurn native-session transcript ownership', () => {
  beforeEach(async () => {
    conversationModeState.current = 'agent';
    events.length = 0;
    approvalArtifacts.clear();
    directPendingEntered = createDeferred<void>();
    turnIndex = 0;
    rejectStart = false;
    turnReplies = () => ({ assistantText: 'I found Claude and Codex.', actions: [] });
    repliesByStream.clear();
    webhookRevision = 1;
    webhookCatalog = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1,
      id: 'deployment-webhook', kind: 'webhook', url: 'https://deployment-hook.test/notify', enabled: true,
      topics: {}, readyIncludeMessageText: false, requestIncludeMessageText: false, signingSecretRef: null }] });
    retainedAgent = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: answerVoiceAgentRpc });
    account = await serveAccountHomes({ homes: [
      { key: 'other', serverUrl: 'https://transcript-other.test', accountId: 'account-b' },
      { key: 'voice', serverUrl: 'https://transcript-voice.test', serverIdentityId: 'srv_transcript_voice', accountId: 'account-a', currentAccount: true, settings: buildAccountSettings() },
    ], route: createSessionReadBatchHttpBoundary(request => {
      if (request.path === managedMachineActionEndpointPathV1('machines.managed.list')) {
        return Response.json(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }));
      }
      if (request.path === '/v1/account/profile') return request.accountId
        ? Response.json({ ...profileDefaults, id: request.accountId })
        : Response.json({}, { status: 401 });
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
        features: { voice: { enabled: true, agent: { enabled: true } }, execution: { runs: { enabled: true } },
          machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } } },
        capabilities: { session: { pendingInput: { protocolVersion: 1 } },
          machines: { liveStream: { serverRouted: { caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null } } } },
      }));
      if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      // This Home has no target Session: do not serve the active Home's seed
      // through another Home's real scoped fetch.
      if (request.home === 'other') return undefined;
      const artifactResponse = approvalArtifacts.handle(request.path + request.url.search, { method: request.method,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      if (artifactResponse) return artifactResponse;
      if (request.path === NOTIFICATION_CHANNELS_ROUTE_V1) {
        if (request.method === 'GET') return Response.json({ status: 'present', revision: webhookRevision,
          content: { t: 'plain', v: webhookCatalog } });
        if (request.method === 'POST') {
          const mutation = NotificationChannelCatalogMutationV1Schema.parse(request.body);
          expect(mutation.expectedRevision).toBe(webhookRevision);
          if (mutation.content?.t !== 'plain') throw new Error('Expected Plain webhook catalog');
          webhookCatalog = mutation.content.v;
          return Response.json({ status: 'updated', revision: ++webhookRevision, cursor: webhookRevision });
        }
      }
      const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
      if (request.path === '/v1/machines/read-batch' && request.method === 'POST') return createMachineReadBatchResponseFixture(
        request.body, id => id === machine.id ? machine : null);
      if (request.path === '/v1/machines') return Response.json([machine]);
      if (request.path === '/v1/machines/machine-1') return Response.json({ machine });
      if (/^\/v2\/sessions\/[^/]+\/pending$/.test(request.path)) {
        if (request.method !== 'POST') return Response.json({ pending: [], discarded: [], pendingVersion: 0 });
        const body = request.body;
        if (!body || typeof body !== 'object' || !('localId' in body) || !('requestedAction' in body)) throw new Error('Expected canonical pending producer');
        events.push(`enqueue:${body.localId}`);
        if (request.path === '/v2/sessions/s1/pending') directPendingEntered.resolve();
        // The canonical enqueue producer omits deliveryMode for ordinary
        // queued Actions; only explicit external handoff includes that field.
        return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId,
          deliveryStatus: { status: 'deliveryMode' in body && body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued' } } });
      }
      const handled = /\/pending\/([^/]+)\/delivery\/handled$/.exec(request.path);
      if (request.method === 'POST' && handled) { events.push(`settle:${decodeURIComponent(handled[1]!)}`); return Response.json({}); }
      if (/^\/v1\/sessions\/[^/]+\/messages$/.test(request.path)) return Response.json({ messages: [], hasMore: false });
      return sessionMetadata.handle(request.url, { method: request.method,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) })
        ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers }) ?? undefined;
    }).handle });
    disconnect = await account.restoreActiveConnection();
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    const serverId = account.homes.voice!.id;
    // Sync hydrated the HTTP Machine row, including its Plain transport mode.
    // Replacing it with an unadmitted local seed loses that mode at Resume.
    const machine = storage.getState().machineListByServerId[serverId]?.find(row => row.id === 'machine-1');
    if (!machine) throw new Error('The Voice fixture did not hydrate its Machine');
    const target = createSessionFixture({ id: 's1', serverId, active: true, presence: 'online', pendingVersion: 0, pendingCount: 0, metadata: {
      machineId: machine.id, path: '/workspace/s1', host: 'voice.test', flavor: 'claude',
      agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
    } });
    const carrier = createSessionFixture({ id: 'carrier-s1', serverId, active: true, presence: 'online', pendingVersion: 0, pendingCount: 0,
      metadata: writeVoiceConversationScopeMetadata({ ...target.metadata!,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        permissionMode: readLocalConversationVoiceSettings(storage.getState().settings.voice).agent.permissionIntent,
      }, { kind: 'session_root', sessionRootId: target.id }) });
    storage.setState({ sessions: { s1: target, 'carrier-s1': carrier }, machines: { [machine.id]: machine },
      machineListByServerId: { [serverId]: [machine] }, sessionMessages: {},
    });
    sessionMetadata.replaceSession(target.id);
    sessionMetadata.replaceSession(carrier.id);
    account.requests.length = 0;
    voiceConversationRuntimeMachine.reset();
  });

  afterEach(async () => { await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID); await disconnect?.(); disconnect = undefined; await account?.dispose(); });

  it.each([
    { path: 'setting', streamedNarration: false }, { path: 'existing-request', streamedNarration: false },
    { path: 'approvals-off', streamedNarration: false }, { path: 'refused-setting', streamedNarration: false },
    { path: 'setting', streamedNarration: true }, { path: 'existing-request', streamedNarration: true },
  ] as const)(
    'executes the spoken $path without a model confirmation round (streamed narration=$streamedNarration)', async ({ path, streamedNarration }) => {
      const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
      const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
      const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
      const serverId = account.homes.voice!.id;
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => 's1', currentServerId: serverId });
      const input = { anchor: 'voiceConversations.verbosity', value: path === 'refused-setting' ? 'unsupported' : 'balanced' };
      const controller = new AbortController();
      const narration = streamedNarration ? ['I found the requested change.', 'I will apply it now.'] : undefined;
      let pending: Promise<string> | undefined;
      let artifactId: string | undefined;
      if (path === 'existing-request' || path === 'approvals-off') {
        const created = createDeferred<void>();
        approvalArtifacts.afterNextCreate(async () => { created.resolve(); });
        pending = handlers.settings_set!(input, { effectId: 'existing-settings-request', signal: controller.signal });
        await created.promise;
        artifactId = approvalArtifacts.list()[0]?.id;
        expect(artifactId).toBeDefined();
        expect(ApprovalRequestSchema.parse(JSON.parse(approvalArtifacts.readPlainBody(artifactId!)!)).status).toBe('open');
      }
      setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected', mode: 'listening', canStop: true });
      // Only the daemon/model transport is scripted. Each next operand comes from
      // the real provider-bound discovery result, not from a fixture catalog.
      let discoveredArtifactId: string | undefined;
      const resultBody = (message: string) => z.object({ toolResults: z.array(z.object({ result: z.unknown() })) })
        .parse(parseVoiceToolResultsFollowUp(message)).toolResults[0]!.result;
      const catalog = z.object({ actionSpecs: z.array(z.object({ id: z.string(), bindings: z.optional(z.object({ voiceClientToolName: z.optional(z.string()) })),
        inputHints: z.optional(z.object({ fields: z.array(z.object({ path: z.string(), description: z.optional(z.string()) })) })) })) });
      let settingsListName = '';
      let settingsSetName = '';
      let discoveredAnchor = '';
      turnReplies = (index, message) => {
        if (index === 0) return { assistantText: 'Looking up the requested action.', actions: [
          { t: 'searchActionSpecs', args: { query: artifactId ? 'list approval requests' : 'voice settings', limit: 5 } },
        ] };
        if (index === 1) {
          expect(resultBody(message), JSON.stringify(resultBody(message))).toMatchObject({ ok: true });
          const specs = catalog.parse(resultBody(message)).actionSpecs;
          const spec = specs.find(spec => spec.id === (artifactId ? 'approval.request.list' : 'settings.list'));
          expect(spec).toBeDefined();
          expect(spec?.bindings?.voiceClientToolName).toEqual(expect.any(String));
          if (artifactId) return { assistantText: '', actions: [{ t: spec!.bindings!.voiceClientToolName!, args: { status: 'open' } }] };
          settingsListName = spec!.bindings!.voiceClientToolName!;
          const page = spec!.inputHints?.fields.find(field => field.path === 'pageId')?.description
            ?.match(/\bvoiceConversations\b/)?.[0];
          expect(page).toBe('voiceConversations');
          return { assistantText: '', actions: [{ t: settingsListName, args: { pageId: page } }] };
        }
        if (index === 2 && !artifactId) {
          const settings = z.object({ items: z.array(z.object({ anchor: z.string(), title: z.string() })) }).parse(resultBody(message)).items;
          const replies = settings.find(setting => setting.title === 'Replies');
          expect(replies?.anchor).toBe(input.anchor);
          discoveredAnchor = replies!.anchor;
          return { assistantText: '', actions: [{ t: 'getActionSpec', args: { id: 'settings.set' } }] };
        }
        if (index === 3 && !artifactId) {
          const spec = z.object({ actionSpec: z.object({ bindings: z.object({ voiceClientToolName: z.string() }) }) }).parse(resultBody(message)).actionSpec;
          settingsSetName = spec.bindings.voiceClientToolName;
          return { assistantText: 'Replies is now set to Balanced.', speechSegments: narration, actions: [{ t: settingsSetName, args: { ...input, anchor: discoveredAnchor } }] };
        }
        if (index === 2 && artifactId) {
          const requests = z.object({ items: z.array(z.object({ artifactId: z.string() })) }).parse(resultBody(message)).items;
          discoveredArtifactId = requests.find(request => request.artifactId === artifactId)?.artifactId;
          expect(discoveredArtifactId).toBe(artifactId);
          return { assistantText: '', actions: [{ t: 'approval_request_get', args: { artifactId: discoveredArtifactId } }] };
        }
        if (index === 3 && artifactId) {
          expect(resultBody(message)).toMatchObject({ ok: true, request: { status: 'open', actionId: 'settings.set' } });
          return { assistantText: 'Approved.', speechSegments: narration, actions: [{ t: 'approval_request_decide', args: { artifactId: discoveredArtifactId, decision: 'approve' } }] };
        }
        const result = resultBody(message);
        expect(result, JSON.stringify(result)).toMatchObject(path === 'approvals-off' ? { ok: false, errorCode: 'present_user_required' }
          : path === 'refused-setting' ? { ok: false } : { ok: true });
        return { assistantText: 'Unverified provider success claim.', actions: [] };
      };
      const base = buildAccountSettings();
      const local = readLocalConversationVoiceSettings(base.voice);
      const settings = settingsParse({ ...base, ...normalizeVoiceSettingsLocalDelta({ voice: { ...base.voice,
        canApproveRequests: path !== 'approvals-off', providers: { ...base.voice.providers, local_conversation: { schemaVersion: 1,
          config: { ...local, tts: { ...local.tts, provider: 'device', autoSpeakReplies: true },
            streaming: { ...local.streaming, enabled: true, ttsEnabled: true } } } } } }) });
      storage.setState({ settings });
      account.replaceAccountSettings('voice', { settings, version: 10 });
      const spoken: string[] = [];
      const firstNarration = createDeferred<SpeechOptions>();
      const hostSummary = createDeferred<SpeechOptions>();
      const secondNarration = createDeferred<void>();
      let activeSpeech: SpeechOptions | undefined;
      let summaryAttempted = false;
      let summaryStopped = false;
      let summaryOptions: SpeechOptions | undefined;
      const { getVoiceSessionSpokenActionConfirmation } = await import('@/voice/session/voiceSessionStore');
      const carrier = getVoiceSessionSpokenActionConfirmation();
      await speech.speak.withImplementation((text, options) => {
        spoken.push(text); activeSpeech = options;
        if (text === narration?.[0]) { options.onStart?.(); firstNarration.resolve(options); }
        else {
          if (streamedNarration && text === carrier?.readPending()?.operation.summary) {
            summaryAttempted = true; summaryOptions = options; hostSummary.resolve(options);
          } else {
            options.onStart?.(); options.onDone?.();
            if (text === narration?.[1]) secondNarration.resolve();
          }
        }
      }, async () => await speech.stop.withImplementation(() => {
        if (activeSpeech === summaryOptions) summaryStopped = true;
        activeSpeech?.onStopped?.();
      }, async () => {
        try {
          const sending = sendVoiceTextTurn({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, settings,
            userText: artifactId ? 'Approve this exact request.' : 'In Voice settings change Replies from Short to Balanced.',
            playbackController: createVoicePlaybackController(), voiceAgentSessions, signal: controller.signal });
          // Keep a transport assertion failure observed while OS playback is held.
          void sending.catch(() => undefined);
          if (streamedNarration) {
            const first = await firstNarration.promise;
            // Hold real OS playback while the same streamed reply delivers its
            // Action. The queued second segment must not replace host read-back.
            await vi.waitFor(() => expect(carrier?.readPending() !== null || summaryAttempted).toBe(true));
            first.onDone?.();
            const summary = await hostSummary.promise;
            await secondNarration.promise;
            if (!summaryStopped) { summary.onStart?.(); summary.onDone?.(); }
          }
          await sending;
          expect(JSON.parse(await handlers.settings_get!({ anchor: input.anchor }))).toMatchObject({ ok: true, value: path === 'refused-setting' || path === 'approvals-off' ? 'short' : 'balanced' });
          expect(spoken).not.toContain('Replies is now set to Balanced.');
          expect(spoken).not.toContain('Unverified provider success claim.');
          if (path === 'approvals-off') expect(spoken).toContain(t('voiceSurface.approvalTapRequired'));
          else if (path === 'refused-setting') expect(spoken).not.toContain(t('common.done'));
          else expect(spoken).toContain(path === 'setting' ? t('common.done') : t('approvals.status.executed'));
          if (artifactId && path === 'approvals-off') {
            expect(ApprovalRequestSchema.parse(JSON.parse(approvalArtifacts.readPlainBody(artifactId)!)).status).toBe('open');
          } else if (artifactId) {
            expect(ApprovalRequestSchema.parse(JSON.parse(approvalArtifacts.readPlainBody(artifactId)!)))
              .toMatchObject({ status: 'executed', decision: { decidedVia: 'voice' }, execution: { ok: true } });
            await pending;
          } else expect(approvalArtifacts.list()).toEqual([]);
        } finally {
          controller.abort(); resetVoiceSessionStoreForTests(); await pending?.catch(() => undefined);
        }
      }));
    });

  it.each([
    { streaming: false, completion: 'done' },
    { streaming: true, completion: 'done' },
    { streaming: true, completion: 'barge-in' },
    { streaming: true, completion: 'end' },
    { streaming: true, completion: 'not-started' },
    { streaming: true, completion: 'failed' },
  ] as const)('only completed host summary playback executes the Action (streaming=$streaming, $completion)', async ({ streaming, completion }) => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests,
      getVoiceSessionSpokenActionConfirmation } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected', mode: 'listening', canStop: true });
    const carrier = getVoiceSessionSpokenActionConfirmation();
    if (!carrier) throw new Error('Missing live call');
    const actionId = 'notifications.webhooks.remove';
    const toolName = getActionSpec(actionId).bindings?.voiceClientToolName;
    if (!toolName) throw new Error('Missing Voice webhook tool');
    const input = { channelId: 'deployment-webhook' };
    turnReplies = index => index === 0
      ? { assistantText: 'Okay.', actions: [{ t: toolName, args: input }] }
      : { assistantText: 'Done.', actions: [] };
    const base = buildAccountSettings();
    const local = readLocalConversationVoiceSettings(base.voice);
    const settings = settingsParse({ ...base, ...normalizeVoiceSettingsLocalDelta({ voice: { ...base.voice, providers: { ...base.voice.providers,
      local_conversation: { schemaVersion: 1, config: { ...local,
        // Required host read-back also speaks when optional model replies are muted.
        tts: { ...local.tts, provider: 'device', autoSpeakReplies: streaming },
        streaming: { ...local.streaming, enabled: streaming, ttsEnabled: streaming },
      } },
    } } }) });
    const summaryStarted = createDeferred<SpeechOptions>();
    const spoken: string[] = [];
    let activeSpeech: SpeechOptions | undefined;
    const playbackController = createVoicePlaybackController();
    const controller = new AbortController();
    await speech.speak.withImplementation((text, options) => {
      activeSpeech = options;
      spoken.push(text);
      if (text === carrier.readPending()?.operation.summary && completion === 'not-started') {
        summaryStarted.resolve(options);
        options.onStopped?.();
        return;
      }
      options.onStart?.();
      if (text === carrier.readPending()?.operation.summary) summaryStarted.resolve(options);
      else options.onDone?.();
    }, async () => await speech.stop.withImplementation(() => { activeSpeech?.onStopped?.(); }, async () => {
      const sending = sendVoiceTextTurn({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, settings,
        userText: 'remove the deployment webhook', playbackController, voiceAgentSessions, signal: controller.signal });
      try {
        const summarySpeech = await Promise.race([summaryStarted.promise, sending.then(() => {
          throw new Error('The model repeated the Action without host summary playback');
        })]);
        expect(spoken).toContain(carrier.readPending()!.operation.summary);
        expect(carrier.readPending()).not.toBeNull();
        expect(webhookRevision).toBe(1);
        if (completion === 'done') summarySpeech.onDone?.();
        else if (completion === 'not-started') summarySpeech.onStopped?.();
        else if (completion === 'failed') summarySpeech.onError?.(new Error('fixture_tts_failed'));
        else {
          if (completion === 'end') {
            setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            controller.abort();
          }
          playbackController.interrupt();
        }
        await sending;
        expect(webhookRevision).toBe(completion === 'done' ? 2 : 1);
        expect(webhookCatalog.channels).toHaveLength(completion === 'done' ? 0 : 1);
        expect(carrier.readPending()).toBeNull();
      } finally {
        controller.abort();
        playbackController.interrupt();
        activeSpeech?.onStopped?.();
        await sending.catch(() => undefined);
        resetVoiceSessionStoreForTests();
      }
    }));
  });

  it('submits direct coding-session voice turns through durable immediate delivery', async () => {
    conversationModeState.current = 'direct_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 's1',
      settings: buildAccountSettings(),
      userText: 'send this directly',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toHaveLength(1);
    expect(pendingWrites('s1')[0]?.body).toMatchObject({ requestedAction: { v: 1, kind: 'send_now' } });
    expect(pendingRecords('s1')[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'send this directly' } });
    expect(pendingWrites()).toEqual([]);
  });

  it('does not admit a direct coding-session voice turn after cancellation', async () => {
    conversationModeState.current = 'direct_session';
    const controller = new AbortController();
    controller.abort();
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await expect(sendVoiceTextTurn({
      sessionId: 's1',
      settings: buildAccountSettings(),
      userText: 'cancelled before admission',
      signal: controller.signal,
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(pendingWrites('s1')).toEqual([]);
  });

  it.each(['reply', 'cancel', 'remote_cancel'] as const)('keeps a slow direct-session turn owned until %s', async (outcome) => {
    conversationModeState.current = 'direct_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    const { sync } = await import('@/sync/sync');
    // Observe the real submit promise so the reply clock starts after HTTP acceptance.
    const submission = vi.spyOn(sync, 'submitMessage');
    const settings = buildAccountSettings();
    const config = readLocalConversationVoiceSettings(settings.voice);
    const controller = new AbortController();
    speech.speak.mockReset();
    speech.speak.mockImplementation((_text, options) => { options.onStart?.(); options.onDone?.(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const turn = sendVoiceTextTurn({
      sessionId: 's1', userText: 'slow spoken reply', signal: controller.signal,
      settings: { ...settings, voice: { ...settings.voice, providers: { ...settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...config, tts: { autoSpeakReplies: true, provider: 'device' } } },
      } } },
      playbackController: createVoicePlaybackController(), voiceAgentSessions,
    }).then(() => { settled = true; });
    try {
      await directPendingEntered.promise;
      expect(pendingWrites('s1')).toHaveLength(1);
      await submission.mock.results[0]!.value;
      await vi.advanceTimersByTimeAsync(65_000);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(account.homes.voice!.id)).toContain('s1');
      if (outcome === 'cancel') controller.abort();
      if (outcome === 'remote_cancel') {
        const admission = pendingWrites('s1')[0]?.body;
        if (!admission || typeof admission !== 'object' || !('localId' in admission)) throw new Error('Missing durable admission');
        const user = { id: 'voice-user', kind: 'user-text', text: 'slow spoken reply', seq: 17,
          localId: String(admission.localId), createdAt: Date.now() } satisfies Message;
        storage.setState({ sessions: { ...storage.getState().sessions, s1: { ...storage.getState().sessions.s1!,
          sessionTurns: buildSessionTurnsProjectionV1({ sessionId: 's1', updatedAt: Date.now(), turns: [{
            turnId: 'coding-turn', startedAt: Date.now(), updatedAt: Date.now(), status: 'cancelled',
            transcriptAnchors: { startUserMessageSeq: user.seq, finalAssistantMessageSeq: null },
          }] }),
        } }, sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: [user.id], messagesById: { [user.id]: user } }) } });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(voiceConversationRuntimeMachine.getSnapshot().state).toBe('connected');
        expect(speech.speak).not.toHaveBeenCalled();
        return;
      }
      const reply = { id: 'slow-reply', kind: 'agent-text', text: 'Here is the slow reply.', localId: null, seq: 18, createdAt: Date.now(),
        meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'reply-local',
          segmentState: 'complete', startedAtMs: Date.now(), updatedAtMs: Date.now() } },
      } satisfies Message;
      if (outcome === 'reply') {
        const admission = pendingWrites('s1')[0]?.body;
        if (!admission || typeof admission !== 'object' || !('localId' in admission)) throw new Error('Missing durable admission');
        const user = { id: 'voice-user', kind: 'user-text', text: 'slow spoken reply', seq: 17,
          localId: String(admission.localId), createdAt: Date.now() } satisfies Message;
        const previousReply = { id: 'older-reply', kind: 'agent-text', text: 'An older hydrated reply.', seq: 16,
          localId: null, createdAt: Date.now() - 1 } satisfies Message;
        storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
          messageIdsOldestFirst: [previousReply.id, user.id], messagesById: { [previousReply.id]: previousReply, [user.id]: user },
        }) } });
        await vi.advanceTimersByTimeAsync(0);
        expect(speech.speak).not.toHaveBeenCalled();
        const draft = { ...reply, text: 'Here', meta: { happierStreamSegmentV1: {
          ...reply.meta.happierStreamSegmentV1, segmentState: 'streaming' as const,
        } } } satisfies Message;
        storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
          messageIdsOldestFirst: [user.id, draft.id], messagesById: { [user.id]: user, [draft.id]: draft },
        }) } });
        await vi.advanceTimersByTimeAsync(0);
        expect(speech.speak).not.toHaveBeenCalled();
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(account.homes.voice!.id)).toContain('s1');
      }
      const messages = [...readStoredSessionMessages(storage.getState(), 's1').filter(message => message.kind === 'user-text'), reply];
      storage.setState({ ...(outcome === 'reply' ? { sessions: { ...storage.getState().sessions,
        s1: { ...storage.getState().sessions.s1!, sessionTurns: buildSessionTurnsProjectionV1({
          sessionId: 's1', updatedAt: Date.now(), turns: [{ turnId: 'coding-turn', startedAt: Date.now(), updatedAt: Date.now(),
            status: 'completed', transcriptAnchors: { userMessageSeqs: [17], finalAssistantMessageSeq: reply.seq } }],
        }) },
      } } : {}), sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: messages.map(message => message.id), messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
      }) } });
      await turn;
      expect(speech.speak.mock.calls.map(call => call[0])).toEqual(outcome === 'reply' ? [reply.text] : []);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(account.homes.voice!.id)).not.toContain('s1');
    } finally {
      controller.abort();
      await turn;
      vi.useRealTimers();
      submission.mockRestore();
    }
  });

  it('durably enqueues speech input before one local-agent dispatch', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'from microphone',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    const body = pendingWrites()[0]?.body;
    expect(body).toMatchObject({ localId: expect.any(String) });
    if (!body || typeof body !== 'object' || !('localId' in body)) throw new Error('Missing durable admission');
    const localId = body.localId;
    expect(account.requests.filter(request => request.method === 'POST' && /\/delivery\/handled$/.test(request.path))).toHaveLength(1);
    expect(turnIndex).toBe(1);
    expect(events).toEqual([`enqueue:${localId}`, `dispatch:${localId}`, `settle:${localId}`]);
  });

  it('trims the control session id while preserving daemon transcript ownership', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: ` ${VOICE_AGENT_GLOBAL_SESSION_ID} `,
      settings: buildAccountSettings(),
      userText: 'list the backends',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expectNoSyntheticTranscript();
    expect(pendingRecords()).toHaveLength(1);
  });

  it('normalizes sendSessionMessage preambles without creating synthetic tool transcript rows', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    turnReplies = index => index === 0
      ? { assistantText: 'I will send that now.', actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }] }
      : { assistantText: 'Done.', actions: [] };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toHaveLength(1);
    expect(pendingWrites('s1')[0]).toMatchObject({ home: 'voice', accountId: 'account-a',
      body: { requestedAction: { v: 1, kind: 'steer_if_active' } } });
    expect(pendingRecords('s1')[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello' } });
    expectNoSyntheticTranscript();
  });

  it('continues admitted tool work to its terminal answer without a guessed-limit status', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    const { voiceOutputStatusStore } = await import('@/voice/runtime/outputStatus/voiceOutputStatusStore');
    const { voiceTextTurnPendingPort } = await import('@/voice/binding/sendVoiceSessionComposerText');
    turnReplies = index => index === 9
      ? { assistantText: 'The requested messages were sent.', actions: [] }
      : { assistantText: 'Round ' + (index + 1), actions: [{ t: 'sendSessionMessage', args: { message: 'hello-' + (index + 1) } }] };

    const admitted = await voiceTextTurnPendingPort.enqueuePendingMessage({
      conversationSessionId: 'carrier-s1', text: 'keep sending', localId: 'bounded-tool-input',
    });
    expect(admitted.externalHandoffClaimed).toBe(true);
    // Exercise the canonical post-admission dispatch and Pending custody.
    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'keep sending',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
      durableDispatch: { localId: admitted.localId, deliveryCommand: 'interrupt_and_send' },
      onUserTranscriptAccepted: () => voiceTextTurnPendingPort.markPendingDeliveryHandled({
        conversationSessionId: 'carrier-s1', localId: admitted.localId,
      }),
    });

    expect(turnIndex, JSON.stringify({
      daemonMethods: retainedAgent.requests.map(request => request.method),
      admittedToolMessages: pendingRecords('s1').map(record => record.content),
      runtime: voiceConversationRuntimeMachine.getSnapshot(),
    })).toBe(10);
    expect(pendingRecords('s1').map(record => record.content)).toEqual(
      Array.from({ length: 9 }, (_, index) => ({ type: 'text', text: 'hello-' + (index + 1) })),
    );
    expectNoSyntheticTranscript();
    expect(voiceOutputStatusStore.readForSession(VOICE_AGENT_GLOBAL_SESSION_ID)).toBeNull();
  });

  it('does not send an implicit tool action to the active Home when the bound target is on another Home', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
    await voiceSessionBindingManager.syncTargetSession({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      targetSessionAddress: { serverId: account.homes.other!.id, sessionId: 's1' },
    });

    turnReplies = index => index === 0
      ? { assistantText: 'I will send that now.', actions: [{ t: 'sendSessionMessage', args: { message: 'hello on Home B' } }] }
      : { assistantText: 'Done.', actions: [] };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello on the bound target',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toEqual([]);
    // Batch snapshots are reads even though their bounded request uses POST.
    expect(account.requests.filter(request => request.home === 'other' && request.method === 'POST'
      && request.path !== '/v2/sessions/read-batch')).toEqual([]);
  });

  it('rethrows agent-mode send failures and leaves error publication to the lifecycle caller', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    rejectStart = true;

    await expect(
      sendVoiceTextTurn({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        settings: buildAccountSettings(),
        userText: 'send hello',
        playbackController: createVoicePlaybackController(),
        voiceAgentSessions,
      }),
    ).rejects.toThrow('voice_turn_dispatch_ambiguous');
    // Direct dispatch never publishes its own failure; the lifecycle caller owns it.
    expect(voiceConversationRuntimeMachine.getSnapshot().error).toBeNull();
    expect(pendingWrites('s1')).toEqual([]);
  });
});
