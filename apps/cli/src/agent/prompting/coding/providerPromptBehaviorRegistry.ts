import type { PromptBlockV1 } from '@happier-dev/protocol';

import { readCatalogEntriesSnapshot } from '@/agent/catalog/registry';

export function resolveCodingProviderBehaviorBlocks(args: Readonly<{
  agentId: string | null | undefined;
  disableTodos?: boolean;
}>): PromptBlockV1[] {
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  if (!agentId) return [];
  return readCatalogEntriesSnapshot()[agentId]?.resolveCodingPromptBehaviorBlocks?.({
    disableTodos: args.disableTodos,
  }) ?? [];
}
