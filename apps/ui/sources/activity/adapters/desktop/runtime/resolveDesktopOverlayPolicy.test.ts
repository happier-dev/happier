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
        expect(policy.expandedBehavior).toBe('click');
        expect(policy.interactiveCollapsed).toBe(true);
        expect(policy.presentationMode).toBe('automatic');
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
        expect(policy.expandedBehavior).toBe('hover');
        expect(policy.interactiveCollapsed).toBe(false);
        expect(policy.presentationMode).toBe('floating_overlay');
        expect(policy.placementMode).toBe('custom');
        expect(policy.anchor).toBe('bottom_right');
        expect(policy.offsetX).toBe(24);
        expect(policy.offsetY).toBe(-16);
        expect(policy.enableDragReposition).toBe(true);
        expect(policy.lockPosition).toBe(false);
        expect(policy.density).toBe('comfortable');
        expect(policy.compactStyle).toBe('panel');
        expect(policy.showSessionCount).toBe(false);
        expect(policy.showPreviewText).toBe(true);
        expect(policy.clickAction).toBe('open_primary_session');
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
        expect(hiddenWhenDisabled.showAutoHideDelay).toBe(false);
        expect(hiddenWhenDisabled.showCollapsedClickAction).toBe(false);
        expect(hiddenWhenDisabled.showExpandedBehavior).toBe(false);
        expect(hiddenWhenDisabled.showCustomPlacementControls).toBe(false);
        expect(hiddenWhenDisabled.showFloatingPlacementControls).toBe(false);

        const hiddenWhenCollapsedInteractionIsOff = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayInteractiveCollapsed: false,
                desktopOverlayClickAction: 'expand_overlay',
            }),
        );
        expect(hiddenWhenCollapsedInteractionIsOff.showCollapsedClickAction).toBe(false);
        expect(hiddenWhenCollapsedInteractionIsOff.showExpandedBehavior).toBe(false);

        const hiddenWhenClickDoesNotExpand = resolveDesktopOverlaySettingsVisibilityState(
            resolveDesktopOverlayPolicy({
                desktopOverlayEnabled: true,
                desktopOverlayInteractiveCollapsed: true,
                desktopOverlayClickAction: 'open_sessions',
            }),
        );
        expect(hiddenWhenClickDoesNotExpand.showCollapsedClickAction).toBe(true);
        expect(hiddenWhenClickDoesNotExpand.showExpandedBehavior).toBe(false);

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
