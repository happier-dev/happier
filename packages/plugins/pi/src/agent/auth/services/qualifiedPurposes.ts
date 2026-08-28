import {
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
} from './requestAuth/purposes.js';

export const PI_OPENAI_API_KEY_PURPOSE_ID = 'openai-api-key' as const;
export const PI_ANTHROPIC_API_KEY_PURPOSE_ID = 'anthropic-api-key' as const;

export const PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES = Object.freeze([
  Object.freeze({
    purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
    service: Object.freeze({
      pluginId: 'happier.agent.claude',
      localId: 'claude-subscription',
    }),
    materializationKinds: Object.freeze(['httpHeaders', 'environment'] as const),
    credentialKinds: Object.freeze(['oauth', 'token'] as const),
  }),
  Object.freeze({
    purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
    service: Object.freeze({
      pluginId: 'happier.agent.codex',
      localId: 'openai-codex',
    }),
    materializationKinds: Object.freeze(['httpHeaders'] as const),
    credentialKinds: Object.freeze(['oauth'] as const),
  }),
  Object.freeze({
    purpose: PI_OPENAI_API_KEY_PURPOSE_ID,
    service: Object.freeze({
      pluginId: 'happier.voice.openai',
      localId: 'openai',
    }),
    materializationKinds: Object.freeze(['environment'] as const),
    credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: PI_ANTHROPIC_API_KEY_PURPOSE_ID,
    service: Object.freeze({
      pluginId: 'happier.agent.claude',
      localId: 'anthropic',
    }),
    materializationKinds: Object.freeze(['environment'] as const),
    credentialKinds: Object.freeze(['token'] as const),
  }),
] as const);
