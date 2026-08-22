import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';

import type {
  CatalogAgentId,
  CatalogAgentLookupId,
} from './ids';
import {
  AGENTS,
  findCatalogEntry,
} from './registry';

/**
 * Checks the one current resolved catalog projection. This is deliberately
 * distinct from the generated built-in Agent table: an installed external
 * contribution is a catalog Agent too, while an unavailable identity receives
 * no other Agent's catalog facts.
 */
export function isCatalogAgentId(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENTS, value);
}

export function isCatalogAgentLookupId(value: string): boolean {
  return isCatalogAgentId(value) || value === LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID;
}

/**
 * The one catalog identity lookup.
 *
 * Absence is a typed result rather than an exception or a default: an Agent id
 * that names no installed contribution, and an absent id, both answer `null`.
 * Callers own that case in their own vocabulary — a missing catalog hook, a
 * typed refusal, a CLI diagnostic — instead of silently inheriting the default
 * Agent's facts, which is indistinguishable downstream from a declared one.
 */
export function resolveCatalogAgentId(agentId?: string | null): CatalogAgentId | null {
  const raw = typeof agentId === 'string' ? agentId.trim() : '';
  return raw && isCatalogAgentId(raw) ? raw : null;
}

export function resolveAgentCliSubcommand(agentId?: string | null): CatalogAgentLookupId | null {
  const catalogId = resolveCatalogAgentId(agentId);
  if (!catalogId) return null;
  return findCatalogEntry(catalogId)?.cliSubcommand ?? null;
}

export function resolveCatalogAgentIdForCliSubcommand(subcommand: string): CatalogAgentLookupId | null {
  for (const [agentId, entry] of Object.entries(AGENTS)) {
    if (entry.cliSubcommand === subcommand) {
      return agentId;
    }
  }
  return null;
}
