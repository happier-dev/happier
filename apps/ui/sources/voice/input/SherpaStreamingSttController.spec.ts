import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RUNTIME_STT_PCM_FORMAT } from '@happier-dev/protocol';

import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { SttSink } from '@/voice/input/sttController';

const requestMicrophonePermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
const showMicrophonePermissionDeniedAlert = vi.fn();

vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission,
  showMicrophonePermissionDeniedAlert,
}));

const ensureModelPackInstalled = vi.fn(async () => ({
  packDirUri: 'file:///packs/stt-pack',
  manifest: { packId: 'dummy', kind: 'stt_sherpa', model: 'zipformer_transducer', version: 'v1', files: [] },
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
  ensureModelPackInstalled,
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
  resolveModelPackManifestUrl: () => 'https://example.com/manifest.json',
}));

type AudioFrameListener = (event: any) => void;
const runtimeAvailability = vi.hoisted(() => ({
  audioStreamAvailable: true,
  sherpaAvailable: true,
}));

let audioFrameListener: AudioFrameListener | null = null;
const audioStreamStart = vi.fn(async () => ({ streamId: 'stream-1' }));
const audioStreamStop = vi.fn(async () => {});

vi.mock('@happier-dev/audio-stream-native', () => ({
  getOptionalHappierAudioStreamNativeModule: () =>
    runtimeAvailability.audioStreamAvailable
      ? {
          start: audioStreamStart,
          stop: audioStreamStop,
          addListener: (eventName: string, cb: AudioFrameListener) => {
            if (eventName === 'audioFrame') audioFrameListener = cb;
            return { remove: () => {} };
          },
        }
      : null,
}));

const sherpaStreamingCreate = vi.fn(async () => {});
const sherpaStreamingFinish = vi.fn(async () => ({ text: '' }));

type Resolver = (value: any) => void;
const pushResolvers: Resolver[] = [];
const sherpaStreamingPushFrame = vi.fn((_params: any) => {
  return new Promise((resolve) => {
    pushResolvers.push(resolve);
  });
});

vi.mock('@happier-dev/sherpa-native', () => ({
  getOptionalHappierSherpaNativeModule: () =>
    runtimeAvailability.sherpaAvailable
      ? {
          createStreamingRecognizer: sherpaStreamingCreate,
          pushAudioFrame: sherpaStreamingPushFrame,
          finishStreaming: sherpaStreamingFinish,
          cancel: async () => {},
        }
      : null,
}));

function emitAudioFrame(pcm16leBase64: string) {
  if (!audioFrameListener) throw new Error('audioFrameListener_missing');
  audioFrameListener({
    streamId: 'stream-1',
    pcm16leBase64,
    sampleRate: 16000,
    channels: 1,
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createMicSession(): MicSession {
  return {
    ensureActive: vi.fn(async () => {}),
    setMuted: vi.fn(),
    isMuted: vi.fn(() => false),
    teardown: vi.fn(async () => {}),
    getStream: vi.fn(() => null),
    getAudioContext: vi.fn(() => null),
  };
}

function createSink(): SttSink & {
  onAudioStarted: ReturnType<typeof vi.fn>;
  onPartial: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onEndpoint: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  return {
    onAudioStarted: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onEndpoint: vi.fn(),
    onError: vi.fn(),
  };
}

function localNeuralSettings() {
  return {
    voice: {
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
        },
      },
    },
  };
}

describe('SherpaStreamingSttController (native)', () => {
  beforeEach(() => {
    runtimeAvailability.audioStreamAvailable = true;
    runtimeAvailability.sherpaAvailable = true;
    pushResolvers.length = 0;
    audioFrameListener = null;
    sherpaStreamingPushFrame.mockClear();
  });

  it('serializes pushAudioFrame, marks audio started, and drops old frames when queue is full', async () => {
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await controller.start({ micSession: createMicSession(), sink });
    expect(audioStreamStart).toHaveBeenCalled();
    expect(sherpaStreamingCreate).toHaveBeenCalled();

    emitAudioFrame('frame-1');
    await flushMicrotasks();
    expect(sink.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 20; i++) emitAudioFrame(`frame-${i}`);
    await flushMicrotasks();

    // The first push is still unresolved, so pushes must not run concurrently.
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);

    // Resolve the first, then allow the controller to drain a bounded queue.
    pushResolvers.shift()?.({ text: 'frame-1', isEndpoint: false });
    await flushMicrotasks();

    let safety = 0;
    while (pushResolvers.length > 0 && safety++ < 50) {
      pushResolvers.shift()?.({ text: '', isEndpoint: false });
      await flushMicrotasks();
    }

    const seen = sherpaStreamingPushFrame.mock.calls.map((c) => String(c[0]?.pcm16leBase64 ?? ''));
    expect(seen[0]).toBe('frame-1');
    expect(seen).toContain('frame-20');
    expect(seen).not.toContain('frame-2');
    expect(seen).not.toContain('frame-3');
  });

  it('emits interim partials, a committed final, and a runtime-owned endpoint when Sherpa reports an endpoint', async () => {
    const onEndpointSignal = vi.fn();
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({
      getSettings: () => localNeuralSettings(),
      onEndpointSignal,
    });

    await controller.start({ micSession: createMicSession(), sink });
    emitAudioFrame('frame-endpoint');
    await flushMicrotasks();

    pushResolvers.shift()?.({ text: 'hello sherpa', isEndpoint: true });
    await flushMicrotasks();

    expect(sink.onPartial).toHaveBeenCalledWith('hello sherpa');
    expect(sink.onFinal).toHaveBeenCalledWith('hello sherpa');
    expect(sink.onEndpoint).toHaveBeenCalledWith('vad');
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'native_stream',
      transcript: 'hello sherpa',
      sessionId: expect.any(String),
    }));
  });

  it('ensures the injected mic session is active before starting local-neural streaming STT', async () => {
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await controller.start({ micSession, sink: createSink() });

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(audioStreamStart).toHaveBeenCalled();
    expect(sherpaStreamingCreate).toHaveBeenCalled();
  });

  it('captures audio at the canonical STT PCM sample rate and channel count', async () => {
    audioStreamStart.mockClear();
    sherpaStreamingCreate.mockClear();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink: createSink() });

    expect(audioStreamStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
        channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
        frameMs: 20,
      }),
    );
    expect(sherpaStreamingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
        channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
      }),
    );
  });

  it('requires a mic session before starting local-neural streaming capture', async () => {
    requestMicrophonePermission.mockClear();
    audioStreamStart.mockClear();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await expect(controller.start({ sink: createSink() } as never)).rejects.toThrow('mic_session_required');
    expect(requestMicrophonePermission).not.toHaveBeenCalled();
    expect(audioStreamStart).not.toHaveBeenCalled();
  });

  it('releases the audio stream and mic when the recognizer fails to start (no leaked capture)', async () => {
    audioStreamStart.mockClear();
    audioStreamStop.mockClear();
    sherpaStreamingCreate.mockClear();
    // Recognizer creation throws AFTER the audio stream has been started — the
    // classic half-open startup. The controller must transactionally release the
    // started stream and the injected mic so no capture leaks.
    sherpaStreamingCreate.mockRejectedValueOnce(new Error('recognizer_init_failed'));
    const micSession = createMicSession();
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await expect(controller.start({ micSession, sink })).rejects.toThrow('recognizer_init_failed');

    expect(audioStreamStart).toHaveBeenCalledTimes(1);
    expect(audioStreamStop).toHaveBeenCalledWith({ streamId: 'stream-1' });
    expect(micSession.teardown).toHaveBeenCalledTimes(1);
  });

  it('releases the mic when the model pack is not installed (early sink error, no leaked capture)', async () => {
    audioStreamStart.mockClear();
    ensureModelPackInstalled.mockRejectedValueOnce(new Error('not_installed'));
    const micSession = createMicSession();
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await controller.start({ micSession, sink });

    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'local_neural_pack_not_installed',
    }));
    // The mic was activated before the pack check failed; it must be released and
    // the audio stream must never have been started.
    expect(micSession.teardown).toHaveBeenCalledTimes(1);
    expect(audioStreamStart).not.toHaveBeenCalled();
  });

  it('detaches the external abort listener when stopped', async () => {
    const abortController = new AbortController();
    const addAbortListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await controller.start({ micSession: createMicSession(), sink: createSink(), signal: abortController.signal });
    const abortListener = addAbortListener.mock.calls.find((call) => call[0] === 'abort')?.[1];
    expect(abortListener).toEqual(expect.any(Function));

    await controller.stop();

    expect(removeAbortListener).toHaveBeenCalledWith('abort', abortListener);
  });

  it('surfaces missing native runtime through a typed sink error', async () => {
    runtimeAvailability.audioStreamAvailable = false;
    runtimeAvailability.sherpaAvailable = false;
    const sink = createSink();

    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    await controller.start({ micSession: createMicSession(), sink });
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'local_neural_stt_unavailable',
    }));
  });
});
