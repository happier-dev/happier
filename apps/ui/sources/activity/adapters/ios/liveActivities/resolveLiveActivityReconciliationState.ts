import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import type { ActivityOverviewSnapshot } from '@/activity/attention/activityAttentionTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildLiveActivitySnapshots, type LiveActivitySnapshot } from './buildLiveActivitySnapshots';

const LIVE_ACTIVITY_DYNAMIC_PRIMARY_DWELL_MS = 90_000;

export type LiveActivityReconciliationState = Readonly<{
    snapshots: readonly LiveActivitySnapshot[];
    preferredPrimarySessionId: string | null;
    preferredPrimaryActivityInstanceKey: string | null;
    preferredPrimaryChangedAtMs: number | null;
}>;

export function resolveLiveActivityReconciliationState(params: Readonly<{
    sessions: readonly Session[];
    overview?: ActivityOverviewSnapshot;
    policy: ActivitySurfacePolicy;
    currentPreferredPrimarySessionId?: string | null;
    currentPreferredPrimaryActivityInstanceKey?: string | null;
    currentPreferredPrimaryChangedAtMs?: number | null;
    dwellMs?: number;
    staleAfterMs?: number;
    nowMs?: number;
}>): LiveActivityReconciliationState {
    const nowMs = params.nowMs ?? Date.now();
    const dwellMs = typeof params.dwellMs === 'number' && Number.isFinite(params.dwellMs)
        ? Math.max(0, params.dwellMs)
        : LIVE_ACTIVITY_DYNAMIC_PRIMARY_DWELL_MS;
    const rawSnapshots = buildLiveActivitySnapshots({
        sessions: params.sessions,
        overview: params.overview,
        policy: params.policy,
        preferredPrimarySessionId: params.currentPreferredPrimarySessionId ?? null,
        staleAfterMs: params.staleAfterMs,
        nowMs,
    });
    const currentKey = normalizeKey(params.currentPreferredPrimaryActivityInstanceKey);
    const currentChangedAtMs = typeof params.currentPreferredPrimaryChangedAtMs === 'number'
        ? params.currentPreferredPrimaryChangedAtMs
        : null;
    const shouldHoldDynamicPrimary =
        params.policy.liveActivities.strategy === 'dynamic_primary'
        && currentKey !== null
        && currentChangedAtMs !== null
        && nowMs - currentChangedAtMs < dwellMs;
    const snapshots = shouldHoldDynamicPrimary
        ? buildLiveActivitySnapshots({
            sessions: params.sessions,
            overview: params.overview,
            policy: params.policy,
            preferredPrimaryActivityInstanceKey: currentKey,
            staleAfterMs: params.staleAfterMs,
            nowMs,
        })
        : rawSnapshots;
    const preferredPrimaryActivityInstanceKey = snapshots[0]?.activityInstanceKey ?? null;
    const preferredPrimaryChangedAtMs = preferredPrimaryActivityInstanceKey === null
        ? null
        : preferredPrimaryActivityInstanceKey === currentKey && currentChangedAtMs !== null
            ? currentChangedAtMs
            : nowMs;

    return {
        snapshots,
        preferredPrimarySessionId: params.policy.liveActivities.strategy === 'pinned_primary'
            ? (snapshots[0]?.sessionId ?? null)
            : null,
        preferredPrimaryActivityInstanceKey,
        preferredPrimaryChangedAtMs,
    };
}

function normalizeKey(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}
