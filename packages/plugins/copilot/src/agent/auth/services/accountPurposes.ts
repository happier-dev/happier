import {
  KIMI_CONNECTED_ACCOUNT_SERVICE,
  KIMI_CODE_API_KEY_ENV,
  KIMI_CODE_API_BASE_ENV,
  GROK_CONNECTED_ACCOUNT_SERVICE,
  XAI_SELECTED_API_KEY_ENV,
  ANTHROPIC_CONNECTED_ACCOUNT_SERVICE,
  ANTHROPIC_API_KEY_ENV,
  OPENAI_CONNECTED_ACCOUNT_SERVICE,
  OPENAI_SELECTED_API_KEY_ENV,
  OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
} from '@happier-dev/plugin-sdk/connected-accounts';

export const COPILOT_NATIVE_KEY_PURPOSES = [
  { purpose: 'anthropic-api-key', service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, environmentKey: ANTHROPIC_API_KEY_ENV, baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' },
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, environmentKey: OPENAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.openai.com/v1', protocol: 'openai-chat' },
  { purpose: 'kimi-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, environmentKey: KIMI_CODE_API_KEY_ENV, baseUrlEnvironmentKey: KIMI_CODE_API_BASE_ENV, protocol: 'openai-chat' },
  { purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE, environmentKey: XAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.x.ai/v1', protocol: 'openai-chat' },
] as const;

export const COPILOT_OPENAI_CODEX_PURPOSE_ID = 'openai-codex' as const;
export const COPILOT_GITHUB_PURPOSE_ID = 'github-copilot' as const;

export const COPILOT_CONNECTED_ACCOUNT_PURPOSES = Object.freeze([{
  purpose: COPILOT_OPENAI_CODEX_PURPOSE_ID,
  service: OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
  credentialKinds: ['oauth'] as const,
  materializationKinds: ['httpHeaders'] as const,
}, {
  purpose: COPILOT_GITHUB_PURPOSE_ID,
  service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
  credentialKinds: ['token', 'oauth'] as const,
  materializationKinds: ['environment'] as const,
}, ...COPILOT_NATIVE_KEY_PURPOSES.map(({ purpose, service }) => ({ purpose, service, credentialKinds: ['token'] as const, materializationKinds: ['environment'] as const }))]);
