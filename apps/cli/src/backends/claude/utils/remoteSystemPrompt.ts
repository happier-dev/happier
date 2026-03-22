import { buildPromptPlanV1, renderPromptPlanV1 } from '@happier-dev/protocol';

import { resolveCodingProviderBehaviorBlocks } from '@/agent/prompting/coding/providerPromptBehaviorRegistry';

export function getClaudeRemoteSystemPrompt(args: { disableTodos: boolean }): string {
    return renderPromptPlanV1(buildPromptPlanV1({
        modality: 'coding',
        blocks: resolveCodingProviderBehaviorBlocks({
            providerId: 'claude',
            disableTodos: args.disableTodos,
        }),
    }));
}
