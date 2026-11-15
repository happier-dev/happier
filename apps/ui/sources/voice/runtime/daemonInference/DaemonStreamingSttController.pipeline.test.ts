import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
  DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
  DaemonVoiceInferenceSttStreamStartRequestSchema, DaemonVoiceInferenceSttStreamStartResponseSchema,
  DaemonVoiceInferenceSttStreamChunkRequestSchema, DaemonVoiceInferenceSttStreamChunkResponseSchema,
  DaemonVoiceInferenceSttStreamFinishRequestSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema,
  DaemonVoiceInferenceSttStreamCancelRequestSchema, DaemonVoiceInferenceSttStreamCancelResponseSchema,
} from '@happier-dev/protocol/daemon/voiceInference';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import type { HappierAudioStreamNativeModule } from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

const nativeBoundary = vi.hoisted(() => ({ module: null as HappierAudioStreamNativeModule | null }));
// Physical Expo module discovery; shared native registry/capture/coordinator stay real.
vi.mock('expo-modules-core', async original => ({
  ...await original<typeof import('expo-modules-core')>(),
  requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative' ? nativeBoundary.module : null,
}));

// The native module has one process identity; install it before Sync can
// resolve the shared registry, whose missing-module decision is cached.
const nativeAudio = createNativeVoicePcmCaptureHarness(false);
nativeBoundary.module = nativeAudio.nativeModule;
const network = await installSessionOpsNetworkBoundary();
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
const { VoiceLocalSttSchema } = await import('@/sync/domains/settings/voiceLocalSttSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { createDaemonStreamingSttController, createDefaultDaemonVoiceInferenceClient } = await import('./DaemonStreamingSttController');
const { createWebDaemonSpeechPcmCapture } = await import('./WebDaemonSpeechPcmCapture.web');
const { createDaemonSpeechPcmCapture } = await import('./DaemonSpeechPcmCapture.native');
const { resolveDaemonSpeechPcmCaptureAvailability } = await import('./resolveDaemonSpeechPcmCaptureAvailability.native');
const { createNativeMicSession } = await import('../mic/NativeMicSession');

const features = FeaturesResponseSchema.parse({
  features: { voice: { enabled: true }, execution: { runs: { enabled: true } },
    machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } } },
  capabilities: { machines: { liveStream: { serverRouted: {
    caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
  } } } },
});
const initialState = storage.getState();
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
let browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
let context: InstanceType<typeof TestVoiceAudioContext>;
let runtime: ReturnType<typeof createDaemonStreamingSttController> | null = null;
let nativeMic: MicSession | null = null;
const methods = {
  start: 'daemon.voiceInference.stt.stream.start', chunk: 'daemon.voiceInference.stt.stream.chunk',
  finish: 'daemon.voiceInference.stt.stream.finish', cancel: 'daemon.voiceInference.stt.stream.cancel',
};
const requests = (name: keyof typeof methods) => network.requests.filter(request => request.method === methods[name]);
const createSink = () => ({ onAudioStarted: vi.fn(), onPartial: vi.fn(), onFinal: vi.fn(), onEndpoint: vi.fn(), onError: vi.fn() });
async function respond(request: SessionOpsRpcRequest): Promise<unknown> {
  expect(request.targetId).toBe('pipeline-machine');
  if (request.method === methods.start) {
    const start = DaemonVoiceInferenceSttStreamStartRequestSchema.parse(request.payload);
    return DaemonVoiceInferenceSttStreamStartResponseSchema.parse({ ok: true,
      requestId: start.requestId, streamId: 'pipeline-stream', generation: 1, ackSeq: -1,
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
  }
  if (request.method === methods.finish) {
    const finish = DaemonVoiceInferenceSttStreamFinishRequestSchema.parse(request.payload);
    return DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({ ok: true,
      streamId: finish.streamId, generation: finish.generation, ackSeq: finish.finalSeq,
      finalText: 'all admitted words', language: 'en', modelPackId: 'pack', events: [] });
  }
  if (request.method === methods.cancel) return DaemonVoiceInferenceSttStreamCancelResponseSchema.parse({
    ok: true, ...DaemonVoiceInferenceSttStreamCancelRequestSchema.parse(request.payload),
  });
  throw new Error('unexpected daemon request: ' + request.method);
}

beforeEach(async () => {
  network.resetRequests();
  await network.addHome('https://capture-pipeline.example.test', 'artifact-account');
  account = await createPlainArtifactHomeFixture('https://capture-pipeline.example.test', {
    serverFeatures: features,
    handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
  });
  const machine = createMachineFixture({ id: 'pipeline-machine', activeAt: Date.now() });
  storage.getState().applyMachines([machine], true, { sourceServerId: account.home.id });
  const voice = voiceSettingsParse({ providerId: 'local_conversation',
    executionMachine: { mode: 'fixed', machineId: machine.id } });
  const configuredVoice = writeLocalConversationVoiceSettings(voice, {
    ...readLocalConversationVoiceSettings(voice),
    stt: VoiceLocalSttSchema.parse({ provider: 'local_neural', localNeural: {
      assetId: 'pack', language: 'en', execution: 'daemon',
    } }),
  });
  storage.getState().applySettingsLocal({
    experiments: true, featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true },
    ...normalizeVoiceSettingsLocalDelta({ voice: configuredVoice }, storage.getState().settings),
  });
  primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
  network.setRpcResponder(respond);
  context = new TestVoiceAudioContext();
  browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => context as unknown as AudioContext });
});
afterEach(async () => {
  await runtime?.stop();
  runtime = null;
  await nativeMic?.teardown();
  nativeMic = null;
  await browser?.micSession.teardown();
  browser?.restore();
  await account?.dispose();
  storage.setState(initialState, true);
  resetServerFeaturesClientForTests();
  vi.useRealTimers();
});
afterAll(async () => {
  await nativeAudio.coordinator.dispose();
  await network.dispose();
});

describe('daemon STT capture pipeline through the default client', () => {
  it.each([
    { abortSuperseded: false, replaceController: false },
    { abortSuperseded: true, replaceController: false },
    { abortSuperseded: true, replaceController: true },
  ])('serializes overlapping starts through retirement of the preceding stream ($abortSuperseded/$replaceController)', async ({ abortSuperseded, replaceController }) => {
    const call = new AbortController();
    const supersededCapture = new AbortController();
    let releaseStart!: () => void;
    const startReady = new Promise<void>(resolve => { releaseStart = resolve; });
    let enteredStart!: () => void;
    const startEntered = new Promise<void>(resolve => { enteredStart = resolve; });
    let applicationActive = false;
    let applicationRequestId: string | null = null;
    const lifecycle: string[] = [];
    network.setRpcResponder(async request => {
      lifecycle.push(request.method);
      if (request.method === methods.start) {
        const start = DaemonVoiceInferenceSttStreamStartRequestSchema.parse(request.payload);
        if (applicationRequestId) expect(start.requestId).toBe(applicationRequestId);
        applicationRequestId = start.requestId;
        // The daemon permits one active stream for the call's admitted application.
        if (applicationActive) {
          return { ok: false, errorCode: 'invalid_stream_state', error: 'invalid_stream_state' };
        }
        applicationActive = true;
        enteredStart();
        await startReady;
        lifecycle.push('start-replied');
      }
      if (request.method === methods.chunk) {
        const chunk = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(request.payload);
        return DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: true,
          streamId: chunk.streamId, generation: chunk.generation, ackSeq: chunk.seq, events: [],
        });
      }
      if (request.method === methods.cancel || request.method === methods.finish) applicationActive = false;
      return respond(request);
    });
    const sink = createSink();
    const client = createDefaultDaemonVoiceInferenceClient();
    const createController = () => createDaemonStreamingSttController({
      createClient: () => client,
      getSettings: () => storage.getState().settings, createPcmCapture: createWebDaemonSpeechPcmCapture,
    });
    runtime = createController();
    const startListening = (signal?: AbortSignal) => runtime!.start({
      sessionId: 'overlap', micSession: browser.micSession, sink, callSignal: call.signal, signal,
    });
    try {
      const first = startListening(supersededCapture.signal);
      await Promise.race([startEntered, first.then(() => { throw new Error('initial_stream_not_started'); })]);
      if (abortSuperseded) supersededCapture.abort();
      if (replaceController) runtime = createController();
      const second = startListening();
      // Let a competing request reach the network while the first reply is held.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      releaseStart();
      await Promise.all([first, second]);
      expect(sink.onError, lifecycle.join(' -> ')).not.toHaveBeenCalled();
      context.emitInput(new Float32Array(480).fill(0.25));
      await vi.waitFor(() => expect(requests('chunk')).toHaveLength(1));
      await expect(runtime.stop()).resolves.toEqual({ finalText: 'all admitted words' });
      expect(requests('finish')).toHaveLength(1);
    } finally {
      releaseStart();
      call.abort();
    }
  });

  it('reports native source finalization failure instead of returning a successful transcript', async () => {
    const harness = nativeAudio;
    expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('available');
    harness.nativeModule.stop.mockRejectedValueOnce(new Error('native_stop_failed'));
    nativeMic = createNativeMicSession();
    runtime = createDaemonStreamingSttController({
      getSettings: () => storage.getState().settings, createPcmCapture: createDaemonSpeechPcmCapture,
    });
    const sink = createSink();
    await runtime.start({ capturePurpose: 'dictation', micSession: nativeMic, sink });
    expect(harness.nativeModule.start).toHaveBeenCalledWith(expect.objectContaining({
      sampleRate: 16_000, channels: 1, frameMs: 20,
    }));
    await expect(runtime.stop()).resolves.toMatchObject({ error: {
      kind: 'provider_error', reason: 'daemon_streaming_stt_finalization_failed',
    } });
    expect(requests('finish')).toHaveLength(0);
    expect(requests('cancel')).toHaveLength(1);
    expect(sink.onFinal).not.toHaveBeenCalled();
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
  });

  it.each([0, 50, 100, 150])('maintains 20ms capture admission with %ims recognition replies and drains finals', async latencyMs => {
    vi.useFakeTimers();
    const sends: Array<{ seq: number; at: number }> = [];
    let inFlight = 0;
    let peakInFlight = 0;
    network.setRpcResponder(async request => {
      if (request.method === methods.chunk) {
        const chunk = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(request.payload);
        sends.push({ seq: chunk.seq, at: Date.now() });
        peakInFlight = Math.max(peakInFlight, ++inFlight);
        return new Promise(resolve => setTimeout(() => {
          --inFlight;
          resolve(DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: true,
            streamId: chunk.streamId, generation: chunk.generation, ackSeq: chunk.seq,
            events: [{ type: 'partial', seq: chunk.seq, text: 'words-' + chunk.seq, isEndpoint: false, confidence: null }],
          }));
        }, latencyMs));
      }
      if (request.method === methods.finish) expect(inFlight).toBe(0);
      return respond(request);
    });
    const sink = createSink();
    runtime = createDaemonStreamingSttController({
      getSettings: () => storage.getState().settings, createPcmCapture: createWebDaemonSpeechPcmCapture,
    });
    await runtime.start({ micSession: browser.micSession, sink });
    for (let frame = 0; frame < 25; frame++) {
      context.emitInput(new Float32Array(480).fill(0.25));
      await vi.advanceTimersByTimeAsync(20);
      expect(sends).toHaveLength(frame + 1);
    }
    const stopping = runtime.stop();
    await vi.runAllTimersAsync();
    await expect(stopping).resolves.toEqual({ finalText: 'all admitted words' });
    expect(sends.map(({ seq }) => seq)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(sends.slice(1).every((send, index) => send.at - sends[index]!.at === 20)).toBe(true);
    expect(peakInFlight).toBeLessThanOrEqual(8);
    if (latencyMs > 20) expect(peakInFlight).toBeGreaterThan(1);
    expect(sink.onPartial).toHaveBeenCalledTimes(25);
    expect(sink.onError).not.toHaveBeenCalled();
    expect(context.processor.onaudioprocess).toBeNull();
    expect(requests('finish')).toHaveLength(1);
    expect(requests('cancel')).toHaveLength(0);
  });
});
