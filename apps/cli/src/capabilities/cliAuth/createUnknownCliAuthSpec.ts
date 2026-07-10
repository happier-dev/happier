import type { CliAuthSpec } from './types';
import { createCatalogCliAuthSpec } from './createCatalogCliAuthSpec';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

export function createUnknownCliAuthSpec(agentId: CatalogAgentLookupId): CliAuthSpec {
  return createCatalogCliAuthSpec(agentId, {
    detectAuthStatus: async () => ({
      state: 'unknown',
      reason: 'unsupported',
    }),
  });
}
