import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildLiveActivitySnapshots, type LiveActivitySnapshot } from './buildLiveActivitySnapshots';

export type LiveActivityReconciliationState = Readonly<{
    snapshots: readonly LiveActivitySnapshot[];
    preferredPrimarySessionId: string | null;
}>;

export function resolveLiveActivityReconciliationState(params: Readonly<{
    sessions: readonly Session[];
    policy: ActivitySurfacePolicy;
    currentPreferredPrimarySessionId?: string | null;
    nowMs?: number;
}>): LiveActivityReconciliationState {
    const snapshots = buildLiveActivitySnapshots({
        sessions: params.sessions,
        policy: params.policy,
        preferredPrimarySessionId: params.currentPreferredPrimarySessionId ?? null,
        nowMs: params.nowMs,
    });

    return {
        snapshots,
        preferredPrimarySessionId: params.policy.liveActivities.strategy === 'pinned_primary'
            ? (snapshots[0]?.sessionId ?? null)
            : null,
    };
}
