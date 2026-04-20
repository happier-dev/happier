import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

export function buildRelayDriftRepairSystemTaskSpec(params: Readonly<{
    activeRelayUrl: string;
    activeWebappUrl: string;
    activeLocalRelayUrl?: string | null;
}>): SystemTaskSpec {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.repairThisComputer.v1',
        params: {
            channel,
            activeRelayUrl: params.activeRelayUrl,
            activeWebappUrl: params.activeWebappUrl,
            activeLocalRelayUrl: params.activeLocalRelayUrl ?? null,
            surface: 'desktop.ui',
        },
    };
}
