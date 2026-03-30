import { renderPromptPlanV1 } from '@happier-dev/protocol';

import { resolveCodingProviderBehaviorBlocks } from '@/agent/prompting/coding/providerPromptBehaviorRegistry';

/**
 * Back-compat wrapper for the centralized Codex provider-behavior registry entry.
 */
export const EXEC_SEQUENCING_INSTRUCTION = renderPromptPlanV1({
  modality: 'coding',
  blocks: resolveCodingProviderBehaviorBlocks({ providerId: 'codex' }),
});
