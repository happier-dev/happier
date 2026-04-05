import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import {
    createLiveActivitySelectionSpec,
    createWidgetSelectionSpec,
    type ActivitySurfaceKind,
} from '@/activity/selection/activitySurfaceSelectionTypes';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';

export type SelectActivitySurfaceCandidatesParams = Readonly<{
    overview: ActivityOverviewSnapshot;
    policy: ActivitySurfacePolicy;
    surface?: ActivitySurfaceKind;
    preferredPrimarySessionId?: string;
    applyCap?: boolean;
}>;

export function selectActivitySurfaceCandidates(
    params: SelectActivitySurfaceCandidatesParams,
): readonly SessionActivityAttention[] {
    return resolveActivitySurfaceSlots({
        overview: params.overview,
        selection: params.surface === 'widgets'
            ? createWidgetSelectionSpec(params.policy)
            : createLiveActivitySelectionSpec(params.policy),
        preferredPrimarySessionId: params.preferredPrimarySessionId,
        applyCap: params.applyCap,
    }).selectedSessions;
}
