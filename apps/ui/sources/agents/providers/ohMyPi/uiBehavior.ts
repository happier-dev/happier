import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

import { resolveOhMyPiBrowseSourceOptions } from '@/agents/providers/ohMyPi/externalSessions/resolveOhMyPiBrowseSourceOptions';
import { resolveOhMyPiLinkEnsureRequestExtras } from '@/agents/providers/ohMyPi/externalSessions/resolveOhMyPiLinkEnsureRequestExtras';

export const OH_MY_PI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    mcpServers: {
        supportsDetectedConfigScan: true,
    },
    externalSessions: {
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
