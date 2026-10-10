import type { DetailsOpenerRegion } from '@/components/ui/panels/paneBreakpoints';
import { PaneRegionProvider } from './paneRegion';
import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { MultiPaneHostWithBottom } from '@/components/ui/panels/MultiPaneHostWithBottom';
import { resolvePaneLayout, type ResolvePaneLayoutInput } from '@/components/ui/panels/paneBreakpoints';
import { resolveBottomPaneLayout } from '@/components/ui/panels/resolveBottomPaneLayout';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';

import { AppPaneScopeLayoutProvider } from './hooks/useAppPaneScopeLayout';
import { applyPaneFocusModeLayoutOverride } from './layout/applyPaneFocusModeLayoutOverride';
import {
    PANE_SIZING_DEFAULTS,
    resolveDockedPaneSizing,
    resolveScaledPaneHeightPx,
    resolveScaledPaneHeightPxUncapped,
    resolveScaledPaneWidthPx,
    resolveScaledPaneWidthPxUncapped,
} from './layout/paneSizing';
import { resolveMultiPaneDeviceType } from './layout/resolveMultiPaneDeviceType';
import { PaneActionRailContext, PANE_ACTION_RAIL_WIDTH } from './PaneActionRailContext';

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
    detailsOpen?: boolean;
    /** A destination's selected content survives losing the optional side-panel presentation. */
    destinationOwnsDetails?: boolean;
    bottomOpen?: boolean;
    /** Pane focus mode: the open panes take the main column's place. */
    paneFocusModeActive?: boolean;
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

export const PaneColumnsHost = React.memo(function PaneColumnsHost(props: PaneColumnsHostProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    const { width: windowWidthPx, height: windowHeightPx } = useWindowDimensions();
    const [hostWidthPx, setHostWidthPx] = React.useState<number>(windowWidthPx);
    const [containerHeightPx, setContainerHeightPx] = React.useState<number>(windowHeightPx);
    const [rightDragWidthPx, setRightDragWidthPx] = React.useState<number | null>(null);
    const [detailsDragWidthPx, setDetailsDragWidthPx] = React.useState<number | null>(null);
    const [bottomDragHeightPx, setBottomDragHeightPx] = React.useState<number | null>(null);
    // `useLocalSetting` may return `undefined` transiently during hydration. Treat the setting as
    // enabled unless it has been explicitly disabled to avoid hiding panes on initial load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;

    const rightPaneWidthPx = useLocalSetting('rightPaneWidthPx');
    const rightPaneWidthBasisPx = useLocalSetting('rightPaneWidthBasisPx');
    const detailsPaneWidthPx = useLocalSetting('detailsPaneWidthPx');
    const detailsPaneWidthBasisPx = useLocalSetting('detailsPaneWidthBasisPx');
    const bottomPaneHeightPx = useLocalSetting('bottomPaneHeightPx');
    const bottomPaneHeightBasisPx = useLocalSetting('bottomPaneHeightBasisPx');

    const [, setRightPaneWidthPx] = useLocalSettingMutable('rightPaneWidthPx');
    const [, setRightPaneWidthBasisPx] = useLocalSettingMutable('rightPaneWidthBasisPx');
    const [, setDetailsPaneWidthPx] = useLocalSettingMutable('detailsPaneWidthPx');
    const [, setDetailsPaneWidthBasisPx] = useLocalSettingMutable('detailsPaneWidthBasisPx');
    const [, setBottomPaneHeightPx] = useLocalSettingMutable('bottomPaneHeightPx');
    const [, setBottomPaneHeightBasisPx] = useLocalSettingMutable('bottomPaneHeightBasisPx');

    const rightPane = props.rightPane ?? null;
    const detailsPane = props.detailsPane ?? null;
    const bottomPane = props.bottomPane ?? null;
    const rightOpen = props.rightOpen ?? rightPane !== null;
    const detailsOpen = props.detailsOpen ?? detailsPane !== null;
    const bottomOpen = props.bottomOpen ?? bottomPane !== null;
    const requestedPaneFocusMode = props.paneFocusModeActive === true && (rightOpen || detailsOpen);
    // Resolve the optional rail's layout first; destination-only content takes the whole host.
    const panelContainerWidthPx = Math.max(0, hostWidthPx - (props.actionRail != null ? PANE_ACTION_RAIL_WIDTH : 0));
    const mainMinPx = requestedPaneFocusMode ? 0 : (props.mainMinWidthPx ?? PANE_SIZING_DEFAULTS.mainMinPx);
    // With both side panes docked the canonical main column may run a little narrower; a caller's
    // own minimum is the content's real floor and holds in every layout.
    const mainMinPxThreePane = requestedPaneFocusMode
        ? 0
        : (props.mainMinWidthPx ?? PANE_SIZING_DEFAULTS.mainMinThreePanePx);
    const right = PANE_SIZING_DEFAULTS.right;
    const details = PANE_SIZING_DEFAULTS.details;

    const scaledRightPreferredPx = resolveScaledPaneWidthPxUncapped({
        preferredWidthPx: rightPaneWidthPx,
        basisContainerWidthPx: rightPaneWidthBasisPx,
        containerWidthPx: panelContainerWidthPx,
        minPx: right.minPx,
    });
    const scaledDetailsPreferredPx = resolveScaledPaneWidthPxUncapped({
        preferredWidthPx: detailsPaneWidthPx,
        basisContainerWidthPx: detailsPaneWidthBasisPx,
        containerWidthPx: panelContainerWidthPx,
        minPx: details.minPx,
    });
    const storedEffectiveRightDockWidthPx = resolveScaledPaneWidthPx({
        preferredWidthPx: rightPaneWidthPx,
        basisContainerWidthPx: rightPaneWidthBasisPx,
        containerWidthPx: panelContainerWidthPx,
        minPx: right.minPx,
        maxPx: right.maxPx,
    });
    const storedEffectiveDetailsDockWidthPx = resolveScaledPaneWidthPx({
        preferredWidthPx: detailsPaneWidthPx,
        basisContainerWidthPx: detailsPaneWidthBasisPx,
        containerWidthPx: panelContainerWidthPx,
        minPx: details.minPx,
        maxPx: details.maxPx,
    });

    const effectiveRightDockWidthPx = rightDragWidthPx ?? storedEffectiveRightDockWidthPx;
    const effectiveDetailsDockWidthPx = detailsDragWidthPx ?? storedEffectiveDetailsDockWidthPx;
    const rightPreferredPxForLayout = rightDragWidthPx ?? scaledRightPreferredPx;
    const detailsPreferredPxForLayout = detailsDragWidthPx ?? scaledDetailsPreferredPx;

    const scaledBottomPreferredPx = resolveScaledPaneHeightPxUncapped({
        preferredHeightPx: bottomPaneHeightPx,
        basisContainerHeightPx: bottomPaneHeightBasisPx,
        containerHeightPx,
        minPx: PANE_SIZING_DEFAULTS.bottom.minPx,
    });
    const bottomPreferredPxForLayout = bottomDragHeightPx ?? scaledBottomPreferredPx;
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
    const destinationDetailOnly = baseLayout.kind === 'single' && baseLayout.details === 'overlay';
    const paneFocusModeActive = requestedPaneFocusMode && !destinationDetailOnly;
    const resolvedLayout = applyPaneFocusModeLayoutOverride({
        paneFocusModeActive,
        rightOpen,
        detailsOpen,
        baseLayout,
    });
    const showActionRail = props.actionRail != null && !destinationDetailOnly;
    const containerWidthPx = destinationDetailOnly ? Math.max(0, hostWidthPx) : panelContainerWidthPx;
    const effectiveBottomPresentation = destinationDetailOnly ? 'hidden' : resolvedBottomLayout.presentation;

    const bottomStoredMaxHeightPxForSizing =
        effectiveBottomPresentation === 'docked'
            ? resolvedBottomLayout.dockMaxHeightPx
            : resolvedBottomLayout.overlayMaxHeightPx;
    const storedEffectiveBottomDockHeightPx = resolveScaledPaneHeightPx({
        preferredHeightPx: bottomPaneHeightPx,
        basisContainerHeightPx: bottomPaneHeightBasisPx,
        containerHeightPx,
        minPx: PANE_SIZING_DEFAULTS.bottom.minPx,
        maxPx: bottomStoredMaxHeightPxForSizing,
    });
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

    const mainRegionWidthPx = Math.max(
        0,
        containerWidthPx
            - (resolvedLayout.right === 'docked' && Boolean(rightPane) ? dockSizing.rightWidthPx : 0)
            - (resolvedLayout.details === 'docked' && Boolean(detailsPane) ? dockSizing.detailsWidthPx : 0),
    );

    const baseSizing = React.useMemo(() => {
        const prefersFullScreenOverlay = deviceType === 'phone';
        const clampOverlayWidth = (value: number, minPx: number) => {
            if (destinationDetailOnly) return containerWidthPx;
            if (prefersFullScreenOverlay) return Math.max(minPx, mainRegionWidthPx);
            if (!Number.isFinite(value)) return minPx;
            return Math.min(mainRegionWidthPx, Math.max(minPx, value));
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
                ? Math.max(right.minPx, mainRegionWidthPx)
                : right.maxPx;
        const detailsMaxWidthPx = resolvedLayout.details === 'docked'
            ? dockSizing.detailsMaxWidthPx
            : resolvedLayout.details === 'overlay'
                ? Math.max(details.minPx, mainRegionWidthPx)
                : details.maxPx;
        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx };
    }, [
        deviceType,
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

    const focusAwareDockSizing = React.useMemo(() => {
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

        if (paneFocusModeActive) {
            const rightDocked = Boolean(rightPane) && resolvedLayout.right === 'docked';
            const detailsPresent = Boolean(detailsPane) && resolvedLayout.details !== 'hidden';
            const rightPresent = Boolean(rightPane) && resolvedLayout.right !== 'hidden';
            if (detailsPresent) {
                // In focus mode, avoid leaving empty space by stretching the visible details pane
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
        paneFocusModeActive,
        resolvedLayout.details,
        resolvedLayout.right,
        right.minPx,
        rightPane,
    ]);

    const onCommitRightDockWidthPx = React.useCallback((nextWidthPx: number) => {
        setRightPaneWidthPx(nextWidthPx);
        setRightPaneWidthBasisPx(containerWidthPx);
    }, [containerWidthPx, setRightPaneWidthBasisPx, setRightPaneWidthPx]);
    const onCommitDetailsDockWidthPx = React.useCallback((nextWidthPx: number) => {
        setDetailsPaneWidthPx(nextWidthPx);
        setDetailsPaneWidthBasisPx(containerWidthPx);
    }, [containerWidthPx, setDetailsPaneWidthBasisPx, setDetailsPaneWidthPx]);
    // The docked budget is what main's minimum leaves (minus a docked neighbour). A pull past it
    // (`exceededMaxPx`) carries the attempted width, which is what flips the layout to an overlay for a
    // pane that opts in; the docked handle then unmounts mid-drag, so the pulled width is kept.
    const detailsDockBudgetRef = React.useRef({ budgetPx: 0, docked: false });
    detailsDockBudgetRef.current = {
        budgetPx: Math.max(
            details.minPx,
            containerWidthPx - mainMinPx - (resolvedLayout.right === 'docked' && rightPane ? focusAwareDockSizing.rightWidthPx : 0),
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
        setBottomPaneHeightPx(nextHeightPx);
        setBottomPaneHeightBasisPx(containerHeightPx);
    }, [containerHeightPx, setBottomPaneHeightBasisPx, setBottomPaneHeightPx]);

    const rightPaneHiddenByDetails = detailsOpen && applyPaneFocusModeLayoutOverride({
        paneFocusModeActive,
        rightOpen: true,
        detailsOpen,
        baseLayout: resolvePaneLayout({ ...paneLayoutInput, rightOpen: true }),
    }).right === 'hidden';
    const railContext = React.useMemo(() => ({
        visible: showActionRail,
        contentWidthPx: containerWidthPx,
        rightPaneHiddenByDetails,
    }), [showActionRail, containerWidthPx, rightPaneHiddenByDetails]);
    const layoutContext = React.useMemo(() => ({
        containerWidthPx,
        containerHeightPx,
        mainRegionWidthPx,
        mainRegionHeightPx,
        multiPaneEnabled,
        deviceType: multiPaneDeviceType,
        layout: resolvedLayout,
        bottomPresentation: effectiveBottomPresentation,
    }), [
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
        () => (rightPane ? <PaneRegionProvider region="side">{rightPane}</PaneRegionProvider> : null),
        [rightPane],
    );
    const regionDetailsPane = React.useMemo(
        () => (detailsPane ? <PaneRegionProvider region="details">{detailsPane}</PaneRegionProvider> : null),
        [detailsPane],
    );

    const columns = (
        <>
            <MultiPaneHostWithBottom
                main={regionMain}
                hideMain={paneFocusModeActive}
                rightPane={regionRightPane}
                detailsPane={regionDetailsPane}
                detailsScrim={props.detailsOpenedFrom === 'side' ? 'soft' : 'standard'}
                layout={resolvedLayout}
                rightDockWidthPx={focusAwareDockSizing.rightWidthPx}
                detailsDockWidthPx={focusAwareDockSizing.detailsWidthPx}
                rightDockMinWidthPx={focusAwareDockSizing.rightMinWidthPx}
                detailsDockMinWidthPx={focusAwareDockSizing.detailsMinWidthPx}
                rightDockMaxWidthPx={focusAwareDockSizing.rightMaxWidthPx}
                detailsDockMaxWidthPx={focusAwareDockSizing.detailsMaxWidthPx}
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
                bottomOverlayFocusReturnRef={props.bottomOverlayFocusReturnRef}
            />
            {showActionRail ? (
                <View style={[styles.railColumn, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
                    <PaneRegionProvider region="main">{props.actionRail}</PaneRegionProvider>
                </View>
            ) : null}
        </>
    );

    return (
        <PaneActionRailContext.Provider value={railContext}>
            <View
                testID={props.testID}
                style={styles.root}
                {...props.rootProps}
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
                    {props.wrapContent ? props.wrapContent(columns) : columns}
                </AppPaneScopeLayoutProvider>
            </View>
        </PaneActionRailContext.Provider>
    );
});

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
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
}));
