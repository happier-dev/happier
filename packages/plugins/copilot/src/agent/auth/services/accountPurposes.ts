export const COPILOT_OPENAI_CODEX_PURPOSE_ID = 'openai-codex' as const;
export const COPILOT_GITHUB_PURPOSE_ID = 'github-copilot' as const;

export const COPILOT_CONNECTED_ACCOUNT_PURPOSES = Object.freeze([{
  purpose: COPILOT_OPENAI_CODEX_PURPOSE_ID,
  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
  credentialKinds: ['oauth'] as const,
  materializationKinds: ['httpHeaders'] as const,
}, {
  purpose: COPILOT_GITHUB_PURPOSE_ID,
  service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
  credentialKinds: ['token', 'oauth'] as const,
  materializationKinds: ['environment'] as const,
}]);
