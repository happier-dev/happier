import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';

export function buildRelayDriftRepairSystemTaskSpec(params: Readonly<{
    activeRelayUrl: string;
    activeWebappUrl: string;
    activeLocalRelayUrl?: string | null;
}>): SystemTaskSpec {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.connectBackgroundService.v1',
        params: {
            activeRelayUrl: params.activeRelayUrl,
            activeWebappUrl: params.activeWebappUrl,
            activeLocalRelayUrl: params.activeLocalRelayUrl ?? null,
            surface: 'desktop.ui',
        },
    };
}
