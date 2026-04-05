import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

export type ActivitySurfaceKind = 'liveActivities' | 'widgets';
export type ActivitySurfaceSelectionMode = 'focused' | 'attention' | 'running' | 'summary';
export type ActivitySurfaceSelectionReason = 'all_eligible' | 'dynamic_primary' | 'pinned_primary' | 'session_specific';

export type ActivitySurfaceSelectionSpec = Readonly<{
    surfaceId: string;
    enabled: boolean;
    mode: ActivitySurfaceSelectionMode;
    selectionReason: ActivitySurfaceSelectionReason;
    maxSelected: number | null;
    includeReady: boolean;
    includeThinking: boolean;
}>;

export type ResolveActivitySurfaceSlotsParams = Readonly<{
    overview: ActivityOverviewSnapshot;
    selection: ActivitySurfaceSelectionSpec;
    applyCap?: boolean;
    preferredPrimarySessionId?: string | null;
}>;

export type ActivitySurfaceSlots = Readonly<{
    selection: ActivitySurfaceSelectionSpec;
    overview: ActivityOverviewSnapshot;
    eligibleSessions: readonly SessionActivityAttention[];
    selectedSessions: readonly SessionActivityAttention[];
    primarySession: SessionActivityAttention | null;
    overflowCount: number;
    selectionReason: ActivitySurfaceSelectionReason;
}>;

export function createLiveActivitySelectionSpec(policy: ActivitySurfacePolicy): ActivitySurfaceSelectionSpec {
    return {
        surfaceId: 'ios_live_activities',
        enabled: policy.liveActivities.enabled,
        mode: policy.liveActivities.mode,
        selectionReason: policy.liveActivities.strategy,
        maxSelected: policy.liveActivities.strategy === 'session_specific'
            ? policy.liveActivities.maxConcurrent
            : 1,
        includeReady: policy.liveActivities.includeReady,
        includeThinking: policy.liveActivities.includeThinking,
    };
}

export function createWidgetSelectionSpec(policy: ActivitySurfacePolicy): ActivitySurfaceSelectionSpec {
    return {
        surfaceId: 'ios_widgets',
        enabled: policy.widgets.enabled,
        mode: policy.widgets.mode,
        selectionReason: 'all_eligible',
        maxSelected: null,
        includeReady: true,
        includeThinking: true,
    };
}
