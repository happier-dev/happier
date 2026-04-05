import type { ActivityOverviewCounts } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceCountsViewModel } from '@/activity/presentation/activitySurfaceViewModels';

export function buildActivitySurfaceCountsViewModel(
    counts: ActivityOverviewCounts,
): ActivitySurfaceCountsViewModel {
    return {
        attentionCount: counts.totalAttention,
        runningCount: counts.thinking,
        permissionCount: counts.permissionRequired + counts.actionRequired,
    };
}
