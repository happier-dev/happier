import { describe, expect, it, vi } from 'vitest';

import { createDaemonStreamingSttController } from './DaemonStreamingSttController';
import type { DaemonSpeechPcmCaptureOptions } from './DaemonSpeechPcmCapture';
import type { SttSink } from '@/voice/input/sttController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';

vi.mock('@/utils/platform/microphonePermissions', () => ({
  isPermissionDeniedMicrophoneError: () => false,
}));

type TestPcmCaptureOptions = DaemonSpeechPcmCaptureOptions;

function createSink(): SttSink {
  return {
    onAudioStarted: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onEndpoint: vi.fn(),
    onError: vi.fn(),
  };
}

function requireCaptureOptions(options: TestPcmCaptureOptions | null): TestPcmCaptureOptions {
  if (!options) {
    throw new Error('expected daemon PCM capture options');
  }
  return options;
}

function emitCaptureError(options: TestPcmCaptureOptions | null): void {
  const onError = requireCaptureOptions(options).onError;
  if (!onError) {
    throw new Error('expected daemon PCM capture onError handler');
  }
  onError(createVoiceMachineError({
    kind: 'provider_error',
    reason: 'daemon_streaming_stt_web_mic_unavailable',
  }));
}

describe('createDaemonStreamingSttController', () => {
  it('streams canonical mic PCM into the daemon sender and maps partial/endpoint/final events into the sink', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
    };
    const sender = {
      start: vi.fn(async () => {}),
      pushChunk: vi.fn(async () => [
        { type: 'partial' as const, seq: 0, text: 'open', isEndpoint: false, confidence: null },
        { type: 'endpoint' as const, seq: 0, transcript: 'open notes', reason: 'vad' as const },
      ]),
      finish: vi.fn(async () => ({
        ok: true as const,
        streamId: 'stream-1',
        generation: 1,
        ackSeq: 0,
        finalText: 'open notes',
        language: 'en',
        modelPackId: 'stt-pack-1',
        events: [{ type: 'final' as const, seq: 0, text: 'open notes', language: 'en', modelPackId: 'stt-pack-1' }],
      })),
      cancel: vi.fn(async () => {}),
    };
    const createStreamingSttSender = vi.fn(async () => sender);
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            },
          },
        },
      }),
      createClient: () => ({ createStreamingSttSender }),
      createPcmCapture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const sink = createSink();
    const pcmBytes = new Uint8Array([0, 1, 2, 3]);
    const micSession = {
      ensureActive: vi.fn(async () => {}),
      setMuted: vi.fn(),
      isMuted: vi.fn(() => false),
      teardown: vi.fn(async () => {}),
      getStream: vi.fn(() => null),
    };

    await controller.start({ micSession, sink });
    const options = requireCaptureOptions(captureOptions);
    await options.onChunk(pcmBytes);
    options.onAudioStarted();
    await expect(controller.stop()).resolves.toEqual({ finalText: 'open notes' });

    expect(createStreamingSttSender).toHaveBeenCalledWith({
      packId: 'stt-pack-1',
      language: 'en',
      signal: undefined,
    });
    expect(sender.start).toHaveBeenCalledTimes(1);
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(sender.pushChunk).toHaveBeenCalledWith(pcmBytes);
    expect(sink.onPartial).toHaveBeenCalledWith('open');
    expect(sink.onFinal).toHaveBeenCalledWith('open notes');
    expect(sink.onEndpoint).toHaveBeenCalledWith('vad');
    expect(sink.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(sender.finish).toHaveBeenCalledTimes(1);
    expect(sender.cancel).not.toHaveBeenCalled();
  });

  it('cancels the sender and capture when the caller aborts the active stream', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => false),
    };
    const sender = {
      start: vi.fn(async () => {}),
      pushChunk: vi.fn(async () => []),
      finish: vi.fn(async () => ({
        ok: true as const,
        streamId: 'stream-1',
        generation: 1,
        ackSeq: -1,
        finalText: '',
        language: null,
        modelPackId: null,
        events: [],
      })),
      cancel: vi.fn(async () => {}),
    };
    const abortController = new AbortController();
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({}),
      createClient: () => ({ createStreamingSttSender: vi.fn(async () => sender) }),
      createPcmCapture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const sink = createSink();

    await controller.start({
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink,
      signal: abortController.signal,
    });

    abortController.abort();
    await requireCaptureOptions(captureOptions).onChunk(new Uint8Array([0, 1]));
    await expect(controller.stop()).resolves.toEqual({ finalText: '' });

    expect(capture.stop).toHaveBeenCalled();
    expect(sender.cancel).toHaveBeenCalled();
    expect(sender.finish).not.toHaveBeenCalled();
  });

  it('cancels the daemon stream when PCM capture reports a startup failure without throwing', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    const capture = {
      start: vi.fn(async () => {
        emitCaptureError(captureOptions);
      }),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => false),
    };
    const sender = {
      start: vi.fn(async () => {}),
      pushChunk: vi.fn(async () => []),
      finish: vi.fn(async () => ({
        ok: true as const,
        streamId: 'stream-1',
        generation: 1,
        ackSeq: -1,
        finalText: '',
        language: null,
        modelPackId: null,
        events: [],
      })),
      cancel: vi.fn(async () => {}),
    };
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({}),
      createClient: () => ({ createStreamingSttSender: vi.fn(async () => sender) }),
      createPcmCapture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const sink = createSink();

    await controller.start({
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink,
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(controller.stop()).resolves.toEqual({ finalText: '' });

    expect(sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_web_mic_unavailable',
      recoverable: true,
    });
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(sender.cancel).toHaveBeenCalledTimes(1);
    expect(sender.finish).not.toHaveBeenCalled();
  });

  it('surfaces typed daemon runtime startup errors instead of a generic start failure', async () => {
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            },
          },
        },
      }),
      createClient: () => ({
        createStreamingSttSender: vi.fn(async () => {
          throw Object.assign(new Error('daemon_voice_inference_runtime_unavailable'), { code: 'runtime_unavailable' });
        }),
      }),
      createPcmCapture: () => {
        throw new Error('capture_must_not_start_after_sender_failure');
      },
    });
    const sink = createSink();

    await controller.start({
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink,
    });

    expect(sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_runtime_unavailable',
      recoverable: true,
    });
  });

  it('cancels the active daemon stream when PCM chunk delivery fails during capture', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
    };
    const sender = {
      start: vi.fn(async () => {}),
      pushChunk: vi.fn(async () => {
        throw Object.assign(new Error('daemon_voice_inference_substream_response_timeout'), {
          code: 'daemon_voice_inference_substream_response_timeout',
        });
      }),
      finish: vi.fn(async () => ({
        ok: true as const,
        streamId: 'stream-1',
        generation: 1,
        ackSeq: 0,
        finalText: '',
        language: null,
        modelPackId: null,
        events: [],
      })),
      cancel: vi.fn(async () => {}),
    };
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            },
          },
        },
      }),
      createClient: () => ({ createStreamingSttSender: vi.fn(async () => sender) }),
      createPcmCapture: (options) => {
        captureOptions = options;
        return capture;
      },
    });
    const sink = createSink();

    await controller.start({
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink,
    });

    await expect(requireCaptureOptions(captureOptions).onChunk(new Uint8Array([0, 1]))).rejects.toMatchObject({
      code: 'daemon_voice_inference_substream_response_timeout',
    });
    requireCaptureOptions(captureOptions).onError?.(createVoiceMachineError({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_chunk_failed',
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(sender.cancel).toHaveBeenCalledTimes(1);
    expect(sender.finish).not.toHaveBeenCalled();
    expect(sink.onError).toHaveBeenCalledWith({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_chunk_failed',
      recoverable: true,
    });
  });
});
