export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.xai',
  version: '0.0.0',
  displayName: 'xAI Grok Voice',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: {
    voiceProviders: [{
      id: 'realtime-grok',
      title: 'xAI Grok Voice',
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: ['credential'] },
        turn: {
          cancelResponse: true,
          bargeIn: true,
          clearInput: true,
          resumption: 'resume',
          replay: 'stable_ids',
          exactMessage: true,
          interruptionPolicy: 'provider_immediate',
        },
      },
      settings: {
        schemaVersion: 1,
        fields: [],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.xai.privacyDisclosure',
          fallback: 'Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
        },
      },
      accountMediation: {
        credentialSlots: [{ id: 'api_key', scope: 'account' }],
        operations: [
          {
            id: 'client-auth',
            purpose: 'voice.client-auth',
            credentialSlotId: 'api_key',
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
          },
          {
            id: 'voices',
            purpose: 'voice.catalog.voices',
            credentialSlotId: 'api_key',
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
          },
        ],
      },
      client: {
        artifactId: 'voice-runtime-web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    } satisfies import('@happier-dev/protocol').PluginVoiceProviderContributionV1],
  },
});
