import type { ActivitySurfaceSelectionSpec } from '@/activity/selection/activitySurfaceSelectionTypes';

import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';

export function resolveDesktopOverlaySelectionSpec(
    policy: DesktopOverlayPolicy,
): ActivitySurfaceSelectionSpec {
    const selectsActiveSessions = policy.visibilityMode === 'active_sessions';

    return {
        surfaceId: 'desktop_overlay',
        enabled: policy.enabled,
        mode: 'running',
        selectionReason: 'all_eligible',
        maxSelected: null,
        includeUrgent: selectsActiveSessions ? true : policy.showWhenAttentionRequired,
        includeReady: selectsActiveSessions ? true : policy.showWhenReady,
        includeThinking: selectsActiveSessions ? true : policy.showWhenRunning,
        includeQuietActive: policy.visibilityMode !== 'attention_only',
        activeOnly: selectsActiveSessions,
    };
}
