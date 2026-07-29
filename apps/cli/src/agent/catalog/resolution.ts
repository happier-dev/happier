import type { AgentId } from '@happier-dev/agents';

import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';

import {
  CATALOG_AGENT_IDS,
  DEFAULT_CATALOG_AGENT_ID,
  type CatalogAgentId,
  type CatalogAgentLookupId,
} from './ids';
import {
  AGENTS,
  requireCatalogEntry,
} from './registry';

export function isCatalogAgentId(value: string): value is CatalogAgentId {
  return (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

export function isCatalogAgentLookupId(value: string): value is CatalogAgentLookupId {
  return isCatalogAgentId(value) || value === LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID;
}

export function resolveCatalogAgentId(agentId?: AgentId | null): CatalogAgentId {
  const raw = agentId ?? DEFAULT_CATALOG_AGENT_ID;
  const base = raw.split('-')[0];
  if (isCatalogAgentId(base)) {
    return base;
  }
  return DEFAULT_CATALOG_AGENT_ID;
}

export function resolveAgentCliSubcommand(agentId?: AgentId | null): CatalogAgentLookupId {
  const catalogId = resolveCatalogAgentId(agentId);
  return requireCatalogEntry(catalogId).cliSubcommand;
}

export function resolveCatalogAgentIdForCliSubcommand(subcommand: string): CatalogAgentLookupId | null {
  for (const [agentId, entry] of Object.entries(AGENTS)) {
    if (entry.cliSubcommand === subcommand) {
      return agentId as CatalogAgentLookupId;
    }
  }
  return null;
}
