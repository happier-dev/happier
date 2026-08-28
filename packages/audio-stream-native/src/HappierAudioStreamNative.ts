import { requireOptionalNativeModule } from 'expo-modules-core';

import type {
  HappierAudioStreamNativeModule,
  HappierAudioStreamNativePlaybackModule,
  HappierAudioStreamNativeFileRecordingModule,
  HappierAudioStreamNativeEncodedPlaybackModule,
} from './HappierAudioStreamNative.types';
import type {
  VoiceAudioSessionPlatform,
  VoiceAudioSessionPlatformEvent,
} from './voiceAudioSessionCoordinator';

export const HAPPIER_AUDIO_STREAM_NATIVE_MODULE_NAME = 'HappierAudioStreamNative';

export function getOptionalHappierAudioStreamNativeModule(): HappierAudioStreamNativeModule | null {
  try {
    const mod = requireOptionalNativeModule(HAPPIER_AUDIO_STREAM_NATIVE_MODULE_NAME) as HappierAudioStreamNativeModule | null;
    return mod ?? null;
  } catch {
    return null;
  }
}

export function supportsVoiceFileRecording(
  module: HappierAudioStreamNativeModule | null,
): module is HappierAudioStreamNativeFileRecordingModule {
  return supportsVoiceAudioSessionCoordination(module)
    && typeof module.startFileRecording === 'function'
    && typeof module.setFileRecordingMuted === 'function'
    && typeof module.stopFileRecording === 'function';
}

export function supportsVoiceEncodedAudioPlayback(
  module: HappierAudioStreamNativeModule | null,
): module is HappierAudioStreamNativeEncodedPlaybackModule {
  return supportsVoiceAudioSessionCoordination(module)
    && typeof module.startEncodedAudioPlayback === 'function'
    && typeof module.setEncodedAudioPlaybackPaused === 'function'
    && typeof module.stopEncodedAudioPlayback === 'function';
}

export function supportsVoiceAudioSessionCoordination(
  module: HappierAudioStreamNativeModule | null,
): module is HappierAudioStreamNativeModule {
  return typeof module?.start === 'function'
    && typeof module.stop === 'function'
    && typeof module.addListener === 'function'
    && typeof module.configureAudioSession === 'function'
    && typeof module.restoreAudioSession === 'function';
}

/**
 * Playback is additive to the capture/session bridge so an older installed
 * native module can still provide capture without advertising output support.
 */
export function supportsVoicePcmPlayback(
  module: HappierAudioStreamNativeModule | null,
): module is HappierAudioStreamNativePlaybackModule {
  return supportsVoiceAudioSessionCoordination(module)
    && typeof module.startPlayback === 'function'
    && typeof module.enqueuePlayback === 'function'
    && typeof module.clearPlayback === 'function'
    && typeof module.stopPlayback === 'function'
    && typeof module.setPlaybackGain === 'function'
    && typeof module.getPlaybackCursorMs === 'function';
}

export function createHappierAudioStreamNativePlatform(
  module: HappierAudioStreamNativeModule,
): VoiceAudioSessionPlatform {
  if (!supportsVoiceAudioSessionCoordination(module)) {
    throw new Error('voice_audio_session_coordination_unavailable');
  }
  return {
    apply: async (request) => {
      const applied = await module.configureAudioSession(request);
      // Configuring an audio session can request voice processing, but it does
      // not activate a capture. The start-time capabilities event is the sole
      // confirmation that AEC is active.
      return { ...applied, aecActive: false };
    },
    restore: (request) => module.restoreAudioSession(request),
    subscribe: (listener) => module.addListener(
      'voiceAudioSessionEvent',
      (event: VoiceAudioSessionPlatformEvent) => listener(event),
    ),
  };
}
