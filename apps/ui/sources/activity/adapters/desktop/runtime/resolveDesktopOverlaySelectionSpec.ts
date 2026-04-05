import type { ActivitySurfaceSelectionSpec } from '@/activity/selection/activitySurfaceSelectionTypes';

import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';

export function resolveDesktopOverlaySelectionSpec(
    policy: DesktopOverlayPolicy,
): ActivitySurfaceSelectionSpec {
    return {
        surfaceId: 'desktop_overlay',
        enabled: policy.enabled,
        mode: 'running',
        selectionReason: 'all_eligible',
        maxSelected: null,
        includeUrgent: policy.showWhenAttentionRequired,
        includeReady: policy.showWhenReady,
        includeThinking: policy.showWhenRunning,
        includeQuietActive: policy.visibilityMode !== 'attention_only',
    };
}
