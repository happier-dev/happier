import { describe, expect, it, vi } from 'vitest';

const nativeBoundary = vi.hoisted(() => ({
  capture: null as unknown,
  playback: null as unknown,
}));

function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('@happier-dev/audio-stream-native', () => ({
  getSharedVoicePcmCapture: () => nativeBoundary.capture,
  getSharedVoicePcmPlayback: () => nativeBoundary.playback,
}));

import { createWebSocketPcmMedia } from './WebSocketPcmMedia.native';

describe('native WebSocketPcmMedia', () => {
  it('uses the one shared native capture/player lifecycle with a stream-scoped output lease', async () => {
    const callbacks: {
      onFrame: ((frame: Readonly<{ pcm16leBase64: string }>) => void) | null;
      onPlaybackError: ((error: Error) => void) | null;
    } = { onFrame: null, onPlaybackError: null };
    const releaseCapture = vi.fn(async () => {});
    const releasePlayback = vi.fn(async () => {});
    const enqueue = vi.fn(() => true);
    const clear = vi.fn();
    const setGain = vi.fn(() => true);
    const waitForDrain = vi.fn(async () => {});
    const playbackCursorMs = vi.fn(() => 325);
    const onInputChunk = vi.fn();
    const onOutputLevel = vi.fn();
    const ensureActive = vi.fn(async () => {});
    nativeBoundary.capture = {
      acquire: vi.fn(async (input: { onFrame: typeof callbacks.onFrame }) => {
        callbacks.onFrame = input.onFrame;
        return {
          id: 'native-capture',
          streamId: 'stream-1',
          generation: 3,
          waitForDrain: async () => {},
          release: releaseCapture,
        };
      }),
    };
    nativeBoundary.playback = {
      open: vi.fn(async (input: { onError?: (error: Error) => void }) => {
        callbacks.onPlaybackError = input.onError ?? null;
        return {
          streamId: 'stream-1',
          generation: 3,
          enqueue,
          clear,
          setGain,
          waitForDrain,
          playbackCursorMs,
          release: releasePlayback,
        };
      }),
    };

    const media = createWebSocketPcmMedia({
      mic: {
        ensureActive,
        isMuted: () => false,
        getStream: () => null,
      },
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, maxBufferedMs: 5_000 },
      onInputChunk,
      onOutputLevel,
    });
    const terminal = vi.fn();
    media.pcm.subscribeTerminal?.(terminal);

    await media.pcm.start(new AbortController().signal);

    expect(ensureActive).not.toHaveBeenCalled();

    expect((nativeBoundary.capture as { acquire: ReturnType<typeof vi.fn> }).acquire).toHaveBeenCalledWith(expect.objectContaining({
      format: { sampleRate: 24_000, channels: 1, frameMs: 100 },
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'required' },
    }));
    expect((nativeBoundary.playback as { open: ReturnType<typeof vi.fn> }).open).toHaveBeenCalledWith(expect.objectContaining({
      capture: { streamId: 'stream-1', generation: 3 },
      format: { sampleRate: 24_000, channels: 1, maxBufferedMs: 5_000 },
    }));

    callbacks.onFrame?.({ pcm16leBase64: 'AQACAA==' });
    expect(onInputChunk).toHaveBeenCalledWith('AQACAA==');
    expect(media.inputLevel()).toBeGreaterThan(0);
    expect(media.enqueueOutput('AQACAA==')).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('AQACAA==');
    expect(media.pcm.playbackCursorMs()).toBe(325);
    expect(media.playbackCursorMs()).toBe(325);
    expect(playbackCursorMs).toHaveBeenCalledTimes(2);

    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(setGain).toHaveBeenCalledWith(0.18);
    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(setGain).toHaveBeenLastCalledWith(1);
    expect(media.pcm.setOutputFocusState?.('suspended')).toBe('applied');
    expect(setGain).toHaveBeenLastCalledWith(0);
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    expect(setGain).toHaveBeenLastCalledWith(0);
    media.resolveOutputInterruptionCandidate('false_alarm');
    expect(setGain).toHaveBeenLastCalledWith(0);
    expect(media.pcm.setOutputFocusState?.('ducked')).toBe('applied');
    expect(setGain).toHaveBeenLastCalledWith(0.18);
    expect(media.pcm.setOutputFocusState?.('active')).toBe('applied');
    expect(setGain).toHaveBeenLastCalledWith(1);
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    media.resolveOutputInterruptionCandidate('confirmed');
    expect(clear).toHaveBeenCalledTimes(1);
    await media.waitForOutputDrain(new AbortController().signal);
    expect(waitForDrain).toHaveBeenCalledTimes(1);

    callbacks.onPlaybackError?.(Object.assign(new Error('pcm_playback_write_error'), {
      code: 'pcm_playback_write_error',
    }));
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      message: 'pcm_playback_write_error',
    }));

    await media.pcm.stop();
    await media.pcm.stop();
    expect(releasePlayback).toHaveBeenCalledTimes(1);
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);
  });

  it('fences a pending capture acquisition when stopped so late capture cannot open playback', async () => {
    const acquired = createDeferred<{
      id: string;
      streamId: string;
      generation: number;
      waitForDrain: () => Promise<void>;
      release: () => Promise<void>;
    }>();
    const releaseCapture = vi.fn(async () => {});
    const releasePlayback = vi.fn(async () => {});
    const openPlayback = vi.fn(async () => ({
      streamId: 'stream-1',
      generation: 3,
      enqueue: () => true,
      clear: () => {},
      setGain: () => true,
      waitForDrain: async () => {},
      playbackCursorMs: () => 0,
      release: releasePlayback,
    }));
    nativeBoundary.capture = { acquire: vi.fn(() => acquired.promise) };
    nativeBoundary.playback = { open: openPlayback };

    const media = createWebSocketPcmMedia({
      mic: { getStream: () => null },
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, maxBufferedMs: 5_000 },
      onInputChunk: () => {},
    });
    const starting = media.pcm.start(new AbortController().signal);
    await Promise.resolve();
    await media.pcm.stop();

    acquired.resolve({
      id: 'native-capture',
      streamId: 'stream-1',
      generation: 3,
      waitForDrain: async () => {},
      release: releaseCapture,
    });

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(openPlayback).not.toHaveBeenCalled();
    expect(releasePlayback).not.toHaveBeenCalled();
    expect(media.enqueueOutput('AQACAA==')).toBe(false);
  });

  it('releases a late capture acquisition when its start signal aborts', async () => {
    const acquired = createDeferred<{
      id: string;
      streamId: string;
      generation: number;
      waitForDrain: () => Promise<void>;
      release: () => Promise<void>;
    }>();
    const releaseCapture = vi.fn(async () => {});
    const openPlayback = vi.fn();
    nativeBoundary.capture = { acquire: vi.fn(() => acquired.promise) };
    nativeBoundary.playback = { open: openPlayback };

    const controller = new AbortController();
    const media = createWebSocketPcmMedia({
      mic: { getStream: () => null },
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: { sampleRate: 24_000, maxBufferedMs: 5_000 },
      onInputChunk: () => {},
    });
    const starting = media.pcm.start(controller.signal);
    await Promise.resolve();
    controller.abort();
    acquired.resolve({
      id: 'native-capture',
      streamId: 'stream-1',
      generation: 3,
      waitForDrain: async () => {},
      release: releaseCapture,
    });

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(openPlayback).not.toHaveBeenCalled();
  });
});
