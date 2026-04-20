import type { CliAuthSpec } from './types';
import { createCatalogCliAuthSpec } from './createCatalogCliAuthSpec';
import type { CatalogAgentLookupId } from '@/backends/types';

export function createUnknownCliAuthSpec(agentId: CatalogAgentLookupId): CliAuthSpec {
  return createCatalogCliAuthSpec(agentId, {
    detectAuthStatus: async () => ({
      state: 'unknown',
      reason: 'unsupported',
    }),
  });
}
