export const COPILOT_OPENAI_CODEX_PURPOSE_ID = 'openai-codex' as const;

export const COPILOT_CONNECTED_ACCOUNT_PURPOSES = Object.freeze([{
  purpose: COPILOT_OPENAI_CODEX_PURPOSE_ID,
  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
  credentialKinds: ['oauth'] as const,
  materializationKinds: ['httpHeaders'] as const,
}]);
