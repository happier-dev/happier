import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

import { resolveOhMyPiBrowseSourceOptions } from '@/agents/providers/ohMyPi/directSessions/resolveOhMyPiBrowseSourceOptions';
import { resolveOhMyPiLinkEnsureRequestExtras } from '@/agents/providers/ohMyPi/directSessions/resolveOhMyPiLinkEnsureRequestExtras';

export const OH_MY_PI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    mcpServers: {
        supportsDetectedConfigScan: true,
    },
    directSessions: {
        supportsBackgroundFollow: true,
        browse: {
            order: 25,
            getSourceOptions: () => resolveOhMyPiBrowseSourceOptions(),
            buildLinkEnsureRequestExtras: ({ candidate, source }) => (
                source.kind === 'ohMyPiAgentDir'
                    ? resolveOhMyPiLinkEnsureRequestExtras({ source, candidate })
                    : {}
            ),
        },
    },
};
