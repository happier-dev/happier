import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

export const CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    newSession: {
        buildNewSessionOptions: () => null,
        getAgentInputExtraActionChips: () => [],
        canSelectWithoutDetectedCli: () => false,
    },
};
