/** Service identities shared by declarations and native account consumers. */
export const CLAUDE_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const);
export const ANTHROPIC_CONNECTED_ACCOUNT_SERVICE = Object.freeze({ pluginId: 'happier.agent.claude', localId: 'anthropic' } as const);
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
