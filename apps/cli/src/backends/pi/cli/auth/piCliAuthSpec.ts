import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import type { CliAuthSpec } from '@/backends/types';

export const piCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('pi', {
  detectAuthStatus: async () => {
    const openAiApiKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY.trim() : '';
    if (openAiApiKey) {
      return { state: 'logged_in', method: 'api_key_env', source: 'env' };
    }

    const anthropicApiKey = typeof process.env.ANTHROPIC_API_KEY === 'string' ? process.env.ANTHROPIC_API_KEY.trim() : '';
    if (anthropicApiKey) {
      return { state: 'logged_in', method: 'api_key_env', source: 'env' };
    }

    return { state: 'logged_out', reason: 'missing_credentials' };
  },
});
