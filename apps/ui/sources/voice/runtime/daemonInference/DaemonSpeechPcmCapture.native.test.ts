import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { createDaemonSpeechPcmCapture } from './DaemonSpeechPcmCapture.native';

type SubscriberRequest = Readonly<{
  ownerId: string;
  format: Readonly<{ sampleRate: number; channels: number; frameMs: number }>;
  audioSession: unknown;
  shouldDeliver?: () => boolean;
  onFrame: (event: any) => void | Promise<void>;
  onDroppedFrames?: (count: number) => void;
  onError?: (error: unknown) => void;
}>;

const sharedCapture = vi.hoisted(() => ({
  available: true,
  request: null as SubscriberRequest | null,
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  waitForDrain: vi.fn(async () => {}),
}));

vi.mock('@happier-dev/audio-stream-native', () => ({
  getSharedVoicePcmCapture: () => sharedCapture.available ? {
    acquire: sharedCapture.acquire,
    waitForDrain: sharedCapture.waitForDrain,
  } : null,
}));

const VALID_PCM16_BASE64 = Buffer.from([0, 0, 1, 0]).toString('base64');
const VALID_PCM16_BYTES = new Uint8Array([0, 0, 1, 0]);

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

async function emitFrame(overrides: Record<string, unknown> = {}): Promise<void> {
  const request = sharedCapture.request;
  if (!request) throw new Error('missing capture request');
  if (request.shouldDeliver?.() === false) return;
  try {
    await request.onFrame({
      streamId: 'shared-stream',
      pcm16leBase64: VALID_PCM16_BASE64,
      sampleRate: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount,
      ...overrides,
    });
  } catch (error) {
    request.onError?.(error);
  }
}

describe('createDaemonSpeechPcmCapture (native shared capture)', () => {
  beforeEach(() => {
    sharedCapture.available = true;
    sharedCapture.request = null;
    sharedCapture.release.mockClear();
    sharedCapture.waitForDrain.mockClear();
    sharedCapture.acquire.mockReset();
    sharedCapture.acquire.mockImplementation(async (request: SubscriberRequest) => {
      sharedCapture.request = request;
      return {
        id: 'lease',
        streamId: 'shared-stream',
        release: sharedCapture.release,
        waitForDrain: sharedCapture.waitForDrain,
      };
    });
  });

  it('fails closed when the package-owned shared capture is unavailable', async () => {
    sharedCapture.available = false;
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);
    await capture.start();
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'daemon_streaming_stt_pcm_capture_unavailable' }));
    expect(sharedCapture.acquire).not.toHaveBeenCalled();
  });

  it('acquires one conversation/AEC subscriber with the canonical PCM format', async () => {
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);
    await capture.start();

    expect(options.micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(sharedCapture.acquire).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'daemon-streaming-stt',
      format: {
        sampleRate: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz,
        channels: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount,
        frameMs: 20,
      },
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'required' },
      maxQueuedFrames: 8,
    }));
    expect(capture.isActive()).toBe(true);
  });

  it('decodes canonical frames and equality-gates the audio-start edge', async () => {
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);
    await capture.start();
    await emitFrame();
    await emitFrame();

    expect(options.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(options.onChunk).toHaveBeenCalledTimes(2);
    expect(options.onChunk).toHaveBeenNthCalledWith(1, VALID_PCM16_BYTES);
  });

  it('drops muted, malformed, and non-canonical frames', async () => {
    const micSession = createMicSession();
    const options = createCaptureOptions({ micSession });
    const capture = createDaemonSpeechPcmCapture(options);
    await capture.start();
    micSession.isMuted.mockReturnValue(true);
    await emitFrame();
    micSession.isMuted.mockReturnValue(false);
    await emitFrame({ sampleRate: 48_000 });
    await emitFrame({ channels: 2 });
    await emitFrame({ pcm16leBase64: 'invalid' });
    expect(options.onChunk).not.toHaveBeenCalled();
  });

  it('releases exactly once on abort/stop and leaves mic teardown to its owner', async () => {
    const abortController = new AbortController();
    const micSession = createMicSession();
    const capture = createDaemonSpeechPcmCapture(createCaptureOptions({ micSession, signal: abortController.signal }));
    await capture.start();
    abortController.abort();
    await capture.stop();
    await capture.stop();
    expect(sharedCapture.release).toHaveBeenCalledTimes(1);
    expect(micSession.teardown).not.toHaveBeenCalled();
  });

  it('reports startup failure and does not retain a half-open lease', async () => {
    sharedCapture.acquire.mockRejectedValueOnce(new Error('configure_failed'));
    const options = createCaptureOptions();
    const capture = createDaemonSpeechPcmCapture(options);
    await capture.start();
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'daemon_streaming_stt_pcm_capture_start_failed' }));
    expect(capture.isActive()).toBe(false);
  });

  it('maps subscriber delivery failures and dropped-frame backpressure to typed fatal errors', async () => {
    const options = createCaptureOptions({ onChunk: vi.fn(async () => { throw new Error('send_failed'); }) });
    const capture = createDaemonSpeechPcmCapture(options);
    await capture.start();
    await emitFrame();
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'daemon_streaming_stt_pcm_chunk_failed' }));
    await vi.waitFor(() => expect(sharedCapture.release).toHaveBeenCalledTimes(1));

    const secondOptions = createCaptureOptions();
    const second = createDaemonSpeechPcmCapture(secondOptions);
    await second.start();
    sharedCapture.request?.onDroppedFrames?.(1);
    expect(secondOptions.onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'daemon_streaming_stt_pcm_backpressure' }));
    await vi.waitFor(() => expect(sharedCapture.release).toHaveBeenCalledTimes(2));
  });

  it('delegates drain waiting to its own subscriber lease', async () => {
    const capture = createDaemonSpeechPcmCapture(createCaptureOptions());
    await capture.start();
    await capture.waitForDrain();
    expect(sharedCapture.waitForDrain).toHaveBeenCalledTimes(1);
  });
});
