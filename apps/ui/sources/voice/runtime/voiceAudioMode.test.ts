import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAudioModeAsync = vi.fn(async (_mode: unknown) => {});

vi.mock('expo-audio', () => ({
  AudioModule: {
    setAudioModeAsync: (mode: unknown) => setAudioModeAsync(mode),
  },
}));

describe('voiceAudioMode', () => {
  beforeEach(() => {
    setAudioModeAsync.mockReset();
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('redacts raw audio-mode errors from dev logging', async () => {
    setAudioModeAsync.mockRejectedValueOnce(new Error('native audio permissions failed'));

    const { ensureVoiceForegroundAudioMode } = await import('./voiceAudioMode');

    await ensureVoiceForegroundAudioMode();

    expect(console.warn).toHaveBeenCalledWith(
      '[voiceAudioMode] Failed to set audio mode',
      expect.objectContaining({
        mode: expect.objectContaining({
          allowsRecording: true,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        }),
        errorKind: 'Error',
      }),
    );
  });
});
