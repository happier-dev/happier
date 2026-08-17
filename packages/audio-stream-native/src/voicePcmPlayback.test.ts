import { describe, expect, it, vi } from 'vitest';

import type {
  AudioStreamPlaybackDrainedEvent,
  AudioStreamPlaybackLevelEvent,
  AudioStreamPlaybackTerminalEvent,
  HappierAudioStreamNativeModule,
} from './HappierAudioStreamNative.types';
import { createVoicePcmPlayback } from './voicePcmPlayback';
import type { VoicePcmCapture } from './voicePcmCapture';

function createHarness() {
  let drainedListener: ((event: AudioStreamPlaybackDrainedEvent) => void) | null = null;
  let levelListener: ((event: AudioStreamPlaybackLevelEvent) => void) | null = null;
  let terminalListener: ((event: AudioStreamPlaybackTerminalEvent) => void) | null = null;
  const nativeModule = {
    start: vi.fn(async () => ({ streamId: 'capture-1' })),
    stop: vi.fn(async () => undefined),
    configureAudioSession: vi.fn(async ({ generation, configuration }) => ({
      generation,
      aecAvailable: true,
      aecActive: configuration.aec !== 'off',
      route: 'speaker',
    })),
    restoreAudioSession: vi.fn(async () => undefined),
    startPlayback: vi.fn(async () => ({ streamId: 'capture-1', generation: 7 })),
    enqueuePlayback: vi.fn(() => ({ accepted: true, level: 0.4 })),
    clearPlayback: vi.fn(),
    stopPlayback: vi.fn(async () => undefined),
    setPlaybackGain: vi.fn(),
    getPlaybackCursorMs: vi.fn(() => 725),
    addListener: vi.fn((eventName, listener) => {
      if (eventName === 'playbackDrained') {
        drainedListener = listener as (event: AudioStreamPlaybackDrainedEvent) => void;
      }
      if (eventName === 'playbackLevel') {
        levelListener = listener as (event: AudioStreamPlaybackLevelEvent) => void;
      }
      if (eventName === 'playbackTerminal') {
        terminalListener = listener as (event: AudioStreamPlaybackTerminalEvent) => void;
      }
      return {
        remove: () => {
          if (eventName === 'playbackDrained') drainedListener = null;
          if (eventName === 'playbackLevel') levelListener = null;
          if (eventName === 'playbackTerminal') terminalListener = null;
        },
      };
    }),
  } satisfies HappierAudioStreamNativeModule & Readonly<{
    getPlaybackCursorMs: (params: { streamId: string; generation: number }) => number;
  }>;
  const capture = {
    getSnapshot: vi.fn(() => ({
      generation: 7,
      streamId: 'capture-1',
      subscriberCount: 1,
      format: { sampleRate: 24_000, channels: 1, frameMs: 100 },
    })),
  } as unknown as VoicePcmCapture;
  return {
    nativeModule,
    capture,
    emitDrained: (event: AudioStreamPlaybackDrainedEvent) => drainedListener?.(event),
    emitLevel: (event: AudioStreamPlaybackLevelEvent) => levelListener?.(event),
    emitTerminal: (event: AudioStreamPlaybackTerminalEvent) => terminalListener?.(event),
  };
}

describe('VoicePcmPlayback', () => {
  it('attaches bounded PCM output to the exact active capture stream and rejects writes after release', async () => {
    const harness = createHarness();
    const playback = createVoicePcmPlayback(harness);
    const onOutputLevel = vi.fn();
    const lease = await playback.open({
      capture: { streamId: 'capture-1', generation: 7 },
      format: { sampleRate: 24_000, channels: 1, maxBufferedMs: 5_000 },
      onOutputLevel,
    });

    expect(harness.nativeModule.startPlayback).toHaveBeenCalledWith({
      streamId: 'capture-1',
      generation: 7,
      sampleRate: 24_000,
      channels: 1,
      maxBufferedMs: 5_000,
    });
    expect(lease.enqueue('AQI=')).toBe(true);
    expect(harness.nativeModule.enqueuePlayback).toHaveBeenCalledWith({
      streamId: 'capture-1',
      generation: 7,
      pcm16leBase64: 'AQI=',
    });
    expect(onOutputLevel).toHaveBeenLastCalledWith(0.4);
    expect(lease.playbackCursorMs()).toBe(725);
    expect(harness.nativeModule.getPlaybackCursorMs).toHaveBeenCalledWith({
      streamId: 'capture-1',
      generation: 7,
    });

    let drained = false;
    const waiting = lease.waitForDrain().then(() => { drained = true; });
    harness.emitDrained({ streamId: 'capture-1', generation: 7 });
    await waiting;
    expect(drained).toBe(true);
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);

    await Promise.all([lease.release(), lease.release()]);
    expect(harness.nativeModule.stopPlayback).toHaveBeenCalledTimes(1);
    expect(lease.enqueue('AQI=')).toBe(false);
    expect(lease.playbackCursorMs()).toBe(0);
  });

  it('fails closed for a stale capture stream and reports matching native playback terminal failures', async () => {
    const harness = createHarness();
    const playback = createVoicePcmPlayback(harness);
    await expect(playback.open({
      capture: { streamId: 'stale-stream', generation: 6 },
      format: { sampleRate: 24_000, channels: 1, maxBufferedMs: 5_000 },
    })).rejects.toMatchObject({ code: 'playback_capture_mismatch' });
    expect(harness.nativeModule.startPlayback).not.toHaveBeenCalled();

    const onError = vi.fn();
    const lease = await playback.open({
      capture: { streamId: 'capture-1', generation: 7 },
      format: { sampleRate: 24_000, channels: 1, maxBufferedMs: 5_000 },
      onError,
    });
    harness.emitLevel({ streamId: 'wrong-stream', generation: 7, level: 1 });
    harness.emitTerminal({ streamId: 'capture-1', generation: 7, reason: 'write_error' });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'native_playback_write_error' }));
    expect(lease.enqueue('AQI=')).toBe(false);
    await expect(lease.waitForDrain()).rejects.toMatchObject({ code: 'native_playback_write_error' });
  });
});
