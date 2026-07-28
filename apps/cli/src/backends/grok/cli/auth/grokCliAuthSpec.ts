import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import type { CliAuthSpec } from '@/capabilities/cliAuth/types';

export const grokCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('grok', {
  detectAuthStatus: async () => {
    if (typeof process.env.XAI_API_KEY === 'string' && process.env.XAI_API_KEY.trim().length > 0) {
      return { state: 'logged_in', method: 'api_key_env', source: 'env' };
    }
    // There is no documented non-interactive cached-login status probe. Unknown is
    // deliberately distinct from logged out; ACP initialize/auth is the authority.
    return { state: 'unknown', reason: 'unsupported' };
  },
});
