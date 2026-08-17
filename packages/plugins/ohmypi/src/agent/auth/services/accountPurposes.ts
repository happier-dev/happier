export const OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES = [{
  purpose: 'openai-codex',
  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
  materializationKey: 'OPENAI_CODEX_OAUTH_TOKEN',
  launchEnvironmentKey: 'OPENAI_CODEX_OAUTH_TOKEN',
}, {
  purpose: 'openai',
  service: { pluginId: 'happier.voice.openai', localId: 'openai' },
  materializationKey: 'OPENAI_API_KEY',
  launchEnvironmentKey: 'OPENAI_API_KEY',
}, {
  purpose: 'claude-subscription',
  service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
  materializationKey: 'CLAUDE_CODE_OAUTH_TOKEN',
  launchEnvironmentKey: 'ANTHROPIC_OAUTH_TOKEN',
}, {
  purpose: 'anthropic',
  service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
  materializationKey: 'ANTHROPIC_API_KEY',
  launchEnvironmentKey: 'ANTHROPIC_API_KEY',
}, {
  purpose: 'gemini',
  service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
  materializationKey: 'GEMINI_API_KEY',
  launchEnvironmentKey: 'GEMINI_API_KEY',
}] as const;
