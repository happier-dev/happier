import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

import { resolvePiBrowseSourceOptions } from './directSessions/resolvePiBrowseSourceOptions';

export const PI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    // Pi thinking level is now modeled as a model-scoped option (reasoning_effort) returned
    // by model probing + session metadata, so no Pi-specific chip or env-var bridge is needed here.
    directSessions: {
        browse: {
            order: 40,
            getSourceOptions: () => resolvePiBrowseSourceOptions(),
        },
    },
};
