import { registerGlobals } from '@livekit/react-native';
import {
  createConnection,
  setSetupStrategy,
  setupWebRTCSession,
} from '@elevenlabs/client/internal';

import {
  activate,
  createElevenLabsVoiceProviderRuntime,
} from './runtime.js';
import { installElevenLabsNativeSessionStrategy } from './runtime/nativeSessionStrategy.js';

installElevenLabsNativeSessionStrategy({
  registerGlobals,
  setSetupStrategy,
  createConnection,
  setupWebRTCSession,
});

/**
 * Native preserves the web provider's runtime and lifecycle. Only the
 * ElevenLabs SDK's platform setup changes at this external boundary.
 */
export { VOICE_PROVIDER_PRESENTATIONS } from './entries.js';

export {
  activate,
  createElevenLabsVoiceProviderRuntime,
};
