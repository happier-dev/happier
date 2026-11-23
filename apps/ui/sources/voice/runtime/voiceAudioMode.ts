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
let soundEffectAudioSessionApplied = false;

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
 * Prepares the session for a short sound effect and says whether one may play.
 *
 * iOS has no public API to read Focus / Do Not Disturb or the Ring/Silent switch, so sound effects
 * use the ambient category, which mixes with other apps' audio and is muted by the switch. Once
 * voice has set the session to play in silent mode, a sound effect could no longer honour the
 * switch, so it is skipped for the rest of the app run. Other platforms need no session change.
 */
export async function prepareSoundEffectAudioSession(): Promise<boolean> {
  if (Platform.OS !== 'ios') return true;
  if (voiceConfiguredAudioSession) return false;
  if (!soundEffectAudioSessionApplied) {
    soundEffectAudioSessionApplied = true;
    await safeSetAudioMode({
      allowsRecording: false,
      playsInSilentMode: false,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    });
  }
  return true;
}
