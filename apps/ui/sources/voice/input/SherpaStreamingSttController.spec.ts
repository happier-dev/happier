import { describe, expect, it, vi } from 'vitest';

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

let audioFrameListener: AudioFrameListener | null = null;
const audioStreamStart = vi.fn(async () => ({ streamId: 'stream-1' }));
const audioStreamStop = vi.fn(async () => {});

vi.mock('@happier-dev/audio-stream-native', () => ({
  getOptionalHappierAudioStreamNativeModule: () => ({
    start: audioStreamStart,
    stop: audioStreamStop,
    addListener: (eventName: string, cb: AudioFrameListener) => {
      if (eventName === 'audioFrame') audioFrameListener = cb;
      return { remove: () => {} };
    },
  }),
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
  getOptionalHappierSherpaNativeModule: () => ({
    createStreamingRecognizer: sherpaStreamingCreate,
    pushAudioFrame: sherpaStreamingPushFrame,
    finishStreaming: sherpaStreamingFinish,
    cancel: async () => {},
  }),
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

describe('SherpaStreamingSttController (native)', () => {
  it('serializes pushAudioFrame and drops old frames when queue is full', async () => {
    const patches: any[] = [];
    const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');

    const controller = createSherpaStreamingSttController({
      setState: (patch) => patches.push(patch),
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

    await controller.start('s1');
    expect(patches[patches.length - 1]).toEqual({ status: 'recording', sessionId: 's1', error: null });
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
});
