import { definePlugin } from '@happier-dev/plugin-sdk';

import {
  GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION,
  GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION,
  GOOGLE_VOICE_UI,
} from './voice/declarations.js';
import {
  GOOGLE_CLOUD_TTS_RUNTIME,
  GOOGLE_GEMINI_STT_RUNTIME,
} from './voice/speech.js';

export const GOOGLE_PLUGIN = definePlugin({
  id: 'happier.voice.google',
  version: '0.0.0',
  displayName: 'Google Voice',
  description: 'Google Gemini speech-to-text and Google Cloud text-to-speech.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [], optional: [] },
  voiceProviders: {
    'gemini-stt': {
      declaration: GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION,
      runtime: GOOGLE_GEMINI_STT_RUNTIME,
    },
    'google-cloud-tts': {
      declaration: GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION,
      runtime: GOOGLE_CLOUD_TTS_RUNTIME,
    },
  },
  ui: GOOGLE_VOICE_UI,
});

export const PLUGIN_MANIFEST = GOOGLE_PLUGIN.manifest;
export const activate = GOOGLE_PLUGIN.activate;
