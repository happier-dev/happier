import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';

import { resolvePiBrowseSourceOptions } from './directSessions/resolvePiBrowseSourceOptions';

export const PI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    usesSessionLevelVoiceReplies: (session) => {
        const localControl = getSessionLocalControlState(session);
        return localControl?.attached === true && localControl.topology === 'shared';
    },
    // Pi thinking level is now modeled as a model-scoped option (reasoning_effort) returned
    // by model probing + session metadata, so no Pi-specific chip or env-var bridge is needed here.
    directSessions: {
        browse: {
            order: 40,
            getSourceOptions: () => resolvePiBrowseSourceOptions(),
        },
    },
};
