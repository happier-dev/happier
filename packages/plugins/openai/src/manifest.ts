export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.openai',
  version: '0.0.0',
  displayName: 'OpenAI Realtime Voice',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  contributes: {
    connectedAccountDescriptors: [{
      id: 'openai',
      title: 'OpenAI API key',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'OpenAI API key',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
    }],
    voiceProviders: [{
      id: 'realtime-openai',
      title: 'OpenAI Realtime Voice',
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: { cancelResponse: true, bargeIn: true },
      },
      credentials: {
        slot: {
          id: 'api_key',
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
            allowedHeaderNames: ['authorization', 'chatgpt-account-id'],
          }],
        }],
        hostMediated: {
          operations: [{
            id: 'client-auth',
            purpose: 'voice.client-auth',
            credentialSlotId: 'api_key',
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
      },
      client: {
        artifactId: 'voice-runtime-web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    }],
  },
} satisfies import('@happier-dev/plugin-sdk/manifest').PluginManifest);
