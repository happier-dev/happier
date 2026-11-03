import { definePlugin } from '@happier-dev/plugin-sdk';
import { VoiceCredentialSlotIdSchema } from '@happier-dev/plugin-sdk/voice';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';

import { openAiConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import { OPENAI_VOICE_PROVIDER_CONTRIBUTION_ID } from './constants.js';
import { OPENAI_REALTIME_SETTINGS_SECTION } from './voiceSettingsPresentation.js';

const OPENAI_API_KEY_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.voice.openai',
  version: '0.0.0',
  displayName: 'OpenAI Realtime Voice',
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
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  connectedAccountDescriptors: {
    openai: {
      declaration: {
        title: 'OpenAI API key',
        authentication: {
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key',
            kind: 'manual',
            setup: {
              url: 'https://platform.openai.com/api-keys',
              checklist: ['Choose the OpenAI API project you want to use and create a secret API key.', 'Copy the key when it is shown and paste it here.'],
              createKeyTitle: 'Open OpenAI API keys',
            },
            accountDirectSave: true,
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'OpenAI API key',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }],
        },
      },
      runtime: openAiConnectedAccountRuntime,
    },
  },
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
    [OPENAI_VOICE_PROVIDER_CONTRIBUTION_ID]: {
      declaration: {
      title: 'OpenAI Realtime Voice',
      description: { key: 'settingsVoice.realtimeProviders.openai.description', fallback: 'Uses your OpenAI account or API key' },
      mark: { kind: 'connected_service', serviceId: 'openai' },
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: { cancelResponse: true, bargeIn: true, clearInput: true },
        tools: { effectCalls: 'stable_ids' },
      },
      credentials: {
        slot: {
          id: OPENAI_API_KEY_CREDENTIAL_SLOT_ID,
          purpose: 'voice.client-auth',
          title: 'OpenAI credential',
          description: 'Credential used to mint short-lived OpenAI Realtime client authentication.',
        },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          operationProjections: [{
            kind: 'recipientCredential',
            operation: 'client-auth',
            phase: 'prepare',
            format: 'bearer',
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          operationProjections: [{
            kind: 'materializedHttpHeaders',
            operation: 'client-auth',
            phase: 'prepare',
            request: {
              kind: 'httpHeaders',
              origin: 'https://api.openai.com',
              headerNames: ['authorization'],
            },
            requiredHeaderNames: ['authorization'],
            allowedHeaderNames: ['authorization'],
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          operationProjections: [{
            kind: 'materializedHttpHeaders',
            operation: 'client-auth',
            phase: 'prepare',
            request: {
              kind: 'httpHeaders',
              origin: 'https://api.openai.com',
              headerNames: ['authorization', 'chatgpt-account-id'],
            },
            requiredHeaderNames: ['authorization'],
            allowedHeaderNames: ['authorization', 'chatgpt-account-id'],
          }],
        }],
        hostMediated: {
          operations: [{
            id: 'client-auth',
            purpose: 'voice.client-auth',
            credentialSlotId: OPENAI_API_KEY_CREDENTIAL_SLOT_ID,
            effect: 'read',
            request: {
              origin: 'https://api.openai.com',
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
            response: { maxBytes: 65536, contentTypes: ['application/json'] },
          }],
        },
      },
      settings: {
        schemaVersion: 1,
        presentation: JSON.parse(JSON.stringify(OPENAI_REALTIME_SETTINGS_SECTION)),
        fields: [{
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
                id: { const: 'gpt-realtime' },
              },
              required: ['kind', 'id'],
              additionalProperties: false,
            }],
          },
          default: { kind: 'pinned', id: 'gpt-realtime-2.1' },
          presentation: { control: 'json' },
        }, {
          id: 'voice',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
          default: 'marin',
          presentation: { control: 'text' },
        }, {
          id: 'instructions',
          title: 'Instructions',
          schema: { type: 'string', maxLength: 10_000 },
          default: '',
          presentation: { control: 'textarea' },
        }, {
          id: 'turnDetection',
          title: 'Turn detection',
          schema: { type: 'string', enum: ['server_vad', 'semantic_vad', 'manual'] },
          default: 'server_vad',
          presentation: {
            control: 'select',
            options: [
              { value: 'server_vad', title: 'Server voice activity detection' },
              { value: 'semantic_vad', title: 'Semantic voice activity detection' },
              { value: 'manual', title: 'Manual' },
            ],
          },
        }, {
          id: 'inputTranscriptionModel',
          title: 'Input transcription model',
          schema: { type: 'string', maxLength: 128 },
          default: '',
          presentation: { control: 'text' },
        }],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.openai.privacyDisclosure',
          fallback: 'Audio and conversation content are sent from this device to OpenAI using WebRTC. When enabled or used, OpenAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
        },
        privacyFacts: {
          audioDestination: 'OpenAI',
          processor: 'OpenAI Realtime',
          retention: { key: 'settingsVoice.pages.privacy.servicePolicy', fallback: 'Follows your service account settings and terms.' },
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
