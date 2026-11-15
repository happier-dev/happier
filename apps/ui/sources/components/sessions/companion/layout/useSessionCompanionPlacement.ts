import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitComposerChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { isSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';

import { useSessionCompanionPreference } from '../state/useSessionCompanionPreference';
import {
    resolveSessionCompanionPlacement,
    type SessionCompanionPlacement,
} from './resolveSessionCompanionPlacement';
import type { SessionCompanionPreferenceV1 } from '../state/sessionCompanionPreference';
import { useSessionCompanionCardBounds } from './sessionCompanionCardMeasurement';

/**
 * The mounted host's binding to the pure placement resolver.
 *
 * Every geometry fact comes from its incumbent owner: pane layout from the pane
 * scope, bottom/composer chrome from the Cockpit chrome registry, the software
 * keyboard from the canonical keyboard-height hook, safe areas from the platform
 * provider, and text scale from the window. The prototype's optimistic
 * `mainVisible: true` / zero-obstruction / `fontScale: 1` defaults are gone: when
 * geometry is genuinely unknown the resolver collapses to the safe control
 * instead of reserving a rail it cannot prove fits.
 */
type SessionCompanionPlacementOwnerInput = Readonly<{
    sessionId: string | null;
    serverId?: string | null;
    paneScopeId: string;
}>;

/**
 * Exposes the incumbent placement decision for a projected preference without
 * duplicating any pane, keyboard, safe-area or visibility facts. The shell uses
 * this after an acknowledged preference mutation to decide whether the content
 * already revealed as a rail or needs the existing full Companion destination.
 */
export function useResolveSessionCompanionPlacementForDensity(
    input: SessionCompanionPlacementOwnerInput,
    density: SessionCompanionPreferenceV1['density'],
): (preference: SessionCompanionPreferenceV1) => SessionCompanionPlacement {
    const paneLayout = useOptionalAppPaneScopeLayout();
    const pane = useAppPaneScope(input.paneScopeId);
    const { fontScale } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const keyboardHeightPx = useKeyboardHeight();
    const cockpitBottomChromePx = useSessionCockpitBottomChromeHeight();
    const composerChromePx = useSessionCockpitComposerChromeHeight();

    // The card sits inside the Session main region, so everything the incumbent
    // owners already reserve at the bottom is unavailable height for it.
    const bottomObstructionPx = Math.max(
        keyboardHeightPx,
        cockpitBottomChromePx + composerChromePx,
    ) + insets.bottom;

    const scopeState = pane.scopeState;
    // Right/details overlay state is already encoded in `paneLayout.layout`.
    // Bottom presentation is a separate pane-owner decision: only an OPEN bottom
    // overlay is modal. A docked bottom pane reserves main-region height instead.
    const accessibilityModalPaneActive = scopeState?.bottom?.isOpen === true
        && paneLayout?.bottomPresentation === 'overlay';
    const presentedInSidePanel = scopeState?.right?.isOpen === true && scopeState.right.activeTabId === 'companion';
    const mainVisible = input.sessionId !== null
        && isSessionSurfaceVisible(input.sessionId, input.serverId ?? null);

    // The pane host measures this region after the Session header and its top
    // safe-area treatment have already reserved their space. Subtracting the
    // top inset again makes internal and external header modes disagree and can
    // collapse a rail that genuinely fits.
    const hostHeightPx = paneLayout?.mainRegionHeightPx ?? 0;
    const cardBounds = useSessionCompanionCardBounds({
        sessionId: input.sessionId ?? '',
        serverId: input.serverId ?? null,
        paneScopeId: input.paneScopeId,
        density,
        fontScale,
    });

    return React.useCallback((preference: SessionCompanionPreferenceV1) => resolveSessionCompanionPlacement({
        preference,
        paneLayout,
        hostHeightPx,
        bottomObstructionPx,
        mainVisible,
        accessibilityModalPaneActive,
        fontScale,
        cardBounds,
        presentedInSidePanel,
    }), [
        accessibilityModalPaneActive,
        presentedInSidePanel,
        bottomObstructionPx,
        cardBounds,
        fontScale,
        hostHeightPx,
        mainVisible,
        paneLayout,
    ]);
}

export function useResolveSessionCompanionPlacement(
    input: SessionCompanionPlacementOwnerInput,
): (preference: SessionCompanionPreferenceV1) => SessionCompanionPlacement {
    const { preference } = useSessionCompanionPreference({
        sessionId: input.sessionId,
        serverId: input.serverId ?? null,
    });
    return useResolveSessionCompanionPlacementForDensity(input, preference.density);
}

export function useSessionCompanionPlacement(
    input: SessionCompanionPlacementOwnerInput,
): SessionCompanionPlacement {
    const { preference } = useSessionCompanionPreference({
        sessionId: input.sessionId,
        serverId: input.serverId ?? null,
    });
    const resolvePlacement = useResolveSessionCompanionPlacementForDensity(input, preference.density);
    return React.useMemo(
        () => resolvePlacement(preference),
        [preference, resolvePlacement],
    );
}
