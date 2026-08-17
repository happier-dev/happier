import type { PluginApi } from '@happier-dev/plugin-sdk';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  GOOGLE_CLOUD_TTS_RUNTIME,
  GOOGLE_GEMINI_STT_RUNTIME,
} from './voice/speech.js';

export { PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest };
export * from './protocol/voice/index.js';

export function activate(api: PluginApi): void {
  api.voiceProviders.register('gemini-stt', GOOGLE_GEMINI_STT_RUNTIME);
  api.voiceProviders.register('google-cloud-tts', GOOGLE_CLOUD_TTS_RUNTIME);
}
