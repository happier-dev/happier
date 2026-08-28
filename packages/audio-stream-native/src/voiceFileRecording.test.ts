import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
import type { HappierAudioStreamNativeModule } from './HappierAudioStreamNative.types';
import { createVoiceFileRecording } from './voiceFileRecording';

function createModule(overrides: Partial<HappierAudioStreamNativeModule>): HappierAudioStreamNativeModule {
  return {
    start: vi.fn(), stop: vi.fn(), configureAudioSession: vi.fn(), restoreAudioSession: vi.fn(),
    addListener: vi.fn(() => ({ remove: () => {} })), ...overrides,
  } as unknown as HappierAudioStreamNativeModule;
}

describe('createVoiceFileRecording', () => {
  it('fails closed when the paired native module does not own file recording', () => {
    expect(createVoiceFileRecording(createModule({}))).toBeNull();
  });

  it('stops and mutes the exact native recording returned by start', async () => {
    const startFileRecording = vi.fn(async () => ({ recordingId: 'r1' }));
    const setFileRecordingMuted = vi.fn(async () => {});
    const stopFileRecording = vi.fn(async () => ({ uri: 'file:///tmp/r1.m4a' }));
    const recording = createVoiceFileRecording(createModule({ startFileRecording, setFileRecordingMuted, stopFileRecording }));
    if (!recording) throw new Error('recording unavailable');

    await recording.start();
    await recording.setMuted(true);
    await expect(recording.stop()).resolves.toBe('file:///tmp/r1.m4a');
    await expect(recording.stop()).resolves.toBeNull();

    expect(startFileRecording).toHaveBeenCalledWith({ format: 'm4a' });
    expect(setFileRecordingMuted).toHaveBeenCalledWith({ recordingId: 'r1', muted: true });
    expect(stopFileRecording).toHaveBeenCalledOnce();
  });
});
