import { agent as codexAgent } from './codex';
import { agent as geminiAgent } from './gemini';
import { agent as kiroAgent } from './kiro';
import { agent as ohMyPiAgent } from './ohMyPi';
import { agent as piAgent } from './pi';
import type { AgentCatalogEntry, CatalogAgentId } from './types';

function isAgentCatalogEntry(entry: AgentCatalogEntry | undefined): entry is AgentCatalogEntry {
  return typeof entry?.id === 'string' && entry.id.length > 0;
}

const BUILT_IN_HOST_CATALOG_ENTRIES = Object.freeze(([
  codexAgent,
  geminiAgent,
  kiroAgent,
  ohMyPiAgent,
  piAgent,
] satisfies readonly (AgentCatalogEntry | undefined)[]).filter(isAgentCatalogEntry));

const BUILT_IN_HOST_CATALOG_ENTRIES_BY_ID = Object.freeze(
  Object.fromEntries(BUILT_IN_HOST_CATALOG_ENTRIES.map((entry) => [entry.id, entry] as const)),
) as Readonly<Partial<Record<CatalogAgentId, AgentCatalogEntry>>>;

export function readBuiltInHostCatalogEntries(): Readonly<Partial<Record<CatalogAgentId, AgentCatalogEntry>>> {
  return BUILT_IN_HOST_CATALOG_ENTRIES_BY_ID;
}

export function readBuiltInHostCatalogEntry(agentId: string | null | undefined): AgentCatalogEntry | null {
  if (!agentId) return null;
  return (BUILT_IN_HOST_CATALOG_ENTRIES_BY_ID as Readonly<Record<string, AgentCatalogEntry>>)[agentId] ?? null;
}
