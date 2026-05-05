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
        hoverExpandDelayMs: 500,
        expandedBehavior: 'click',
        interactiveCollapsed: true,
        presentationMode: 'automatic',
        clickAction: 'expand_overlay',
        density: 'compact',
        compactStyle: 'pill',
        showSessionCount: true,
        showPreviewText: false,
        quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
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
            dwellMs: 90_000,
            staleAfterMs: 120_000,
        });
    });

    it('lets active-session mode include active quiet and active attention sessions regardless of trigger toggles', () => {
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
            dwellMs: 90_000,
            staleAfterMs: 120_000,
        });
    });

    it('maps always-when-enabled mode to the same candidate pool as active sessions so idle rendering can be decided later', () => {
        expect(resolveDesktopOverlaySelectionSpec(createPolicy({
            visibilityMode: 'always_when_enabled',
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
            dwellMs: 90_000,
            staleAfterMs: 120_000,
        });
    });
});
