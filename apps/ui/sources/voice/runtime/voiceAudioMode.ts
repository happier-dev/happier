import { AudioModule } from 'expo-audio';
import { Platform } from 'react-native';

type VoiceAudioMode = Readonly<{
  allowsRecording: boolean;
  playsInSilentMode: boolean;
  shouldPlayInBackground: boolean;
  interruptionMode: 'mixWithOthers' | 'doNotMix' | 'duckOthers';
}>;

// This module is the one owner of the app-wide audio session mode. Voice needs a session that
// records and plays through the Ring/Silent switch; sound effects need one that the switch mutes.
let voiceConfiguredAudioSession = false;
let soundEffectAudioSessionPreparation: Promise<boolean> | null = null;

async function safeSetAudioMode(mode: Partial<VoiceAudioMode>): Promise<boolean> {
  try {
    await AudioModule.setAudioModeAsync(mode as any);
    return true;
  } catch (error) {
    if (__DEV__) {
      console.warn('[voiceAudioMode] Failed to set audio mode', { mode, error });
    }
    return false;
  }
}

export async function ensureVoiceForegroundAudioMode(): Promise<void> {
  voiceConfiguredAudioSession = true;
  await safeSetAudioMode({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
}

export async function enableVoiceBackgroundCallAudioMode(): Promise<void> {
  voiceConfiguredAudioSession = true;
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

/**
 * Whether a sound effect may start now. iOS has no public API to read Focus / Do Not Disturb or the
 * Ring/Silent switch, so sound effects rely on the ambient category, which the switch mutes. Once
 * voice has set the session to play in silent mode, a sound effect could no longer honour the
 * switch, so sound effects stay off for the rest of the app run. Check this immediately before
 * playback: voice can claim the session while a sound is being prepared.
 */
export function canPlaySoundEffectNow(): boolean {
  return Platform.OS !== 'ios' || !voiceConfiguredAudioSession;
}

/**
 * Prepares the audio session for a short sound effect and says whether one may play. On iOS this
 * applies the ambient category, which mixes with other apps' audio. Concurrent callers share one
 * attempt; a failed attempt is reported and retried on the next sound rather than cached.
 * Other platforms need no session change.
 */
export async function prepareSoundEffectAudioSession(): Promise<boolean> {
  if (Platform.OS !== 'ios') return true;
  if (!canPlaySoundEffectNow()) return false;
  soundEffectAudioSessionPreparation ??= safeSetAudioMode({
    allowsRecording: false,
    playsInSilentMode: false,
    shouldPlayInBackground: false,
    interruptionMode: 'mixWithOthers',
  }).then((applied) => {
    if (!applied) {
      soundEffectAudioSessionPreparation = null;
      console.warn('[voiceAudioMode] Could not apply the ambient audio session; skipping the sound effect');
    }
    return applied;
  });
  return (await soundEffectAudioSessionPreparation) && canPlaySoundEffectNow();
}
