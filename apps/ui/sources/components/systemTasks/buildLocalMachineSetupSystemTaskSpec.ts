import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

export function buildLocalMachineSetupSystemTaskSpec(params: Readonly<{
    activeRelayUrl?: string;
    activeWebappUrl?: string;
    activeLocalRelayUrl?: string | null;
    installService?: boolean;
    startService?: boolean;
    verifyService?: boolean;
}> = {}): SystemTaskSpec {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
            channel,
            ...(typeof params.activeRelayUrl === 'string' && params.activeRelayUrl.trim().length > 0
                ? { activeRelayUrl: params.activeRelayUrl.trim() }
                : {}),
            ...(typeof params.activeWebappUrl === 'string' && params.activeWebappUrl.trim().length > 0
                ? { activeWebappUrl: params.activeWebappUrl.trim() }
                : {}),
            ...(params.activeLocalRelayUrl === null
                ? { activeLocalRelayUrl: null }
                : (typeof params.activeLocalRelayUrl === 'string' && params.activeLocalRelayUrl.trim().length > 0
                    ? { activeLocalRelayUrl: params.activeLocalRelayUrl.trim() }
                    : {})),
            ...(typeof params.installService === 'boolean' ? { installService: params.installService } : {}),
            ...(typeof params.startService === 'boolean' ? { startService: params.startService } : {}),
            ...(typeof params.verifyService === 'boolean' ? { verifyService: params.verifyService } : {}),
        },
    };
}
