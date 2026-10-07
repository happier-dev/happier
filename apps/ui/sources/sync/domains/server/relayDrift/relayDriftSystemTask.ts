import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { readActiveServerIdentityForRelayUrl } from '@/sync/domains/server/activeServerTaskScope';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';

export function buildRelayDriftRepairSystemTaskSpec(params: Readonly<{
    activeRelayUrl: string;
    activeWebappUrl: string;
    activeLocalRelayUrl?: string | null;
    /** A11-06 — the app's own account on that Home, so repair re-pairs for it; never the daemon's. */
    activeAccountId?: string | null;
}>): SystemTaskSpec {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    const activeServerIdentityId = readActiveServerIdentityForRelayUrl(params.activeRelayUrl);
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.repairThisComputer.v1',
        params: {
            channel,
            activeRelayUrl: params.activeRelayUrl,
            activeWebappUrl: params.activeWebappUrl,
            activeLocalRelayUrl: params.activeLocalRelayUrl ?? null,
            ...(activeServerIdentityId ? { activeServerIdentityId } : {}),
            ...(params.activeAccountId?.trim() ? { activeAccountId: params.activeAccountId.trim() } : {}),
            surface: 'desktop.ui',
        },
    };
}
