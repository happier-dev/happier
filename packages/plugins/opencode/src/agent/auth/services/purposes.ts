import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';
import { MUSE_ACCOUNT_SERVICE, META_API_KEY_ENV_KEY } from '@happier-dev/plugins-muse/connected-account-service';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import type { ConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { CLAUDE_CONNECTED_ACCOUNT_SERVICE, ANTHROPIC_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-claude/connected-account-service';
import { OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-codex/connected-account-service';
import { OPENAI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-openai/connected-account-service';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-gemini/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-grok/connected-account-service';
import { KIMI_CONNECTED_ACCOUNT_SERVICE, KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV } from '@happier-dev/plugins-kimi/connected-account-service';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-scm-github/connected-account-service';

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
      service: CLAUDE_CONNECTED_ACCOUNT_SERVICE,
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
      service: OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
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
      service: OPENAI_CONNECTED_ACCOUNT_SERVICE,
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
      service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE,
      materializationKinds: ['environment'],
      credentialKinds: ['token'],
    },
    provider: 'anthropic',
    environmentKeys: ['ANTHROPIC_API_KEY'],
    requestAuthOrigin: null,
    requestAuthHeaderNames: [],
  },
  {
    declaration: { purpose: 'kimi-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE,
      materializationKinds: ['environment'], credentialKinds: ['token'] },
    provider: 'kimi-code-plan-global',
    additionalProviders: ['kimi-code-plan-cn'],
    environmentKeys: [KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV],
    nativeEnvironmentAuth: { key: KIMI_CODE_API_KEY_ENV, baseURLKey: KIMI_CODE_API_BASE_ENV },
    requestAuthOrigin: null, requestAuthHeaderNames: [],
  },
  {
    declaration: { purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE,
      materializationKinds: ['environment'], credentialKinds: ['token'] },
    provider: 'xai', environmentKeys: ['XAI_API_KEY'], nativeEnvironmentAuth: { key: 'XAI_API_KEY' },
    requestAuthOrigin: null, requestAuthHeaderNames: [],
  },
  {
    declaration: { purpose: 'meta-inference', service: MUSE_ACCOUNT_SERVICE,
      managedProviderEndpoint: {
        provider: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        purpose: 'meta-upstream', modelIdPrefix: 'meta/',
      },
      materializationKinds: ['environment'], credentialKinds: ['token', 'oauth'] },
    provider: 'meta', environmentKeys: [META_API_KEY_ENV_KEY],
    requestAuthOrigin: null, requestAuthHeaderNames: [],
  },
  {
    declaration: { purpose: 'gemini', service: GEMINI_CONNECTED_ACCOUNT_SERVICE,
      materializationKinds: ['environment', 'files'], credentialKinds: ['token'] },
    provider: 'google', additionalProviders: ['google-vertex'],
    environmentKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
    nativeEnvironmentAuth: { key: 'GEMINI_API_KEY' },
    requestAuthOrigin: null, requestAuthHeaderNames: [],
  },
  {
    declaration: { purpose: 'github-copilot', service: GITHUB_CONNECTED_ACCOUNT_SERVICE,
      materializationKinds: ['environment'], credentialKinds: ['token', 'oauth'] },
    provider: 'github-copilot', environmentKeys: ['COPILOT_GITHUB_TOKEN'], nativeEnvironmentAuth: { key: 'COPILOT_GITHUB_TOKEN' },
    requestAuthOrigin: null, requestAuthHeaderNames: [],
  },
] as const);

export type OpenCodeConnectedAccountPurposeId =
  typeof OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS[number]['declaration']['purpose'];
type AccountDescriptor = typeof OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS[number];
type RequestAuthDescriptor = Extract<AccountDescriptor, { requestAuthOrigin: string }>;
export type OpenCodeRequestAuthProvider = RequestAuthDescriptor['provider'];

export function openCodeAccountProviders(row: AccountDescriptor) {
  return [row.provider, ...('additionalProviders' in row ? row.additionalProviders : [])];
}

export const OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_DESCRIPTORS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.filter((row): row is Exclude<AccountDescriptor, { declaration: { managedProviderEndpoint: unknown } }> => !('managedProviderEndpoint' in row.declaration)),
);
export const OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_PURPOSE_IDS = Object.freeze(
  OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_DESCRIPTORS.map(({ declaration }) => declaration.purpose),
);
export type OpenCodeNativeConnectedAccountPurposeId = typeof OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_PURPOSE_IDS[number];

export const OPEN_CODE_NATIVE_ACCOUNT_DESCRIPTORS = Object.freeze(
  OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_DESCRIPTORS.filter((row): row is Extract<typeof OPEN_CODE_NATIVE_CONNECTED_ACCOUNT_DESCRIPTORS[number], { nativeEnvironmentAuth: unknown }> => 'nativeEnvironmentAuth' in row),
);

export const OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.map(({ declaration }) => declaration),
);
export const OPEN_CODE_CONNECTED_ACCOUNT_SERVICE_IDS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS.map(({ service }) => buildQualifiedPluginContributionKey(service)),
);
export const OPEN_CODE_NATIVE_AUTH_ENV_KEYS = Object.freeze([
  'OPENCODE_AUTH_CONTENT',
  ...OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.flatMap(({ environmentKeys }) => [...environmentKeys]),
]);
export const OPEN_CODE_REQUEST_AUTH_DESCRIPTORS = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.filter((row): row is RequestAuthDescriptor => row.requestAuthOrigin !== null),
);
export const OPEN_CODE_REQUEST_AUTH_PROVIDERS = Object.freeze(
  OPEN_CODE_REQUEST_AUTH_DESCRIPTORS.map(({ provider }) => provider),
);
export const OPEN_CODE_REQUEST_AUTH_USES = Object.freeze(
  OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.flatMap((row) => row.requestAuthOrigin === null ? [] : [{
    purpose: row.declaration.purpose,
    materialization: {
      kind: 'httpHeaders' as const,
      origin: row.requestAuthOrigin,
      headerNames: [...row.requestAuthHeaderNames],
    },
  }]) satisfies readonly ConnectedAccountRequestAuthUseV1[],
);
export const OPEN_CODE_NATIVE_PROVIDERS = Object.freeze([
  ...new Set(OPEN_CODE_CONNECTED_ACCOUNT_DESCRIPTORS.flatMap(openCodeAccountProviders)),
]);
export type OpenCodeNativeProvider = typeof OPEN_CODE_NATIVE_PROVIDERS[number];

export function isOpenCodeNativeProvider(value: unknown): value is OpenCodeNativeProvider {
  return OPEN_CODE_NATIVE_PROVIDERS.some((provider) => provider === value);
}
