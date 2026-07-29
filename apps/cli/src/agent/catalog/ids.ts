import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  type AgentId,
  type VendorResumeSupportLevel,
} from '@happier-dev/agents';

import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';

export const CATALOG_AGENT_IDS = AGENT_IDS;
export const DEFAULT_CATALOG_AGENT_ID = DEFAULT_AGENT_ID;

export type CatalogAgentId = AgentId;
export type CatalogAgentLookupId = CatalogAgentId | typeof LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID;
export type { VendorResumeSupportLevel };
