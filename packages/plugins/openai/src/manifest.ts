export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.openai',
  version: '0.0.0',
  displayName: 'OpenAI Realtime Voice',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'realtime-openai-account',
      capability: 'connectedAccounts',
      reason: 'Select and use the OpenAI account that mints Realtime client authentication.',
      scope: {
        serviceRefs: ['openai'],
        operations: ['select', 'use'],
        materializationKinds: ['httpHeaders'],
      },
    }, {
      id: 'realtime-openai-codex-account',
      capability: 'connectedAccounts',
      reason: 'Select and use the experimental OpenAI Codex OAuth account that mints Realtime client authentication.',
      scope: {
        serviceRefs: [{
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        }],
        operations: ['select', 'use'],
        materializationKinds: ['httpHeaders'],
      },
    }, {
      id: 'realtime-openai-api',
      capability: 'network',
      reason: 'Mint bounded OpenAI Realtime client authentication for the selected account.',
      scope: {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.openai.com' }],
        methods: ['POST'],
      },
    }],
    optional: [],
  },
  contributes: {
    actions: [{
      id: 'mint-realtime-client-auth',
      title: 'OpenAI Realtime client authentication',
      description: 'Mints short-lived OpenAI Realtime client authentication for the Voice runtime.',
      scopes: ['session'],
      surfaces: ['ui'],
      placement: 'secondary',
      dangerLevel: 'safe',
      hostAccess: ['realtime-openai-account', 'realtime-openai-api'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationId: { type: 'string', enum: ['client-auth'] },
          parameters: { type: 'object' },
        },
        required: ['operationId', 'parameters'],
      },
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'number' },
          finalUrl: { type: 'string' },
          headers: { type: 'object' },
          body: {},
        },
        required: ['status', 'finalUrl', 'headers', 'body'],
      },
      metadata: { internalVoiceOperation: true },
    }, {
      id: 'mint-realtime-client-auth-with-codex-oauth',
      title: 'Experimental OpenAI Codex OAuth Realtime client authentication',
      description: 'Mints short-lived OpenAI Realtime client authentication from the explicitly selected Codex OAuth account.',
      scopes: ['session'],
      surfaces: ['ui'],
      placement: 'secondary',
      dangerLevel: 'safe',
      hostAccess: ['realtime-openai-codex-account', 'realtime-openai-api'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationId: { type: 'string', enum: ['client-auth'] },
          parameters: { type: 'object' },
        },
        required: ['operationId', 'parameters'],
      },
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'number' },
          finalUrl: { type: 'string' },
          headers: { type: 'object' },
          body: {},
        },
        required: ['status', 'finalUrl', 'headers', 'body'],
      },
      metadata: { internalVoiceOperation: true },
    }],
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
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: ['credential'] },
        turn: { cancelResponse: true, bargeIn: true },
      },
      settings: {
        schemaVersion: 1,
        fields: [],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.openai.privacyDisclosure',
          fallback: 'Audio and conversation content are sent from this device to OpenAI using WebRTC. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
        },
      },
      accountMediation: {
        credentialSlots: [{ id: 'api_key', scope: 'account' }],
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
      client: {
        artifactId: 'voice-runtime-web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    }],
  },
} satisfies import('@happier-dev/plugin-sdk/manifest').PluginManifest);
