import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  type VendorResumeSupportLevel,
} from '@happier-dev/agents';
import type { ExternalSessionAgentId } from '@happier-dev/protocol';

import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';

/**
 * The static generated table remains exhaustive for bundled Agent facts only.
 * The resolved catalog itself also carries installed contributed Agents, whose
 * identities are intentionally open.
 */
export const CATALOG_AGENT_IDS = AGENT_IDS;
export const DEFAULT_CATALOG_AGENT_ID = DEFAULT_AGENT_ID;

export type CatalogAgentId = ExternalSessionAgentId;
export type CatalogAgentLookupId = CatalogAgentId | typeof LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID;
export type { VendorResumeSupportLevel };
