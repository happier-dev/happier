import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
import type { HappierAudioStreamNativeModule, VoiceEncodedAudioPlaybackEvent } from './HappierAudioStreamNative.types';
import { createVoiceEncodedAudioPlayback } from './voiceEncodedAudioPlayback';

describe('createVoiceEncodedAudioPlayback', () => {
  it('binds playback events and control to one exact native identity', async () => {
    let eventListener!: (event: VoiceEncodedAudioPlaybackEvent) => void;
    const startEncodedAudioPlayback = vi.fn(async (_params: { playbackId: string; uri: string }) => {});
    const setEncodedAudioPlaybackPaused = vi.fn(async (_params: { playbackId: string; paused: boolean }) => {});
    const stopEncodedAudioPlayback = vi.fn(async (_params: { playbackId: string }) => {});
    const module = {
      start: vi.fn(), stop: vi.fn(), configureAudioSession: vi.fn(), restoreAudioSession: vi.fn(),
      addListener: vi.fn((_name, listener) => {
        eventListener = listener as (event: VoiceEncodedAudioPlaybackEvent) => void;
        return { remove: vi.fn() };
      }),
      startEncodedAudioPlayback, setEncodedAudioPlaybackPaused, stopEncodedAudioPlayback,
    } as unknown as HappierAudioStreamNativeModule;
    const playback = createVoiceEncodedAudioPlayback(module);
    if (!playback) throw new Error('playback unavailable');
    const observed = vi.fn();
    playback.subscribe(observed);

    await playback.start('file:///tmp/a.mp3');
    const params = startEncodedAudioPlayback.mock.calls[0]![0];
    expect(params.uri).toBe('file:///tmp/a.mp3');
    eventListener({ playbackId: 'other', status: 'finished' });
    expect(observed).not.toHaveBeenCalled();
    eventListener({ playbackId: params.playbackId, status: 'started' });
    expect(observed).toHaveBeenCalledOnce();
    await playback.setPaused(true);
    await playback.stop();

    expect(setEncodedAudioPlaybackPaused).toHaveBeenCalledWith({ playbackId: params.playbackId, paused: true });
    expect(stopEncodedAudioPlayback).toHaveBeenCalledWith({ playbackId: params.playbackId });
  });
});
