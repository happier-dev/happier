import type { PluginApi } from '@happier-dev/plugin-sdk';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  OPENAI_COMPAT_STT_RUNTIME,
  OPENAI_COMPAT_TTS_RUNTIME,
} from './voice/speech.js';

export { PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest };
export * from './speechIdentity.js';

export function activate(api: PluginApi): void {
  api.voiceProviders.register('stt', OPENAI_COMPAT_STT_RUNTIME);
  api.voiceProviders.register('tts', OPENAI_COMPAT_TTS_RUNTIME);
}
