import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RUNTIME_STT_PCM_FORMAT } from '@happier-dev/protocol';

import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { SttSink } from '@/voice/input/sttController';

const ensureModelPackInstalled = vi.fn(async () => ({
  packDirUri: 'file:///packs/stt-pack',
  manifest: { packId: 'dummy', kind: 'stt_sherpa', model: 'zipformer_transducer', version: 'v1', files: [] },
}));
vi.mock('@/voice/modelPacks/installer.native', () => ({ ensureModelPackInstalled }));
vi.mock('@/voice/modelPacks/manifests', () => ({ resolveModelPackManifestUrl: () => 'https://example.com/manifest.json' }));

type CaptureRequest = Readonly<{
  ownerId: string;
  format: Readonly<{ sampleRate: number; channels: number; frameMs: number }>;
  audioSession: unknown;
  maxQueuedFrames: number;
  shouldDeliver?: () => boolean;
  onFrame: (event: any) => void | Promise<void>;
  onDroppedFrames?: (count: number) => void;
  onError?: (error: unknown) => void;
}>;

const runtime = vi.hoisted(() => ({
  captureAvailable: true,
  sherpaAvailable: true,
  captureRequest: null as CaptureRequest | null,
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  waitForDrain: vi.fn(async () => {}),
}));

vi.mock('@happier-dev/audio-stream-native', () => ({
  getSharedVoicePcmCapture: () => runtime.captureAvailable ? {
    acquire: runtime.acquire,
  } : null,
}));

const sherpaStreamingCreate = vi.fn(async () => {});
const sherpaStreamingPushFrame = vi.fn(async () => ({ text: '', isEndpoint: false }));
const sherpaStreamingFinish = vi.fn(async () => ({ text: '' }));
const sherpaCancel = vi.fn(async () => {});

vi.mock('@happier-dev/sherpa-native', () => ({
  getOptionalHappierSherpaNativeModule: () => runtime.sherpaAvailable ? {
    createStreamingRecognizer: sherpaStreamingCreate,
    pushAudioFrame: sherpaStreamingPushFrame,
    finishStreaming: sherpaStreamingFinish,
    cancel: sherpaCancel,
  } : null,
}));

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

function createSink(): SttSink & Record<'onAudioStarted' | 'onPartial' | 'onFinal' | 'onEndpoint' | 'onError', ReturnType<typeof vi.fn>> {
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
      providers: {
        local_direct: { schemaVersion: 1, config: {
          stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
        } },
      },
    },
  };
}

async function emitAudioFrame(pcm16leBase64 = 'AAE='): Promise<void> {
  const request = runtime.captureRequest;
  if (!request) throw new Error('capture_request_missing');
  if (request.shouldDeliver?.() === false) return;
  try {
    await request.onFrame({
      streamId: 'shared-stream',
      pcm16leBase64,
      sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
    });
  } catch (error) {
    request.onError?.(error);
  }
}

describe('SherpaStreamingSttController (native shared capture)', () => {
  beforeEach(() => {
    runtime.captureAvailable = true;
    runtime.sherpaAvailable = true;
    runtime.captureRequest = null;
    runtime.release.mockReset();
    runtime.release.mockResolvedValue(undefined);
    runtime.waitForDrain.mockReset();
    runtime.waitForDrain.mockResolvedValue(undefined);
    runtime.acquire.mockReset();
    runtime.acquire.mockImplementation(async (request: CaptureRequest) => {
      runtime.captureRequest = request;
      return {
        id: 'lease',
        streamId: 'shared-stream',
        release: runtime.release,
        waitForDrain: runtime.waitForDrain,
      };
    });
    sherpaStreamingCreate.mockReset();
    sherpaStreamingCreate.mockResolvedValue(undefined);
    sherpaStreamingPushFrame.mockReset();
    sherpaStreamingPushFrame.mockResolvedValue({ text: '', isEndpoint: false });
    sherpaStreamingFinish.mockReset();
    sherpaStreamingFinish.mockResolvedValue({ text: '' });
    sherpaCancel.mockReset();
    sherpaCancel.mockResolvedValue(undefined);
    ensureModelPackInstalled.mockReset();
    ensureModelPackInstalled.mockResolvedValue({
      packDirUri: 'file:///packs/stt-pack',
      manifest: { packId: 'dummy', kind: 'stt_sherpa', model: 'zipformer_transducer', version: 'v1', files: [] },
    });
  });

  it('acquires the sole shared conversation/AEC capture with a bounded async subscriber', async () => {
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession, sink: createSink() });

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(sherpaStreamingCreate).toHaveBeenCalledWith(expect.objectContaining({
      sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
    }));
    expect(runtime.acquire).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: expect.stringContaining('sherpa-streaming-stt:'),
      format: {
        sampleRate: VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz,
        channels: VOICE_RUNTIME_STT_PCM_FORMAT.channelCount,
        frameMs: 20,
      },
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'preferred' },
      maxQueuedFrames: 8,
    }));
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
    vi.mocked(micSession.isMuted).mockReturnValue(true);
    await emitAudioFrame();
    expect(sherpaStreamingPushFrame).not.toHaveBeenCalled();
  });

  it('requires a mic session before any native work', async () => {
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await expect(controller.start({ sink: createSink() } as never)).rejects.toThrow('mic_session_required');
    expect(runtime.acquire).not.toHaveBeenCalled();
  });

  it('does not start capture when recognizer creation fails and rolls back the mic facade', async () => {
    sherpaStreamingCreate.mockRejectedValueOnce(new Error('recognizer_init_failed'));
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await expect(controller.start({ micSession, sink: createSink() })).rejects.toThrow('recognizer_init_failed');
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(micSession.teardown).toHaveBeenCalledTimes(1);
  });

  it('does not create a recognizer or capture after model setup resolves for an aborted start, and permits retry', async () => {
    let resolveInstall!: (value: {
      packDirUri: string;
      manifest: {
        packId: string;
        kind: 'stt_sherpa';
        model: 'zipformer_transducer';
        version: string;
        files: never[];
      };
    }) => void;
    ensureModelPackInstalled.mockImplementationOnce(() => new Promise((resolve) => {
      resolveInstall = resolve;
    }));
    const abortController = new AbortController();
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });

    const starting = controller.start({
      micSession,
      sink: createSink(),
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(ensureModelPackInstalled).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    resolveInstall({
      packDirUri: 'file:///packs/stt-pack',
      manifest: {
        packId: 'dummy',
        kind: 'stt_sherpa',
        model: 'zipformer_transducer',
        version: 'v1',
        files: [],
      },
    });
    await starting;

    expect(sherpaStreamingCreate).not.toHaveBeenCalled();
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(micSession.teardown).toHaveBeenCalledTimes(1);

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    expect(sherpaStreamingCreate).toHaveBeenCalledTimes(1);
    expect(runtime.acquire).toHaveBeenCalledTimes(1);
  });

  it('rolls back recognizer, capture lease, and mic when capture acquisition fails', async () => {
    runtime.acquire.mockRejectedValueOnce(new Error('audio_session_failed'));
    const micSession = createMicSession();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await expect(controller.start({ micSession, sink: createSink() })).rejects.toThrow('audio_session_failed');
    expect(sherpaCancel).toHaveBeenCalledTimes(1);
    expect(micSession.teardown).toHaveBeenCalledTimes(1);
  });

  it('surfaces pack/runtime/backpressure failures without leaking capture', async () => {
    ensureModelPackInstalled.mockRejectedValueOnce(new Error('not_installed'));
    const micSession = createMicSession();
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession, sink });
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_pack_not_installed' }));
    expect(runtime.acquire).not.toHaveBeenCalled();

    runtime.captureAvailable = false;
    runtime.sherpaAvailable = false;
    const unavailableSink = createSink();
    const unavailableController = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await unavailableController.start({ micSession: createMicSession(), sink: unavailableSink });
    expect(unavailableSink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_unavailable' }));
  });

  it('releases and drains exactly its lease before finalizing, and detaches abort ownership', async () => {
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');
    sherpaStreamingFinish.mockResolvedValueOnce({ text: 'final words' });
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink: createSink(), signal: abortController.signal });
    const result = await controller.stop();

    expect(runtime.release).toHaveBeenCalledTimes(1);
    expect(runtime.waitForDrain).toHaveBeenCalledTimes(1);
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

  it('maps dropped or failed subscriber frames to typed errors and cleanup', async () => {
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });
    runtime.captureRequest?.onDroppedFrames?.(1);
    expect(sink.onError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.release).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_pcm_backpressure' }));
    });

    const secondSink = createSink();
    const second = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await second.start({ micSession: createMicSession(), sink: secondSink });
    runtime.captureRequest?.onError?.(new Error('push_failed'));
    expect(secondSink.onError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.release).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(secondSink.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local_neural_stt_pcm_frame_failed' }));
    });
  });

  it('publishes a runtime capture error only after its lease drains, including concurrent stop', async () => {
    let resolveRelease!: () => void;
    runtime.release.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRelease = resolve;
    }));
    const sink = createSink();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({ getSettings: () => localNeuralSettings() });
    await controller.start({ micSession: createMicSession(), sink });

    const request = runtime.captureRequest;
    if (!request?.onError) throw new Error('capture_error_callback_missing');
    request.onError(new Error('push_failed'));
    expect(runtime.release).toHaveBeenCalledTimes(1);
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
    expect(runtime.waitForDrain).toHaveBeenCalledTimes(1);
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
    const firstCaptureRequest = runtime.captureRequest;
    if (!firstCaptureRequest?.onError) throw new Error('capture_error_callback_missing');
    await controller.stop();

    await controller.start({ micSession: createMicSession(), sink: secondSink });
    firstCaptureRequest.onError(new Error('late_failure_from_first_capture'));
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.release).toHaveBeenCalledTimes(1);
    expect(firstSink.onError).not.toHaveBeenCalled();
    expect(secondSink.onError).not.toHaveBeenCalled();

    await controller.stop();
    expect(runtime.release).toHaveBeenCalledTimes(2);
  });
});
