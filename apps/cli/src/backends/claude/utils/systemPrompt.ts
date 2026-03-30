import { buildPromptPlanV1, renderPromptPlanV1 } from '@happier-dev/protocol';

import { resolveCodingProviderBehaviorBlocks } from '@/agent/prompting/coding/providerPromptBehaviorRegistry';

/**
 * Claude-specific supplemental provider-behavior prompt blocks.
 * Shared session instructions such as change_title belong to the centralized base prompt.
 */
export function getClaudeSystemPrompt(): string {
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'coding',
    blocks: resolveCodingProviderBehaviorBlocks({ providerId: 'claude' }),
  }));
}

// Backwards-compatible export name, but evaluated at call time (not module init).
export function systemPrompt(): string {
  return getClaudeSystemPrompt();
}
