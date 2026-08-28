import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';

export const OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES = [{
  purpose: 'openai-codex',
  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
  materializationKey: 'OPENAI_CODEX_OAUTH_TOKEN',
  launchEnvironmentKey: 'OPENAI_CODEX_OAUTH_TOKEN',
  credentialKinds: ['oauth'],
}, {
  purpose: 'openai',
  service: { pluginId: 'happier.voice.openai', localId: 'openai' },
  materializationKey: 'OPENAI_API_KEY',
  launchEnvironmentKey: 'OPENAI_API_KEY',
  credentialKinds: ['token'],
}, {
  purpose: 'claude-subscription',
  service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
  materializationKey: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
  launchEnvironmentKey: 'ANTHROPIC_OAUTH_TOKEN',
  credentialKinds: ['token'],
}, {
  purpose: 'anthropic',
  service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
  materializationKey: 'ANTHROPIC_API_KEY',
  launchEnvironmentKey: 'ANTHROPIC_API_KEY',
  credentialKinds: ['token'],
}, {
  purpose: 'gemini',
  service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
  materializationKey: 'GEMINI_API_KEY',
  launchEnvironmentKey: 'GEMINI_API_KEY',
  credentialKinds: ['token'],
}] as const;
