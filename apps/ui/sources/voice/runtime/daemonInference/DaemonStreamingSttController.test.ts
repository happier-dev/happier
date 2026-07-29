import { describe, expect, it, vi } from 'vitest';

import { createDaemonStreamingSttController } from './DaemonStreamingSttController';
import type { DaemonSpeechPcmCaptureOptions } from './DaemonSpeechPcmCapture';
import type { SttSink } from '@/voice/input/sttController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { createTurnEndpointController } from '@/voice/runtime/input/TurnEndpointController';

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
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            } },
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

    await controller.start({ sessionId: 'active-control-session', micSession, sink });
    const options = requireCaptureOptions(captureOptions);
    await options.onChunk(pcmBytes);
    options.onAudioStarted();
    await expect(controller.stop()).resolves.toEqual({ finalText: 'open notes' });

    expect(createStreamingSttSender).toHaveBeenCalledWith({
      sessionId: 'active-control-session',
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

  it('delivers and applies a queued PCM chunk released by capture drain before finishing', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    const callOrder: string[] = [];
    const drainedPcmBytes = new Uint8Array([4, 5, 6, 7]);
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {
        await requireCaptureOptions(captureOptions).onChunk(drainedPcmBytes);
      }),
      isActive: vi.fn(() => true),
    };
    const sender = {
      start: vi.fn(async () => {}),
      pushChunk: vi.fn(async () => {
        callOrder.push('push');
        return [
          {
            type: 'final' as const,
            seq: 0,
            text: 'drained words',
            language: 'en',
            modelPackId: 'stt-pack-1',
          },
        ];
      }),
      finish: vi.fn(async () => {
        callOrder.push('finish');
        return {
          ok: true as const,
          streamId: 'stream-1',
          generation: 1,
          ackSeq: 0,
          finalText: '',
          language: 'en',
          modelPackId: 'stt-pack-1',
          events: [],
        };
      }),
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

    await controller.start({
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink: createSink(),
    });

    await expect(controller.stop()).resolves.toEqual({ finalText: 'drained words' });
    expect(sender.pushChunk).toHaveBeenCalledWith(drainedPcmBytes);
    expect(callOrder).toEqual(['push', 'finish']);
  });

  it('retains a final transcript carried only by finish events', async () => {
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
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
        language: 'en',
        modelPackId: 'stt-pack-1',
        events: [
          {
            type: 'final' as const,
            seq: 0,
            text: 'finish event words',
            language: 'en',
            modelPackId: 'stt-pack-1',
          },
        ],
      })),
      cancel: vi.fn(async () => {}),
    };
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({}),
      createClient: () => ({ createStreamingSttSender: vi.fn(async () => sender) }),
      createPcmCapture: () => capture,
    });

    await controller.start({
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink: createSink(),
    });

    await expect(controller.stop()).resolves.toEqual({ finalText: 'finish event words' });
  });

  it('keeps a non-endpoint partial provisional when successful finish has no authoritative final', async () => {
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
        { type: 'partial' as const, seq: 0, text: 'provisional words', isEndpoint: false, confidence: null },
      ]),
      finish: vi.fn(async () => ({
        ok: true as const,
        streamId: 'stream-1',
        generation: 1,
        ackSeq: 0,
        finalText: '',
        language: 'en',
        modelPackId: 'stt-pack-1',
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
    await requireCaptureOptions(captureOptions).onChunk(new Uint8Array([0, 1]));

    expect(sink.onPartial).toHaveBeenCalledWith('provisional words');
    expect(sink.onFinal).not.toHaveBeenCalled();
    await expect(controller.stop()).resolves.toEqual({ finalText: '' });
    expect(sender.finish).toHaveBeenCalledTimes(1);
    expect(sender.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['finish timeout', Object.assign(new Error('daemon_speech_stream_finish_timeout'), { code: 'daemon_speech_stream_finish_timeout' }), 'stt_timeout', 'daemon_streaming_stt_finish_timeout'],
    ['invalid ACK', Object.assign(new Error('daemon_speech_stream_invalid_ack'), { code: 'daemon_speech_stream_invalid_ack' }), 'provider_error', 'daemon_streaming_stt_invalid_ack'],
    ['stale finish', Object.assign(new Error('daemon_speech_stream_stale_finish'), { code: 'daemon_speech_stream_stale_finish' }), 'provider_error', 'daemon_streaming_stt_stale_finish'],
    ['transport failure', new Error('socket closed'), 'provider_error', 'daemon_streaming_stt_finalization_failed'],
  ])('does not promote a provisional partial when %s prevents truthful finalization', async (
    _label,
    finishError,
    expectedKind,
    expectedReason,
  ) => {
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
        { type: 'partial' as const, seq: 0, text: 'provisional words', isEndpoint: false, confidence: null },
      ]),
      finish: vi.fn(async () => {
        throw finishError;
      }),
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
    await requireCaptureOptions(captureOptions).onChunk(new Uint8Array([0, 1]));

    const firstStop = controller.stop();
    const concurrentStop = controller.stop();
    await expect(firstStop).resolves.toEqual({
      error: expect.objectContaining({
        kind: expectedKind,
        reason: expectedReason,
      }),
    });
    await expect(concurrentStop).resolves.toEqual({
      error: expect.objectContaining({
        kind: expectedKind,
        reason: expectedReason,
      }),
    });

    expect(sink.onPartial).toHaveBeenCalledWith('provisional words');
    expect(sender.finish).toHaveBeenCalledTimes(1);
    expect(sender.cancel).toHaveBeenCalledTimes(1);
  });

  it('waits for a stopping handle to finish before starting the next stream', async () => {
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const firstCapture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => drainGate),
      isActive: vi.fn(() => true),
    };
    const secondCapture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
    };
    const createSender = () => ({
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
    });
    const senders = [createSender(), createSender()];
    const createStreamingSttSender = vi.fn(async () => senders[createStreamingSttSender.mock.calls.length - 1]!);
    const createPcmCapture = vi.fn(() => (
      createPcmCapture.mock.calls.length === 1 ? firstCapture : secondCapture
    ));
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({}),
      createClient: () => ({ createStreamingSttSender }),
      createPcmCapture,
    });
    const micSession = {
      ensureActive: vi.fn(async () => {}),
      setMuted: vi.fn(),
      isMuted: vi.fn(() => false),
      teardown: vi.fn(async () => {}),
      getStream: vi.fn(() => null),
    };

    await controller.start({ micSession, sink: createSink() });
    const stopping = controller.stop();
    await Promise.resolve();
    const starting = controller.start({ micSession, sink: createSink() });
    await Promise.resolve();

    expect(createStreamingSttSender).toHaveBeenCalledTimes(1);

    releaseDrain();
    await stopping;
    await starting;
    expect(createStreamingSttSender).toHaveBeenCalledTimes(2);
    await controller.stop();
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

  it('ignores an in-flight daemon response that arrives after abort and stop begin', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    let resolveCaptureStop!: () => void;
    let resolvePush!: (events: readonly [
      { type: 'partial'; seq: number; text: string; isEndpoint: boolean; confidence: null },
      { type: 'endpoint'; seq: number; transcript: string; reason: 'vad' },
    ]) => void;
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(() => new Promise<void>((resolve) => {
        resolveCaptureStop = resolve;
      })),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
    };
    const sender = {
      start: vi.fn(async () => {}),
      pushChunk: vi.fn(() => new Promise<readonly [
        { type: 'partial'; seq: number; text: string; isEndpoint: boolean; confidence: null },
        { type: 'endpoint'; seq: number; transcript: string; reason: 'vad' },
      ]>((resolve) => {
        resolvePush = resolve;
      })),
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
      sessionId: 'daemon-control-session',
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
    const pushing = requireCaptureOptions(captureOptions).onChunk(new Uint8Array([0, 1]));
    await vi.waitFor(() => {
      expect(sender.pushChunk).toHaveBeenCalledTimes(1);
    });

    abortController.abort();
    const stopping = controller.stop();
    resolvePush([
      { type: 'partial', seq: 0, text: 'late provisional words', isEndpoint: true, confidence: null },
      { type: 'endpoint', seq: 0, transcript: 'late final words', reason: 'vad' },
    ]);
    await pushing;

    expect(sink.onPartial).not.toHaveBeenCalled();
    expect(sink.onFinal).not.toHaveBeenCalled();
    expect(sink.onEndpoint).not.toHaveBeenCalled();

    resolveCaptureStop();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(sender.finish).not.toHaveBeenCalled();
    expect(sender.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'abort'] as const)(
    'clears daemon endpoint authority so a late endpoint after %s cannot signal',
    async (terminalAction) => {
      const capture = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        waitForDrain: vi.fn(async () => {}),
        isActive: vi.fn(() => true),
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
      const onEndpointSignal = vi.fn();
      const endpointController = createTurnEndpointController({
        onSignal: onEndpointSignal,
      });
      const abortController = new AbortController();
      const controller = createDaemonStreamingSttController({
        endpointController,
        getSettings: () => ({}),
        createClient: () => ({
          createStreamingSttSender: vi.fn(async () => sender),
        }),
        createPcmCapture: () => capture,
      });

      await controller.start({
        sessionId: 'daemon-control-session',
        micSession: {
          ensureActive: vi.fn(async () => {}),
          setMuted: vi.fn(),
          isMuted: vi.fn(() => false),
          teardown: vi.fn(async () => {}),
          getStream: vi.fn(() => null),
        },
        sink: createSink(),
        signal: abortController.signal,
      });
      if (terminalAction === 'abort') {
        abortController.abort();
        await controller.stop();
      } else {
        await controller.stop();
      }

      endpointController.signalEndpointDetected({
        sessionId: 'daemon-control-session',
        source: 'native_stream',
        transcript: 'late transcript',
      });
      expect(onEndpointSignal).not.toHaveBeenCalled();
    },
  );

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
      phase: 'runtime',
      presentation: 'notice',
      reason: 'daemon_streaming_stt_web_mic_unavailable',
      recoverable: true,
      recoveryAction: 'retry',
      retryPolicy: 'user_action',
    });
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(sender.cancel).toHaveBeenCalledTimes(1);
    expect(sender.finish).not.toHaveBeenCalled();
  });

  it('publishes a PCM runtime error only after capture and sender cancellation settle', async () => {
    let captureOptions: TestPcmCaptureOptions | null = null;
    let resolveCaptureStop!: () => void;
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(() => new Promise<void>((resolve) => {
        resolveCaptureStop = resolve;
      })),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
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

    emitCaptureError(captureOptions);
    let stopFinished = false;
    const stopping = controller.stop().then((result) => {
      stopFinished = true;
      return result;
    });
    await Promise.resolve();

    expect(sink.onError).not.toHaveBeenCalled();
    expect(stopFinished).toBe(false);

    resolveCaptureStop();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(sender.cancel).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'daemon_streaming_stt_web_mic_unavailable',
    }));
  });

  it('surfaces typed daemon runtime startup errors instead of a generic start failure', async () => {
    const recordStartFailure = vi.fn();
    const startFailure = Object.assign(new Error('daemon_voice_inference_runtime_unavailable'), {
      code: 'runtime_unavailable',
    });
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            } },
          },
        },
      }),
      createClient: () => ({
        createStreamingSttSender: vi.fn(async () => {
          throw startFailure;
        }),
      }),
      recordStartFailure,
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
      phase: 'runtime',
      presentation: 'notice',
      reason: 'daemon_streaming_stt_runtime_unavailable',
      recoverable: true,
      recoveryAction: 'retry',
      retryPolicy: 'user_action',
    });
    expect(recordStartFailure).toHaveBeenCalledWith(startFailure);
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
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            } },
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

    await vi.waitFor(() => {
      expect(sender.cancel).toHaveBeenCalledTimes(1);
      expect(sink.onError).toHaveBeenCalledWith({
        kind: 'provider_error',
        phase: 'runtime',
        presentation: 'notice',
        reason: 'daemon_streaming_stt_pcm_chunk_failed',
        recoverable: true,
        recoveryAction: 'retry',
        retryPolicy: 'user_action',
      });
    });
    expect(sender.finish).not.toHaveBeenCalled();
  });

  it('does not start a late daemon sender or PCM capture after cancellation, and permits retry', async () => {
    let resolveSender!: (sender: {
      start: ReturnType<typeof vi.fn>;
      pushChunk: ReturnType<typeof vi.fn>;
      finish: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    }) => void;
    const firstSender = {
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
    const secondSender = {
      ...firstSender,
      start: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    };
    const createStreamingSttSender = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSender = resolve;
      }))
      .mockResolvedValueOnce(secondSender);
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitForDrain: vi.fn(async () => {}),
      isActive: vi.fn(() => true),
    };
    const createPcmCapture = vi.fn(() => capture);
    const controller = createDaemonStreamingSttController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                localNeural: { assetId: 'stt-pack-1', language: 'en', execution: 'daemon' },
              },
            } },
          },
        },
      }),
      createClient: () => ({ createStreamingSttSender }),
      createPcmCapture,
    });
    const abortController = new AbortController();
    const startParams = {
      micSession: {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        teardown: vi.fn(async () => {}),
        getStream: vi.fn(() => null),
      },
      sink: createSink(),
    };

    const starting = controller.start({
      ...startParams,
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(createStreamingSttSender).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    resolveSender(firstSender);
    await starting;

    expect(firstSender.start).not.toHaveBeenCalled();
    expect(firstSender.cancel).toHaveBeenCalledTimes(1);
    expect(createPcmCapture).not.toHaveBeenCalled();

    await controller.start(startParams);
    expect(secondSender.start).toHaveBeenCalledTimes(1);
    expect(createPcmCapture).toHaveBeenCalledTimes(1);
  });
});
