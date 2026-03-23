import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

export const PI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    // Pi thinking level is now modeled as a model-scoped option (reasoning_effort) returned
    // by model probing + session metadata, so no Pi-specific chip or env-var bridge is needed here.
};
