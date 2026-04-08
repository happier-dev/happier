import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
export type ActivitySurfaceSelectionMode = 'focused' | 'attention' | 'running' | 'summary';
export type ActivitySurfaceSelectionReason = 'all_eligible' | 'dynamic_primary' | 'pinned_primary' | 'session_specific';

export const ACTIVITY_SURFACE_SELECTION_IDS = {
    liveActivities: 'live_activities',
    widgets: 'widgets',
    desktopOverlay: 'desktop_overlay',
} as const;

export type ActivitySurfaceSelectionId =
    (typeof ACTIVITY_SURFACE_SELECTION_IDS)[keyof typeof ACTIVITY_SURFACE_SELECTION_IDS];

export type ActivitySurfaceSelectionSpec = Readonly<{
    surfaceId: ActivitySurfaceSelectionId;
    enabled: boolean;
    mode: ActivitySurfaceSelectionMode;
    selectionReason: ActivitySurfaceSelectionReason;
    maxSelected: number | null;
    includeUrgent: boolean;
    includeReady: boolean;
    includeThinking: boolean;
    includeQuietActive: boolean;
    activeOnly: boolean;
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
        surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.liveActivities,
        enabled: policy.liveActivities.enabled,
        mode: policy.liveActivities.mode,
        selectionReason: policy.liveActivities.strategy,
        maxSelected: policy.liveActivities.strategy === 'session_specific'
            ? policy.liveActivities.maxConcurrent
            : 1,
        includeUrgent: true,
        includeReady: policy.liveActivities.includeReady,
        includeThinking: policy.liveActivities.includeThinking,
        includeQuietActive: false,
        activeOnly: false,
    };
}

export function createWidgetSelectionSpec(policy: ActivitySurfacePolicy): ActivitySurfaceSelectionSpec {
    return {
        surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.widgets,
        enabled: policy.widgets.enabled,
        mode: policy.widgets.mode,
        selectionReason: 'all_eligible',
        maxSelected: null,
        includeUrgent: true,
        includeReady: true,
        includeThinking: true,
        includeQuietActive: false,
        activeOnly: false,
    };
}
