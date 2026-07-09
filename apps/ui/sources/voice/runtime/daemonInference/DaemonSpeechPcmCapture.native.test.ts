import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { createDaemonSpeechPcmCapture } from './DaemonSpeechPcmCapture.native';

type NativeAudioFrame = Readonly<{
  streamId: string;
  pcm16leBase64: string;
  sampleRate: number;
  channels: number;
}>;

type NativeAudioFrameListener = (event: NativeAudioFrame) => void;

const nativeAudioStream = vi.hoisted(() => {
  const state: {
    available: boolean;
    listener: NativeAudioFrameListener | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
  } = {
    available: true,
    listener: null,
    start: vi.fn(async () => ({ streamId: 'native-stream-1' })),
    stop: vi.fn(async () => {}),
    remove: vi.fn(),
    addListener: vi.fn(),
  };
  state.addListener.mockImplementation((eventName: 'audioFrame', cb: NativeAudioFrameListener) => {
    if (eventName !== 'audioFrame') {
      throw new Error(`unexpected event ${eventName}`);
    }
    state.listener = cb;
    return { remove: state.remove };
  });
  return state;
});

vi.mock('@happier-dev/audio-stream-native', () => ({
  getOptionalHappierAudioStreamNativeModule: () =>
    nativeAudioStream.available
      ? {
          start: nativeAudioStream.start,
          stop: nativeAudioStream.stop,
          addListener: nativeAudioStream.addListener,
        }
      : null,
}));

const VALID_PCM16_BASE64 = Buffer.from([0, 0, 1, 0]).toString('base64');
const VALID_PCM16_BYTES = new Uint8Array([0, 0, 1, 0]);

function toInt16Values(bytes: Uint8Array): readonly number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    values.push(view.getInt16(offset, true));
  }
  return values;
}

function createMicSession() {
  return {
    ensureActive: vi.fn(async () => {}),
    setMuted: vi.fn(),
    isMuted: vi.fn(() => false),
    teardown: vi.fn(async () => {}),
    getStream: vi.fn(() => null),
    getAudioContext: vi.fn(() => null),
  };
}

function createCaptureOptions(overrides: Partial<Parameters<typeof createDaemonSpeechPcmCapture>[0]> = {}) {
  return {
    micSession: createMicSession(),
    onAudioStarted: vi.fn(),
    onChunk: vi.fn(async (_pcm16Bytes: Uint8Array) => {}),
    onError: vi.fn(),
    ...overrides,
  };
}

function emitNativeFrame(frame: Partial<NativeAudioFrame> = {}): void {
  if (!nativeAudioStream.listener) {
    throw new Error('missing native audio frame listener');
  }
  nativeAudioStream.listener({
    streamId: 'native-stream-1',
    pcm16leBase64: VALID_PCM16_BASE64,
    sampleRate: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz,
    channels: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount,
    ...frame,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createDaemonSpeechPcmCapture (native)', () => {
  beforeEach(() => {
    nativeAudioStream.available = true;
    nativeAudioStream.listener = null;
    nativeAudioStream.start.mockReset();
    nativeAudioStream.start.mockResolvedValue({ streamId: 'native-stream-1' });
    nativeAudioStream.stop.mockReset();
    nativeAudioStream.stop.mockResolvedValue(undefined);
    nativeAudioStream.remove.mockClear();
    nativeAudioStream.addListener.mockClear();
  });

  it('reports a typed unavailable error when the native audio stream module is missing', async () => {
    nativeAudioStream.available = false;
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();

    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_capture_unavailable',
    }));
    expect(nativeAudioStream.start).not.toHaveBeenCalled();
    expect(capture.isActive()).toBe(false);
  });

  it('starts native capture with the canonical daemon STT PCM format', async () => {
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();

    expect(options.micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(nativeAudioStream.start).toHaveBeenCalledWith({
      sampleRate: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount,
      frameMs: 20,
    });
    expect(nativeAudioStream.addListener).toHaveBeenCalledWith('audioFrame', expect.any(Function));
    expect(capture.isActive()).toBe(true);
  });

  it('reports a typed start failure when mic activation fails before native start', async () => {
    const micSession = createMicSession();
    micSession.ensureActive.mockRejectedValueOnce(new Error('mic_permission_denied'));
    const options = createCaptureOptions({ micSession });
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();

    expect(nativeAudioStream.start).not.toHaveBeenCalled();
    expect(nativeAudioStream.addListener).not.toHaveBeenCalled();
    expect(nativeAudioStream.stop).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_capture_start_failed',
    }));
    expect(micSession.teardown).not.toHaveBeenCalled();
    expect(capture.isActive()).toBe(false);
  });

  it('only accepts frames for the active native stream id', async () => {
    const onChunk = vi.fn(async (_pcm16Bytes: Uint8Array) => {});
    const options = createCaptureOptions({ onChunk });
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();
    emitNativeFrame({ streamId: 'stale-stream' });
    emitNativeFrame();
    await capture.waitForDrain();

    expect(options.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(1);
    const firstChunk = onChunk.mock.calls[0]?.[0];
    expect(firstChunk).toBeInstanceOf(Uint8Array);
    expect(firstChunk).toEqual(VALID_PCM16_BYTES);
    expect(toInt16Values(firstChunk as Uint8Array)).toEqual([0, 1]);
  });

  it('drops muted mic frames without marking audio started or sending chunks', async () => {
    const micSession = createMicSession();
    micSession.isMuted.mockReturnValueOnce(true).mockReturnValue(false);
    const options = createCaptureOptions({ micSession });
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();
    emitNativeFrame();
    await capture.waitForDrain();
    emitNativeFrame();
    await capture.waitForDrain();

    expect(options.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(options.onChunk).toHaveBeenCalledTimes(1);
  });

  it('drops invalid native PCM frames before calling onChunk', async () => {
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();
    emitNativeFrame({ sampleRate: 48_000 });
    emitNativeFrame({ channels: 2 });
    emitNativeFrame({ pcm16leBase64: '' });
    emitNativeFrame({ pcm16leBase64: 'not valid base64' });
    await capture.waitForDrain();

    expect(options.onAudioStarted).not.toHaveBeenCalled();
    expect(options.onChunk).not.toHaveBeenCalled();
  });

  it('removes the listener, stops the exact native stream, ignores late frames, and leaves mic teardown to the owner', async () => {
    const abortController = new AbortController();
    const micSession = createMicSession();
    const options = createCaptureOptions({ micSession, signal: abortController.signal });
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();
    abortController.abort();
    await capture.stop();
    emitNativeFrame();
    await capture.waitForDrain();
    await capture.stop();

    expect(nativeAudioStream.remove).toHaveBeenCalledTimes(1);
    expect(nativeAudioStream.stop).toHaveBeenCalledTimes(1);
    expect(nativeAudioStream.stop).toHaveBeenCalledWith({ streamId: 'native-stream-1' });
    expect(options.onChunk).not.toHaveBeenCalled();
    expect(micSession.teardown).not.toHaveBeenCalled();
    expect(capture.isActive()).toBe(false);
  });

  it('cleans up the native stream if listener setup fails after start', async () => {
    nativeAudioStream.addListener.mockImplementationOnce(() => {
      throw new Error('listener_failed');
    });
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();

    expect(nativeAudioStream.start).toHaveBeenCalledTimes(1);
    expect(nativeAudioStream.stop).toHaveBeenCalledWith({ streamId: 'native-stream-1' });
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_capture_start_failed',
    }));
    expect(capture.isActive()).toBe(false);
    expect(options.micSession.teardown).not.toHaveBeenCalled();
  });

  it('reports a typed fatal send error and stops native capture when chunk sending fails', async () => {
    const options = createCaptureOptions({
      onChunk: vi.fn(async () => {
        throw new Error('send_failed');
      }),
    });
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();
    emitNativeFrame();
    await capture.waitForDrain();

    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_chunk_failed',
    }));
    expect(nativeAudioStream.remove).toHaveBeenCalledTimes(1);
    expect(nativeAudioStream.stop).toHaveBeenCalledWith({ streamId: 'native-stream-1' });
  });

  it('reports typed backpressure and stops native capture instead of queueing unbounded chunks', async () => {
    const pending = deferred();
    const options = createCaptureOptions({
      maxQueuedChunks: 1,
      onChunk: vi.fn(() => pending.promise),
    });
    const capture = createDaemonSpeechPcmCapture(options);

    await capture.start();
    emitNativeFrame({ pcm16leBase64: Buffer.from([1, 0]).toString('base64') });
    emitNativeFrame({ pcm16leBase64: Buffer.from([2, 0]).toString('base64') });

    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_pcm_backpressure',
    }));
    expect(nativeAudioStream.remove).toHaveBeenCalledTimes(1);
    expect(nativeAudioStream.stop).toHaveBeenCalledWith({ streamId: 'native-stream-1' });

    pending.resolve();
    await capture.stop();
  });
});
