import { requireOptionalNativeModule } from 'expo-modules-core';

import type { HappierAudioStreamNativeModule } from './HappierAudioStreamNative.types';
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

export function supportsVoiceAudioSessionCoordination(
  module: HappierAudioStreamNativeModule | null,
): module is HappierAudioStreamNativeModule {
  return typeof module?.start === 'function'
    && typeof module.stop === 'function'
    && typeof module.addListener === 'function'
    && typeof module.configureAudioSession === 'function'
    && typeof module.restoreAudioSession === 'function';
}

export function createHappierAudioStreamNativePlatform(
  module: HappierAudioStreamNativeModule,
): VoiceAudioSessionPlatform {
  if (!supportsVoiceAudioSessionCoordination(module)) {
    throw new Error('voice_audio_session_coordination_unavailable');
  }
  return {
    apply: (request) => module.configureAudioSession(request),
    restore: (request) => module.restoreAudioSession(request),
    subscribe: (listener) => module.addListener(
      'voiceAudioSessionEvent',
      (event: VoiceAudioSessionPlatformEvent) => listener(event),
    ),
  };
}
