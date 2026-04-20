import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MicSession } from '@/voice/runtime/mic/MicSession';

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
const sherpaStreamingPushFrame = vi.fn((params: any) => {
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
  };
}

describe('SherpaStreamingSttController (native)', () => {
  beforeEach(() => {
    runtimeAvailability.audioStreamAvailable = true;
    runtimeAvailability.sherpaAvailable = true;
  });

  it('serializes pushAudioFrame and drops old frames when queue is full', async () => {
    const onCaptureStarted = vi.fn();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({
      onCaptureStarted,
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
            },
          },
        },
      }),
    });

    await controller.start('s1', createMicSession());
    expect(onCaptureStarted).toHaveBeenCalledWith('s1');
    expect(audioStreamStart).toHaveBeenCalled();
    expect(sherpaStreamingCreate).toHaveBeenCalled();

    emitAudioFrame('frame-1');
    await flushMicrotasks();
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 20; i++) emitAudioFrame(`frame-${i}`);
    await flushMicrotasks();

    // The first push is still unresolved, so pushes must not run concurrently.
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);

    // Resolve the first, then allow the controller to drain a bounded queue.
    pushResolvers.shift()?.({ text: 'frame-1', isEndpoint: false });
    await flushMicrotasks();

    // Drain everything by resolving whatever the controller requests.
    let safety = 0;
    while (pushResolvers.length > 0 && safety++ < 50) {
      pushResolvers.shift()?.({ text: '', isEndpoint: false });
      await flushMicrotasks();
    }

    const seen = sherpaStreamingPushFrame.mock.calls.map((c) => String(c[0]?.pcm16leBase64 ?? ''));
    // Expect the controller to keep the newest frames when overloaded.
    expect(seen[0]).toBe('frame-1');
    expect(seen).toContain('frame-20');
    expect(seen).not.toContain('frame-2');
    expect(seen).not.toContain('frame-3');
  });

  it('emits runtime-owned endpoint signals when Sherpa reports an endpoint', async () => {
    const onEndpointSignal = vi.fn();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
            },
          },
        },
      }),
      onEndpointSignal,
    });

    await controller.start('s-endpoint', createMicSession());
    emitAudioFrame('frame-endpoint');
    await flushMicrotasks();

    pushResolvers.shift()?.({ text: 'hello sherpa', isEndpoint: true });
    await flushMicrotasks();

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-endpoint',
      source: 'native_stream',
      transcript: 'hello sherpa',
    }));
  });

  it('ensures an injected mic session is active before starting local-neural streaming STT', async () => {
    const micSession = createMicSession();

    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
            },
          },
        },
      }),
    });

    await controller.start('s-mic', micSession);

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(audioStreamStart).toHaveBeenCalled();
    expect(sherpaStreamingCreate).toHaveBeenCalled();
  });

  it('requires a mic session before starting local-neural streaming capture', async () => {
    requestMicrophonePermission.mockClear();
    audioStreamStart.mockClear();
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
            },
          },
        },
      }),
    });

    // @ts-expect-error intentional contract violation to verify the runtime guard
    await expect(controller.start('s-missing-mic')).rejects.toThrow('mic_session_required');
    expect(requestMicrophonePermission).not.toHaveBeenCalled();
    expect(audioStreamStart).not.toHaveBeenCalled();
  });

  it('surfaces missing native runtime through the explicit capture-error callback', async () => {
    runtimeAvailability.audioStreamAvailable = false;
    runtimeAvailability.sherpaAvailable = false;
    const onCaptureError = vi.fn();

    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
    const controller = createSherpaStreamingSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError,
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: 'en' } },
            },
          },
        },
      }),
    });

    await controller.start('s-runtime-missing', createMicSession());
    expect(onCaptureError).toHaveBeenCalledWith({
      controlSessionId: 's-runtime-missing',
      reason: 'local_neural_stt_unavailable',
    });
  });
});
