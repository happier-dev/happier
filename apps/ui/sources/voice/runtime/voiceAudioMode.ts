import { AudioModule } from 'expo-audio';

type VoiceAudioMode = Readonly<{
  allowsRecording: boolean;
  playsInSilentMode: boolean;
  shouldPlayInBackground: boolean;
}>;

async function safeSetAudioMode(mode: Partial<VoiceAudioMode>): Promise<void> {
  try {
    await AudioModule.setAudioModeAsync(mode as any);
  } catch (error) {
    if (__DEV__) {
      console.warn('[voiceAudioMode] Failed to set audio mode', { mode, error });
    }
  }
}

export async function ensureVoiceForegroundAudioMode(): Promise<void> {
  await safeSetAudioMode({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
}

export async function enableVoiceBackgroundCallAudioMode(): Promise<void> {
  await safeSetAudioMode({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: true,
  });
}

export async function disableVoiceBackgroundCallAudioMode(): Promise<void> {
  await safeSetAudioMode({
    shouldPlayInBackground: false,
  });
}

