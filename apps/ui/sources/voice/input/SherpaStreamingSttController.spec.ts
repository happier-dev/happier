import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';

const requestMicrophonePermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
const showMicrophonePermissionDeniedAlert = vi.fn();

vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission,
  showMicrophonePermissionDeniedAlert,
}));

const installedPack = {
  packDirUri: 'file:///packs/stt-pack',
  manifest: { packId: 'dummy', kind: 'stt_sherpa', model: 'zipformer_transducer', version: 'v1', files: [] },
};
const ensureModelPackInstalled = vi.fn<(...args: any[]) => Promise<typeof installedPack>>();

vi.mock('@/voice/modelPacks/installer.native', () => ({
  ensureModelPackInstalled,
}));

const listeners = new Map<string, (event: any) => void>();
const audioStreamStart = vi.fn<(...args: any[]) => Promise<{ streamId: string }>>();
const audioStreamStop = vi.fn(async (_params: { streamId: string }) => {});

vi.mock('@happier-dev/audio-stream-native', () => ({
  getOptionalHappierAudioStreamNativeModule: () => ({
    start: audioStreamStart,
    stop: audioStreamStop,
    addListener: (eventName: string, cb: (event: any) => void) => {
      listeners.set(eventName, cb);
      return { remove: () => listeners.delete(eventName) };
    },
  }),
}));

const sherpaStreamingCreate = vi.fn<(...args: any[]) => Promise<void>>();
const sherpaStreamingFinish = vi.fn(async (_params: { jobId: string }) => ({ text: '' }));
const sherpaStreamingCancel = vi.fn(async (_params: { jobId: string }) => {});
const pushResolvers: Array<(value: { text: string; isEndpoint: boolean }) => void> = [];
const sherpaStreamingPushFrame = vi.fn(
  (_params: { jobId: string; pcm16leBase64: string; sampleRate: number; channels: number }) =>
    new Promise<{ text: string; isEndpoint: boolean }>((resolve) => {
      pushResolvers.push(resolve);
    }),
);

vi.mock('@happier-dev/sherpa-native', () => ({
  getOptionalHappierSherpaNativeModule: () => ({
    createStreamingRecognizer: sherpaStreamingCreate,
    pushAudioFrame: sherpaStreamingPushFrame,
    finishStreaming: sherpaStreamingFinish,
    cancel: sherpaStreamingCancel,
  }),
}));

// 20 ms of 16 kHz mono PCM16 = 320 samples = 640 bytes; each frame is filled with its index.
const FRAME_BYTES = 640;

function emitAudioFrame(index: number) {
  const cb = listeners.get('audioFrame');
  if (!cb) throw new Error('audioFrameListener_missing');
  cb({
    streamId: 'stream-1',
    pcm16leBase64: encodeBase64(new Uint8Array(FRAME_BYTES).fill(index)),
    sampleRate: 16000,
    channels: 1,
  });
}

function pushedFrameIndexes(): number[] {
  const out: number[] = [];
  for (const call of sherpaStreamingPushFrame.mock.calls) {
    const bytes = decodeBase64(String(call[0]?.pcm16leBase64 ?? ''));
    expect(bytes.length % FRAME_BYTES).toBe(0);
    for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) out.push(bytes[offset]!);
  }
  return out;
}

async function flushMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function settings(overrides?: { handsFree?: { enabled: boolean; silenceMs?: number; minSpeechMs?: number } }) {
  const handsFree = overrides?.handsFree;
  return {
    voice: {
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: { provider: 'local_neural', localNeural: { assetId: 'dummy-pack', language: null } },
          handsFree: {
            enabled: handsFree?.enabled ?? false,
            endpointing: { silenceMs: handsFree?.silenceMs ?? 0, minSpeechMs: handsFree?.minSpeechMs ?? 0 },
          },
        },
      },
    },
  };
}

async function createController(opts?: Parameters<typeof settings>[0]) {
  const patches: any[] = [];
  const onAutoStopTurn = vi.fn();
  const { createSherpaStreamingSttController } = await import('./SherpaStreamingSttController');
  const controller = createSherpaStreamingSttController({
    setState: (patch) => patches.push(patch),
    getSettings: () => settings(opts),
    canAutoStopTurn: () => true,
    onAutoStopTurn,
  });
  return { controller, patches, onAutoStopTurn };
}

beforeEach(() => {
  listeners.clear();
  pushResolvers.length = 0;
  ensureModelPackInstalled.mockReset().mockResolvedValue(installedPack);
  audioStreamStart.mockReset().mockResolvedValue({ streamId: 'stream-1' });
  audioStreamStop.mockClear();
  sherpaStreamingCreate.mockReset().mockResolvedValue(undefined);
  sherpaStreamingPushFrame.mockClear();
  sherpaStreamingFinish.mockClear();
  sherpaStreamingCancel.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SherpaStreamingSttController (native)', () => {
  it('batches 20 ms frames into ~100 ms pushes and never drops audio under native backpressure', async () => {
    const { controller, patches } = await createController();

    await controller.start('s1');
    expect(patches[patches.length - 1]).toEqual({ status: 'recording', sessionId: 's1', error: null });

    for (let i = 1; i <= 4; i++) emitAudioFrame(i);
    await flushMicrotasks();
    // 80 ms buffered: below the batch size, so nothing crosses the native bridge yet.
    expect(sherpaStreamingPushFrame).not.toHaveBeenCalled();

    emitAudioFrame(5);
    await flushMicrotasks();
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);

    // While the first push is in flight, 1 s of audio arrives; it must be coalesced, not dropped.
    for (let i = 6; i <= 55; i++) emitAudioFrame(i);
    await flushMicrotasks();
    expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);

    let safety = 0;
    while (pushResolvers.length > 0 && safety++ < 50) {
      pushResolvers.shift()?.({ text: 'partial', isEndpoint: false });
      await flushMicrotasks();
    }

    // A trailing partial batch (< 100 ms) is flushed on stop before finishing the stream.
    emitAudioFrame(56);
    emitAudioFrame(57);
    const stopPromise = controller.stop('s1');
    await flushMicrotasks();
    while (pushResolvers.length > 0 && safety++ < 60) {
      pushResolvers.shift()?.({ text: 'partial', isEndpoint: false });
      await flushMicrotasks();
    }
    await stopPromise;

    expect(pushedFrameIndexes()).toEqual(Array.from({ length: 57 }, (_, i) => i + 1));
    expect(sherpaStreamingPushFrame.mock.calls.length).toBeLessThanOrEqual(4);
    expect(sherpaStreamingFinish).toHaveBeenCalledTimes(1);
  });

  it('auto-stops a hands-free turn when the native endpoint fires after recognized speech', async () => {
    const { controller, onAutoStopTurn } = await createController({ handsFree: { enabled: true } });
    controller.setHandsFreeSession('s1');
    await controller.start('s1');

    for (let i = 1; i <= 5; i++) emitAudioFrame(i);
    await flushMicrotasks();
    // Trailing silence without any recognized words is not a turn.
    pushResolvers.shift()?.({ text: '', isEndpoint: true });
    await flushMicrotasks();
    expect(onAutoStopTurn).not.toHaveBeenCalled();

    for (let i = 6; i <= 10; i++) emitAudioFrame(i);
    await flushMicrotasks();
    // The endpoint batch can carry the final words; the native endpoint fires only once, so it arms.
    pushResolvers.shift()?.({ text: 'hello there', isEndpoint: true });
    await flushMicrotasks();
    expect(onAutoStopTurn).toHaveBeenCalledWith('s1');
  });

  it('keeps listening while recognized words keep growing even if the native endpoint stays set', async () => {
    vi.useFakeTimers();
    const { controller, onAutoStopTurn } = await createController({ handsFree: { enabled: true, silenceMs: 450 } });
    controller.setHandsFreeSession('s1');
    await controller.start('s1');

    // A native build without stream reset keeps isEndpoint=true once tripped; growing text is still speech.
    const words = ['one', 'one two', 'one two three', 'one two three four', 'one two three four five'];
    for (const [n, text] of words.entries()) {
      for (let i = 1; i <= 5; i++) emitAudioFrame(n * 5 + i);
      await flushMicrotasks();
      pushResolvers.shift()?.({ text, isEndpoint: true });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(onAutoStopTurn).not.toHaveBeenCalled();
  });

  it('stops once even when stop is re-entered or the endpoint fires during a slow finish', async () => {
    let resolveFinish: (value: { text: string }) => void = () => {};
    sherpaStreamingFinish.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveFinish = resolve;
      }),
    );
    const { controller, onAutoStopTurn } = await createController({ handsFree: { enabled: true } });
    controller.setHandsFreeSession('s1');
    await controller.start('s1');

    for (let i = 1; i <= 5; i++) emitAudioFrame(i);
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello', isEndpoint: false });
    await flushMicrotasks();

    // A trailing partial batch is flushed during stop and reports an endpoint with unchanged text.
    emitAudioFrame(6);
    const first = controller.stop('s1');
    const second = controller.stop('s1');
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello', isEndpoint: true });
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello', isEndpoint: true });
    await flushMicrotasks();
    resolveFinish({ text: 'hello' });

    await expect(first).resolves.toBe('hello');
    await expect(second).resolves.toBe('hello');
    expect(sherpaStreamingFinish).toHaveBeenCalledTimes(1);
    expect(onAutoStopTurn).not.toHaveBeenCalled();
  });

  it('applies the hands-free silence policy after the endpoint and cancels it when speech resumes', async () => {
    vi.useFakeTimers();
    const { controller, onAutoStopTurn } = await createController({ handsFree: { enabled: true, silenceMs: 450 } });
    controller.setHandsFreeSession('s1');
    await controller.start('s1');

    for (let i = 1; i <= 5; i++) emitAudioFrame(i);
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello', isEndpoint: true });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(200);
    for (let i = 6; i <= 10; i++) emitAudioFrame(i);
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello again', isEndpoint: false });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onAutoStopTurn).not.toHaveBeenCalled();
  });

  it('ends the turn after the endpoint while later silent batches report no endpoint', async () => {
    vi.useFakeTimers();
    const { controller, onAutoStopTurn } = await createController({ handsFree: { enabled: true, silenceMs: 450 } });
    controller.setHandsFreeSession('s1');
    await controller.start('s1');

    for (let i = 1; i <= 5; i++) emitAudioFrame(i);
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello', isEndpoint: false });
    await flushMicrotasks();

    // Native resets the stream after an endpoint: isEndpoint is true only on the batch where it fires,
    // and later silent batches return the same committed text with isEndpoint=false.
    const results = [true, false, false];
    for (const [n, isEndpoint] of results.entries()) {
      for (let i = 1; i <= 5; i++) emitAudioFrame((n + 2) * 5 + i);
      await flushMicrotasks();
      pushResolvers.shift()?.({ text: 'hello', isEndpoint });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onAutoStopTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(onAutoStopTurn).toHaveBeenCalledWith('s1');
  });

  it('does not auto-stop when the session is not hands-free', async () => {
    const { controller, onAutoStopTurn } = await createController({ handsFree: { enabled: true } });
    await controller.start('s1');

    for (let i = 1; i <= 5; i++) emitAudioFrame(i);
    await flushMicrotasks();
    pushResolvers.shift()?.({ text: 'hello', isEndpoint: true });
    await flushMicrotasks();
    expect(onAutoStopTurn).not.toHaveBeenCalled();
  });

  it('releases the microphone and reports an error when the recognizer cannot be created', async () => {
    sherpaStreamingCreate.mockRejectedValueOnce(new Error('model load failed'));
    const { controller, patches } = await createController();

    await expect(controller.start('s1')).resolves.toBeUndefined();

    expect(audioStreamStop).toHaveBeenCalledWith({ streamId: 'stream-1' });
    expect(patches[patches.length - 1]).toEqual({ status: 'idle', sessionId: null, error: 'local_neural_stt_start_failed' });
    await expect(controller.stop('s1')).resolves.toBe('');
  });

  it('reports a start failure when the audio stream cannot start', async () => {
    audioStreamStart.mockRejectedValueOnce(new Error('mic busy'));
    const { controller, patches } = await createController();

    await expect(controller.start('s1')).resolves.toBeUndefined();

    expect(sherpaStreamingCreate).not.toHaveBeenCalled();
    expect(patches[patches.length - 1]).toEqual({ status: 'idle', sessionId: null, error: 'local_neural_stt_start_failed' });
  });

  it('honors a stop that arrives while start is still resolving the model pack', async () => {
    let resolveInstall: (value: typeof installedPack) => void = () => {};
    ensureModelPackInstalled.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const { controller, patches } = await createController();

    const startPromise = controller.start('s1');
    await flushMicrotasks();
    await expect(controller.stop('s1')).resolves.toBe('');
    resolveInstall(installedPack);
    await startPromise;

    expect(audioStreamStart).not.toHaveBeenCalled();
    expect(patches.some((patch) => patch.status === 'recording')).toBe(false);
  });

  it('releases the microphone when stop arrives while the recognizer is being created', async () => {
    let resolveCreate: () => void = () => {};
    sherpaStreamingCreate.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { controller, patches } = await createController();

    const startPromise = controller.start('s1');
    await vi.waitFor(() => expect(sherpaStreamingCreate).toHaveBeenCalled());
    await controller.stop('s1');
    resolveCreate();
    await startPromise;

    expect(audioStreamStop).toHaveBeenCalledWith({ streamId: 'stream-1' });
    expect(sherpaStreamingCancel).toHaveBeenCalled();
    expect(patches.some((patch) => patch.status === 'recording')).toBe(false);
  });

  it('ends the turn with an error when native audio capture fails mid-recording', async () => {
    const { controller, patches } = await createController();
    await controller.start('s1');

    listeners.get('audioError')?.({ streamId: 'stream-1', code: 'read_failed', message: 'AudioRecord.read -3' });
    await flushMicrotasks();

    expect(audioStreamStop).toHaveBeenCalledWith({ streamId: 'stream-1' });
    expect(patches[patches.length - 1]).toEqual({ status: 'idle', sessionId: null, error: 'local_neural_audio_capture_failed' });
  });
});
