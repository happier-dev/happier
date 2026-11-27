import {
  KIMI_CONNECTED_ACCOUNT_SERVICE,
  KIMI_CODE_API_KEY_ENV,
  KIMI_CODE_API_BASE_ENV,
  GROK_CONNECTED_ACCOUNT_SERVICE,
  GEMINI_CONNECTED_ACCOUNT_SERVICE,
  GITHUB_CONNECTED_ACCOUNT_SERVICE,
  CLAUDE_CONNECTED_ACCOUNT_SERVICE,
  ANTHROPIC_CONNECTED_ACCOUNT_SERVICE,
  OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
  OPENAI_CONNECTED_ACCOUNT_SERVICE,
} from '@happier-dev/plugin-sdk/connected-accounts';

export const PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID = 'anthropic-model-request' as const;
export const PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID = 'openai-codex-model-request' as const;

export const PI_OPENAI_API_KEY_PURPOSE_ID = 'openai-api-key' as const;
export const PI_ANTHROPIC_API_KEY_PURPOSE_ID = 'anthropic-api-key' as const;

export const PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES = Object.freeze([
  Object.freeze({
    purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
    native: { providerId: 'anthropic', startupModel: 'claude-opus-5', modelScope: 'anthropic/*' },
    requestAuth: {
      materialization: { kind: 'httpHeaders' as const, origin: 'https://api.anthropic.com', headerNames: ['authorization'] },
      ownedHeaders: ['authorization', 'x-api-key'],
    },
    service: CLAUDE_CONNECTED_ACCOUNT_SERVICE,
    materializationKinds: Object.freeze(['httpHeaders', 'environment'] as const),
    credentialKinds: Object.freeze(['oauth', 'token'] as const),
  }),
  Object.freeze({
    purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
    native: { providerId: 'openai-codex', startupModel: 'gpt-5.5', modelScope: 'openai-codex/*' },
    requestAuth: {
      materialization: { kind: 'httpHeaders' as const, origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'] },
      ownedHeaders: ['authorization', 'chatgpt-account-id'],
    },
    service: OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
    materializationKinds: Object.freeze(['httpHeaders'] as const),
    credentialKinds: Object.freeze(['oauth'] as const),
  }),
  Object.freeze({
    purpose: PI_OPENAI_API_KEY_PURPOSE_ID,
    native: { providerId: 'openai', startupModel: 'gpt-5.4', modelScope: 'openai/*', environmentKeys: ['OPENAI_API_KEY'], apiKeyEnvironmentKey: 'OPENAI_API_KEY' },
    service: OPENAI_CONNECTED_ACCOUNT_SERVICE,
    materializationKinds: Object.freeze(['environment'] as const),
    credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: PI_ANTHROPIC_API_KEY_PURPOSE_ID,
    native: { providerId: 'anthropic', startupModel: 'claude-opus-5', modelScope: 'anthropic/*', environmentKeys: ['ANTHROPIC_API_KEY'], apiKeyEnvironmentKey: 'ANTHROPIC_API_KEY' },
    service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE,
    materializationKinds: Object.freeze(['environment'] as const),
    credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: 'kimi-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE,
    native: { providerId: 'kimi-coding', modelScope: 'kimi-coding/*',
      environmentKeys: [KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV], apiKeyEnvironmentKey: KIMI_CODE_API_KEY_ENV,
      baseUrlEnvironmentKey: KIMI_CODE_API_BASE_ENV },
    materializationKinds: Object.freeze(['environment'] as const), credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE,
    native: { providerId: 'xai', modelScope: 'xai/*', environmentKeys: ['XAI_API_KEY'], apiKeyEnvironmentKey: 'XAI_API_KEY' },
    materializationKinds: Object.freeze(['environment'] as const), credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: 'gemini', service: GEMINI_CONNECTED_ACCOUNT_SERVICE,
    native: { providerId: 'google', modelScope: 'google/*', apiKeyEnvironmentKey: 'GEMINI_API_KEY',
      environmentKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
      serviceAccount: { providerId: 'google-vertex', fileId: 'google-service-account.json', environmentKey: 'GOOGLE_APPLICATION_CREDENTIALS' } },
    materializationKinds: Object.freeze(['environment', 'files'] as const), credentialKinds: Object.freeze(['token'] as const),
  }),
  Object.freeze({
    purpose: 'github-copilot', service: GITHUB_CONNECTED_ACCOUNT_SERVICE,
    native: { providerId: 'github-copilot', modelScope: 'github-copilot/*', environmentKeys: ['COPILOT_GITHUB_TOKEN'],
      apiKeyEnvironmentKey: 'COPILOT_GITHUB_TOKEN', oauthExchange: true },
    materializationKinds: Object.freeze(['environment'] as const), credentialKinds: Object.freeze(['oauth', 'token'] as const),
  }),
] as const);

type PiQualifiedPurposeRow = (typeof PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES)[number];

export const PI_REQUEST_AUTH_PURPOSE_ROWS = Object.freeze(
  PI_QUALIFIED_CONNECTED_ACCOUNT_PURPOSES.filter(
    (row): row is Extract<PiQualifiedPurposeRow, { requestAuth: unknown }> => 'requestAuth' in row),
);
