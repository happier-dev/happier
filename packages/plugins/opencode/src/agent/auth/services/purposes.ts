import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';

export const OPEN_CODE_REQUEST_AUTH_CONSUMER = Object.freeze({
  pluginId: 'happier.agent.opencode',
  localId: 'opencode',
} as const);

export const OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID = 'anthropic-model-request' as const;
export const OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID = 'openai-codex-model-request' as const;
export const OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID = 'openai-api-key' as const;
export const OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID = 'anthropic-api-key' as const;

/** Native provider ids belong to OpenCode; service and purpose projections share these rows. */
export const OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS = Object.freeze([
  {
    declaration: {
      purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      materializationKinds: ['environment', 'httpHeaders'],
      credentialKinds: ['oauth', 'token'],
    },
    provider: 'anthropic',
    environmentKeys: [CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey],
    requestAuthOrigin: 'https://api.anthropic.com',
    requestAuthHeaderNames: ['authorization'],
  },
  {
    declaration: {
      purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      materializationKinds: ['httpHeaders'],
      credentialKinds: ['oauth'],
    },
    provider: 'openai',
    environmentKeys: [],
    requestAuthOrigin: 'https://chatgpt.com',
    requestAuthHeaderNames: ['authorization', 'chatgpt-account-id'],
  },
  {
    declaration: {
      purpose: OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      materializationKinds: ['environment'],
      credentialKinds: ['token'],
    },
    provider: 'openai',
    environmentKeys: ['OPENAI_API_KEY'],
    requestAuthOrigin: null,
    requestAuthHeaderNames: [],
  },
  {
    declaration: {
      purpose: OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
      service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
      materializationKinds: ['environment'],
      credentialKinds: ['token'],
    },
    provider: 'anthropic',
    environmentKeys: ['ANTHROPIC_API_KEY'],
    requestAuthOrigin: null,
    requestAuthHeaderNames: [],
  },
] as const);

export type OpenCodeConnectedAccountPurposeId =
  typeof OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS[number]['declaration']['purpose'];
export type OpenCodeRequestAuthProvider = typeof OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS[number]['provider'];

export const OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.map(({ declaration }) => declaration),
);
export const OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS.map(({ purpose }) => purpose),
);
export const OPEN_CODE_CONNECTED_ACCOUNT_SERVICE_IDS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS.map(({ service }) => service.localId),
);
export const OPEN_CODE_NATIVE_AUTH_ENV_KEYS = Object.freeze([
  'OPENCODE_AUTH_CONTENT',
  ...OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.flatMap(({ environmentKeys }) => [...environmentKeys]),
]);
export const OPEN_CODE_REQUEST_AUTH_DESCRIPTORS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.filter((row) => row.requestAuthOrigin !== null),
);
export const OPEN_CODE_REQUEST_AUTH_USES = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.flatMap((row) => row.requestAuthOrigin === null ? [] : [{
    purpose: row.declaration.purpose,
    materialization: {
      kind: 'httpHeaders' as const,
      origin: row.requestAuthOrigin,
      headerNames: [...row.requestAuthHeaderNames],
    },
  }]),
);
export const OPEN_CODE_NATIVE_PROVIDERS = Object.freeze([
  ...new Set(OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.map(({ provider }) => provider)),
]);

export function isOpenCodeNativeProvider(value: unknown): value is OpenCodeRequestAuthProvider {
  return OPEN_CODE_NATIVE_PROVIDERS.some((provider) => provider === value);
}
