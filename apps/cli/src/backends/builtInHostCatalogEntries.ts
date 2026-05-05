import { agent as auggieAgent } from './auggie';
import { agent as claudeAgent } from './claude';
import { agent as codexAgent } from './codex';
import { agent as copilotAgent } from './copilot';
import { agent as geminiAgent } from './gemini';
import { agent as kiloAgent } from './kilo';
import { agent as kimiAgent } from './kimi';
import { agent as kiroAgent } from './kiro';
import { agent as ohMyPiAgent } from './ohMyPi';
import { agent as opencodeAgent } from './opencode';
import { agent as piAgent } from './pi';
import { agent as qwenAgent } from './qwen';
import type { AgentCatalogEntry, CatalogAgentId } from './types';

const BUILT_IN_HOST_CATALOG_ENTRIES = Object.freeze([
  claudeAgent,
  codexAgent,
  opencodeAgent,
  geminiAgent,
  auggieAgent,
  qwenAgent,
  kimiAgent,
  kiloAgent,
  kiroAgent,
  ohMyPiAgent,
  piAgent,
  copilotAgent,
] satisfies readonly AgentCatalogEntry[]);

const BUILT_IN_HOST_CATALOG_ENTRIES_BY_ID = Object.freeze(
  Object.fromEntries(BUILT_IN_HOST_CATALOG_ENTRIES.map((entry) => [entry.id, entry] as const)),
) as Readonly<Record<CatalogAgentId, AgentCatalogEntry>>;

export function readBuiltInHostCatalogEntries(): Readonly<Record<CatalogAgentId, AgentCatalogEntry>> {
  return BUILT_IN_HOST_CATALOG_ENTRIES_BY_ID;
}

export function readBuiltInHostCatalogEntry(agentId: string | null | undefined): AgentCatalogEntry | null {
  if (!agentId) return null;
  return (BUILT_IN_HOST_CATALOG_ENTRIES_BY_ID as Readonly<Record<string, AgentCatalogEntry>>)[agentId] ?? null;
}
