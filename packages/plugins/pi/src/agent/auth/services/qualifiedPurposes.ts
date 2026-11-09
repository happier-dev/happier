export const PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID = 'anthropic-model-request' as const;
export const PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID = 'openai-codex-model-request' as const;

export const PI_OPENAI_API_KEY_PURPOSE_ID = 'openai-api-key' as const;
export const PI_ANTHROPIC_API_KEY_PURPOSE_ID = 'anthropic-api-key' as const;

export const PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES = Object.freeze([
  Object.freeze({
    purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
    native: { providerId: 'anthropic', startupModel: 'claude-opus-5', modelScope: 'anthropic/*' },
    requestAuth: {
      materialization: { kind: 'httpHeaders', origin: 'https://api.anthropic.com', headerNames: ['authorization'] },
      ownedHeaders: ['authorization', 'x-api-key'],
    },
    service: Object.freeze({
      pluginId: 'happier.agent.claude',
      localId: 'claude-subscription',
    }),
    materializationKinds: Object.freeze(['httpHeaders', 'environment'] as const),
    credentialKinds: Object.freeze(['oauth', 'token'] as const),
  }),
  Object.freeze({
    purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
    native: { providerId: 'openai-codex', startupModel: 'gpt-5.5', modelScope: 'openai-codex/*' },
    requestAuth: {
      materialization: { kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'] },
      ownedHeaders: ['authorization', 'chatgpt-account-id'],
    },
    service: Object.freeze({
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
    }),
    materializationKinds: Object.freeze(['httpHeaders'] as const),
    credentialKinds: Object.freeze(['oauth'] as const),
  }),
  Object.freeze({
    purpose: PI_OPENAI_API_KEY_PURPOSE_ID,
    native: { providerId: 'openai', startupModel: 'gpt-5.4', modelScope: 'openai/*', environmentKey: 'OPENAI_API_KEY' },
    service: Object.freeze({
      pluginId: 'happier.voice.openai',
      localId: 'openai',
    }),
    materializationKinds: Object.freeze(['environment'] as const),
    credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: PI_ANTHROPIC_API_KEY_PURPOSE_ID,
    native: { providerId: 'anthropic', startupModel: 'claude-opus-5', modelScope: 'anthropic/*', environmentKey: 'ANTHROPIC_API_KEY' },
    service: Object.freeze({
      pluginId: 'happier.agent.claude',
      localId: 'anthropic',
    }),
    materializationKinds: Object.freeze(['environment'] as const),
    credentialKinds: Object.freeze(['token'] as const),
  }),
] as const);

export const PI_REQUEST_AUTH_PURPOSE_ROWS = Object.freeze(
  PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.filter((row) => 'requestAuth' in row),
);
