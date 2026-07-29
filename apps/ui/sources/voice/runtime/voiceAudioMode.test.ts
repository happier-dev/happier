import { beforeEach, describe, expect, it, vi } from 'vitest';

const setAudioModeAsync = vi.fn(async (_mode: unknown) => {});
const audioRuntime = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'web',
  acquire: vi.fn(),
  coordinatorEnabled: true,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return audioRuntime.platform;
    },
  },
}));

vi.mock('expo-audio', () => ({
  AudioModule: {
    setAudioModeAsync: (mode: unknown) => setAudioModeAsync(mode),
  },
}));

vi.mock('@happier-dev/audio-stream-native', () => ({
  getSharedVoiceAudioSessionCoordinator: () => (
    audioRuntime.coordinatorEnabled ? { acquire: audioRuntime.acquire } : null
  ),
}));

describe('voiceAudioMode', () => {
  beforeEach(() => {
    audioRuntime.platform = 'ios';
    audioRuntime.coordinatorEnabled = true;
    setAudioModeAsync.mockReset();
    audioRuntime.acquire.mockReset();
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('uses the browser audio-mode boundary without requiring a native coordinator', async () => {
    audioRuntime.platform = 'web';
    audioRuntime.coordinatorEnabled = false;
    const { acquireVoiceForegroundRecordingAudioMode } = await import('./voiceAudioMode');

    const lease = await acquireVoiceForegroundRecordingAudioMode('expo-audio-recorder');

    expect(audioRuntime.acquire).not.toHaveBeenCalled();
    expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({
      allowsRecording: true,
      shouldPlayInBackground: false,
    }));
    await lease.release();
    await lease.release();
  });

  it('acquires provider-managed native call mode through the sole audio-session coordinator', async () => {
    const release = vi.fn(async () => {});
    audioRuntime.acquire.mockResolvedValueOnce({ release, capabilities: { aecAvailable: true, aecActive: true, route: 'speaker' } });
    const { acquireVoiceBackgroundCallAudioMode } = await import('./voiceAudioMode');

    const lease = await acquireVoiceBackgroundCallAudioMode('realtime_elevenlabs');

    expect(audioRuntime.acquire).toHaveBeenCalledWith({
      ownerId: 'realtime-provider:realtime_elevenlabs',
      mode: 'conversation', input: true, output: true, aec: 'preferred',
      capture: 'provider_managed_exclusive',
    });
    expect(setAudioModeAsync).not.toHaveBeenCalled();
    await lease.release();
    await lease.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('acquires host-managed native playback mode through the sole audio-session coordinator', async () => {
    const release = vi.fn(async () => {});
    audioRuntime.acquire.mockResolvedValueOnce({ release });
    const { acquireVoicePlaybackAudioMode } = await import('./voiceAudioMode');

    const lease = await acquireVoicePlaybackAudioMode('device-speech');

    expect(audioRuntime.acquire).toHaveBeenCalledWith({
      ownerId: 'playback:device-speech',
      mode: 'playback', input: false, output: true, aec: 'off',
      capture: 'host_managed',
    });
    await lease.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('uses a coordinator-free no-op playback lease on web', async () => {
    audioRuntime.platform = 'web';
    audioRuntime.coordinatorEnabled = false;
    const { acquireVoicePlaybackAudioMode } = await import('./voiceAudioMode');

    const lease = await acquireVoicePlaybackAudioMode('web-audio');
    await lease.release();

    expect(audioRuntime.acquire).not.toHaveBeenCalled();
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('redacts raw audio-mode errors from dev logging', async () => {
    audioRuntime.platform = 'web';
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
