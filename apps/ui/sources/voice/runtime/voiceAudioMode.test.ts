import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';

const setAudioModeAsync = vi.fn(async (_mode: unknown) => {});
const audioRuntime = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'web',
  coordinatorEnabled: true,
}));
const audioSession = createNativeVoicePcmCaptureHarness();
const nativeLookup = vi.fn(() => audioRuntime.coordinatorEnabled ? audioSession.nativeModule : null);

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return audioRuntime.platform;
      },
    },
  });
});

vi.mock('expo-audio', async () => (
  await import('@/dev/testkit/mocks/expoAudio')
).expoAudioModuleMock({ setAudioModeAsync: mode => setAudioModeAsync(mode) }));

vi.mock('expo-modules-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('expo-modules-core')>();
  return { ...original, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
    ? nativeLookup() : original.requireOptionalNativeModule(name) };
});

describe('voiceAudioMode', () => {
  beforeEach(() => {
    audioRuntime.platform = 'ios';
    audioRuntime.coordinatorEnabled = true;
    setAudioModeAsync.mockReset();
    nativeLookup.mockClear();
    vi.mocked(audioSession.nativeModule.configureAudioSession).mockClear();
    vi.mocked(audioSession.nativeModule.restoreAudioSession).mockClear();
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses the browser audio-mode boundary without requiring a native coordinator', async () => {
    audioRuntime.platform = 'web';
    audioRuntime.coordinatorEnabled = false;
    const { acquireVoiceForegroundRecordingAudioMode } = await import('./voiceAudioMode');

    const lease = await acquireVoiceForegroundRecordingAudioMode('expo-audio-recorder');

    expect(nativeLookup).not.toHaveBeenCalled();
    expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({
      allowsRecording: true,
      shouldPlayInBackground: false,
    }));
    await lease.release();
    await lease.release();
  });

  it('acquires provider-managed native call mode through the sole audio-session coordinator', async () => {
    const { acquireVoiceBackgroundCallAudioMode } = await import('./voiceAudioMode');
    const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');

    const lease = await acquireVoiceBackgroundCallAudioMode('happier.voice.elevenlabs/realtime-elevenlabs');

    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot()).toMatchObject({ leaseCount: 1, configuration: {
      mode: 'conversation', input: true, output: true, aec: 'preferred',
      capture: 'provider_managed_exclusive',
    } });
    expect(audioSession.nativeModule.configureAudioSession).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { mode: 'conversation', input: true, output: true, aec: 'preferred', capture: 'provider_managed_exclusive' },
    }));
    expect(setAudioModeAsync).not.toHaveBeenCalled();
    await lease.release();
    await lease.release();
    expect(audioSession.nativeModule.restoreAudioSession).toHaveBeenCalledOnce();
    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot()).toMatchObject({ leaseCount: 0, configuration: null });
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('acquires host-managed native playback mode through the sole audio-session coordinator', async () => {
    const { acquireVoicePlaybackAudioMode } = await import('./voiceAudioMode');
    const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');

    const lease = await acquireVoicePlaybackAudioMode('device-speech');

    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot()).toMatchObject({ leaseCount: 1, configuration: {
      mode: 'playback', input: false, output: true, aec: 'off',
      capture: 'host_managed',
    } });
    await lease.release();
    expect(audioSession.nativeModule.restoreAudioSession).toHaveBeenCalledOnce();
    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot()).toMatchObject({ leaseCount: 0, configuration: null });
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('uses a coordinator-free no-op playback lease on web', async () => {
    audioRuntime.platform = 'web';
    audioRuntime.coordinatorEnabled = false;
    const { acquireVoicePlaybackAudioMode } = await import('./voiceAudioMode');

    const lease = await acquireVoicePlaybackAudioMode('web-audio');
    await lease.release();

    expect(nativeLookup).not.toHaveBeenCalled();
    expect(audioSession.nativeModule.configureAudioSession).not.toHaveBeenCalled();
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it('redacts raw audio-mode errors from dev logging', async () => {
    audioRuntime.platform = 'web';
    setAudioModeAsync.mockRejectedValueOnce(new Error('private audio permission detail for /Users/example/secret'));

    const { ensureVoiceForegroundAudioMode } = await import('./voiceAudioMode');

    await ensureVoiceForegroundAudioMode();

    const diagnostics = vi.mocked(console.warn).mock.calls.filter(
      ([event]) => event === '[voiceAudioMode] Failed to set audio mode',
    );
    expect(diagnostics).toEqual([[
      '[voiceAudioMode] Failed to set audio mode', {
        mode: {
          allowsRecording: true,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        },
        errorKind: 'Error',
      },
    ]]);
  });
});
