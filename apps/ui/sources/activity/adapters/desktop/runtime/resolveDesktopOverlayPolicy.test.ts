import { describe, expect, it } from 'vitest';

import {
    resolveDesktopOverlayPolicy,
    resolveDesktopOverlaySettingsVisibilityState,
} from './resolveDesktopOverlayPolicy';

describe('resolveDesktopOverlayPolicy', () => {
    it('uses conservative desktop defaults when settings are missing', () => {
        const policy = resolveDesktopOverlayPolicy({});

        expect(policy.enabled).toBe(false);
        expect(policy.visibilityMode).toBe('attention_only');
        expect(policy.showWhenRunning).toBe(true);
        expect(policy.showWhenAttentionRequired).toBe(true);
        expect(policy.showWhenReady).toBe(true);
        expect(policy.alwaysOnTop).toBe(true);
        expect(policy.autoHideEnabled).toBe(true);
        expect(policy.autoHideDelayMs).toBe(6000);
        expect(policy).toMatchObject({
            hoverExpandDelayMs: 500,
        });
        expect(policy.expandedBehavior).toBe('click');
        expect(policy.interactiveCollapsed).toBe(true);
        expect(policy.presentationMode).toBe('automatic');
        expect(policy.displayMode).toBe('automatic');
        expect(policy.placementMode).toBe('anchored');
        expect(policy.anchor).toBe('top_center');
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
        expect(policy.showWhenRunning).toBe(false);
        expect(policy.showWhenAttentionRequired).toBe(true);
        expect(policy.showWhenReady).toBe(false);
        expect(policy.alwaysOnTop).toBe(false);
        expect(policy.autoHideEnabled).toBe(false);
        expect(policy.autoHideDelayMs).toBe(10000);
        expect(policy.expandedBehavior).toBe('click');
        expect(policy.interactiveCollapsed).toBe(true);
        expect(policy.presentationMode).toBe('floating_overlay');
        expect(policy.displayMode).toBe('built_in');
        expect(policy.placementMode).toBe('custom');
        expect(policy.anchor).toBe('bottom_right');
        expect(policy.offsetX).toBe(24);
        expect(policy.offsetY).toBe(-16);
        expect(policy.enableDragReposition).toBe(true);
        expect(policy.lockPosition).toBe(false);
        expect(policy.density).toBe('compact');
        expect(policy.compactStyle).toBe('pill');
        expect(policy.showSessionCount).toBe(true);
        expect(policy.collapsedCarouselEnabled).toBe(true);
        expect(policy.showPreviewText).toBe(true);
        expect(policy.clickAction).toBe('expand_overlay');
    });

    it('reads collapsed carousel behavior from canonical desktop overlay device overrides', () => {
        const policy = resolveDesktopOverlayPolicy({
            attentionDeviceOverridesV1: {
                desktopOverlay: {
                    collapsedCarouselEnabled: false,
                },
            },
        });

        expect(policy.collapsedCarouselEnabled).toBe(false);
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

    it('reads and clamps quick reply phrases from canonical desktop overlay device overrides', () => {
        const policy = resolveDesktopOverlayPolicy({
            attentionDeviceOverridesV1: {
                desktopOverlay: {
                    quickReplyPhrases: [' Ship ', 'Explain', '', 'Retry', 'More', 'Stop', 'Ignored'],
                },
            },
        });

        expect(policy.quickReplyPhrases).toEqual(['Ship', 'Explain', 'Retry', 'More', 'Stop', 'Ignored']);
    });

    it('falls back to click when the expanded behavior is invalid', () => {
        const policy = resolveDesktopOverlayPolicy({
            desktopOverlayExpandedBehavior: 'invalid',
        });

        expect(policy.expandedBehavior).toBe('click');
    });

    it('falls back to automatic when the presentation mode is invalid', () => {
        const policy = resolveDesktopOverlayPolicy({
            desktopOverlayPresentationMode: 'invalid',
        });

        expect(policy.presentationMode).toBe('automatic');
    });

    it('ignores stale placement offsets while anchored placement is active', () => {
        const policy = resolveDesktopOverlayPolicy({
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 240,
            desktopOverlayOffsetY: -160,
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
        });

        expect(policy.placementMode).toBe('anchored');
        expect(policy.offsetX).toBe(0);
        expect(policy.offsetY).toBe(0);
    });

    it('hides non-applicable settings rows from the centralized settings visibility resolver', () => {
        const hiddenWhenDisabled = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: false,
            }),
        );
        expect(hiddenWhenDisabled.showOverlayConfiguration).toBe(false);
        expect(hiddenWhenDisabled.showAttentionFilterControls).toBe(false);
        expect(hiddenWhenDisabled.showAutoHideDelay).toBe(false);
        expect(hiddenWhenDisabled.showCustomPlacementControls).toBe(false);
        expect(hiddenWhenDisabled.showFloatingPlacementControls).toBe(false);

        const shownInAttentionOnlyMode = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayVisibilityMode: 'attention_only',
            }),
        );
        expect(shownInAttentionOnlyMode.showAttentionFilterControls).toBe(true);

        const hiddenInActiveSessionsMode = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayVisibilityMode: 'active_sessions',
            }),
        );
        expect(hiddenInActiveSessionsMode.showAttentionFilterControls).toBe(false);

        const hiddenInAlwaysVisibleMode = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayVisibilityMode: 'always_when_enabled',
            }),
        );
        expect(hiddenInAlwaysVisibleMode.showAttentionFilterControls).toBe(false);

        const hiddenWhenNotchIntegrated = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayPresentationMode: 'notch_integrated',
                desktopOverlayPlacementMode: 'custom',
            }),
        );
        expect(hiddenWhenNotchIntegrated.showFloatingPlacementControls).toBe(false);
        expect(hiddenWhenNotchIntegrated.showHostModeFallbackNotice).toBe(false);

        const shownWhenFloatingOverlay = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayPresentationMode: 'floating_overlay',
                desktopOverlayPlacementMode: 'custom',
            }),
        );
        expect(shownWhenFloatingOverlay.showFloatingPlacementControls).toBe(true);
        expect(shownWhenFloatingOverlay.showHostModeFallbackNotice).toBe(false);

        const hiddenWhenResolvedHostModeIsNotchIntegrated = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayPresentationMode: 'floating_overlay',
                desktopOverlayPlacementMode: 'custom',
            }),
            'notch_integrated',
        );
        expect(hiddenWhenResolvedHostModeIsNotchIntegrated.showFloatingPlacementControls).toBe(false);

        const shownWhenResolvedHostModeIsFloating = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayPresentationMode: 'notch_integrated',
                desktopOverlayPlacementMode: 'custom',
            }),
            'floating',
        );
        expect(shownWhenResolvedHostModeIsFloating.showFloatingPlacementControls).toBe(true);
        expect(shownWhenResolvedHostModeIsFloating.showHostModeFallbackNotice).toBe(true);

        const shownWhenAutomaticFallsBackToFloating = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayPresentationMode: 'automatic',
                desktopOverlayPlacementMode: 'custom',
            }),
            'floating',
        );
        expect(shownWhenAutomaticFallsBackToFloating.showFloatingPlacementControls).toBe(true);
        expect(shownWhenAutomaticFallsBackToFloating.showHostModeFallbackNotice).toBe(true);

        const hiddenWhenHostModeIsStillUnknown = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayPresentationMode: 'automatic',
                desktopOverlayPlacementMode: 'custom',
            }),
        );
        expect(hiddenWhenHostModeIsStillUnknown.showFloatingPlacementControls).toBe(false);
        expect(hiddenWhenHostModeIsStillUnknown.showHostModeFallbackNotice).toBe(false);
    });
});
