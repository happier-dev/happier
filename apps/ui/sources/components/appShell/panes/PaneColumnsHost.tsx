import type { DetailsOpenerRegion } from '@/components/ui/panels/paneBreakpoints';
import { PaneRegionProvider } from './paneRegion';
import * as React from 'react';
import { Animated, Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { MultiPaneHostWithBottom } from '@/components/ui/panels/MultiPaneHostWithBottom';
import { resolvePaneLayout, type ResolvePaneLayoutInput, type ResolvedPaneLayout, type PaneArrangement } from '@/components/ui/panels/paneBreakpoints';
import { resolveBottomPaneLayout } from '@/components/ui/panels/resolveBottomPaneLayout';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';
import { getStorage, useLocalSetting } from '@/sync/domains/state/storage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { useDeviceType } from '@/utils/platform/responsive';

import { AppPaneScopeLayoutProvider, type AppPaneScopeLayoutState } from './hooks/useAppPaneScopeLayout';
import { applyMainHiddenLayoutOverride } from './layout/applyMainHiddenLayoutOverride';
import {
    PANE_SIZING_DEFAULTS,
    resolveDockedPaneSizing,
} from './layout/paneSizing';
import { resolveMultiPaneDeviceType } from './layout/resolveMultiPaneDeviceType';
import { useReportSessionCockpitActionRailRect } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { PaneActionRailContext, PANE_ACTION_RAIL_WIDTH, type RightPaneHiddenByDetails } from './PaneActionRailContext';
import { captureArrangementTravelStart, playArrangementTravel, type ArrangementTravelStart } from './arrangement/arrangementTravel';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { RightPanePlacement } from './rightPanePlacement';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { AppShellTailContext, AppShellTailSlot, useAppShellTail } from '@/components/navigation/shell/appShellTail';
import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';

/**
 * The one pane primitive: a main column plus the side columns every destination shares — the
 * right sidebar, the wider details pane, an optional bottom pane and the action rail at the far
 * right. It owns measuring, the docked/overlay decision, widths (with their min/max, the drag and
 * the persisted width of each pane) and the column chrome. What a pane shows, and whether it is
 * open, belongs to the caller: `AppPaneScopeHost` for scoped Session/Project panes,
 * `DetailsPaneHost` for a destination opening its own details.
 */
export type PaneColumnsHostProps = Readonly<{
    main: React.ReactNode;
    /** The rendered right sidebar, or null when it has nothing to show. */
    rightPane?: React.ReactNode | null;
    /** The rendered details pane, or null when it has nothing to show. */
    detailsPane?: React.ReactNode | null;
    bottomPane?: React.ReactNode | null;
    /** The owner's open state. A pane can be open but hidden by the layout (narrow overlay stacks). */
    rightOpen?: boolean;
    /**
     * `main`: the open right pane presents inside the session column, over the transcript and beside
     * the composer (Editor first, lab AR1 EFv). The same mounted pane, laid out over main.
     */
    rightPlacement?: RightPanePlacement;
    detailsOpen?: boolean;
    /** A destination's selected content survives losing the optional side-panel presentation. */
    destinationOwnsDetails?: boolean;
    bottomOpen?: boolean;
    /** The open neighbours take the retained main column's place. */
    mainHidden?: boolean;
    arrangement?: PaneArrangement;
    resolveMainHidden?: (layout: ResolvedPaneLayout) => boolean;
    onSetMainHidden?: (hidden: boolean) => void;
    onMainDrawerControlsChange?: (controls: Readonly<{ open: () => void; close: () => void }> | null) => void;
    emptyEditorPane?: React.ReactNode;
    mainAccessibilityLabel?: string;
    mainOverlayFocusReturnRef?: FocusReturnMutableRef;
    onBeforeMainDrawerOpen?: () => void;
    /** Where Details was last opened from; keeps it off that column when all three cannot dock. */
    detailsOpenedFrom?: DetailsOpenerRegion | null;
    /** The action rail column at the far right, or null for none. */
    actionRail?: React.ReactNode | null;
    /**
     * The main content's own minimum width. It is the threshold at which a widened details pane
     * becomes an overlay and the limit a widened sidebar stops at. Defaults to the canonical
     * main minimum.
     */
    mainMinWidthPx?: number;
    onCloseRight?: () => void;
    onCloseDetails?: () => void;
    onCloseBottom?: () => void;
    rightOverlayFocusReturnRef?: FocusReturnMutableRef;
    detailsOverlayFocusReturnRef?: FocusReturnMutableRef;
    bottomOverlayFocusReturnRef?: FocusReturnMutableRef;
    /** Native capture props for the root that contains a pane opener. */
    rootProps?: Readonly<Record<string, unknown>>;
    /** Installs caller context around main and every pane. Must return the given content once. */
    wrapContent?: (content: React.ReactElement) => React.ReactNode;
    testID?: string;
}>;

const NOOP = () => {};
const EMPTY_EDITOR = <></>;

export const PaneColumnsHost = React.memo(function PaneColumnsHost(props: PaneColumnsHostProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    const { width: windowWidthPx, height: windowHeightPx } = useWindowDimensions();
    const [measuredHostWidthPx, setHostWidthPx] = React.useState<number>(windowWidthPx);
    const [containerHeightPx, setContainerHeightPx] = React.useState<number>(windowHeightPx);
    const hostRef = React.useRef<View | null>(null);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        // The DOM adapter supplies the measured host before its first painted clamp.
        const rect = (hostRef.current as unknown as HTMLElement | null)?.getBoundingClientRect?.();
        if (rect && rect.width > 0) setHostWidthPx(Math.round(rect.width));
        if (rect && rect.height > 0) setContainerHeightPx(Math.round(rect.height));
    }, []);
    const [rightDragWidthPx, setRightDragWidthPx] = React.useState<number | null>(null);
    const [detailsDragWidthPx, setDetailsDragWidthPx] = React.useState<number | null>(null);
    const [bottomDragHeightPx, setBottomDragHeightPx] = React.useState<number | null>(null);
    // `useLocalSetting` may return `undefined` transiently during hydration. Treat the setting as
    // enabled unless it has been explicitly disabled to avoid hiding panes on initial load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;

    const arrangement = props.arrangement === 'editor' && multiPaneEnabled && multiPaneDeviceType !== 'phone' ? 'editor' : 'session';
    const mirrored = arrangement === 'editor';
    // The shell's tail (calm-shell R4-2, R11-1): this page's rail stands there, on the canvas beside the page
    // sheet, and with the `canvas` placement its docked right column too; only for the one page on screen at
    // the trailing edge (not Editor first, not one pane of a split). The layout keeps budgeting the
    // width the sheet has when the tail is empty, so every placement resolves the same columns.
    const shellTail = useAppShellTail();
    const workspace = useOptionalWorkspaceNavigation();
    const destinationFocused = useDestinationFocus();
    const soleScope = !workspace?.active || workspace.state.maximizedGroupId !== null || workspace.state.root.kind === 'leaf';
    const railTail = shellTail?.railOnCanvas === true && Platform.OS === 'web' && !mirrored && soleScope ? shellTail : null;
    const canvasTail = railTail?.placement === 'canvas' ? railTail : null;
    const hostWidthPx = railTail?.containerWidthPx ?? measuredHostWidthPx;
    const rightTail = React.useMemo(() => (canvasTail ? { host: canvasTail.rightHost, hidden: !destinationFocused } : undefined),
        [canvasTail, destinationFocused]);
    // The swap travels (lab FL): read the columns where they are before the new order commits, then
    // slide each from there once it has.
    const reducedMotion = useReducedMotionPreference();
    const committedArrangementRef = React.useRef(arrangement);
    const travelStartRef = React.useRef<ArrangementTravelStart | null>(null);
    if (Platform.OS === 'web' && committedArrangementRef.current !== arrangement && travelStartRef.current === null) {
        travelStartRef.current = captureArrangementTravelStart(hostRef.current);
    }
    // Native has no DOM planes to travel: the sheet cross-fades instead, the web's reduced-motion form
    // (opacity only, on the native driver), so the swap still reads as one change.
    const nativeSheetOpacity = React.useRef(new Animated.Value(1)).current;
    React.useLayoutEffect(() => {
        const previous = committedArrangementRef.current;
        committedArrangementRef.current = arrangement;
        const start = travelStartRef.current;
        travelStartRef.current = null;
        if (start) playArrangementTravel(hostRef.current, start, reducedMotion);
        if (Platform.OS === 'web' || previous === arrangement) return;
        nativeSheetOpacity.setValue(0.4);
        const fade = Animated.timing(nativeSheetOpacity, {
            toValue: 1,
            duration: motionTokens.overlay.panel.reducedMotionFadeMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: true,
        });
        fade.start();
        return () => fade.stop();
    }, [arrangement, nativeSheetOpacity, reducedMotion]);
    const [mainDrawerOpen, setMainDrawerOpen] = React.useState(false);
    const mainDrawerOpenRef = React.useRef(mainDrawerOpen);
    mainDrawerOpenRef.current = mainDrawerOpen;
    const beforeMainDrawerOpenRef = React.useRef(props.onBeforeMainDrawerOpen);
    beforeMainDrawerOpenRef.current = props.onBeforeMainDrawerOpen;
    const [sessionDragWidthPx, setSessionDragWidthPx] = React.useState<number | null>(null);
    const sessionColumnWidthPx = useLocalSetting('sessionColumnWidthPx');
    const mainPresentationRef = React.useRef<'docked' | 'overlay'>('docked');
    const drawerControls = React.useMemo(() => ({ open: () => {
        if (mainPresentationRef.current !== 'overlay' || mainDrawerOpenRef.current) return;
        beforeMainDrawerOpenRef.current?.();
        mainDrawerOpenRef.current = true;
        setMainDrawerOpen(true);
    }, close: () => { mainDrawerOpenRef.current = false; setMainDrawerOpen(false); } }), []);
    React.useLayoutEffect(() => { if (!mirrored) drawerControls.close(); }, [drawerControls, mirrored]);
    React.useEffect(() => { props.onMainDrawerControlsChange?.(drawerControls); return () => props.onMainDrawerControlsChange?.(null); }, [drawerControls, props.onMainDrawerControlsChange]);
    const rightPaneWidthPx = useLocalSetting('rightPaneWidthPx');
    const detailsPaneWidthPx = useLocalSetting('detailsPaneWidthPx');
    const bottomPaneHeightPx = useLocalSetting('bottomPaneHeightPx');

    const rightPane = props.rightPane ?? null;
    const detailsPane = props.detailsPane ?? (mirrored ? props.emptyEditorPane ?? EMPTY_EDITOR : null);
    const bottomPane = props.bottomPane ?? null;
    // A pane presented over the session column takes no column of its own.
    const rightInMain = props.rightPlacement === 'main' && mirrored && rightPane !== null;
    const rightOpen = (props.rightOpen ?? rightPane !== null) && !rightInMain;
    const detailsOpen = mirrored || (props.detailsOpen ?? detailsPane !== null);
    const bottomOpen = props.bottomOpen ?? bottomPane !== null;
    const requestedMainHidden = props.mainHidden === true && (rightOpen || detailsOpen);
    // Resolve the optional rail's layout first; destination-only content takes the whole host.
    const [railReportsVacant, setRailVacant] = React.useState(false);
    // The column goes only where the rail's More has another home, so its panels and Customize stay reachable.
    const railVacant = railReportsVacant && railTail?.railMoreHost != null;
    const panelContainerWidthPx = Math.max(0, hostWidthPx - (props.actionRail != null && !railVacant ? PANE_ACTION_RAIL_WIDTH : 0));
    const mainMinPx = requestedMainHidden ? 0 : (props.mainMinWidthPx ?? PANE_SIZING_DEFAULTS.mainMinPx);
    // With both side panes docked the canonical main column may run a little narrower; a caller's
    // own minimum is the content's real floor and holds in every layout.
    const mainMinPxThreePane = requestedMainHidden
        ? 0
        : (props.mainMinWidthPx ?? PANE_SIZING_DEFAULTS.mainMinThreePanePx);
    const right = PANE_SIZING_DEFAULTS.right;
    const details = PANE_SIZING_DEFAULTS.details;

    const storedEffectiveRightDockWidthPx = Math.max(right.minPx, rightPaneWidthPx ?? right.defaultPx);
    const storedEffectiveDetailsDockWidthPx = Math.max(details.minPx, detailsPaneWidthPx ?? details.minPx);
    const effectiveRightDockWidthPx = rightDragWidthPx ?? storedEffectiveRightDockWidthPx;
    const effectiveDetailsDockWidthPx = detailsDragWidthPx ?? storedEffectiveDetailsDockWidthPx;
    const rightPreferredPxForLayout = effectiveRightDockWidthPx;
    const detailsPreferredPxForLayout = effectiveDetailsDockWidthPx;
    const bottomPreferredPxForLayout = bottomDragHeightPx ?? Math.max(PANE_SIZING_DEFAULTS.bottom.minPx, bottomPaneHeightPx ?? PANE_SIZING_DEFAULTS.bottom.minPx);
    const resolvedBottomLayout = resolveBottomPaneLayout({
        containerHeightPx,
        mainMinHeightPx: PANE_SIZING_DEFAULTS.mainMinPx,
        bottomMinHeightPx: PANE_SIZING_DEFAULTS.bottom.minPx,
        preferredHeightPx: bottomPreferredPxForLayout,
    });
    // A pane that opts into the overlay-at-threshold behavior becomes an overlay once its preferred
    // width (stored or mid-drag) would leave the main content narrower than its minimum. A pane
    // that does not opt in stays docked and is clamped at that budget instead.
    const singlePaneBudgetMaxPx = React.useMemo(() => {
        const clamp = (value: number, minPx: number, maxPx: number) => Math.min(maxPx, Math.max(minPx, value));
        return {
            rightMax: clamp(panelContainerWidthPx - mainMinPx, right.minPx, right.maxPx),
            detailsMax: clamp(panelContainerWidthPx - mainMinPx, details.minPx, details.maxPx),
        };
    }, [panelContainerWidthPx, details.maxPx, details.minPx, mainMinPx, right.maxPx, right.minPx]);
    const rightPrefersOverlay = right.overlayWhenWiderThanBudget
        && (rightDragWidthPx != null || storedEffectiveRightDockWidthPx > singlePaneBudgetMaxPx.rightMax + 1);
    const detailsPrefersOverlay = details.overlayWhenWiderThanBudget
        && (detailsDragWidthPx != null || storedEffectiveDetailsDockWidthPx > singlePaneBudgetMaxPx.detailsMax + 1);

    const paneLayoutInput = {
        arrangement,
        sessionWidthPx: sessionDragWidthPx ?? sessionColumnWidthPx ?? PANE_SIZING_DEFAULTS.session.defaultPx,
        containerWidthPx: panelContainerWidthPx,
        deviceType: multiPaneDeviceType,
        multiPaneEnabled,
        rightOpen,
        detailsOpen,
        destinationOwnsDetails: props.destinationOwnsDetails,
        rightPreferOverlayWhenPreferredDoesNotFit: rightPrefersOverlay,
        detailsPreferOverlayWhenPreferredDoesNotFit: detailsPrefersOverlay,
        detailsOpenedFrom: props.detailsOpenedFrom ?? null,
        mainMinPx,
        mainMinPxThreePane,
        rightMinPx: right.minPx,
        detailsMinPx: details.minPx,
        rightPreferredPx: rightPreferredPxForLayout,
        detailsPreferredPx: detailsPreferredPxForLayout,
    } satisfies ResolvePaneLayoutInput;
    const baseLayout = resolvePaneLayout(paneLayoutInput);
    mainPresentationRef.current = baseLayout.main;
    const destinationDetailOnly = baseLayout.kind === 'single' && baseLayout.details === 'overlay';
    const mainHidden = (props.resolveMainHidden?.(baseLayout) ?? requestedMainHidden) && !destinationDetailOnly;
    const { kind, main: mainPresentation, right: rightPresentation, details: detailsPresentation } = applyMainHiddenLayoutOverride({
        arrangement,
        mainHidden,
        rightOpen,
        detailsOpen,
        baseLayout,
    });
    // Page content changes independently of pane geometry. Publish the same
    // resolved layout to the pane hosts and context until its three facts change.
    const resolvedLayout = React.useMemo(() => ({
        kind,
        main: mainPresentation,
        right: rightPresentation,
        details: detailsPresentation,
    }), [detailsPresentation, kind, mainPresentation, rightPresentation]);
    // The rail stays mounted while vacant, so it can say when it has an action again; only its column goes.
    const mountActionRail = props.actionRail != null && !destinationDetailOnly;
    const showActionRail = mountActionRail && !railVacant;
    // A floating companion (the Voice Orb) keeps clear of the rail: its window rectangle is published.
    const railColumnRef = React.useRef<View | null>(null);
    const reportRailRectValue = useReportSessionCockpitActionRailRect(showActionRail);
    const reportRailRect = React.useCallback(() => {
        railColumnRef.current?.measureInWindow((x, y, width, height) => {
            reportRailRectValue(width > 0 && height > 0 ? { x, y, width, height } : null);
        });
    }, [reportRailRectValue]);
    const containerWidthPx = destinationDetailOnly ? Math.max(0, hostWidthPx) : panelContainerWidthPx;
    const effectiveBottomPresentation = destinationDetailOnly ? 'hidden' : resolvedBottomLayout.presentation;

    const bottomStoredMaxHeightPxForSizing =
        effectiveBottomPresentation === 'docked'
            ? resolvedBottomLayout.dockMaxHeightPx
            : resolvedBottomLayout.overlayMaxHeightPx;
    const storedEffectiveBottomDockHeightPx = Math.min(bottomStoredMaxHeightPxForSizing, Math.max(PANE_SIZING_DEFAULTS.bottom.minPx, bottomPaneHeightPx ?? PANE_SIZING_DEFAULTS.bottom.minPx));
    const effectiveBottomDockHeightPx = bottomDragHeightPx ?? storedEffectiveBottomDockHeightPx;
    const mainRegionHeightPx = Math.max(
        0,
        containerHeightPx - (
            bottomOpen && Boolean(bottomPane) && effectiveBottomPresentation === 'docked'
                ? effectiveBottomDockHeightPx
                : 0
        ),
    );
    const bottomResizeMaxHeightPx =
        bottomDragHeightPx != null
            ? resolvedBottomLayout.overlayMaxHeightPx
            : bottomStoredMaxHeightPxForSizing;

    // NOTE: When both panes are open on narrow widths, `resolvePaneLayout` can return `overlayStack`
    // with `right: 'hidden'` + `details: 'overlay'`. We intentionally keep the right pane "open"
    // in state (but hidden by layout) so that closing details returns the user back to the right
    // pane on small screens.

    const dockSizing = resolveDockedPaneSizing({
        arrangement,
        sessionWidthPx: sessionDragWidthPx ?? sessionColumnWidthPx ?? PANE_SIZING_DEFAULTS.session.defaultPx,
        mainDocked: !mainHidden && resolvedLayout.main === 'docked',
        containerWidthPx,
        mainMinPx,
        rightMinPx: right.minPx,
        detailsMinPx: details.minPx,
        rightWidthPx: effectiveRightDockWidthPx,
        detailsWidthPx: effectiveDetailsDockWidthPx,
        rightGlobalMinPx: right.minPx,
        rightGlobalMaxPx: right.maxPx,
        detailsGlobalMinPx: details.minPx,
        detailsGlobalMaxPx: details.maxPx,
        rightDocked: resolvedLayout.right === 'docked' && Boolean(rightPane),
        detailsDocked: resolvedLayout.details === 'docked' && Boolean(detailsPane),
    });

    const mainRegionWidthPx = mirrored ? (resolvedLayout.main === 'overlay' ? Math.min(PANE_SIZING_DEFAULTS.mainMinPx, containerWidthPx * 0.9) : dockSizing.mainWidthPx ?? 0) : Math.max(
        0,
        containerWidthPx
            - (resolvedLayout.right === 'docked' && Boolean(rightPane) ? dockSizing.rightWidthPx : 0)
            - (resolvedLayout.details === 'docked' && Boolean(detailsPane) ? dockSizing.detailsWidthPx : 0),
    );

    const baseSizing = React.useMemo(() => {
        const overlayRegionWidthPx = mirrored ? dockSizing.detailsWidthPx : mainRegionWidthPx;
        const prefersFullScreenOverlay = deviceType === 'phone';
        const clampOverlayWidth = (value: number, minPx: number) => {
            if (destinationDetailOnly) return containerWidthPx;
            if (prefersFullScreenOverlay) return Math.max(minPx, overlayRegionWidthPx);
            if (!Number.isFinite(value)) return minPx;
            return Math.min(overlayRegionWidthPx, Math.max(minPx, value));
        };
        const rightWidthPx = resolvedLayout.right === 'docked'
            ? dockSizing.rightWidthPx
            : resolvedLayout.right === 'overlay'
                ? clampOverlayWidth(rightPreferredPxForLayout, right.minPx)
                : 0;
        const detailsWidthPx = resolvedLayout.details === 'docked'
            ? dockSizing.detailsWidthPx
            : resolvedLayout.details === 'overlay'
                ? clampOverlayWidth(detailsPreferredPxForLayout, details.minPx)
                : 0;
        const rightMaxWidthPx = resolvedLayout.right === 'docked'
            ? dockSizing.rightMaxWidthPx
            : resolvedLayout.right === 'overlay'
                ? Math.max(right.minPx, overlayRegionWidthPx)
                : right.maxPx;
        const detailsMaxWidthPx = resolvedLayout.details === 'docked'
            ? dockSizing.detailsMaxWidthPx
            : resolvedLayout.details === 'overlay'
                ? Math.max(details.minPx, overlayRegionWidthPx)
                : details.maxPx;
        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx };
    }, [
        deviceType,
        mirrored,
        destinationDetailOnly,
        containerWidthPx,
        details.maxPx,
        details.minPx,
        detailsPreferredPxForLayout,
        dockSizing.detailsMaxWidthPx,
        dockSizing.detailsWidthPx,
        dockSizing.rightMaxWidthPx,
        dockSizing.rightWidthPx,
        mainRegionWidthPx,
        resolvedLayout.details,
        resolvedLayout.right,
        right.maxPx,
        right.minPx,
        rightPreferredPxForLayout,
    ]);

    const effectivePaneSizing = React.useMemo(() => {
        let rightWidthPx = baseSizing.rightWidthPx;
        let detailsWidthPx = baseSizing.detailsWidthPx;
        let rightMaxWidthPx = baseSizing.rightMaxWidthPx;
        let detailsMaxWidthPx = baseSizing.detailsMaxWidthPx;
        let rightMinWidthPx: number | undefined = undefined;
        let detailsMinWidthPx: number | undefined = undefined;

        // A docked pane never grows past its budget, even mid-drag: widening it past that point is
        // the overlay decision (see `onDragDetailsDockWidthPx`), never a wider docked column that
        // would crowd the columns around this host. An overlay can be resized up to the available
        // main-region width.
        const overlayMainRegionWidthPx = Math.max(
            0,
            containerWidthPx
                - (resolvedLayout.right === 'docked' ? rightWidthPx : 0)
                - (resolvedLayout.details === 'docked' ? detailsWidthPx : 0),
        );
        if (resolvedLayout.details === 'overlay') {
            detailsMaxWidthPx = Math.max(detailsMaxWidthPx, overlayMainRegionWidthPx);
        }
        if (resolvedLayout.right === 'overlay') {
            rightMaxWidthPx = Math.max(rightMaxWidthPx, overlayMainRegionWidthPx);
        }

        if (mainHidden && !mirrored) {
            const rightDocked = Boolean(rightPane) && resolvedLayout.right === 'docked';
            const detailsPresent = Boolean(detailsPane) && resolvedLayout.details !== 'hidden';
            const rightPresent = Boolean(rightPane) && resolvedLayout.right !== 'hidden';
            if (detailsPresent) {
                // With main hidden, stretch the visible details pane to avoid empty space
                // to the maximum available width (including widths above the default global max).
                const available = Math.max(details.minPx, containerWidthPx - (rightDocked ? rightWidthPx : 0));
                detailsWidthPx = available;
                detailsMaxWidthPx = available;
                detailsMinWidthPx = available;
            } else if (rightPresent) {
                const available = Math.max(right.minPx, containerWidthPx);
                rightWidthPx = available;
                rightMaxWidthPx = available;
                rightMinWidthPx = available;
            }
        }
        if (destinationDetailOnly) {
            detailsWidthPx = containerWidthPx;
            detailsMinWidthPx = containerWidthPx;
            detailsMaxWidthPx = containerWidthPx;
        }
        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx, rightMinWidthPx, detailsMinWidthPx };
    }, [
        baseSizing.detailsMaxWidthPx,
        baseSizing.detailsWidthPx,
        baseSizing.rightMaxWidthPx,
        baseSizing.rightWidthPx,
        containerWidthPx,
        details.minPx,
        detailsPane,
        destinationDetailOnly,
        mainHidden,
        mirrored,
        resolvedLayout.details,
        resolvedLayout.right,
        right.minPx,
        rightPane,
    ]);

    const onCommitRightDockWidthPx = React.useCallback((nextWidthPx: number) => {
        getStorage().getState().applyLocalSettings({ rightPaneWidthPx: nextWidthPx }, { source: 'ui' });
    }, [containerWidthPx]);
    const onCommitDetailsDockWidthPx = React.useCallback((nextWidthPx: number) => {
        getStorage().getState().applyLocalSettings({ detailsPaneWidthPx: nextWidthPx }, { source: 'ui' });
    }, [containerWidthPx]);
    // The docked budget is what main's minimum leaves (minus a docked neighbour). A pull past it
    // (`exceededMaxPx`) carries the attempted width, which is what flips the layout to an overlay for a
    // pane that opts in; the docked handle then unmounts mid-drag, so the pulled width is kept.
    const detailsDockBudgetRef = React.useRef({ budgetPx: 0, docked: false });
    detailsDockBudgetRef.current = {
        budgetPx: Math.max(
            details.minPx,
            containerWidthPx - mainMinPx - (resolvedLayout.right === 'docked' && rightPane ? effectivePaneSizing.rightWidthPx : 0),
        ),
        docked: resolvedLayout.details === 'docked',
    };
    const lastDetailsDragWidthRef = React.useRef<number | null>(null);
    const onDragDetailsDockWidthPx = React.useCallback((
        nextWidthPx: number | null,
        meta?: Readonly<{ attemptedSizePx: number; exceededMaxPx: boolean }> | null,
    ) => {
        if (nextWidthPx == null) {
            const pulled = lastDetailsDragWidthRef.current;
            lastDetailsDragWidthRef.current = null;
            setDetailsDragWidthPx(null);
            if (pulled != null && pulled > detailsDockBudgetRef.current.budgetPx + 1) onCommitDetailsDockWidthPx(pulled);
            return;
        }
        const width = details.overlayWhenWiderThanBudget && detailsDockBudgetRef.current.docked && meta?.exceededMaxPx === true
            ? meta.attemptedSizePx
            : nextWidthPx;
        lastDetailsDragWidthRef.current = width;
        setDetailsDragWidthPx(width);
    }, [details.overlayWhenWiderThanBudget, onCommitDetailsDockWidthPx]);
    const onCommitBottomDockHeightPx = React.useCallback((nextHeightPx: number) => {
        getStorage().getState().applyLocalSettings({ bottomPaneHeightPx: nextHeightPx }, { source: 'ui' });
    }, [containerHeightPx]);
    const onResetRightDockWidthPx = React.useCallback(() => {
        getStorage().getState().applyLocalSettings({ rightPaneWidthPx: localSettingsDefaults.rightPaneWidthPx }, { source: 'ui' });
    }, []);
    const onResetDetailsDockWidthPx = React.useCallback(() => {
        getStorage().getState().applyLocalSettings({ detailsPaneWidthPx: localSettingsDefaults.detailsPaneWidthPx }, { source: 'ui' });
    }, []);
    const onResetMainDockWidthPx = React.useCallback(() => {
        getStorage().getState().applyLocalSettings({ sessionColumnWidthPx: localSettingsDefaults.sessionColumnWidthPx }, { source: 'ui' });
    }, []);
    const onResetBottomDockHeightPx = React.useCallback(() => {
        getStorage().getState().applyLocalSettings({ bottomPaneHeightPx: localSettingsDefaults.bottomPaneHeightPx }, { source: 'ui' });
    }, []);
    const onCommitMainDockWidthPx = React.useCallback((widthPx: number) => {
        getStorage().getState().applyLocalSettings({ sessionColumnWidthPx: widthPx }, { source: 'ui' });
    }, []);
    const onCloseMain = React.useCallback(() => {
        drawerControls.close(); props.onSetMainHidden?.(true);
    }, [drawerControls, props.onSetMainHidden]);

    // Opening the side column unfolds one that Details opened from main folded (`appPaneReducer`), so
    // the rail asks the layout without that opener before deciding whether Details must go.
    const rightHiddenWithDetails = (input: ResolvePaneLayoutInput) => applyMainHiddenLayoutOverride({
        arrangement,
        mainHidden,
        rightOpen: true,
        detailsOpen,
        baseLayout: resolvePaneLayout({ ...input, rightOpen: true }),
    }).right === 'hidden';
    const rightPaneHiddenByDetails: RightPaneHiddenByDetails = !detailsOpen || !rightHiddenWithDetails(paneLayoutInput)
        ? false
        : paneLayoutInput.detailsOpenedFrom === 'main' && !rightHiddenWithDetails({ ...paneLayoutInput, detailsOpenedFrom: null })
            ? 'folded'
            : true;
    const railOnCanvas = railTail !== null;
    const panelAttached = railOnCanvas && rightOpen && rightPresentation === 'docked';
    const panelJoinsPage = railOnCanvas && canvasTail === null;
    const [panelTabAtTop, setPanelTabAtTop] = React.useState(false);
    // A joined panel's tab at the rail's top continues the page sheet's top edge: the frame squares that corner.
    const joinTrailingTopCorner = railTail?.joinTrailingTopCorner;
    const pageJoinsTopTab = panelJoinsPage && panelAttached && panelTabAtTop;
    React.useLayoutEffect(() => {
        if (!joinTrailingTopCorner) return;
        joinTrailingTopCorner(pageJoinsTopTab);
        return () => joinTrailingTopCorner(false);
    }, [joinTrailingTopCorner, pageJoinsTopTab]);
    const railContext = React.useMemo(() => ({
        visible: showActionRail,
        mirrored,
        onCanvas: railOnCanvas,
        panelAttached,
        onPanelTabAtTop: setPanelTabAtTop,
        onVacantChange: setRailVacant,
        vacantMoreHost: railVacant && destinationFocused ? railTail?.railMoreHost ?? null : null,
        contentWidthPx: containerWidthPx,
        rightPaneHiddenByDetails,
    }), [showActionRail, mirrored, railOnCanvas, panelAttached, containerWidthPx, rightPaneHiddenByDetails, railVacant, destinationFocused, railTail?.railMoreHost]);
    const detailsAvailable = resolvePaneLayout({ ...paneLayoutInput, rightOpen: true, detailsOpen: true }).details === 'docked';
    const layoutContext = React.useMemo<AppPaneScopeLayoutState>(() => ({
        arrangement, mainHidden, mainDrawerOpen, effectiveDetailsOpen: detailsOpen,
        detailsAvailable,
        containerWidthPx,
        containerHeightPx,
        mainRegionWidthPx,
        mainRegionHeightPx,
        multiPaneEnabled,
        deviceType: multiPaneDeviceType,
        layout: resolvedLayout,
        bottomPresentation: effectiveBottomPresentation,
    }), [
        arrangement, mainHidden, mainDrawerOpen, detailsOpen, detailsAvailable,
        containerHeightPx,
        containerWidthPx,
        mainRegionHeightPx,
        mainRegionWidthPx,
        multiPaneDeviceType,
        multiPaneEnabled,
        effectiveBottomPresentation,
        resolvedLayout,
    ]);

    // Each column tells what it opens where it was opened from (Details' opener rule). Memoized on
    // the caller's nodes so the columns keep their identity between renders.
    const regionMain = React.useMemo(
        () => <PaneRegionProvider region="main">{props.main}</PaneRegionProvider>,
        [props.main],
    );
    const regionRightPane = React.useMemo(
        () => (rightPane ? <PaneRegionProvider region={rightInMain ? 'main' : 'side'}>{rightPane}</PaneRegionProvider> : null),
        [rightInMain, rightPane],
    );
    const regionDetailsPane = React.useMemo(
        () => (detailsPane ? <PaneRegionProvider region="details">{detailsPane}</PaneRegionProvider> : null),
        [detailsPane],
    );

    const columnsContent = (
        <>
            <MultiPaneHostWithBottom
                main={regionMain}
                hideMain={mainHidden || (resolvedLayout.main === 'overlay' && !mainDrawerOpen)}
                mirrored={mirrored}
                detailsClosable={!mirrored}
                mainDrawerOpen={mainDrawerOpen}
                mainAccessibilityLabel={props.mainAccessibilityLabel}
                mainOverlayFocusReturnRef={props.mainOverlayFocusReturnRef}
                mainDockWidthPx={mainRegionWidthPx}
                mainDockMaxWidthPx={dockSizing.mainMaxWidthPx}
                onCommitMainDockWidthPx={onCommitMainDockWidthPx}
                onDragMainDockWidthPx={setSessionDragWidthPx}
                onResetMainDockWidthPx={onResetMainDockWidthPx}
                onResetRightDockWidthPx={onResetRightDockWidthPx}
                onResetDetailsDockWidthPx={onResetDetailsDockWidthPx}
                onResetBottomDockHeightPx={onResetBottomDockHeightPx}
                onCloseMain={onCloseMain}
                rightPane={regionRightPane}
                rightInMain={rightInMain}
                detailsPane={regionDetailsPane}
                // A drawer beside the docked side column only quiets main (lab FB1), however Details was opened
                // (the side list, a cold file link); a drawer alone over main shades it.
                detailsScrim={!mirrored && resolvedLayout.right === 'docked' ? 'soft' : 'standard'}
                layout={resolvedLayout}
                rightDockWidthPx={effectivePaneSizing.rightWidthPx}
                detailsDockWidthPx={effectivePaneSizing.detailsWidthPx}
                rightDockMinWidthPx={effectivePaneSizing.rightMinWidthPx}
                detailsDockMinWidthPx={mirrored ? effectivePaneSizing.detailsWidthPx : effectivePaneSizing.detailsMinWidthPx}
                rightDockMaxWidthPx={effectivePaneSizing.rightMaxWidthPx}
                detailsDockMaxWidthPx={effectivePaneSizing.detailsMaxWidthPx}
                onCloseRight={props.onCloseRight ?? NOOP}
                onCloseDetails={props.onCloseDetails ?? NOOP}
                onCommitRightDockWidthPx={onCommitRightDockWidthPx}
                onCommitDetailsDockWidthPx={onCommitDetailsDockWidthPx}
                onDragRightDockWidthPx={setRightDragWidthPx}
                onDragDetailsDockWidthPx={onDragDetailsDockWidthPx}
                bottomPane={bottomPane}
                bottomPresentation={effectiveBottomPresentation}
                bottomDockHeightPx={effectiveBottomDockHeightPx}
                bottomDockMinHeightPx={PANE_SIZING_DEFAULTS.bottom.minPx}
                bottomDockMaxHeightPx={bottomResizeMaxHeightPx}
                onCloseBottom={props.onCloseBottom ?? NOOP}
                onCommitBottomDockHeightPx={onCommitBottomDockHeightPx}
                onDragBottomDockHeightPx={setBottomDragHeightPx}
                rightOverlayFocusReturnRef={props.rightOverlayFocusReturnRef}
                detailsOverlayFocusReturnRef={props.detailsOverlayFocusReturnRef}
                rightTail={rightTail}
                bottomOverlayFocusReturnRef={props.bottomOverlayFocusReturnRef}
            />
            {mountActionRail ? (
                <RailTailSlot tail={railTail ? { hidden: !destinationFocused } : undefined} host={railTail?.railHost ?? null}>
                <View
                    ref={railColumnRef}
                    testID="pane-action-rail-column"
                    onLayout={reportRailRect}
                    // With its panel open the rail stands above the page's seam: the page never casts onto the tab.
                    style={[styles.railColumn, panelAttached ? styles.railColumnAttached : null, railVacant ? styles.railColumnVacant : null]}
                >
                    {/* On the canvas the rail paints nothing of its own: it coats the canvas around its panel's tab
                        (R11-1/R11-2). Inside a page (native, Editor first, a split pane) the rail and its side column are
                        one surface (OR-2): it takes the column's material, so a page's atmosphere (a Project's planet and
                        band) stays on the page and never shows through the rail. */}
                    {railTail ? null : <GlassSurface surfaceGroup="content" solidColor={theme.colors.surface.base}
                        finishRole={null} nested style={StyleSheet.absoluteFillObject} children={null} />}
                    {/* One parent in every placement, so a placement change never remounts the rail. */}
                    <View style={styles.railSurface}>
                        <PaneRegionProvider region="main">{props.actionRail}</PaneRegionProvider>
                    </View>
                </View>
                </RailTailSlot>
            ) : null}
        </>
    );
    const columns = Platform.OS === 'web' ? columnsContent : (
        <Animated.View style={[styles.root, mirrored ? { flexDirection: 'row-reverse' } : null, { opacity: nativeSheetOpacity }]}>
            {columnsContent}
        </Animated.View>
    );

    return (
        <PaneActionRailContext.Provider value={railContext}>
            <View
                testID={props.testID}
                style={[styles.root, mirrored ? { flexDirection: 'row-reverse' } : null]}
                {...props.rootProps}
                ref={hostRef}
                onLayout={(event) => {
                    const next = Math.round(event?.nativeEvent?.layout?.width ?? 0);
                    if (Number.isFinite(next) && next > 0) {
                        setHostWidthPx((prev) => (Math.abs(prev - next) > 1 ? next : prev));
                    }
                    const nextHeight = Math.round(event?.nativeEvent?.layout?.height ?? 0);
                    if (Number.isFinite(nextHeight) && nextHeight > 0) {
                        setContainerHeightPx((prev) => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev));
                    }
                }}
            >
                <AppPaneScopeLayoutProvider value={layoutContext}>
                    {/* One page takes the shell's tail; a pane host nested inside it never does. */}
                    <AppShellTailContext.Provider value={null}>
                        {props.wrapContent ? props.wrapContent(columns) : columns}
                    </AppShellTailContext.Provider>
                </AppPaneScopeLayoutProvider>
            </View>
        </PaneActionRailContext.Provider>
    );
});

function RailTailSlot(props: Readonly<{
    tail: Readonly<{ hidden: boolean }> | undefined;
    host: HTMLElement | null;
    children: React.ReactElement;
}>): React.ReactNode {
    return <AppShellTailSlot host={props.host} hidden={props.tail?.hidden}>{props.children}</AppShellTailSlot>;
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'row',
    },
    // The rail is its own full-height column: one hairline against the column before it, the
    // same paper as the rest of the sheet.
    railColumn: {
        // Exactly the width the layout budgets for the rail; its hairline is drawn inside it.
        width: PANE_ACTION_RAIL_WIDTH,
        overflow: 'hidden',
        flexShrink: 0,
        alignSelf: 'stretch',
    },
    railColumnAttached: { zIndex: 3 },
    railColumnVacant: { display: 'none' },
    railSurface: { flex: 1, minHeight: 0 },
}));
