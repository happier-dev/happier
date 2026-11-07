import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { AgentCatalogEntry } from '@/agent/catalog/types';

/** Reads runtime capacity without requesting or borrowing native model evidence. */
export async function readAgentRuntimeMaxInputUnicodeCharacters(params: Readonly<{
  agentId: CatalogAgentLookupId;
  catalogEntry?: AgentCatalogEntry | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  runtimeKindOverride?: string;
}>): Promise<number | null> {
  const entry = params.catalogEntry === undefined
    ? readAgentCatalogSnapshot().catalogEntriesById[params.agentId]
    : params.catalogEntry;
  return entry?.resolveRuntimeMaxInputUnicodeCharacters?.({
    accountSettings: params.accountSettings,
    runtimeDescriptorV1: params.runtimeDescriptorV1,
    runtimeKindOverride: params.runtimeKindOverride,
  }) ?? null;
}
