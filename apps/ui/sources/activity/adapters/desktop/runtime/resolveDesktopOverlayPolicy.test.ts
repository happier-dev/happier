import { describe, expect, it } from 'vitest';

import {
    resolveDesktopOverlayPolicy,
} from './resolveDesktopOverlayPolicy';

describe('resolveDesktopOverlayPolicy', () => {
    it('uses conservative desktop defaults when settings are missing', () => {
        const policy = resolveDesktopOverlayPolicy({});

        expect(policy.enabled).toBe(false);
        expect(policy.visibilityMode).toBe('attention_only');
        expect(policy.alwaysOnTop).toBe(true);
        expect(policy).toMatchObject({
            hoverExpandDelayMs: 500,
        });
        expect(policy.displayMode).toBe('automatic');
    });

    it('docks the notch on top and rests it as a tip unless the person chose otherwise', () => {
        expect(resolveDesktopOverlayPolicy({})).toMatchObject({ dock: 'top', idle: 'tip' });
        expect(resolveDesktopOverlayPolicy({ desktopOverlayDock: 'floating', desktopOverlayIdle: 'hidden' }))
            .toMatchObject({ dock: 'floating', idle: 'hidden' });
        expect(resolveDesktopOverlayPolicy({ desktopOverlayDock: 'bottom', desktopOverlayIdle: 'peek' }))
            .toMatchObject({ dock: 'top', idle: 'tip' });
    });

    it('keeps a named display choice and drops the retired focused mode', () => {
        expect(resolveDesktopOverlayPolicy({ desktopOverlayDisplayMode: 'named:edid-610-41056-12345678' }).displayMode)
            .toBe('named:edid-610-41056-12345678');
        expect(resolveDesktopOverlayPolicy({ desktopOverlayDisplayMode: 'focused' }).displayMode).toBe('automatic');
        expect(resolveDesktopOverlayPolicy({ desktopOverlayDisplayMode: 'named:' }).displayMode).toBe('automatic');
    });

    it('reads explicit desktop overlay settings from local settings', () => {
        const policy = resolveDesktopOverlayPolicy({
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayShowWhenRunning: false,
            desktopOverlayShowWhenAttentionRequired: true,
            desktopOverlayShowWhenReady: false,
            desktopOverlayAlwaysOnTop: false,
            desktopOverlayAutoHideEnabled: false,
            desktopOverlayAutoHideDelayMs: 10000,
            desktopOverlayExpandedBehavior: 'hover',
            desktopOverlayInteractiveCollapsed: false,
            desktopOverlayPresentationMode: 'floating_overlay',
            desktopOverlayDisplayMode: 'built_in',
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24,
            desktopOverlayOffsetY: -16,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
            desktopOverlayDensity: 'comfortable',
            desktopOverlayCompactStyle: 'panel',
            desktopOverlayShowSessionCount: false,
            desktopOverlayShowPreviewText: true,
            desktopOverlayClickAction: 'open_primary_session',
        });

        expect(policy.enabled).toBe(true);
        expect(policy.visibilityMode).toBe('active_sessions');
        expect(policy.alwaysOnTop).toBe(false);
        expect(policy.displayMode).toBe('built_in');
    });



    it('maps canonical hover delay overrides to explicit product timings', () => {
        expect(resolveDesktopOverlayPolicy({
            attentionDeviceOverridesV1: {
                desktopOverlay: {
                    hoverExpandDelay: 'instant',
                },
            },
        })).toMatchObject({ hoverExpandDelayMs: 0 });
        expect(resolveDesktopOverlayPolicy({
            attentionDeviceOverridesV1: {
                desktopOverlay: {
                    hoverExpandDelay: 'normal',
                },
            },
        })).toMatchObject({ hoverExpandDelayMs: 500 });
        expect(resolveDesktopOverlayPolicy({
            attentionDeviceOverridesV1: {
                desktopOverlay: {
                    hoverExpandDelay: 'slow',
                },
            },
        })).toMatchObject({ hoverExpandDelayMs: 1000 });
    });

    it('normalizes all quick reply phrases once through the canonical schema from canonical desktop overlay device overrides', () => {
        const policy = resolveDesktopOverlayPolicy({
            attentionDeviceOverridesV1: {
                desktopOverlay: {
                    quickReplyPhrases: [' Ship ', 'Explain', '', 'Retry', 'More', 'Stop', 'Seventh', 'Eighth'],
                },
            },
        });

        expect(policy.quickReplyPhrases).toEqual(['Ship', 'Explain', 'Retry', 'More', 'Stop', 'Seventh', 'Eighth']);
    });



    it('drops retired placement and presentation inputs from the active policy', () => {
        const policy = resolveDesktopOverlayPolicy({ desktopOverlayPresentationMode: 'floating_overlay',
            desktopOverlayPlacementMode: 'custom', desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 240, desktopOverlayOffsetY: -160,
            desktopOverlayEnableDragReposition: false, desktopOverlayLockPosition: true });
        for (const key of ['presentationMode', 'placementMode', 'anchor', 'offsetX', 'offsetY', 'enableDragReposition', 'lockPosition']) {
            expect(policy).not.toHaveProperty(key);
        }
        expect(policy.dock).toBe('top');
    });


});


it('retires hidden and competing controls rather than publishing them as live policy', () => {
    const policy = resolveDesktopOverlayPolicy({ desktopOverlayAutoHideEnabled: true, desktopOverlayShowPreviewText: true,
        desktopOverlayShowWhenRunning: false, attentionDeviceOverridesV1: { desktopOverlay: { collapsedCarouselEnabled: true } } });
    for (const key of ['showWhenRunning', 'showWhenAttentionRequired', 'showWhenReady', 'autoHideEnabled', 'autoHideDelayMs',
        'expandedBehavior', 'interactiveCollapsed', 'clickAction', 'density', 'compactStyle', 'showSessionCount',
        'showPreviewText', 'collapsedCarouselEnabled']) expect(policy).not.toHaveProperty(key);
});
