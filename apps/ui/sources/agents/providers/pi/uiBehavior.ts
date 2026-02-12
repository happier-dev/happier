import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

import { providers } from '@happier-dev/agents';

function getChipFactory(): typeof import('@/agents/providers/pi/PiThinkingChip').createPiThinkingLevelChip {
    // Lazy require so Node-side tests can import `@/agents/catalog` without resolving native icon deps.
    return require('@/agents/providers/pi/PiThinkingChip').createPiThinkingLevelChip;
}

function normalizeThinkingLevelForState(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export const PI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    newSession: {
        buildNewSessionOptions: ({ agentOptionState }) => {
            const thinkingLevel = normalizeThinkingLevelForState(agentOptionState?.[providers.pi.PI_NEW_SESSION_OPTION_THINKING_LEVEL]);
            return { [providers.pi.PI_NEW_SESSION_OPTION_THINKING_LEVEL]: thinkingLevel };
        },
        getAgentInputExtraActionChips: ({ agentOptionState, setAgentOptionState }) => {
            const thinkingLevel = normalizeThinkingLevelForState(agentOptionState?.[providers.pi.PI_NEW_SESSION_OPTION_THINKING_LEVEL]);
            const createPiThinkingLevelChip = getChipFactory();
            return [
                createPiThinkingLevelChip({
                    thinkingLevel,
                    setThinkingLevel: (next) => setAgentOptionState(providers.pi.PI_NEW_SESSION_OPTION_THINKING_LEVEL, next),
                }),
            ];
        },
    },
    payload: {
        buildSpawnEnvironmentVariables: ({ environmentVariables, newSessionOptions }) => {
            const thinkingLevel = newSessionOptions?.[providers.pi.PI_NEW_SESSION_OPTION_THINKING_LEVEL];
            return providers.pi.applyPiThinkingLevelEnv(environmentVariables, thinkingLevel) ?? environmentVariables;
        },
    },
};
