import { describe, expect, it } from 'vitest';

import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { ACTIVITY_SURFACE_SELECTION_IDS } from '@/activity/selection/activitySurfaceSelectionTypes';

import { resolveDesktopOverlaySelectionSpec } from './resolveDesktopOverlaySelectionSpec';

function createPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    return {
        enabled: true,
        visibilityMode: 'attention_only',

        alwaysOnTop: true,

        hoverExpandDelayMs: 500,

        dock: 'top',
        idle: 'tip',
        botConversationPresentation: 'overlay',

        quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
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

    it('lets active-session mode include active quiet and active attention sessions through the one visibility preference', () => {
        expect(resolveDesktopOverlaySelectionSpec(createPolicy({
            visibilityMode: 'active_sessions',

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
