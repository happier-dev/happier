/** Public identity and environment facts for authors consuming contributed Connected Account services. */
import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';

export {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_ACCESS_TOKEN_ENVIRONMENT_REQUEST_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/protocol/agents/claude/connected-account-materialization';

export const CLAUDE_CONNECTED_ACCOUNT_SERVICE = CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.service;
export const ANTHROPIC_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.agent.claude', localId: 'anthropic' } as const);
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

export const OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const);

export const GEMINI_CONNECTED_ACCOUNT_SERVICE = { pluginId: 'happier.agent.gemini', localId: 'gemini-account' } as const;
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

export const GROK_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.agent.grok', localId: 'xai' } as const);
export const XAI_SELECTED_API_KEY_ENV = 'HAPPIER_CONNECTED_XAI_API_KEY';

export const KIMI_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.agent.kimi', localId: 'kimi-code' } as const);
export const KIMI_CODE_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_SELECTED_CODE_API_KEY_ENV = 'HAPPIER_CONNECTED_KIMI_API_KEY';
export const KIMI_CODE_API_BASE_ENV = 'KIMI_CODE_BASE_URL';
export const KIMI_CODE_ANTHROPIC_BASE_ENV = 'KIMI_CODE_ANTHROPIC_BASE_URL';

export const MUSE_ACCOUNT_SERVICE = { pluginId: 'happier.agent.muse', localId: 'muse-account' } as const;
export const MUSE_CODE_CREDENTIAL_ENV_KEY = 'MUSE_CODE_CREDENTIAL';
export const META_API_KEY_ENV_KEY = 'META_API_KEY';

export const OPENAI_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.voice.openai', localId: 'openai' } as const);
export const OPENAI_SELECTED_API_KEY_ENV = 'HAPPIER_CONNECTED_OPENAI_API_KEY';

export const GITHUB_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github-account' } as const);
