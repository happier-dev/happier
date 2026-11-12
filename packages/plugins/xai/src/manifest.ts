import { definePlugin } from '@happier-dev/plugin-sdk';
import { VoiceCredentialSlotIdSchema } from '@happier-dev/plugin-sdk/voice';

import { XAI_VOICE_PROVIDER_CONTRIBUTION_ID } from './constants.js';
import { XAI_REALTIME_SETTINGS_SECTION } from './voiceSettingsPresentation.js';

const XAI_API_KEY_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.voice.xai',
  version: '0.0.0',
  displayName: 'xAI Grok Voice',
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
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
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
      { locale: "ca", resourceId: "i18n-ca" },
      { locale: "de", resourceId: "i18n-de" },
      { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
      { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
      { locale: "ja", resourceId: "i18n-ja" },
    ],
  },
  voiceProviders: {
    [XAI_VOICE_PROVIDER_CONTRIBUTION_ID]: {
      declaration: {
      title: 'xAI Grok Voice',
      description: { key: 'settingsVoice.realtimeProviders.xai.description', fallback: 'Uses your xAI API key' },
      mark: { kind: 'agent', agentId: 'grok' },
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: {
          cancelResponse: true,
          bargeIn: true,
          clearInput: true,
          exactMessage: true,
          interruptionPolicy: 'provider_immediate',
        },

      },
      settings: {
        schemaVersion: 1,
        presentation: JSON.parse(JSON.stringify(XAI_REALTIME_SETTINGS_SECTION)),
        fields: [
          {
            id: 'model',
            title: 'Model',
            schema: {
              type: 'object',
              oneOf: [{
                type: 'object',
                properties: {
                  kind: { const: 'pinned' },
                  id: { type: 'string', minLength: 1, maxLength: 128 },
                },
                required: ['kind', 'id'],
                additionalProperties: false,
              }, {
                type: 'object',
                properties: {
                  kind: { const: 'moving_alias' },
                  id: { const: 'grok-voice-latest' },
                },
                required: ['kind', 'id'],
                additionalProperties: false,
              }],
            },
            default: { kind: 'pinned', id: 'grok-voice-think-fast-2.0' },
            presentation: { control: 'json' },
          },
          {
            id: 'voice',
            title: 'Voice',
            schema: {
              type: 'object',
              oneOf: [{
                type: 'object',
                properties: {
                  kind: { const: 'catalog' },
                  id: { type: 'string', minLength: 1, maxLength: 256 },
                },
                required: ['kind', 'id'],
                additionalProperties: false,
              }, {
                type: 'object',
                properties: {
                  kind: { const: 'custom' },
                  id: { type: 'string', minLength: 1, maxLength: 256 },
                },
                required: ['kind', 'id'],
                additionalProperties: false,
              }],
            },
            default: { kind: 'catalog', id: 'eve' },
            presentation: { control: 'json' },
          },
          {
            id: 'instructions',
            title: 'Instructions',
            schema: { type: 'string', minLength: 0, maxLength: 10_000 },
            default: '',
            presentation: { control: 'textarea' },
          },
          {
            id: 'reasoningEffort',
            title: 'Reasoning effort',
            schema: { type: 'string', enum: ['high', 'none'] },
            default: 'high',
            presentation: {
              control: 'select',
              options: [
                { value: 'high', title: 'High' },
                { value: 'none', title: 'None' },
              ],
            },
          },
          {
            id: 'outputSpeed',
            title: 'Output speed',
            schema: { type: 'number', minimum: 0.7, maximum: 1.5 },
            default: 1,
            presentation: { control: 'number', step: 0.05 },
          },
          {
            id: 'transcription',
            title: 'Transcription',
            schema: {
              type: 'object',
              properties: {
                languageHint: {
                  anyOf: [
                    {
                      type: 'string',
                      enum: [
                        'en',
                        'ar-EG',
                        'ar-SA',
                        'ar-AE',
                        'bn',
                        'zh',
                        'fr',
                        'de',
                        'hi',
                        'id',
                        'it',
                        'ja',
                        'ko',
                        'pt-BR',
                        'pt-PT',
                        'ru',
                        'es-MX',
                        'es-ES',
                        'tr',
                        'vi',
                      ],
                    },
                    { type: 'null' },
                  ],
                },
                keyterms: {
                  type: 'array',
                  items: { type: 'string', minLength: 1, maxLength: 50 },
                  maxItems: 100,
                },
              },
              required: ['languageHint', 'keyterms'],
              additionalProperties: false,
            },
            default: {
              languageHint: null,
              keyterms: [],
            },
            presentation: { control: 'json' },
          },
          {
            id: 'turnDetection',
            title: 'Turn detection',
            schema: {
              type: 'object',
              properties: {
                mode: { const: 'server_vad' },
                threshold: {
                  anyOf: [
                    { type: 'number', minimum: 0.1, maximum: 0.9 },
                    { type: 'null' },
                  ],
                },
                silenceDurationMs: {
                  anyOf: [
                    { type: 'integer', minimum: 0, maximum: 10_000 },
                    { type: 'null' },
                  ],
                },
                prefixPaddingMs: {
                  anyOf: [
                    { type: 'integer', minimum: 0, maximum: 10_000 },
                    { type: 'null' },
                  ],
                },
                idleTimeoutMs: {
                  anyOf: [
                    { type: 'integer', minimum: 1, maximum: 600_000 },
                    { type: 'null' },
                  ],
                },
              },
              required: [
                'mode',
                'threshold',
                'silenceDurationMs',
                'prefixPaddingMs',
                'idleTimeoutMs',
              ],
              additionalProperties: false,
            },
            default: {
              mode: 'server_vad',
              threshold: null,
              silenceDurationMs: null,
              prefixPaddingMs: null,
              idleTimeoutMs: null,
            },
            presentation: { control: 'json' },
          },
          {
            id: 'resumptionEnabled',
            title: 'Resume recent xAI conversation',
            schema: { type: 'boolean' },
            default: false,
            presentation: { control: 'switch' },
          },
        ],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.xai.privacyDisclosure',
          fallback: 'Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. When enabled or used, xAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
        },
        privacyFacts: {
          audioDestination: 'xAI',
          processor: 'xAI Realtime',
          retention: { key: 'settingsVoice.pages.privacy.servicePolicy', fallback: 'Follows your service account settings and terms.' },
        },
      },
      credentials: {
        slot: {
          id: XAI_API_KEY_CREDENTIAL_SLOT_ID,
          purpose: 'voice.client-auth',
          title: 'xAI API key',
          description: 'Used only for short-lived client authentication and the xAI voice catalog.',
        },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          operationProjections: [
            { kind: 'recipientCredential', operation: 'client-auth', phase: 'prepare', format: 'bearer' },
            { kind: 'recipientCredential', operation: 'voices', phase: 'settings', format: 'bearer' },
          ],
        }],
        hostMediated: {
          operations: [{
            id: 'client-auth',
            purpose: 'voice.client-auth',
            credentialSlotId: XAI_API_KEY_CREDENTIAL_SLOT_ID,
            effect: 'read',
            request: {
              origin: 'https://api.x.ai',
              pathTemplate: '/v1/realtime/client_secrets',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
                { name: 'content-type', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'json', value: {} },
              method: 'POST',
              credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
              redirect: 'error',
              maxBodyBytes: 65536,
              contentTypes: ['application/json'],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: {
                  body: { type: 'object', additionalProperties: true },
                },
                required: ['body'],
                additionalProperties: false,
              },
              mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          }, {
            id: 'voices',
            purpose: 'voice.catalog.voices',
            credentialSlotId: XAI_API_KEY_CREDENTIAL_SLOT_ID,
            effect: 'read',
            request: {
              origin: 'https://api.x.ai',
              pathTemplate: '/v1/tts/voices',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'none' },
              method: 'GET',
              credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              mapping: [],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          }],
        },
      },
      client: {
        artifactId: 'voice-runtime-web',
        exportName: 'activate',
      },
      },
    },
  },
});
