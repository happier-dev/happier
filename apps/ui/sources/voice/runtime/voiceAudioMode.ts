import { AudioModule, type AudioMode } from 'expo-audio';
import { Platform } from 'react-native';
import {
  getSharedVoiceAudioSessionCoordinator,
  type VoiceAudioSessionLease,
} from '@happier-dev/audio-stream-native';

async function safeSetAudioMode(mode: Partial<AudioMode>): Promise<void> {
  try {
    await AudioModule.setAudioModeAsync(mode);
  } catch (error) {
    if (__DEV__) {
      console.warn('[voiceAudioMode] Failed to set audio mode', {
        mode,
        errorKind: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

export async function ensureVoiceForegroundAudioMode(): Promise<void> {
  if (Platform.OS !== 'web') return;
  await safeSetAudioMode({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
  });
}

export type VoiceAudioModeLease = Readonly<{ release: () => Promise<void> }>;

const NOOP_AUDIO_MODE_LEASE: VoiceAudioModeLease = Object.freeze({ release: async () => {} });

function audioSessionUnavailable(): Error {
  return Object.assign(new Error('voice_audio_session_unavailable'), {
    code: 'voice_audio_session_unavailable',
  });
}

async function acquireExclusiveVoiceAudioMode(input: Readonly<{
  ownerId: string;
  mode: 'dictation' | 'conversation';
  output: boolean;
  aec: 'preferred' | 'off';
  shouldPlayInBackground: boolean;
}>): Promise<VoiceAudioModeLease> {
  const normalizedOwnerId = input.ownerId.trim();
  if (!normalizedOwnerId) throw new Error('voice_audio_mode_owner_required');

  // Browser capture/playback is owned by getUserMedia/Web Audio. The native
  // coordinator is deliberately absent on web and must not make an otherwise
  // supported browser recording fail closed as if a native module were stale.
  // Keep Expo's web audio-mode boundary best-effort, with an idempotent lease
  // that restores the background flag without inventing a second session owner.
  if (Platform.OS === 'web') {
    await safeSetAudioMode({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: input.shouldPlayInBackground,
    });
    let released = false;
    return Object.freeze({
      async release(): Promise<void> {
        if (released) return;
        released = true;
        await safeSetAudioMode({ shouldPlayInBackground: false });
      },
    });
  }

  const coordinator = getSharedVoiceAudioSessionCoordinator();
  if (!coordinator) throw audioSessionUnavailable();

  const nativeLease: VoiceAudioSessionLease = await coordinator.acquire({
    ownerId: normalizedOwnerId,
    mode: input.mode,
    input: true,
    output: input.output,
    aec: input.aec,
    capture: 'provider_managed_exclusive',
  });

  let released = false;
  return Object.freeze({
    async release(): Promise<void> {
      if (released) return;
      await nativeLease.release();
      released = true;
    },
  });
}

export async function acquireVoiceBackgroundCallAudioMode(
  providerId: string,
): Promise<VoiceAudioModeLease> {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) throw new Error('voice_audio_mode_owner_required');
  return await acquireExclusiveVoiceAudioMode({
    ownerId: `realtime-provider:${normalizedProviderId}`,
    mode: 'conversation',
    output: true,
    aec: 'preferred',
    shouldPlayInBackground: true,
  });
}

export async function acquireVoiceForegroundRecordingAudioMode(
  ownerId: string,
): Promise<VoiceAudioModeLease> {
  return await acquireExclusiveVoiceAudioMode({
    ownerId: `recording:${ownerId}`,
    mode: 'dictation',
    output: false,
    aec: 'off',
    shouldPlayInBackground: false,
  });
}

export async function acquireVoicePlaybackAudioMode(ownerId: string): Promise<VoiceAudioModeLease> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) throw new Error('voice_audio_mode_owner_required');
  if (Platform.OS === 'web') return NOOP_AUDIO_MODE_LEASE;

  const coordinator = getSharedVoiceAudioSessionCoordinator();
  if (!coordinator) throw audioSessionUnavailable();
  return await coordinator.acquire({
    ownerId: `playback:${normalizedOwnerId}`,
    mode: 'playback',
    input: false,
    output: true,
    aec: 'off',
    capture: 'host_managed',
  });
}
