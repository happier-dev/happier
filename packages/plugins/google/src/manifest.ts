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
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
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
