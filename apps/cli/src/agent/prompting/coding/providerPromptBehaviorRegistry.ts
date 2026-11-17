import type { PromptBlockV1 } from '@happier-dev/protocol';

import { readCurrentAgentDefinition } from '@/agent/catalog/registry';
import { readSessionInputPromptUserTextV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

export function resolveCodingProviderBehaviorBlocks(args: Readonly<{
  agentId: string | null | undefined;
  disableTodos?: boolean;
}>): PromptBlockV1[] {
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  if (!agentId) return [];

  const blocks = readCurrentAgentDefinition(agentId)?.catalog?.codingPromptBehavior?.blocks;
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

/** Historical bare prompt echoes use the same installed-Agent catalog as injection. */
export function createCodingSessionInputPromptUserTextReader(agentId: string): (text: string) => string {
  const blocks = resolveCodingProviderBehaviorBlocks({ agentId, disableTodos: true })
    .flatMap(block => [block.text.trim(), block.text.replace(/\s+/g, ' ').trim()])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return text => readSessionInputPromptUserTextV1(text, blocks);
}
