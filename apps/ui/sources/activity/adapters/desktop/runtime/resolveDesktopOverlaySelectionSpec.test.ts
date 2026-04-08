import { describe, expect, it } from 'vitest';

import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { ACTIVITY_SURFACE_SELECTION_IDS } from '@/activity/selection/activitySurfaceSelectionTypes';

import { resolveDesktopOverlaySelectionSpec } from './resolveDesktopOverlaySelectionSpec';

function createPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    return {
        enabled: true,
        visibilityMode: 'attention_only',
        showWhenRunning: true,
        showWhenAttentionRequired: true,
        showWhenReady: true,
        alwaysOnTop: true,
        autoHideEnabled: true,
        autoHideDelayMs: 6000,
        expandedBehavior: 'click',
        interactiveCollapsed: true,
        presentationMode: 'automatic',
        clickAction: 'expand_overlay',
        density: 'compact',
        compactStyle: 'pill',
        showSessionCount: true,
        showPreviewText: false,
        placementMode: 'anchored',
        anchor: 'top_center',
        offsetX: 0,
        offsetY: 0,
        enableDragReposition: false,
        lockPosition: true,
        ...overrides,
    };
}

describe('resolveDesktopOverlaySelectionSpec', () => {
    it('maps attention-only mode to an attention-triggered desktop selection without quiet active sessions', () => {
        expect(resolveDesktopOverlaySelectionSpec(createPolicy())).toEqual({
            surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.desktopOverlay,
            enabled: true,
            mode: 'running',
            selectionReason: 'all_eligible',
            maxSelected: null,
            includeUrgent: true,
            includeReady: true,
            includeThinking: true,
            includeQuietActive: false,
            activeOnly: false,
        });
    });

    it('lets active-session modes include quiet active sessions and respect disabled triggers', () => {
        expect(resolveDesktopOverlaySelectionSpec(createPolicy({
            visibilityMode: 'active_sessions',
            showWhenRunning: false,
            showWhenAttentionRequired: false,
            showWhenReady: false,
        }))).toEqual({
            surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.desktopOverlay,
            enabled: true,
            mode: 'running',
            selectionReason: 'all_eligible',
            maxSelected: null,
            includeUrgent: true,
            includeReady: true,
            includeThinking: true,
            includeQuietActive: true,
            activeOnly: true,
        });
    });
});
