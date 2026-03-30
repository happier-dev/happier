import type { PromptRegistryAdapter } from '@/promptRegistries/types';

export function createClaudeMarketplacePromptRegistryAdapter(): PromptRegistryAdapter {
  return {
    descriptor: {
      id: 'claude_marketplace',
      title: 'Claude marketplace',
      description: 'Reserved adapter slot for a future Claude marketplace integration.',
      supportsConfiguredSources: false,
      supportsQuery: false,
    },

    async listBuiltInSources() {
      return [];
    },

    resolveConfiguredSource() {
      return null;
    },

    async scanSource() {
      return [];
    },

    async fetchItem() {
      return {
        ok: false,
        errorCode: 'unsupported',
        error: 'Claude marketplace integration is not available yet',
      };
    },
  };
}
