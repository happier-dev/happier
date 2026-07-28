import type { AgentState } from '@/api/types';

export function publishStructuredQuestionAnswersV1Capability(state: AgentState): AgentState {
    return {
        ...state,
        capabilities: {
            ...(state.capabilities ?? {}),
            structuredQuestionAnswersV1Supported: true,
        },
    };
}
