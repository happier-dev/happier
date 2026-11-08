import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { serveAccountHomes, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { writeVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamStartV2RequestSchema,
  ExecutionRunTurnStreamStartResponseSchema, ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunUserTranscriptCommitResponseSchema,
  type ExecutionRunTurnStreamEvent } from '@happier-dev/protocol/execution/runs/streaming';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { voiceOutputStatusStore } from '@/voice/runtime/outputStatus/voiceOutputStatusStore';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { resetWebAudioContextForTests } from '@/voice/output/webAudioContext';
import { TestVoiceAudioContext } from '@/dev/testkit/harness/voiceWebRtcHarness';

/**
 * Convergence proof (RL-L4-1): the live streaming TTS path must route every
 * chunk through the canonical ordered ack'd queue (`createTtsPlaybackController`)
 * — the single ordering owner — instead of the retired ad-hoc serial promise
 * chain. We assert chunks reach `speakAssistantText` in contiguous order, and
 * that `playbackController.interrupt()` aborts the queue so no further chunk
 * plays (barge-in interrupt → queue abort preserved).
 */

const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: async () => {
  const home = account?.homes.voice;
  if (!home) throw new Error('Streaming Account is not restored');
  const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
  if (!credentials) throw new Error('Streaming Account credentials are unavailable');
  return { home, credentials };
} });
const { expoSpeechSpeak, expoSpeechStop, encodedAudio, speechSynthesizeRpc } = speechBoundary;

await loadSyncSingletonForTests();
const restoreActionLoader = await installRealActionExecutorModuleLoader();
afterAll(async () => {
  try { await speechBoundary.disposeAudioSession(); }
  finally { restoreActionLoader(); }
});
const [
  { createLocalConversationVoiceAdapter },
  { voiceSessionBindingManager },
  { voiceSessionBindingStore },
  { registerVoiceAdapters, resetVoiceAdapterRegistryForTests },
  { storage },
  { sendVoiceTextTurn },
] = await Promise.all([
  import('@/voice/adapters/localConversation/localConversationAdapter'),
  import('@/voice/binding/voiceConversationBindingRuntime'),
  import('@/voice/binding/voiceConversationBindingStore'),
  import('@/voice/session/voiceAdapterRegistry'),
  import('@/sync/domains/state/storage'),
  import('./sendVoiceTextTurn'),
]);
let account: Awaited<ReturnType<typeof serveAccountHomes>> | null = null;
let disconnect: (() => Promise<void>) | null = null;
let webStorage: ReturnType<typeof installLocalStorageMock> | null = null;
const sessionMetadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);

function readDeviceSpeech() { return expoSpeechSpeak.mock.calls.map(([text]) => text); }
function readBundledSpeech() { return speechSynthesizeRpc.mock.calls.map(([input]) => input.input); }

// Only wire events are synthetic: the actual Agent initializer/client/read loop
// derives accepted effects and handles transcript acceptance and terminal custody.
const streamDeltas: { current: string[] } = { current: [] };
const onInterruptDuringStream: { current: (() => void) | null } = { current: null };
let retainedAgent: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
let turnIndex = 0;
let streamMode: 'speech' | 'tool' | 'status' | 'cancelled' = 'speech';
let playbackStarted: Promise<void> | undefined;
const observedStatuses: unknown[] = [];
const streamEvents = new Map<string, ExecutionRunTurnStreamEvent[]>();
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const voiceProviders = (await import('@/voice/registry/defaultRegistry')).createDefaultVoiceProviderRegistry();

async function answerVoiceAgentRpc(method: string, input: unknown): Promise<unknown> {
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1) {
    return ExecutionRunUserTranscriptCommitResponseSchema.parse({ ok: true });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
    ExecutionRunTurnStreamStartV2RequestSchema.parse(input);
    const currentTurn = turnIndex++;
    const streamId = 'stream-test-' + currentTurn;
    const text = streamMode === 'tool'
      ? currentTurn === 0 ? 'Checking sessions.' : 'Tool round complete.'
      : streamDeltas.current.join('');
    const texts = streamMode === 'tool' ? [text] : streamDeltas.current;
    const events: ExecutionRunTurnStreamEvent[] = texts.map((value, index) => ({ t: 'voice_output', output: {
      v: 1, kind: 'speech_segment', turnId: streamId, seq: index, segmentId: streamId + ':segment:' + index, text: value,
    } }));
    if (streamMode === 'status') {
      events.push({ t: 'voice_output', output: { v: 1, kind: 'display_status', turnId: streamId, seq: 0,
        statusId: 'status-1', text: 'Checking safely' } });
    }
    if (streamMode === 'cancelled') events.push({ t: 'voice_output', output: {
      v: 1, kind: 'turn_cancelled', turnId: streamId, seq: events.length,
    } });
    else {
      if (streamMode === 'tool' && currentTurn === 0) events.push({ t: 'voice_output', output: {
        v: 1, kind: 'side_effect', turnId: streamId, seq: events.length,
        effectId: streamId + ':list-sessions', action: { t: 'listSessions', args: { limit: 1 } },
      } });
      events.push({ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: streamId,
        seq: events.length, text: streamMode === 'status' ? 'Done' : text,
      } });
    }
    streamEvents.set(streamId, events);
    return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
    const request = ExecutionRunTurnStreamReadRequestSchema.parse(input);
    if (request.cursor === 1) {
      if (streamMode === 'cancelled') await playbackStarted;
      if (streamMode === 'status') observedStatuses.push(voiceOutputStatusStore.getSnapshot());
      onInterruptDuringStream.current?.();
      onInterruptDuringStream.current = null;
    }
    const events = streamEvents.get(request.streamId);
    if (!events) throw new Error('Requested unknown Voice stream');
    const event = events[request.cursor];
    return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: request.streamId,
      events: event ? [event] : [], nextCursor: request.cursor + 1,
      done: request.cursor >= events.length - 1,
    });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true });
  throw new Error('Unexpected Voice wire method: ' + method);
}

function makePlaybackController(onInterrupt?: () => void) {
  const controller = createVoicePlaybackController();
  return {
    ...controller,
    interrupt: () => {
      onInterrupt?.();
      controller.interrupt();
    },
  };
}

function buildAccountSettings(ttsProvider = 'device') {
  const providerSettings = voiceProviders.get(ttsProvider)?.providerSettings;
  const providerConfig = providerSettings?.parseStoredConfig({
    ...providerSettings.defaultConfig,
    // The declared Google readiness contract requires a user-selected voice;
    // its genuine empty default intentionally is not synthesis-ready.
    ...(ttsProvider === 'happier.voice.google/google-cloud-tts'
      ? { voiceName: 'en-US-Wavenet-D', languageCode: 'en-US' } : {}),
  });
  return settingsParse({
    ...settingsDefaults,
    ...normalizeVoiceSettingsLocalDelta({
      experiments: true,
      featureToggles: { ...settingsDefaults.featureToggles, voice: true, 'voice.agent': true, 'voice.daemonInference': true, 'execution.runs': true },
      voice: {
        ...settingsDefaults.voice,
        providerId: 'local_conversation',
        executionMachine: { mode: 'fixed', machineId: 'machine-1' },
        providers: {
          ...settingsDefaults.voice.providers,
          ...(providerSettings ? { [ttsProvider]: {
            schemaVersion: providerSettings.schemaVersion, config: providerConfig,
          } } : {}),
          local_conversation: {
            schemaVersion: 1,
            config: {
              conversationMode: 'agent',
              agent: { agentSource: 'session', prewarmOnConnect: false },
              streaming: { enabled: true, ttsEnabled: true, ttsChunkChars: 120 },
              tts: { autoSpeakReplies: true, provider: ttsProvider,
                ...(ttsProvider === 'local_neural' ? { localNeural: { execution: 'daemon' } } : {}),
              },
            },
          },
        },
      },
    }),
  });
}

async function establishProductionBinding() {
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
    conversationSessionAddress: { serverId: expect.any(String), sessionId: 'carrier-s1' },
    transcriptMode: 'native_session',
    targetSessionAddress: { serverId: expect.any(String), sessionId: 's1' },
  });
  expect(binding?.conversationSessionAddress.serverId).toBe(binding?.targetSessionAddress?.serverId);
  await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
  expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
}

function registerStreamingPlaybackHooks(platform: 'ios' | 'web' = 'ios', ttsProvider = 'device') {
  beforeEach(async () => {
    speechBoundary.reset();
    speechBoundary.platform.value = platform;
    if (platform === 'web') webStorage = installLocalStorageMock();
    resetWebAudioContextForTests();
    retainedAgent = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: answerVoiceAgentRpc });
    const nativeSdkRpc = speechBoundary.machineRpc.getMockImplementation();
    speechBoundary.machineRpc.mockImplementation(async request => {
      if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        const resume = SessionResumeRequestV1Schema.parse(request.payload);
        expect(request.machineId).toBe('machine-1');
        expect(resume).toMatchObject({ type: 'resume-session', sessionId: 'carrier-s1', directory: '/workspace/s1' });
        return { type: 'success', sessionId: resume.sessionId };
      }
      return request.method.startsWith('execution.run.')
        ? retainedAgent.dispatch(request.method, request.payload)
        : nativeSdkRpc?.(request);
    });
    turnIndex = 0;
    streamMode = 'speech';
    playbackStarted = undefined;
    observedStatuses.length = 0;
    streamEvents.clear();
    account = await serveAccountHomes({ homes: [{ key: 'voice', serverUrl: 'https://streaming-voice.test',
      accountId: 'account-a', currentAccount: true, settings: buildAccountSettings(ttsProvider) }], route: createSessionReadBatchHttpBoundary(async request => {
        const machineReply = speechBoundary.answerMachineHttpRequest(request.url, 'machine-1', 'account-a', request);
        if (machineReply) return machineReply;
        const metadataReply = await sessionMetadata.handle(request.url.toString(), {
          method: request.method, headers: request.headers, signal: request.signal,
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        });
        if (metadataReply) return metadataReply;
        if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
          features: { voice: { enabled: true, agent: { enabled: true }, daemonInference: { enabled: true } }, execution: { runs: { enabled: true } },
            machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } } },
          capabilities: { session: { pendingInput: { protocolVersion: 1 } }, machines: { liveStream: {
            serverRouted: { disabledReason: null, caps: {
              maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000,
              maxDurationMs: 60_000, maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2,
              maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
            } },
          } } },
        }));
        if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (request.method === 'GET' && /^\/v1\/sessions\/[^/]+\/messages$/.test(request.path)) {
          return Response.json({ messages: [], hasMore: false });
        }
        if (request.path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
          status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
        }));
        if (request.method === 'POST' && /^\/v2\/sessions\/[^/]+\/pending$/.test(request.path)) {
          const body = request.body;
          if (!body || typeof body !== 'object' || !('localId' in body) || !('requestedAction' in body) || !('content' in body)) {
            throw new Error('Expected the real pending input producer');
          }
          const content = StrictSessionStoredMessageContentEnvelopeSchema.parse(body.content);
          if (content.t !== 'plain') throw new Error('Expected this plain Account fixture to write plain Voice input');
          const record = RawRecordSchema.parse(content.v);
          expect(readConversationTurnOriginV1FromMessageMeta(record.meta, 'input')).toMatchObject({
            v: 1, channel: 'realtime_conversation', modality: 'voice',
          });
          return Response.json({ requestedAction: body.requestedAction,
            pending: { localId: body.localId, deliveryStatus: { status: 'external_handoff' } } });
        }
        if (request.method === 'POST' && /\/delivery\/handled$/.test(request.path)) return Response.json({});
        return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers }) ?? undefined;
      }).handle });
    disconnect = await account.restoreActiveConnection();
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    const serverId = account.homes.voice.id;
    const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
    const target = createSessionFixture({ id: 's1', serverId, active: true, presence: 'online',
      metadata: { machineId: machine.id, path: '/workspace/s1', host: 'voice.test', flavor: 'claude',
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } });
    const carrier = createSessionFixture({ id: 'carrier-s1', serverId, active: true, presence: 'online',
      metadata: writeVoiceConversationScopeMetadata({ ...target.metadata!,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        // A retained carrier records the permission admitted by its real creator.
        permissionMode: readLocalConversationVoiceSettings(buildAccountSettings(ttsProvider).voice).agent.permissionIntent,
      }, { kind: 'session_root', sessionRootId: target.id }) });
    storage.setState({ settings: buildAccountSettings(ttsProvider),
      settingsScope: { serverId, accountId: 'account-a' },
      sessions: { s1: target, 'carrier-s1': carrier }, machines: { [machine.id]: machine },
      machineListByServerId: { [serverId]: [machine] }, sessionMessages: {},
    });
    sessionMetadata.replaceSession(target.id);
    sessionMetadata.replaceSession(carrier.id);
    sessionMetadata.writes.length = 0;
    voiceConversationRuntimeMachine.reset();
    streamDeltas.current = [];
    onInterruptDuringStream.current = null;
  });

  afterEach(async () => {
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    speechBoundary.disposeNativeSdkBridge();
    await disconnect?.();
    disconnect = null;
    await account?.dispose();
    account = null;
    webStorage?.restore();
    webStorage = null;
    speechBoundary.platform.value = 'ios';
    vi.unstubAllGlobals();
    resetWebAudioContextForTests();
  });
}

describe('sendVoiceTextTurn streaming playback convergence', () => {
  registerStreamingPlaybackHooks();

  it('routes streamed chunks through the canonical queue and speaks them in contiguous order', async () => {
    resetVoiceAdapterRegistryForTests();
    await expect(voiceSessionBindingManager.ensureBound({
      adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: 's1',
    })).resolves.toBeNull();
    expect(account?.requests.filter(request => request.method === 'POST' && /\/pending$/.test(request.path))).toEqual([]);
    await establishProductionBinding();
    // Sentence-terminated deltas force discrete first/steady chunks.
    streamDeltas.current = ['First sentence. ', 'Second sentence. ', 'Third sentence.'];

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions,
    });

    const spoken = readDeviceSpeech();
    // Every chunk reached the provider via the queue's playChunk (the empty
    // terminal sentinel is filtered out before speaking).
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.some((t) => t === '')).toBe(false);
    // Order is preserved: concatenated chunks reproduce the streamed text in
    // sequence (the queue advances only on a contiguous chunkIndex run).
    const recombined = spoken.join(' ').replace(/\s+/g, ' ').trim();
    expect(recombined).toBe('First sentence. Second sentence. Third sentence.');
  });

  it('routes registry-projected bundled TTS through the canonical streaming owner', async () => {
    await establishProductionBinding();
    streamDeltas.current = ['Bundled first. ', 'Bundled second.'];

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings('happier.voice.google/google-cloud-tts'),
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions,
    });

    const spoken = readBundledSpeech();
    expect(spoken.join(' ').replace(/\s+/g, ' ').trim()).toBe('Bundled first. Bundled second.');
  });

  it.each(['device', 'happier.voice.google/google-cloud-tts'])('preserves normalized inline code and link labels through %s streamed playback', async provider => {
    await establishProductionBinding();
    streamDeltas.current = ['Call `f(*args, ', '**kwargs)` and see [`parser`](u), literal `[x](url)`, then **done**.'];

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(provider),
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions,
    });

    const spoken = provider === 'device' ? readDeviceSpeech() : readBundledSpeech();
    expect(spoken.join(' ').replace(/\s+/gu, ' ').trim()).toBe('Call f(*args, **kwargs) and see parser, literal [x](url), then done.');
  });

  it('plays accepted speech from every canonical tool round in order', async () => {
    await establishProductionBinding();
    streamMode = 'tool';

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'check sessions',
      playbackController: makePlaybackController(),
      voiceAgentSessions,
    });

    expect(readDeviceSpeech()).toEqual([
      'Checking sessions.',
      'Tool round complete.',
    ]);
  });

  it('projects accepted display status even when streaming TTS and auto-speak are disabled', async () => {
    await establishProductionBinding();
    const settings = buildAccountSettings();
    const config = readLocalConversationVoiceSettings(settings.voice);
    settings.voice.providers.local_conversation = { schemaVersion: 1, config: { ...config,
      streaming: { ...config.streaming, ttsEnabled: false },
      tts: { ...config.tts, autoSpeakReplies: false },
    } };
    streamMode = 'status';
    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings,
      userText: 'check',
      playbackController: makePlaybackController(),
      voiceAgentSessions,
    });

    expect(observedStatuses).toEqual([{
      scope: 'turn',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      turnId: 'stream-test-0',
      statusId: 'status-1',
      text: 'Checking safely',
    }]);
    expect(voiceOutputStatusStore.getSnapshot()).toBeNull();
    expect(expoSpeechSpeak).not.toHaveBeenCalled();
    expect(speechSynthesizeRpc).not.toHaveBeenCalled();
  });
});

describe.each([
  { failure: 'synthesis', provider: 'happier.voice.google/google-cloud-tts' },
  { failure: 'playback_start', provider: 'happier.voice.google/google-cloud-tts' },
  { failure: 'playback_start', provider: 'local_neural' },
  { failure: 'playback_start_then_cancelled', provider: 'local_neural' },
] as const)('streamed $provider $failure failure', ({ failure, provider }) => {
  registerStreamingPlaybackHooks(provider === 'local_neural' ? 'web' : 'ios', provider);

  it('surfaces the fault without retrying later chunks', async () => {
    await establishProductionBinding();
    streamDeltas.current = ['Unavailable first. ', 'Must not retry.'];
    const errorCode = failure === 'synthesis' ? 'provider_unavailable' : 'QA_OUTPUT_START_FAILED';
    const outputStart = vi.fn(() => { throw Object.assign(new Error(errorCode), { name: 'OperationError' }); });
    if (provider === 'local_neural') {
      // Only the browser output boundary is replaced: the daemon client, both
      // playback queues, durable input admission and lifecycle caller stay real.
      vi.stubGlobal('AudioContext', class extends TestVoiceAudioContext {
        readonly decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 4.8 }));
        constructor() {
          super();
          const createSource = this.createBufferSource.getMockImplementation()!;
          this.createBufferSource.mockImplementation(() => {
            const source = createSource();
            source.start.mockImplementation(outputStart);
            return source;
          });
        }
      });
    }
    if (failure === 'synthesis') speechBoundary.failNextSynthesis('provider_unavailable');
    else {
      if (failure === 'playback_start_then_cancelled') {
        streamMode = 'cancelled';
        // The remote terminal can arrive after local playback has failed. Cross
        // an OS task boundary so the real playback rejection settles first.
        playbackStarted = new Promise<void>(resolve => {
          outputStart.mockImplementationOnce(() => {
            setTimeout(resolve, 0);
            throw Object.assign(new Error(errorCode), { name: 'OperationError' });
          });
        });
      } else encodedAudio.start.mockRejectedValueOnce(Object.assign(new Error(errorCode), { name: 'OperationError' }));
    }

    const settings = buildAccountSettings(provider);
    const usesLifecycleCaller = provider === 'local_neural' && failure === 'playback_start';
    const send = usesLifecycleCaller
      ? (await import('./localVoiceEngine')).sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'go')
      : sendVoiceTextTurn({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        settings,
        userText: 'go',
        playbackController: makePlaybackController(),
        voiceAgentSessions,
      });
    const outcome = await send.then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(provider === 'local_neural' ? speechBoundary.daemonStreamStartRpc : speechSynthesizeRpc,
      outcome.error instanceof Error ? outcome.error.message : undefined).toHaveBeenCalledTimes(1);
    expect(provider === 'local_neural' ? outputStart : encodedAudio.start).toHaveBeenCalledTimes(failure === 'synthesis' ? 0 : 1);
    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: 'tts_failed', code: errorCode },
    });
    expect(account?.requests.filter(request => request.method === 'POST' && /\/pending$/.test(request.path))).toHaveLength(1);
    expect(account?.requests.filter(request => /\/delivery\/handled$/.test(request.path))).toHaveLength(1);
    if (usesLifecycleCaller) {
      expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
        state: 'disconnected',
        error: { kind: 'tts_failed', reason: errorCode, recoveryAction: 'retry' },
      });
    } else {
      // Direct dispatch leaves publication to the lifecycle caller.
      expect(voiceConversationRuntimeMachine.getSnapshot().error).toBeNull();
    }
  });
});

describe('sendVoiceTextTurn playback cancellation', () => {
  registerStreamingPlaybackHooks();

  it('aborts queued and active playback exactly once when the canonical turn is cancelled', async () => {
    await establishProductionBinding();
    streamDeltas.current = ['Active first. ', 'Queued second.'];
    const releaseFirst = speechBoundary.holdNextPlayback('encoded');
    streamMode = 'cancelled';
    playbackStarted = releaseFirst.started;
    const events: string[] = [];
    const stopNativePlayback = encodedAudio.stop.getMockImplementation();
    encodedAudio.stop.mockImplementation(async () => {
      events.push('stop');
      await stopNativePlayback?.();
    });
    const onInterrupt = vi.fn(() => {
      events.push('interrupt');
    });

    let turnSettled = false;
    const turn = sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings('happier.voice.google/google-cloud-tts'),
      userText: 'go',
      playbackController: makePlaybackController(onInterrupt),
      voiceAgentSessions,
    }).catch(() => {}).finally(() => {
      turnSettled = true;
      events.push('turn:settled');
    });

    try {
      await turn;
      expect(turnSettled).toBe(true);
    } finally {
      // Always release a defective implementation's orphaned first playback so
      // the test itself cannot leave queue work behind after recording the result.
      releaseFirst();
      await turn;
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(encodedAudio.stop).toHaveBeenCalledTimes(1);
    expect(encodedAudio.start).toHaveBeenCalledTimes(1);
    expect(speechSynthesizeRpc).toHaveBeenCalledTimes(1);
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('turn:settled'));
    expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
      state: 'connected',
      error: null,
    });
  });

  it('interrupt() aborts the queue: no further chunks play after a mid-stream barge-in', async () => {
    await establishProductionBinding();
    const controller = makePlaybackController();
    streamDeltas.current = ['Alpha sentence. ', 'Beta sentence. ', 'Gamma sentence.'];

    // Block the first chunk's playback, then interrupt while it is in flight.
    const releaseFirst = speechBoundary.holdNextPlayback('device');

    // After the first delta is pushed, fire the interrupt (barge-in).
    onInterruptDuringStream.current = () => {
      // Wait for the first chunk to begin, then interrupt and release it.
      void releaseFirst.started.then(() => {
        controller.interrupt();
        releaseFirst();
      });
    };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'go',
      playbackController: controller,
      voiceAgentSessions,
    });

    const spoken = readDeviceSpeech();
    // Only the first chunk should have actually been spoken; the epoch advanced
    // by interrupt() makes every later playChunk a no-op (stale epoch guard).
    expect(spoken.filter((t) => t.length > 0)).toEqual([spoken.find((t) => t.length > 0)]);
    expect(spoken.some((t) => t.includes('Gamma'))).toBe(false);
    expect(expoSpeechStop).toHaveBeenCalledOnce();
  });

});
