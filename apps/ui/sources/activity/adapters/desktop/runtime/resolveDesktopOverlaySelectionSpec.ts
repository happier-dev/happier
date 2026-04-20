import type { ActivitySurfaceSelectionSpec } from '@/activity/selection/activitySurfaceSelectionTypes';
import { ACTIVITY_SURFACE_SELECTION_IDS } from '@/activity/selection/activitySurfaceSelectionTypes';

import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';

export function resolveDesktopOverlaySelectionSpec(
    policy: DesktopOverlayPolicy,
): ActivitySurfaceSelectionSpec {
    const usesActiveSessionCandidatePool = policy.visibilityMode === 'active_sessions'
        || policy.visibilityMode === 'always_when_enabled';

    return {
        surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.desktopOverlay,
        enabled: policy.enabled,
        mode: 'running',
        selectionReason: 'all_eligible',
        maxSelected: null,
        includeUrgent: usesActiveSessionCandidatePool ? true : policy.showWhenAttentionRequired,
        includeReady: usesActiveSessionCandidatePool ? true : policy.showWhenReady,
        includeThinking: usesActiveSessionCandidatePool ? true : policy.showWhenRunning,
        includeQuietActive: usesActiveSessionCandidatePool,
        activeOnly: false,
    };
}
