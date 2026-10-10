import type { AgentCatalogEntry } from '@/backends/types';

import { createCatalogDefinedAcpEntry } from './createCatalogDefinedAcpEntry';

export const BUILT_IN_CATALOG_DEFINED_ACP_AGENTS = {
  customAcp: createCatalogDefinedAcpEntry('customAcp'),
  kiro: createCatalogDefinedAcpEntry('kiro'),
  fx: createCatalogDefinedAcpEntry('fx'),
  droid: createCatalogDefinedAcpEntry('droid'),
  codebuddy: createCatalogDefinedAcpEntry('codebuddy'),
} as const satisfies Record<'customAcp' | 'kiro' | 'fx' | 'droid' | 'codebuddy', AgentCatalogEntry>;
