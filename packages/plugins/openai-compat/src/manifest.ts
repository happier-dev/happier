import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  VOICE_SPEECH_OUTPUT_MAX_BYTES,
  VoiceCredentialSlotIdSchema,
} from '@happier-dev/plugin-sdk/voice';

import {
  OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY,
  OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY,
} from './speechIdentity.js';
import {
  OPENAI_COMPAT_STT_RUNTIME,
  OPENAI_COMPAT_TTS_RUNTIME,
} from './voice/speech.js';

const OPENAI_COMPAT_API_KEY_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.voice.openai-compat',
  version: '0.0.0',
  displayName: 'OpenAI-compatible Speech',
  description: 'Batch speech-to-text and text-to-speech through a selected-machine OpenAI-compatible endpoint.',
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
  entrypoints: {
    daemon: './.happier-plugin-build/daemon.js',
    development: './src/index.ts',
  },
  hostAccess: { required: [], optional: [] },
  ui: {
      translations: [
        { locale: "en", resourceId: "i18n-en" },
        { locale: "ru", resourceId: "i18n-ru" },
        { locale: "pl", resourceId: "i18n-pl" },
        { locale: "es", resourceId: "i18n-es" },
        { locale: "fr", resourceId: "i18n-fr" },
        { locale: "it", resourceId: "i18n-it" },
        { locale: "pt", resourceId: "i18n-pt" },
        { locale: "de", resourceId: "i18n-de" },
        { locale: "ca", resourceId: "i18n-ca" },
        { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
        { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
        { locale: "ja", resourceId: "i18n-ja" },
      ],
  },
  voiceProviders: {
    stt: {
      declaration: {
        title: 'OpenAI-compatible Speech-to-Text',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: OPENAI_COMPAT_API_KEY_CREDENTIAL_SLOT_ID,
            purpose: 'voice.speech.transcribe',
            title: 'OpenAI-compatible STT API key',
          },
          requirement: { kind: 'optional' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon',
              phase: 'speech',
              request: {
                kind: 'environment',
                keys: [OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY],
              },
            }],
          }],
        },
        settings: {
          schemaVersion: 2,
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt',
            fallback: 'Audio for transcription is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
          },
          privacyFacts: {
            audioDestination: { key: 'settingsVoice.pages.privacy.yourEndpoint', fallback: 'Your configured endpoint' },
            processor: { key: 'settingsVoice.pages.privacy.endpointOperator', fallback: 'Your endpoint operator' },
            retention: { key: 'settingsVoice.pages.privacy.endpointPolicy', fallback: 'Follows your endpoint operator’s policy.' },
          },
          fields: [
            {
              id: 'baseUrl',
              title: 'Transcription endpoint',
              schema: { type: 'string', minLength: 0, maxLength: 2048 },
              default: '',
              presentation: { control: 'text' },
            },
            {
              id: 'insecureLocalOriginConsent',
              title: 'Confirmed insecure local origin',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'insecureLocalConsentMachineId',
              title: 'Confirmed insecure local machine',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'model',
              title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'whisper-1',
              presentation: { control: 'text' },
            },
            {
              id: 'language',
              title: 'Language',
              schema: { type: 'string', minLength: 0, maxLength: 64 },
              default: '',
              presentation: { control: 'text' },
            },
          ],
          readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
        },
        limits: { transcribe: { maxInputBytes: 8388608 } },
      },
      runtime: OPENAI_COMPAT_STT_RUNTIME,
    },
    tts: {
      declaration: {
        title: 'OpenAI-compatible Text-to-Speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: OPENAI_COMPAT_API_KEY_CREDENTIAL_SLOT_ID,
            purpose: 'voice.speech.synthesize',
            title: 'OpenAI-compatible TTS API key',
          },
          requirement: { kind: 'optional' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon',
              phase: 'speech',
              request: {
                kind: 'environment',
                keys: [OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY],
              },
            }],
          }],
        },
        settings: {
          schemaVersion: 2,
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts',
            fallback: 'Reply text for speech synthesis is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
          },
          privacyFacts: {
            audioDestination: { key: 'settingsVoice.pages.privacy.noMicrophoneAudio', fallback: 'No microphone audio; reply text only.' },
            processor: { key: 'settingsVoice.pages.privacy.endpointOperator', fallback: 'Your endpoint operator' },
            retention: { key: 'settingsVoice.pages.privacy.endpointPolicy', fallback: 'Follows your endpoint operator’s policy.' },
          },
          fields: [
            {
              id: 'baseUrl',
              title: 'Speech endpoint',
              schema: { type: 'string', minLength: 0, maxLength: 2048 },
              default: '',
              presentation: { control: 'text' },
            },
            {
              id: 'insecureLocalOriginConsent',
              title: 'Confirmed insecure local origin',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'insecureLocalConsentMachineId',
              title: 'Confirmed insecure local machine',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'maxInputCharacters',
              title: 'Endpoint input limit (characters)',
              description: 'OpenAI accepts 4,096 characters. For a custom endpoint, use its documented input limit.',
              schema: { type: 'integer', minimum: 1, maximum: 200_000 },
              default: 4_096,
              presentation: { control: 'number', step: 1 },
            },
            {
              id: 'model',
              title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'tts-1',
              presentation: { control: 'text' },
            },
            {
              id: 'voiceName',
              title: 'Voice',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'alloy',
              presentation: { control: 'text' },
            },
            {
              id: 'format',
              title: 'Audio format',
              schema: { type: 'string', enum: ['mp3', 'wav'] },
              default: 'mp3',
              presentation: {
                control: 'select',
                options: [
                  { value: 'mp3', title: 'MP3' },
                  { value: 'wav', title: 'WAV' },
                ],
              },
            },
          ],
          readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
        },
        limits: {
          synthesize: {
            maxInputCharacters: 200_000,
            maxInputCharactersSettingId: 'maxInputCharacters',
            maxOutputBytes: VOICE_SPEECH_OUTPUT_MAX_BYTES,
          },
        },
      },
      runtime: OPENAI_COMPAT_TTS_RUNTIME,
    },
  },
});
