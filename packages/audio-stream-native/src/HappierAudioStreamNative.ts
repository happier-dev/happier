import { requireOptionalNativeModule } from 'expo-modules-core';

import type { HappierAudioStreamNativeModule } from './HappierAudioStreamNative.types';

export const HAPPIER_AUDIO_STREAM_NATIVE_MODULE_NAME = 'HappierAudioStreamNative';

export function getOptionalHappierAudioStreamNativeModule(): HappierAudioStreamNativeModule | null {
  const mod = requireOptionalNativeModule(HAPPIER_AUDIO_STREAM_NATIVE_MODULE_NAME) as HappierAudioStreamNativeModule | null;
  return mod ?? null;
}

