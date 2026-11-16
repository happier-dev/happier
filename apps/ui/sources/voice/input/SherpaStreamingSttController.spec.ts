import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, type Deferred } from '@/dev/testkit';
import { createHash } from 'node:crypto';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import { VOICE_RUNTIME_STT_PCM_FORMAT } from '@happier-dev/protocol/voice/runtimeConfig';
import type { SherpaNativeModule, SherpaNativeStreamingFinalResult } from '@happier-dev/sherpa-native';

import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { SttSink } from '@/voice/input/sttController';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import type { VoicePcmCapture } from '@happier-dev/audio-stream-native';

const runtime = vi.hoisted(() => ({
  realCapture: null as VoicePcmCapture | null,
  sherpaAvailable: true,
  fs: null as ReturnType<typeof createMemFs> | null,
}));
let captureHarness: ReturnType<typeof createNativeVoicePcmCaptureHarness>;
const captureHarnesses: ReturnType<typeof createNativeVoicePcmCaptureHarness>[] = [];
function useCapture(aecAvailable = true) {
  const harness = createNativeVoicePcmCaptureHarness(aecAvailable);
  captureHarnesses.push(harness);
  captureHarness = harness;
  runtime.realCapture = harness.capture;
  return harness;
}

vi.mock('expo-file-system', () => ({
  get File() { return runtime.fs!.fs.File; },
  get Directory() { return runtime.fs!.fs.Directory; },
  get Paths() { return runtime.fs!.fs.Paths; },
}));
vi.mock('@happier-dev/audio-stream-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/audio-stream-native')>(),
  getSharedVoicePcmCapture: () => runtime.realCapture,
}));

const packBytes = new TextEncoder().encode('native SDK model boundary fixture');
const installedManifest = parseModelPackManifest({
  packId: 'dummy-pack', kind: 'stt_sherpa', model: 'zipformer_transducer', version: 'v1',
  files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path) => ({
    path, url: `https://example.com/${path}`,
    sha256: createHash('sha256').update(packBytes).digest('hex'), sizeBytes: packBytes.length,
  })),
});
const packDirUri = 'file:///docs/happier/voice/modelPacks/dummy-pack';

const sherpaStreamingCreate = vi.fn(async () => {});
const sherpaStreamingPushFrame = vi.fn<SherpaNativeModule['pushAudioFrame']>(async () => ({ text: '', isEndpoint: false }));
const sherpaStreamingFinish = vi.fn<() => Promise<SherpaNativeStreamingFinalResult>>(
  async () => ({ status: 'finalized', text: '' }),
);
const sherpaCancel = vi.fn(async () => {});
let pushEntered = createDeferred<void>();
let cancelEntered = createDeferred<void>();

vi.mock('@happier-dev/sherpa-native', () => ({
  getOptionalHappierSherpaNativeModule: () => runtime.sherpaAvailable ? {
    createStreamingRecognizer: sherpaStreamingCreate,
    pushAudioFrame: sherpaStreamingPushFrame,
    finishStreaming: sherpaStreamingFinish,
    cancel: sherpaCancel,
  } : null,
}));

const { createNativeMicSession } = await import('@/voice/runtime/mic/NativeMicSession');
function createMicSession(): MicSession {
  const session = createNativeMicSession();
  vi.spyOn(session, 'ensureActive');
  vi.spyOn(session, 'teardown');
  return session;
}

function createSink(): SttSink & Record<'onAudioStarted' | 'onPartial' | 'onFinal' | 'onEndpoint' | 'onError', ReturnType<typeof vi.fn>> & { errorReported: Deferred<void> } {
  const errorReported = createDeferred<void>();
  return {
    onAudioStarted: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onEndpoint: vi.fn(),
    onError: vi.fn(() => { errorReported.resolve(); }),
    errorReported,
  };
}

function localNeuralSettings() {
  return {
    voice: {
      providerId: 'local_direct',
      providers: {
        local_direct: { schemaVersion: 1, config: {
          stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
        } },
      },
    },
  };
}

async function emitAudioFrame(pcm16leBase64 = 'AAE='): Promise<void> {
  captureHarness.emit(pcm16leBase64);
  await captureHarness.capture.waitForDrain();
}

async function queueOverflow(): Promise<void> {
  captureHarness.emit();
  await pushEntered.promise;
  expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 7; index += 1) captureHarness.emit();
  expect(sherpaCancel).not.toHaveBeenCalled();
  // The eighth admitted frame fits; the ninth crosses the controller-owned
  // queue budget through the real capture subscriber, not a synthetic callback.
  captureHarness.emit();
}

describe('SherpaStreamingSttController (native shared capture)', () => {
  beforeEach(() => {
    useCapture();
    runtime.sherpaAvailable = true;
    runtime.fs = createMemFs();
    runtime.fs.files.set(`${packDirUri}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: installedManifest })));
    for (const file of installedManifest.files) runtime.fs.files.set(`${packDirUri}/${file.path}`, packBytes);
    sherpaStreamingCreate.mockReset();
    sherpaStreamingCreate.mockResolvedValue(undefined);
    sherpaStreamingPushFrame.mockReset();
    pushEntered = createDeferred<void>();
    sherpaStreamingPushFrame.mockImplementation(async () => { pushEntered.resolve(); return { text: '', isEndpoint: false }; });
    sherpaStreamingFinish.mockReset();
    sherpaStreamingFinish.mockResolvedValue({ status: 'finalized', text: '' });
    sherpaCancel.mockReset();
    cancelEntered = createDeferred<void>();
    sherpaCancel.mockImplementation(async () => { cancelEntered.resolve(); });
  });
  afterEach(async () => {
    for (const harness of captureHarnesses.splice(0)) {
      await harness.capture.dispose();
      await harness.coordinator.dispose();
    }
    vi.restoreAllMocks();
  });

  it('acquires the sole shared conversation/AEC capture with a bounded async subscriber', async () => {
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ capturePurpose: 'conversation', micSession, sink: createSink() });

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(sherpaStreamingCreate).toHaveBeenCalledWith(expect.objectContaining({
      assetsDir: '/docs/happier/voice/modelPacks/dummy-pack',
      sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
    }));
    expect(captureHarness.nativeModule.start).toHaveBeenCalledWith(expect.objectContaining({
      sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
      frameMs: 20,
    }));
    expect(captureHarness.apply).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { mode: 'conversation', input: true, output: true, aec: 'required', capture: 'host_managed' },
    }));
    expect(captureHarness.capture.getSnapshot().subscriberCount).toBe(1);
  });

  it('finishes admitted final-word PCM and admits Dictation on hardware without AEC', async () => {
    const harness = useCapture(false);
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const frames: string[] = [];
    sherpaStreamingPushFrame.mockImplementation(async (input) => {
      frames.push(input.pcm16leBase64);
      pushEntered.resolve();
      if (frames.length === 1) await first;
      return { text: frames.length === 1 ? 'last' : 'last word', isEndpoint: false };
    });
    sherpaStreamingFinish.mockImplementation(async () => ({ status: 'finalized', text: frames.length === 2 ? 'last word' : 'truncated' }));
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ capturePurpose: 'dictation', micSession: createMicSession(), sink: createSink() });
    expect(harness.apply).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({ mode: 'dictation', input: true, output: false, aec: 'off' }) }));
    harness.emit('AAE=');
    harness.emit('AgM=');
    await pushEntered.promise;
    expect(frames).toEqual(['AAE=']);
    const captureStopped = createDeferred<void>();
    harness.nativeModule.stop.mockImplementationOnce(async () => { captureStopped.resolve(); });
    const stopping = controller.stop();
    await captureStopped.promise;
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(stopping).resolves.toEqual({ finalText: 'last word' });
    expect(frames).toEqual(['AAE=', 'AgM=']);
  });

  it('delivers onset PCM emitted by native start before shared capture acquisition resolves', async () => {
    const harness = useCapture(false);
    vi.mocked(harness.nativeModule.start).mockImplementationOnce(async () => {
      harness.emit('AgM=');
      return { streamId: 'native-stream' };
    });
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'onset words', isEndpoint: true });
    sherpaStreamingFinish.mockResolvedValueOnce({ status: 'finalized', text: 'onset words' });
    const sink = createSink();
    const onEndpointSignal = vi.fn();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings(), onEndpointSignal });

    try {
      await controller.start({ capturePurpose: 'dictation', micSession: createMicSession(), sink });
      await harness.capture.waitForDrain();

      expect(sherpaStreamingPushFrame).toHaveBeenCalledWith(expect.objectContaining({ pcm16leBase64: 'AgM=' }));
      expect(sink.onPartial).toHaveBeenCalledWith('onset words');
      expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({ source: 'native_stream', transcript: 'onset words' }));
      await expect(controller.stop()).resolves.toEqual({ finalText: 'onset words' });
    } finally {
      await controller.stop();
      await harness.capture.dispose();
    }
  });

  it('retires capture acquired after cancellation without delivering onset or retaining a stale handle', async () => {
    const harness = useCapture(false);
    const signal = new AbortController();
    vi.mocked(harness.nativeModule.start).mockImplementationOnce(async () => {
      harness.emit();
      signal.abort();
      return { streamId: 'native-stream' };
    });
    const sink = createSink();
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    try {
      await controller.start({ capturePurpose: 'dictation', micSession, sink, signal: signal.signal });
      expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
      expect(sherpaStreamingPushFrame).not.toHaveBeenCalled();
      expect(sherpaCancel).toHaveBeenCalledTimes(1);
      expect(micSession.teardown).toHaveBeenCalledTimes(1);
      await expect(controller.stop()).resolves.toEqual({ finalText: '' });

      await controller.start({ capturePurpose: 'dictation', micSession: createMicSession(), sink: createSink() });
      harness.emit('AgM=');
      await harness.capture.waitForDrain();
      expect(sherpaStreamingPushFrame).toHaveBeenCalledWith(expect.objectContaining({ pcm16leBase64: 'AgM=' }));
    } finally {
      await controller.stop();
      await harness.capture.dispose();
    }
  });

  it('cancels native decode immediately when graceful finishing is aborted', async () => {
    const harness = useCapture(false);
    const captureStopped = createDeferred<void>();
    const stop = vi.mocked(harness.nativeModule.stop);
    const stopNative = stop.getMockImplementation();
    if (!stopNative) throw new Error('Native capture stop boundary missing');
    stop.mockImplementationOnce(async (...args) => { await stopNative(...args); captureStopped.resolve(); });
    let settlePush!: () => void;
    sherpaStreamingPushFrame.mockImplementation(async () => {
      pushEntered.resolve();
      await new Promise<void>((resolve) => { settlePush = resolve; });
      return { text: 'aborted words', isEndpoint: false };
    });
    const signal = new AbortController();
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ capturePurpose: 'dictation', micSession: createMicSession(), sink, signal: signal.signal });
    harness.emit();
    await pushEntered.promise;
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);
    const stopping = controller.stop();
    signal.abort();
    try {
      await cancelEntered.promise;
      expect(sherpaCancel).toHaveBeenCalledTimes(1);
      await captureStopped.promise;
      expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
    } finally {
      settlePush();
      await stopping;
    }
    expect(sherpaStreamingFinish).not.toHaveBeenCalled();
    expect(sink.onPartial).not.toHaveBeenCalled();
  });

  it('emits audio start, partial/final transcript, and runtime-owned endpoint from shared frames', async () => {
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'hello sherpa', isEndpoint: true });
    const sink = createSink();
    const onEndpointSignal = vi.fn();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings(), onEndpointSignal });
    await controller.start({ micSession: createMicSession(), sink });
    await emitAudioFrame();

    expect(sink.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(sink.onPartial).toHaveBeenCalledWith('hello sherpa');
    expect(sink.onFinal).toHaveBeenCalledWith('hello sherpa');
    expect(sink.onEndpoint).toHaveBeenCalledWith('vad');
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({ source: 'native_stream', transcript: 'hello sherpa' }));
  });

  it('drops muted frames through the subscriber delivery predicate', async () => {
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession, sink: createSink() });
    micSession.setMuted(true);
    await emitAudioFrame();
    expect(sherpaStreamingPushFrame).not.toHaveBeenCalled();
  });

  it('requires a mic session before any native work', async () => {
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await expect(controller.start({ sink: createSink() } as never)).rejects.toThrow('mic_session_required');
    expect(captureHarness.nativeModule.start).not.toHaveBeenCalled();
  });

  it('does not start capture when recognizer creation fails and rolls back the mic facade', async () => {
    sherpaStreamingCreate.mockRejectedValueOnce(new Error('recognizer_init_failed'));
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await expect(controller.start({ micSession, sink: createSink() })).rejects.toThrow('recognizer_init_failed');
    expect(captureHarness.nativeModule.start).not.toHaveBeenCalled();
    expect(micSession.teardown).toHaveBeenCalledTimes(1);
  });

  it('does not create a recognizer or capture after model setup resolves for an aborted start, and permits retry', async () => {
    let resolveMetadata!: (value: string) => void;
    const readingMetadata = createDeferred<void>();
    const metadataRead = vi.spyOn(runtime.fs!.fs.File.prototype, 'text');
    metadataRead.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveMetadata = resolve; readingMetadata.resolve(); }));
    const abortController = new AbortController();
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    const starting = controller.start({
      micSession,
      sink: createSink(),
      signal: abortController.signal,
    });
    await readingMetadata.promise;
    expect(metadataRead).toHaveBeenCalledTimes(1);
    abortController.abort();
    resolveMetadata(JSON.stringify({ manifest: installedManifest }));
    await starting;

    expect(sherpaStreamingCreate).not.toHaveBeenCalled();
    expect(captureHarness.nativeModule.start).not.toHaveBeenCalled();
    expect(micSession.teardown).toHaveBeenCalledTimes(1);

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    expect(sherpaStreamingCreate).toHaveBeenCalledTimes(1);
    expect(captureHarness.nativeModule.start).toHaveBeenCalledTimes(1);
  });

  it('rolls back recognizer, capture lease, and mic when capture acquisition fails', async () => {
    const harness = useCapture(false);
    vi.mocked(harness.nativeModule.start).mockRejectedValueOnce(new Error('audio_session_failed'));
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await expect(controller.start({ micSession, sink: createSink() })).rejects.toThrow('audio_session_failed');
    expect(sherpaCancel).toHaveBeenCalledTimes(1);
    expect(micSession.teardown).toHaveBeenCalledTimes(1);
    expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
    await expect(controller.stop()).resolves.toEqual({ finalText: '' });
    await controller.start({ micSession: createMicSession(), sink: createSink() });
    harness.emit('AgM=');
    await harness.capture.waitForDrain();
    expect(sherpaStreamingPushFrame).toHaveBeenCalledWith(expect.objectContaining({ pcm16leBase64: 'AgM=' }));
    await controller.stop();
    await harness.capture.dispose();
  });

  it('surfaces pack/runtime/backpressure failures without leaking capture', async () => {
    runtime.fs!.files.delete(`${packDirUri}/pack.json`);
    const micSession = createMicSession();
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession, sink });
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_pack_not_installed' }));
    expect(captureHarness.nativeModule.start).not.toHaveBeenCalled();

    runtime.realCapture = null;
    runtime.sherpaAvailable = false;
    const unavailableSink = createSink();
    const unavailableController = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await unavailableController.start({ micSession: createMicSession(), sink: unavailableSink });
    expect(unavailableSink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_unavailable' }));
  });

  it('releases and drains exactly its lease before finalizing, and detaches abort ownership', async () => {
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');
    sherpaStreamingFinish.mockResolvedValueOnce({ status: 'finalized', text: 'final words' });
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink: createSink(), signal: abortController.signal });
    const result = await controller.stop();

    expect(captureHarness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(captureHarness.capture.getSnapshot().subscriberCount).toBe(0);
    expect(sherpaStreamingFinish).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ finalText: 'final words' });
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not promote a provisional partial when recognizer finalization fails, and cancels exactly once', async () => {
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'provisional words', isEndpoint: false });
    sherpaStreamingFinish.mockRejectedValueOnce(new Error('recognizer_finalization_failed'));
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });
    await emitAudioFrame();

    const firstStop = controller.stop();
    const concurrentStop = controller.stop();
    await expect(firstStop).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'local_neural_stt_finalization_failed',
      }),
    });
    await expect(concurrentStop).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'local_neural_stt_finalization_failed',
      }),
    });

    expect(sink.onPartial).toHaveBeenCalledWith('provisional words');
    expect(sherpaStreamingFinish).toHaveBeenCalledTimes(1);
    expect(sherpaCancel).toHaveBeenCalledTimes(1);
  });

  it('fails typed rather than submitting the last interim partial when native reports the job cancelled', async () => {
    // The pack was invalidated (or the job cancelled) while the tail decode was
    // claimed: there is no final transcript, only the revisable partial the user
    // already saw. Submitting it is user-visible wrong text.
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'provisional words', isEndpoint: false });
    sherpaStreamingFinish.mockResolvedValueOnce({ status: 'cancelled' });
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });
    await emitAudioFrame();
    expect(sink.onPartial).toHaveBeenCalledWith('provisional words');

    await expect(controller.stop()).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'local_neural_stt_finalization_failed',
      }),
    });
  });

  it('fails typed rather than submitting the last interim partial when native no longer holds the job', async () => {
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'provisional words', isEndpoint: false });
    sherpaStreamingFinish.mockResolvedValueOnce({ status: 'missing' });
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });
    await emitAudioFrame();

    await expect(controller.stop()).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'local_neural_stt_finalization_failed',
      }),
    });
  });

  it('keeps a finalized empty utterance a successful empty transcript', async () => {
    // Silence is not a failure: the job finalized, it simply had nothing to say.
    sherpaStreamingFinish.mockResolvedValueOnce({ status: 'finalized', text: '' });
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink: createSink() });

    await expect(controller.stop()).resolves.toEqual({ finalText: '' });
  });

  it('maps dropped or failed subscriber frames to typed errors and cleanup', async () => {
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });
    let finishFrame!: () => void;
    sherpaStreamingPushFrame.mockImplementationOnce(() => new Promise((resolve) => {
      finishFrame = () => resolve({ text: '', isEndpoint: false });
      pushEntered.resolve();
    }));
    await queueOverflow();
    await cancelEntered.promise;
    expect(sherpaCancel).toHaveBeenCalledTimes(1);
    finishFrame();
    expect(sink.onError).not.toHaveBeenCalled();
    await sink.errorReported.promise;
    expect(captureHarness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_pcm_backpressure' }));

    const secondSink = createSink();
    const second = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await second.start({ micSession: createMicSession(), sink: secondSink });
    sherpaStreamingPushFrame.mockRejectedValueOnce(new Error('push_failed'));
    captureHarness.emit();
    expect(secondSink.onError).not.toHaveBeenCalled();
    await secondSink.errorReported.promise;
    expect(captureHarness.nativeModule.stop).toHaveBeenCalledTimes(2);
    expect(secondSink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_pcm_frame_failed' }));
  });

  it('marks the native job cancelled before waiting on the capture drain', async () => {
    // The frame already inside the recognizer decodes for as long as it takes.
    // Waiting for the capture drain first means the cancel only lands once the
    // work it was meant to stop has already finished, so the ordering is the
    // whole contract here -- a hung drain must not hide the cancel.
    const order: string[] = [];
    let resolveDecode!: () => void;
    sherpaStreamingPushFrame.mockImplementationOnce(async () => {
      pushEntered.resolve();
      await new Promise<void>((resolve) => { resolveDecode = resolve; });
      order.push('drained');
      return { text: '', isEndpoint: false };
    });
    sherpaCancel.mockImplementationOnce(async () => { order.push('cancel'); cancelEntered.resolve(); });
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });

    await queueOverflow();
    await cancelEntered.promise;
    expect(order).toEqual(['cancel']);
    expect(sherpaCancel).toHaveBeenCalledTimes(1);
    expect(sink.onError).not.toHaveBeenCalled();
    resolveDecode();
    await sink.errorReported.promise;
    expect(order).toEqual(['cancel', 'drained']);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_pcm_backpressure' }));
  });

  it('publishes a runtime capture error only after its lease drains, including concurrent stop', async () => {
    let resolveRelease!: () => void;
    const releasing = createDeferred<void>();
    vi.mocked(captureHarness.nativeModule.stop).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRelease = resolve;
      releasing.resolve();
    }));
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });

    sherpaStreamingPushFrame.mockRejectedValueOnce(new Error('push_failed'));
    captureHarness.emit();
    await releasing.promise;
    expect(captureHarness.nativeModule.stop).toHaveBeenCalledTimes(1);
    let stopFinished = false;
    const stopping = controller.stop().then((result) => {
      stopFinished = true;
      return result;
    });
    await Promise.resolve();

    expect(sink.onError).not.toHaveBeenCalled();
    expect(stopFinished).toBe(false);

    resolveRelease();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(captureHarness.capture.getSnapshot().subscriberCount).toBe(0);
    expect(sherpaCancel).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'local_neural_stt_pcm_frame_failed',
    }));
  });

  it('ignores a stale capture failure after a rapid stop and restart', async () => {
    const firstSink = createSink();
    const secondSink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await controller.start({ micSession: createMicSession(), sink: firstSink });
    const firstGeneration = captureHarness.nativeModule.start.mock.calls[0]![0].generation;
    const firstTerminalCallback = vi.mocked(captureHarness.nativeModule.addListener).mock.calls.find(([name]) => name === 'captureTerminal')?.[1];
    if (!firstTerminalCallback) throw new Error('native_capture_terminal_callback_missing');
    await controller.stop();

    await controller.start({ micSession: createMicSession(), sink: secondSink });
    // SDK listener tuples lose their event-name correlation in mock.calls.
    firstTerminalCallback({ streamId: 'native-stream', generation: firstGeneration, reason: 'read_error' } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(captureHarness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(firstSink.onError).not.toHaveBeenCalled();
    expect(secondSink.onError).not.toHaveBeenCalled();

    await controller.stop();
    expect(captureHarness.nativeModule.stop).toHaveBeenCalledTimes(2);
  });
});
