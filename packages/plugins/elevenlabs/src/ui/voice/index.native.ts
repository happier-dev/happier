import { NativeModules, Platform } from 'react-native';
import {
  createConnection,
  setSetupStrategy,
  setupWebRTCSession,
} from '@elevenlabs/client/internal';

import {
  activate as activateWebRuntime,
  createElevenLabsVoiceProviderRuntime,
} from './runtime.js';
import { loadLiveKitRegisterGlobals } from './runtime/liveKitReactNative.js';
import { installElevenLabsNativeSessionStrategy } from './runtime/nativeSessionStrategy.js';

const nativeSessionStrategyInstallation = installElevenLabsNativeSessionStrategy({
  nativeWebRtcModule: NativeModules.WebRTCModule,
  requiresAudioDeviceModuleBridge: Platform.OS !== 'android',
  loadRegisterGlobals: loadLiveKitRegisterGlobals,
  setSetupStrategy,
  createConnection,
  setupWebRTCSession,
});

/**
 * Native preserves the web provider's runtime and lifecycle. Only the
 * ElevenLabs SDK's platform setup changes at this external boundary.
 */
export { VOICE_PROVIDER_PRESENTATIONS } from './entries.js';

export function activate(
  ...args: Parameters<typeof activateWebRuntime>
): ReturnType<typeof activateWebRuntime> {
  if (nativeSessionStrategyInstallation.kind === 'unavailable') {
    throw Object.assign(
      new Error('ElevenLabs Voice requires a current iOS WebRTC native module.'),
      { code: nativeSessionStrategyInstallation.code },
    );
  }
  return activateWebRuntime(...args);
}

export { createElevenLabsVoiceProviderRuntime };
