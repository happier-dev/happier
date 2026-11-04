import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
  DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
  DaemonVoiceInferenceSttStreamStartRequestSchema, DaemonVoiceInferenceSttStreamStartResponseSchema,
  DaemonVoiceInferenceSttStreamChunkRequestSchema, DaemonVoiceInferenceSttStreamChunkResponseSchema,
  DaemonVoiceInferenceSttStreamFinishRequestSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema,
  DaemonVoiceInferenceSttStreamCancelRequestSchema, DaemonVoiceInferenceSttStreamCancelResponseSchema,
  type DaemonVoiceInferenceSttStreamEvent,
} from '@happier-dev/protocol/daemon/voiceInference';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { SttStartParams } from '@/voice/input/sttController';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

// Install the physical transport before importing its runtime consumers.
const network = await installSessionOpsNetworkBoundary();
const { createDeferred, createMachineFixture } = await import('@/dev/testkit');
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
const { createDaemonStreamingSttController } = await import('./DaemonStreamingSttController');
const { createWebDaemonSpeechPcmCapture } = await import('./WebDaemonSpeechPcmCapture.web');
const { createTurnEndpointController } = await import('@/voice/runtime/input/TurnEndpointController');
const { daemonSpeechStreamDiagnostics } = await import('./daemonSpeechStreamDiagnostics');
const { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
const { VoiceLocalSttSchema } = await import('@/sync/domains/settings/voiceLocalSttSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');

const features = FeaturesResponseSchema.parse({
  features: {
    voice: { enabled: true }, execution: { runs: { enabled: true } },
    machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
  },
  capabilities: { machines: { liveStream: { serverRouted: {
    caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
  } } } },
});
const rpc = vi.fn<(request: SessionOpsRpcRequest) => Promise<unknown>>();
const initialState = storage.getState();
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
let browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
let context: InstanceType<typeof TestVoiceAudioContext>;
let activeController: ReturnType<typeof createDaemonStreamingSttController> | null = null;
let streamNumber = 0;
let chunkEvents: readonly DaemonVoiceInferenceSttStreamEvent[] = [];
let finishEvents: readonly DaemonVoiceInferenceSttStreamEvent[] = [];
let finishText = '';
let ackSeq = -1;

const methods = {
  start: 'daemon.voiceInference.stt.stream.start',
  chunk: 'daemon.voiceInference.stt.stream.chunk',
  finish: 'daemon.voiceInference.stt.stream.finish',
  cancel: 'daemon.voiceInference.stt.stream.cancel',
};
const requests = (name: keyof typeof methods) => network.requests.filter(request => request.method === methods[name]);
function createSink() {
  const partial = createDeferred<void>();
  const endpoint = createDeferred<void>();
  const error = createDeferred<void>();
  return {
    onAudioStarted: vi.fn(), onFinal: vi.fn(),
    onPartial: vi.fn((_text: string) => { partial.resolve(); }),
    onEndpoint: vi.fn((_reason: string) => { endpoint.resolve(); }),
    onError: vi.fn((_error: unknown) => { error.resolve(); }),
    events: { partial: partial.promise, endpoint: endpoint.promise, error: error.promise },
  };
}

async function respond(request: SessionOpsRpcRequest): Promise<unknown> {
  expect(request.targetId).toBe('streaming-machine');
  switch (request.method) {
    case methods.start: {
      const input = DaemonVoiceInferenceSttStreamStartRequestSchema.parse(request.payload);
      ackSeq = -1;
      return DaemonVoiceInferenceSttStreamStartResponseSchema.parse({
        ok: true, requestId: input.requestId, streamId: 'stream-' + ++streamNumber, generation: 1,
        ackSeq, format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      });
    }
    case methods.chunk: {
      const input = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(request.payload);
      ackSeq = input.seq;
      return DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({
        ok: true, streamId: input.streamId, generation: input.generation, ackSeq, events: chunkEvents,
      });
    }
    case methods.finish: {
      const input = DaemonVoiceInferenceSttStreamFinishRequestSchema.parse(request.payload);
      return DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({
        ok: true, streamId: input.streamId, generation: input.generation, ackSeq,
        finalText: finishText, language: 'en', modelPackId: 'stt-pack-1', events: finishEvents,
      });
    }
    case methods.cancel:
      return DaemonVoiceInferenceSttStreamCancelResponseSchema.parse({
        ok: true, ...DaemonVoiceInferenceSttStreamCancelRequestSchema.parse(request.payload),
      });
    default: throw new Error('unexpected daemon request: ' + request.method);
  }
}
function controller(endpointController?: NonNullable<Parameters<typeof createDaemonStreamingSttController>[0]>['endpointController']) {
  activeController = createDaemonStreamingSttController({
    getSettings: () => storage.getState().settings,
    // Explicit browser production implementation in this portable host test.
    createPcmCapture: createWebDaemonSpeechPcmCapture, endpointController,
  });
  return activeController;
}
function startParams(overrides: Partial<SttStartParams> = {}) {
  const sink = createSink();
  return { sessionId: 'active-control-session', micSession: browser.micSession, sink, ...overrides, events: sink.events };
}
function emitPcm() {
  // Physical 24 kHz browser frame; actual capture resamples/encodes 20 ms PCM.
  context.emitInput(new Float32Array(480).fill(0.25));
}
function provisional() {
  chunkEvents = [{ type: 'partial', seq: 0, text: 'provisional words', isEndpoint: false, confidence: null }];
}

beforeEach(async () => {
  network.resetRequests();
  await network.addHome('https://streaming-stt.example.test', 'streaming-account');
  account = await createPlainArtifactHomeFixture('https://streaming-stt.example.test', {
    serverFeatures: features,
    handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
  });
  const machine = createMachineFixture({ id: 'streaming-machine', activeAt: Date.now() });
  storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
  const voice = voiceSettingsParse({ providerId: 'local_conversation',
    executionMachine: { mode: 'fixed', machineId: machine.id } });
  const configuredVoice = writeLocalConversationVoiceSettings(voice, {
    ...readLocalConversationVoiceSettings(voice),
    stt: VoiceLocalSttSchema.parse({ provider: 'local_neural', localNeural: {
      assetId: 'stt-pack-1', language: 'en', execution: 'daemon',
    } }),
  });
  storage.getState().applySettingsLocal({
    experiments: true, featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true },
    ...normalizeVoiceSettingsLocalDelta({ voice: configuredVoice }, storage.getState().settings),
  });
  primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
  streamNumber = 0; chunkEvents = []; finishEvents = []; finishText = ''; ackSeq = -1;
  rpc.mockReset().mockImplementation(respond);
  network.setRpcResponder(rpc);
  context = new TestVoiceAudioContext();
  browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => context as unknown as AudioContext });
});
afterEach(async () => {
  await activeController?.stop();
  activeController = null;
  await browser?.micSession.teardown();
  browser?.restore();
  await account?.dispose();
  storage.setState(initialState, true);
  resetServerFeaturesClientForTests();
  vi.useRealTimers();
});
afterAll(() => network.dispose());

describe('createDaemonStreamingSttController with actual capture and daemon client', () => {
  it('publishes mute immediately and fences a pending unmute when the buffered capture ends', async () => {
    const runtime = controller();
    const params = startParams();
    const finish = createDeferred<void>();
    const chunkReply = createDeferred<void>();
    chunkEvents = [{ type: 'partial', seq: 0, text: 'buffered input', isEndpoint: true, confidence: null }];
    finishText = 'buffered input';
    rpc.mockImplementation(async request => {
      if (request.method === methods.chunk) await chunkReply.promise;
      if (request.method === methods.finish) await finish.promise;
      return respond(request);
    });
    try {
      await runtime.start(params);
      emitPcm();
      await network.waitForRpcRequest(request => request.method === methods.chunk);
      expect(requests('chunk')).toHaveLength(1);
      browser.micSession.setMuted(true);
      // Recognition has not finished, but physical mute is already confirmed.
      await runtime.setMuted(true);
      chunkReply.resolve();
      await network.waitForRpcRequest(request => request.method === methods.finish);
      expect(requests('finish')).toHaveLength(1);
      expect(params.sink.onEndpoint).not.toHaveBeenCalled();
      browser.micSession.setMuted(false);
      const unmute = runtime.setMuted(false);
      const end = runtime.stop();
      finish.resolve();
      await Promise.all([unmute, end]);
      expect(requests('start')).toHaveLength(1);
      expect(params.sink.onError).not.toHaveBeenCalled();
      expect(context.processor.onaudioprocess).toBeNull();
    } finally {
      chunkReply.resolve();
      finish.resolve();
    }
  });

  it('streams canonical mic PCM into the daemon sender and maps partial/endpoint/final events into the sink', async () => {
    const signalReceived = createDeferred<void>();
    const onSignal = vi.fn(() => { signalReceived.resolve(); });
    const runtime = controller(createTurnEndpointController({ onSignal }));
    const params = startParams();
    chunkEvents = [{ type: 'endpoint', seq: 0, transcript: '', reason: 'vad' }];
    await runtime.start(params);
    emitPcm();
    await params.events.endpoint;
    expect(params.sink.onEndpoint).toHaveBeenCalledWith('vad');
    // The recognizer reports silence endpoints while the Agent prepares its
    // reply. They must not consume the next real utterance's endpoint admission.
    expect(onSignal).not.toHaveBeenCalled();
    chunkEvents = [
      { type: 'partial', seq: 0, text: 'open', isEndpoint: false, confidence: null },
      { type: 'endpoint', seq: 0, transcript: 'open notes', reason: 'vad' },
    ];
    finishText = 'open notes';
    finishEvents = [{ type: 'final', seq: 0, text: 'open notes', language: 'en', modelPackId: 'stt-pack-1' }];
    expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).stt).toMatchObject({
      provider: 'local_neural', localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
    });
    emitPcm();
    await signalReceived.promise;
    expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'daemon_stream', transcript: 'open notes',
    }));
    await expect(runtime.stop()).resolves.toEqual({ finalText: 'open notes' });
    expect(DaemonVoiceInferenceSttStreamStartRequestSchema.parse(requests('start')[0]?.payload)).toMatchObject({
      packId: 'stt-pack-1', language: 'en', streamingMode: 'runtime', format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    const sent = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(requests('chunk')[0]?.payload);
    const bytes = new Uint8Array(Buffer.from(sent.pcm16Base64, 'base64'));
    expect(bytes).toHaveLength(640);
    expect([...bytes.slice(0, 4)]).toEqual([0, 32, 0, 32]);
    expect(params.sink.onPartial).toHaveBeenCalledWith('open');
    expect(params.sink.onFinal).toHaveBeenCalledWith('open notes');
    expect(params.sink.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(context.processor.onaudioprocess).toBeNull();
    expect(requests('finish')).toHaveLength(1);
    expect(requests('cancel')).toHaveLength(0);
  });

  it('delivers and applies a queued PCM chunk released by capture drain before finishing', async () => {
    chunkEvents = [{ type: 'final', seq: 0, text: 'drained words', language: 'en', modelPackId: 'stt-pack-1' }];
    const runtime = controller();
    await runtime.start(startParams());
    emitPcm();
    // Stop before the already admitted capture delivery microtask runs.
    await expect(runtime.stop()).resolves.toEqual({ finalText: 'drained words' });
    expect(network.requests.map(request => request.method)).toEqual([methods.start, methods.chunk, methods.finish]);
    expect(DaemonVoiceInferenceSttStreamFinishRequestSchema.parse(requests('finish')[0]?.payload).finalSeq).toBe(0);
  });

  it('retains a final transcript carried only by finish events', async () => {
    finishEvents = [{ type: 'final', seq: 0, text: 'finish event words', language: 'en', modelPackId: 'stt-pack-1' }];
    const runtime = controller();
    await runtime.start(startParams());
    await expect(runtime.stop()).resolves.toEqual({ finalText: 'finish event words' });
  });

  it('keeps a non-endpoint partial provisional when successful finish has no authoritative final', async () => {
    provisional();
    const runtime = controller();
    const params = startParams();
    await runtime.start(params);
    emitPcm();
    await params.events.partial;
    expect(params.sink.onPartial).toHaveBeenCalledWith('provisional words');
    expect(params.sink.onFinal).not.toHaveBeenCalled();
    await expect(runtime.stop()).resolves.toEqual({ finalText: '' });
    expect(requests('finish')).toHaveLength(1);
    expect(requests('cancel')).toHaveLength(0);
  });

  it.each([
    ['finish timeout', 'stt_timeout', 'daemon_streaming_stt_finish_timeout'],
    ['invalid ACK', 'provider_error', 'daemon_streaming_stt_invalid_ack'],
    ['transport failure', 'provider_error', 'daemon_streaming_stt_finalization_failed'],
  ] as const)('does not promote a provisional partial when %s prevents truthful finalization', async (failure, kind, reason) => {
    provisional();
    const runtime = controller();
    const params = startParams();
    await runtime.start(params);
    emitPcm();
    await params.events.partial;
    expect(params.sink.onPartial).toHaveBeenCalledWith('provisional words');
    const entered = createDeferred<void>();
    rpc.mockImplementation(async request => {
      if (request.method !== methods.finish) return respond(request);
      entered.resolve();
      if (failure === 'finish timeout') return new Promise<never>(() => {});
      if (failure === 'transport failure') throw new Error('socket closed');
      return DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({
        ok: true, streamId: 'stream-1', generation: 1, ackSeq: 1,
        finalText: '', language: 'en', modelPackId: 'stt-pack-1', events: [],
      });
    });
    if (failure === 'finish timeout') vi.useFakeTimers();
    const first = runtime.stop();
    const concurrent = runtime.stop();
    await entered.promise;
    if (failure === 'finish timeout') await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
    const expected = { error: expect.objectContaining({ kind, reason }) };
    await expect(first).resolves.toEqual(expected);
    await expect(concurrent).resolves.toEqual(expected);
    expect(params.sink.onFinal).not.toHaveBeenCalled();
    expect(requests('finish')).toHaveLength(1);
    expect(requests('cancel')).toHaveLength(1);
  });

  it('does not publish a stale finish after cancellation invalidates its sender', async () => {
    provisional();
    const reply = createDeferred<unknown>();
    const entered = createDeferred<void>();
    rpc.mockImplementation(async request => {
      if (request.method !== methods.finish) return respond(request);
      entered.resolve();
      return reply.promise;
    });
    const abort = new AbortController();
    const runtime = controller();
    const params = startParams({ signal: abort.signal });
    await runtime.start(params);
    emitPcm();
    await params.events.partial;
    expect(params.sink.onPartial).toHaveBeenCalledWith('provisional words');
    const first = runtime.stop();
    const concurrent = runtime.stop();
    await entered.promise;
    abort.abort();
    reply.resolve(DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({
      ok: true, streamId: 'stream-1', generation: 1, ackSeq: 0, finalText: 'stale final words',
      language: 'en', modelPackId: 'stt-pack-1', events: [],
    }));
    await expect(first).resolves.toEqual({ finalText: '' });
    await expect(concurrent).resolves.toEqual({ finalText: '' });
    expect(params.sink.onFinal).not.toHaveBeenCalled();
    expect(params.sink.onError).not.toHaveBeenCalled();
    expect(requests('finish')).toHaveLength(1);
    await network.waitForRpcRequest(request => request.method === methods.cancel);
    expect(requests('cancel')).toHaveLength(1);
  });

  it('retains the daemon finish refusal privately without publishing a provisional transcript', async () => {
    provisional();
    rpc.mockImplementation(async request => request.method === methods.finish
      ? DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({
        ok: false, errorCode: 'internal_error', error: 'private daemon finish detail', retryable: false,
      }) : respond(request));
    const runtime = controller();
    const params = startParams();
    await runtime.start(params);
    emitPcm();
    await params.events.partial;
    expect(params.sink.onPartial).toHaveBeenCalledWith('provisional words');
    const result = await runtime.stop();
    expect(result).toMatchObject({ error: { kind: 'provider_error', reason: 'daemon_streaming_stt_finalization_failed' } });
    if (!('error' in result)) throw new Error('Expected finalization failure');
    expect(result.error).toHaveProperty('cause.cause.error', 'private daemon finish detail');
    expect(Object.getOwnPropertyDescriptor(result.error, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private daemon finish detail');
    expect(params.sink.onFinal).not.toHaveBeenCalled();
    expect(requests('cancel')).toHaveLength(1);
    expect(context.processor.onaudioprocess).toBeNull();
  });

  it('waits for a stopping handle to finish before starting the next stream', async () => {
    const gate = createDeferred<void>();
    const entered = createDeferred<void>();
    rpc.mockImplementation(async request => {
      if (request.method === methods.finish && streamNumber === 1) {
        entered.resolve();
        await gate.promise;
      }
      return respond(request);
    });
    const runtime = controller();
    await runtime.start(startParams());
    const stopping = runtime.stop();
    await entered.promise;
    const starting = runtime.start(startParams());
    await Promise.resolve();
    expect(requests('start')).toHaveLength(1);
    expect(context.processor.onaudioprocess).toBeNull();
    gate.resolve();
    await stopping;
    await starting;
    expect(requests('start')).toHaveLength(2);
    expect(context.processor.onaudioprocess).not.toBeNull();
    await runtime.stop();
  });

  it('cancels the sender and capture when the caller aborts the active stream', async () => {
    const abort = new AbortController();
    const runtime = controller();
    const params = startParams({ signal: abort.signal });
    await runtime.start(params);
    abort.abort();
    emitPcm();
    await expect(runtime.stop()).resolves.toEqual({ finalText: '' });
    expect(context.processor.onaudioprocess).toBeNull();
    expect(requests('chunk')).toHaveLength(0);
    expect(requests('cancel')).toHaveLength(1);
    expect(requests('finish')).toHaveLength(0);
    expect(params.sink.onFinal).not.toHaveBeenCalled();
  });

  it('ignores an in-flight daemon response that arrives after abort and stop begin', async () => {
    const reply = createDeferred<unknown>();
    const gate = createDeferred<void>();
    const entered = createDeferred<void>();
    rpc.mockImplementation(async request => {
      if (request.method === methods.chunk) { entered.resolve(); return reply.promise; }
      if (request.method === methods.cancel) await gate.promise;
      return respond(request);
    });
    const abort = new AbortController();
    const runtime = controller();
    const params = startParams({ signal: abort.signal });
    await runtime.start(params);
    emitPcm();
    await entered.promise;
    abort.abort();
    let finished = false;
    const stopping = runtime.stop().then(result => { finished = true; return result; });
    reply.resolve(DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({
      ok: true, streamId: 'stream-1', generation: 1, ackSeq: 0, events: [
        { type: 'partial', seq: 0, text: 'late provisional words', isEndpoint: true, confidence: null },
        { type: 'endpoint', seq: 0, transcript: 'late final words', reason: 'vad' },
      ],
    }));
    await network.waitForRpcRequest(request => request.method === methods.cancel);
    expect(requests('cancel')).toHaveLength(1);
    expect(finished).toBe(false);
    expect(context.processor.onaudioprocess).toBeNull();
    expect(params.sink.onPartial).not.toHaveBeenCalled();
    expect(params.sink.onFinal).not.toHaveBeenCalled();
    expect(params.sink.onEndpoint).not.toHaveBeenCalled();
    gate.resolve();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(requests('finish')).toHaveLength(0);
    expect(requests('cancel')).toHaveLength(1);
  });

  it.each(['stop', 'abort'] as const)('clears daemon endpoint authority so a late endpoint after %s cannot signal', async terminalAction => {
    const onSignal = vi.fn();
    const endpointController = createTurnEndpointController({ onSignal });
    const abort = new AbortController();
    const runtime = controller(endpointController);
    await runtime.start(startParams({ signal: abort.signal }));
    if (terminalAction === 'abort') abort.abort();
    await runtime.stop();
    endpointController.signalEndpointDetected({ sessionId: 'active-control-session', source: 'native_stream', transcript: 'late transcript' });
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('cancels the daemon stream when PCM capture reports a startup failure without throwing', async () => {
    context.createMediaStreamSource.mockImplementationOnce(() => { throw new Error('audio device unavailable'); });
    const runtime = controller();
    const params = startParams();
    await runtime.start(params);
    await params.events.error;
    expect(params.sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error', phase: 'runtime', presentation: 'notice',
      reason: 'daemon_streaming_stt_web_mic_media_source_failed', recoverable: true,
      recoveryAction: 'retry', retryPolicy: 'user_action',
    });
    await expect(runtime.stop()).resolves.toEqual({ finalText: '' });
    expect(requests('cancel')).toHaveLength(1);
    expect(requests('finish')).toHaveLength(0);
    expect(context.processor.onaudioprocess).toBeNull();
  });

  it('publishes a PCM runtime error only after capture and sender cancellation settle', async () => {
    const gate = createDeferred<void>();
    rpc.mockImplementation(async request => {
      if (request.method === methods.cancel) await gate.promise;
      return respond(request);
    });
    const runtime = controller();
    const params = startParams();
    await runtime.start(params);
    browser.micTrack.dispatchEvent(new Event('ended'));
    let finished = false;
    const stopping = runtime.stop().then(result => { finished = true; return result; });
    await network.waitForRpcRequest(request => request.method === methods.cancel);
    expect(requests('cancel')).toHaveLength(1);
    expect(params.sink.onError).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    expect(context.processor.onaudioprocess).toBeNull();
    gate.resolve();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(requests('cancel')).toHaveLength(1);
    expect(params.sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error', phase: 'runtime', presentation: 'notice',
      reason: 'daemon_streaming_stt_web_mic_device_lost', recoverable: true,
      recoveryAction: 'retry', retryPolicy: 'user_action',
    });
  });

  it('surfaces typed daemon runtime startup errors instead of a generic start failure', async () => {
    rpc.mockImplementation(async request => request.method === methods.start
      ? DaemonVoiceInferenceSttStreamStartResponseSchema.parse({ ok: false, errorCode: 'runtime_unavailable', error: 'daemon_voice_inference_runtime_unavailable', retryable: false })
      : respond(request));
    const runtime = controller();
    const sink = createSink();
    const params = startParams({ sink });
    await runtime.start(params);
    expect(params.sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error', phase: 'runtime', presentation: 'notice',
      reason: 'daemon_streaming_stt_runtime_unavailable', recoverable: true,
      recoveryAction: 'retry', retryPolicy: 'user_action',
    });
    expect(daemonSpeechStreamDiagnostics.snapshot().lastStartFailure).toMatchObject({ code: 'runtime_unavailable' });
    expect(browser.micSession.getStream()).toBeNull();
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    expect(requests('chunk')).toHaveLength(0);
    const { classifyVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
    const { resolveVoiceAttemptControl } = await import('@/components/voice/attempt/resolveVoiceAttemptControl');
    const { projectVoiceAttemptPresentation } = await import('@/components/voice/attempt/projectVoiceAttemptPresentation');
    const { resolveVoicePresenceCaption } = await import('@/components/voice/presence/resolveVoicePresenceCaption');
    const { t } = await import('@/text');
    const failure = classifyVoiceMachineError(sink.onError.mock.calls[0]?.[0]);
    const control = resolveVoiceAttemptControl({
      surfaceState: 'error', tone: 'error', status: 'disconnected',
      sessionId: params.sessionId, canStop: false, muted: false, capturing: false,
      startAdmitted: true, hasRecovery: true, canDismissFailedAttempt: true,
    });
    const presentation = projectVoiceAttemptPresentation({
      control, attemptId: 'french-start', ended: false,
      errorCode: failure.kind, errorMessage: failure.reason, recoveryAction: failure.recoveryAction,
      recoveryContext: { connectRecoveryTarget: { kind: 'unavailable' }, runtimeRecoveryTarget: null,
        attemptSessionId: params.sessionId, startSessionId: params.sessionId, globalStartAuthorized: false },
      serviceTitle: 'Local conversation', agentTitle: null, agentMachineLabel: null,
    });
    expect(presentation.failureMessage).toBe(t('settingsVoice.local.daemonInference.states.runtimeUnavailable'));
    expect(resolveVoicePresenceCaption({
      ...control, captionLabel: presentation.failureMessage ?? '',
    })).toBe(presentation.failureMessage);
  });

  it('retains the sender-start cause privately while publishing a safe machine failure', async () => {
    const boundaryFailure = new Error('private transport detail');
    rpc.mockImplementation(async request => {
      if (request.method === methods.start) throw boundaryFailure;
      return respond(request);
    });
    const params = startParams();
    await controller().start(params);
    const failure: unknown = vi.mocked(params.sink.onError).mock.calls[0]?.[0];
    expect(failure).toMatchObject({ reason: 'daemon_streaming_stt_start_failed' });
    expect(failure).toHaveProperty('cause');
    expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(failure)).not.toContain('private transport detail');
    let cause = failure;
    while (cause && typeof cause === 'object' && 'cause' in cause) cause = cause.cause;
    expect(cause).toBe(boundaryFailure);
    expect(browser.micSession.getStream()).toBeNull();
  });

  it('records the failing sender-start sub-step without exposing a daemon internal-error message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockImplementation(async request => request.method === methods.start
      ? DaemonVoiceInferenceSttStreamStartResponseSchema.parse({ ok: false, errorCode: 'internal_error',
        error: 'private transcript token=secret', retryable: false })
      : respond(request));
    try {
      const params = startParams();
      await controller().start(params);
      expect(params.sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'daemon_streaming_stt_internal_error' }));
      const safe = { code: 'internal_error', message: 'redacted_start_failure', step: 'sender_start', errorClass: 'Error' };
      expect(daemonSpeechStreamDiagnostics.snapshot().lastStartFailure).toEqual(safe);
      expect(warn).toHaveBeenCalledWith('[daemonVoiceInference] streaming STT start failed ' + JSON.stringify(safe));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      expect(requests('start')).toHaveLength(1);
      expect(requests('chunk')).toHaveLength(0);
      expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('distinguishes a malformed daemon start response with its known closed discriminator', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockImplementation(async request => request.method === methods.start ? { private: 'token-secret' } : respond(request));
    try {
      const params = startParams();
      await controller().start(params);
      expect(params.sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'daemon_streaming_stt_internal_error' }));
      expect(daemonSpeechStreamDiagnostics.snapshot().lastStartFailure).toEqual({
        code: 'internal_error', message: 'daemon_voice_inference_invalid_response', step: 'sender_start', errorClass: 'Error',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      expect(requests('start')).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it('cancels the active daemon stream when PCM chunk delivery fails during capture', async () => {
    rpc.mockImplementation(async request => request.method === methods.chunk
      ? DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: false, errorCode: 'request_timeout', error: 'daemon_voice_inference_substream_response_timeout', retryable: true })
      : respond(request));
    const runtime = controller();
    const params = startParams();
    await runtime.start(params);
    emitPcm();
    await params.events.error;
    expect(params.sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error', phase: 'runtime', presentation: 'notice',
      reason: 'daemon_streaming_stt_pcm_chunk_failed', recoverable: true,
      recoveryAction: 'retry', retryPolicy: 'user_action',
    });
    const failure: unknown = vi.mocked(params.sink.onError).mock.calls[0]?.[0];
    expect(failure).toHaveProperty('cause');
    expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable).toBe(false);
    expect(Reflect.get(failure as object, 'cause')).toMatchObject({ code: 'request_timeout' });
    expect(failure).toHaveProperty('cause.cause.error', 'daemon_voice_inference_substream_response_timeout');
    await network.waitForRpcRequest(request => request.method === methods.cancel);
    expect(requests('cancel')).toHaveLength(1);
    expect(requests('finish')).toHaveLength(0);
    expect(context.processor.onaudioprocess).toBeNull();
  });

  it('does not start a late daemon sender or PCM capture after cancellation, and permits retry', async () => {
    const gate = createDeferred<void>();
    const entered = createDeferred<void>();
    const readCredentials = TokenStorage.getCredentialsForServerUrl;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return readCredentials(...args);
    });
    const abort = new AbortController();
    const runtime = controller();
    const params = startParams();
    const starting = runtime.start({ ...params, signal: abort.signal });
    await entered.promise;
    abort.abort();
    gate.resolve();
    await starting;
    expect(requests('start')).toHaveLength(0);
    expect(browser.micSession.getStream()).toBeNull();
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    await runtime.start(params);
    expect(requests('start')).toHaveLength(1);
    expect(context.processor.onaudioprocess).not.toBeNull();
    await runtime.stop();
  });

});
