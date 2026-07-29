import type { PluginApi } from '@happier-dev/plugin-sdk';

import { PLUGIN_MANIFEST } from './manifest.js';
import { GOOGLE_VOICE_SPEECH_RUNTIME } from './voice/speech.js';

export { PLUGIN_MANIFEST };
export * from './protocol/voice/index.js';

export function activate(api: PluginApi): void {
  api.voiceProviders.registerSpeech('speech', GOOGLE_VOICE_SPEECH_RUNTIME);
}
