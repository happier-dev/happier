export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.elevenlabs',
  version: '0.0.0',
  displayName: 'ElevenLabs Voice',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: {
    voiceProviders: [{
      id: 'realtime-elevenlabs',
      title: 'ElevenLabs Voice',
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: ['credential'] },
        turn: {
          cancelResponse: false,
          bargeIn: false,
          exactMessage: true,
          interruptionPolicy: 'disabled',
        },
      },
      settings: {
        schemaVersion: 2,
        privacyDisclosure: 'Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.',
        fields: [
          {
            id: 'billingMode',
            title: 'Billing mode',
            schema: {
              type: 'string',
              enum: ['happier', 'byo'],
            },
            default: 'happier',
            presentation: {
              control: 'select',
              options: [
                { value: 'happier', title: 'Happier hosted' },
                { value: 'byo', title: 'Bring your own ElevenLabs account' },
              ],
            },
          },
          {
            id: 'tts',
            title: 'Text-to-speech configuration',
            schema: {
              type: 'object',
              properties: {
                voiceId: { type: 'string', minLength: 1, maxLength: 256 },
                modelId: {
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: 256 },
                    { type: 'null' },
                  ],
                },
                voiceSettings: {
                  type: 'object',
                  properties: {
                    stability: {
                      anyOf: [
                        { type: 'number', minimum: 0, maximum: 1 },
                        { type: 'null' },
                      ],
                    },
                    similarityBoost: {
                      anyOf: [
                        { type: 'number', minimum: 0, maximum: 1 },
                        { type: 'null' },
                      ],
                    },
                    style: {
                      anyOf: [
                        { type: 'number', minimum: 0, maximum: 1 },
                        { type: 'null' },
                      ],
                    },
                    useSpeakerBoost: {
                      anyOf: [
                        { type: 'boolean' },
                        { type: 'null' },
                      ],
                    },
                    speed: {
                      anyOf: [
                        { type: 'number', minimum: 0.7, maximum: 1.2 },
                        { type: 'null' },
                      ],
                    },
                  },
                  required: [
                    'stability',
                    'similarityBoost',
                    'style',
                    'useSpeakerBoost',
                    'speed',
                  ],
                  additionalProperties: false,
                },
              },
              required: ['voiceId', 'modelId', 'voiceSettings'],
              additionalProperties: false,
            },
            default: {
              voiceId: 'EST9Ui6982FZPSi7gCHi',
              modelId: null,
              voiceSettings: {
                stability: null,
                similarityBoost: null,
                style: null,
                useSpeakerBoost: null,
                speed: null,
              },
            },
            presentation: { control: 'json' },
          },
          {
            id: 'byo',
            title: 'Bring your own account configuration',
            schema: {
              type: 'object',
              properties: {
                agentId: {
                  anyOf: [
                    {
                      type: 'string',
                      minLength: 1,
                      maxLength: 256,
                      pattern: '^[A-Za-z0-9_-]+$',
                    },
                    { type: 'null' },
                  ],
                },
              },
              required: ['agentId'],
              additionalProperties: false,
            },
            default: { agentId: null },
            presentation: { control: 'json' },
          },
        ],
      },
      accountMediation: {
        credentialSlots: [{ id: 'api_key', scope: 'account' }],
        operations: [
          {
            id: 'signed-url',
            purpose: 'voice.client-auth.signed-url',
            credentialSlotId: 'api_key',
            effect: 'read',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/conversation/get-signed-url',
              queryTemplate: [],
              headerTemplate: [{ name: 'accept', value: 'application/json' }],
              bodyTemplate: { kind: 'none' },
              method: 'GET',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: { agentId: { type: 'string', minLength: 1, maxLength: 256 } },
                required: ['agentId'],
                additionalProperties: false,
              },
              mapping: [{ parameter: 'agentId', target: { kind: 'query', name: 'agent_id' } }],
            },
            response: { maxBytes: 32768, contentTypes: ['application/json'] },
          },
          {
            id: 'conversation-token',
            purpose: 'voice.client-auth.sdk-token',
            credentialSlotId: 'api_key',
            effect: 'read',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/conversation/token',
              queryTemplate: [],
              headerTemplate: [{ name: 'accept', value: 'application/json' }],
              bodyTemplate: { kind: 'none' },
              method: 'GET',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: { agentId: { type: 'string', minLength: 1, maxLength: 256 } },
                required: ['agentId'],
                additionalProperties: false,
              },
              mapping: [{ parameter: 'agentId', target: { kind: 'query', name: 'agent_id' } }],
            },
            response: { maxBytes: 32768, contentTypes: ['application/json'] },
          },
          {
            id: 'voices',
            purpose: 'voice.catalog.voices',
            credentialSlotId: 'api_key',
            effect: 'read',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/voices',
              queryTemplate: [],
              headerTemplate: [{ name: 'accept', value: 'application/json' }],
              bodyTemplate: { kind: 'none' },
              method: 'GET',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: { type: 'object', properties: {}, additionalProperties: false },
              mapping: [],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
          {
            id: 'agents',
            purpose: 'voice.provision.agents.list',
            credentialSlotId: 'api_key',
            effect: 'read',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/agents',
              queryTemplate: [
                { name: 'page_size', value: '50' },
                { name: 'search', value: 'Happier Voice' },
              ],
              headerTemplate: [{ name: 'accept', value: 'application/json' }],
              bodyTemplate: { kind: 'none' },
              method: 'GET',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: { type: 'object', properties: {}, additionalProperties: false },
              mapping: [],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
          {
            id: 'tools',
            purpose: 'voice.provision.tools.list',
            credentialSlotId: 'api_key',
            effect: 'read',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/tools',
              queryTemplate: [{ name: 'page_size', value: '100' }],
              headerTemplate: [{ name: 'accept', value: 'application/json' }],
              bodyTemplate: { kind: 'none' },
              method: 'GET',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 0,
              contentTypes: [],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: {
                  cursor: { type: 'string', minLength: 1, maxLength: 512 },
                },
                additionalProperties: false,
              },
              mapping: [{ parameter: 'cursor', target: { kind: 'query', name: 'cursor' } }],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
          {
            id: 'create-tool',
            purpose: 'voice.provision.tool.create',
            credentialSlotId: 'api_key',
            effect: 'mutation',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/tools',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
                { name: 'content-type', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'json', value: {} },
              method: 'POST',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 524288,
              contentTypes: ['application/json'],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: { body: { type: 'object', additionalProperties: true } },
                required: ['body'],
                additionalProperties: false,
              },
              mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
          {
            id: 'update-tool',
            purpose: 'voice.provision.tool.update',
            credentialSlotId: 'api_key',
            effect: 'mutation',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/tools/{toolId}',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
                { name: 'content-type', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'json', value: {} },
              method: 'PATCH',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 524288,
              contentTypes: ['application/json'],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: {
                  toolId: { type: 'string', minLength: 1, maxLength: 256 },
                  body: { type: 'object', additionalProperties: true },
                },
                required: ['toolId', 'body'],
                additionalProperties: false,
              },
              mapping: [
                { parameter: 'toolId', target: { kind: 'path', placeholder: 'toolId', encoding: 'uri_component' } },
                { parameter: 'body', target: { kind: 'body', pointer: '' } },
              ],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
          {
            id: 'create-agent',
            purpose: 'voice.provision.agent.create',
            credentialSlotId: 'api_key',
            effect: 'mutation',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/agents/create',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
                { name: 'content-type', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'json', value: {} },
              method: 'POST',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 524288,
              contentTypes: ['application/json'],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: { body: { type: 'object', additionalProperties: true } },
                required: ['body'],
                additionalProperties: false,
              },
              mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
          {
            id: 'update-agent',
            purpose: 'voice.provision.agent.update',
            credentialSlotId: 'api_key',
            effect: 'mutation',
            request: {
              origin: 'https://api.elevenlabs.io',
              pathTemplate: '/v1/convai/agents/{agentId}',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
                { name: 'content-type', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'json', value: {} },
              method: 'PATCH',
              credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
              redirect: 'error',
              maxBodyBytes: 524288,
              contentTypes: ['application/json'],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: {
                  agentId: { type: 'string', minLength: 1, maxLength: 256 },
                  body: { type: 'object', additionalProperties: true },
                },
                required: ['agentId', 'body'],
                additionalProperties: false,
              },
              mapping: [
                { parameter: 'agentId', target: { kind: 'path', placeholder: 'agentId', encoding: 'uri_component' } },
                { parameter: 'body', target: { kind: 'body', pointer: '' } },
              ],
            },
            response: { maxBytes: 2097152, contentTypes: ['application/json'] },
          },
        ],
      },
      client: {
        artifactId: 'voice-runtime',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    } satisfies import('@happier-dev/protocol').PluginVoiceProviderContributionV1],
  },
});
