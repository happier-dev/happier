import type { PromptBlockV1 } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

export function resolveCodingProviderBehaviorBlocks(args: Readonly<{
  agentId: string | null | undefined;
  disableTodos?: boolean;
}>): PromptBlockV1[] {
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  if (!agentId) return [];

  const blocks = readAgentCatalogSnapshot()
    .agentDefinitionsById
    .get(agentId)
    ?.richDefinition
    ?.definition
    .catalog
    ?.codingPromptBehavior
    ?.blocks;
  if (!blocks) return [];

  return blocks.flatMap((block) => {
    if (block.when === 'disableTodos' && args.disableTodos !== true) return [];
    return [{
      id: block.id,
      scope: 'provider_behavior',
      text: block.text,
    }];
  });
}
