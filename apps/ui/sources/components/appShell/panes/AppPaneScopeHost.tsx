import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { MultiPaneHostWithBottom } from '@/components/ui/panels/MultiPaneHostWithBottom';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { resolveBottomPaneLayout } from '@/components/ui/panels/resolveBottomPaneLayout';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useAppPaneContext } from './AppPaneProvider';
import { PANE_SIZING_DEFAULTS, resolveDockedPaneSizing, resolveScaledPaneHeightPx, resolveScaledPaneHeightPxUncapped, resolveScaledPaneWidthPx, resolveScaledPaneWidthPxUncapped } from './layout/paneSizing';
import { resolveMultiPaneDeviceType } from './layout/resolveMultiPaneDeviceType';
import { applyPaneFocusModeLayoutOverride } from './layout/applyPaneFocusModeLayoutOverride';

export type AppPaneScopeHostProps = Readonly<{
    scopeId: string;
    main: React.ReactNode;
    rightPane?: React.ReactNode | null;
    detailsPane?: React.ReactNode | null;
    bottomPane?: React.ReactNode | null;
}>;

export const AppPaneScopeHost = React.memo((props: AppPaneScopeHostProps) => {
    const { dispatch, state, getDriver, driverRegistryVersion } = useAppPaneContext();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    const { width: windowWidthPx, height: windowHeightPx } = useWindowDimensions();
    const [containerWidthPx, setContainerWidthPx] = React.useState<number>(windowWidthPx);
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

    React.useEffect(() => {
        dispatch({ type: 'activateScope', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const scopeState = state.scopes[props.scopeId];
    const rightOpen = Boolean(scopeState?.right.isOpen);
    const detailsOpen = Boolean(scopeState?.details.isOpen);
    const bottomOpen = Boolean(scopeState?.bottom?.isOpen);
    const paneFocusModeActive =
        state.focusMode?.scopeId === props.scopeId
        && state.activeScopeId === props.scopeId
        && (rightOpen || detailsOpen);

    const driver = React.useMemo(() => getDriver(props.scopeId), [driverRegistryVersion, getDriver, props.scopeId]);

    // `MultiPaneHost` uses pane node presence as the logical "open" signal. Keep the
    // nodes null when closed so hidden layouts don't accidentally mount expensive panes.
    const rightPane =
        rightOpen
            ? (props.rightPane ?? driver?.renderRightPane?.({ scopeId: props.scopeId }) ?? null)
            : null;
    const detailsPane =
        detailsOpen
            ? (props.detailsPane ?? driver?.renderDetailsPane?.({ scopeId: props.scopeId }) ?? null)
            : null;
    const bottomPane =
        bottomOpen
            ? (props.bottomPane ?? driver?.renderBottomPane?.({ scopeId: props.scopeId }) ?? null)
            : null;

    const scaledRightPreferredPx = resolveScaledPaneWidthPxUncapped({
        preferredWidthPx: rightPaneWidthPx,
        basisContainerWidthPx: rightPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.right.minPx,
    });

    const scaledDetailsPreferredPx = resolveScaledPaneWidthPxUncapped({
        preferredWidthPx: detailsPaneWidthPx,
        basisContainerWidthPx: detailsPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.details.minPx,
    });

    const storedEffectiveRightDockWidthPx = resolveScaledPaneWidthPx({
        preferredWidthPx: rightPaneWidthPx,
        basisContainerWidthPx: rightPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.right.minPx,
        maxPx: PANE_SIZING_DEFAULTS.right.maxPx,
    });

    const storedEffectiveDetailsDockWidthPx = resolveScaledPaneWidthPx({
        preferredWidthPx: detailsPaneWidthPx,
        basisContainerWidthPx: detailsPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.details.minPx,
        maxPx: PANE_SIZING_DEFAULTS.details.maxPx,
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

    const bottomStoredMaxHeightPxForSizing =
        resolvedBottomLayout.presentation === 'docked'
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
    const bottomResizeMaxHeightPx =
        bottomDragHeightPx != null
            ? resolvedBottomLayout.overlayMaxHeightPx
            : bottomStoredMaxHeightPxForSizing;

    const singlePaneBudgetMaxPx = React.useMemo(() => {
        const mainMinPx = paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinPx;
        const clamp = (value: number, minPx: number, maxPx: number) => Math.min(maxPx, Math.max(minPx, value));
        const rightMax = clamp(containerWidthPx - mainMinPx, PANE_SIZING_DEFAULTS.right.minPx, PANE_SIZING_DEFAULTS.right.maxPx);
        const detailsMax = clamp(containerWidthPx - mainMinPx, PANE_SIZING_DEFAULTS.details.minPx, PANE_SIZING_DEFAULTS.details.maxPx);
        return { rightMax, detailsMax };
    }, [containerWidthPx, paneFocusModeActive]);

    const preferOverlayWhenPreferredDoesNotFit = React.useMemo(() => {
        const rightPrefers =
            rightDragWidthPx != null || storedEffectiveRightDockWidthPx > singlePaneBudgetMaxPx.rightMax + 1;
        const detailsPrefers =
            detailsDragWidthPx != null || storedEffectiveDetailsDockWidthPx > singlePaneBudgetMaxPx.detailsMax + 1;
        return { right: rightPrefers, details: detailsPrefers };
    }, [
        detailsDragWidthPx,
        rightDragWidthPx,
        singlePaneBudgetMaxPx.detailsMax,
        singlePaneBudgetMaxPx.rightMax,
        storedEffectiveDetailsDockWidthPx,
        storedEffectiveRightDockWidthPx,
    ]);

    const resolvedLayoutBase = resolvePaneLayout({
        containerWidthPx,
        deviceType: multiPaneDeviceType,
        multiPaneEnabled,
        rightOpen,
        detailsOpen,
        rightPreferOverlayWhenPreferredDoesNotFit: preferOverlayWhenPreferredDoesNotFit.right,
        detailsPreferOverlayWhenPreferredDoesNotFit: preferOverlayWhenPreferredDoesNotFit.details,
        mainMinPx: paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinPx,
        mainMinPxThreePane: paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinThreePanePx,
        rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        rightPreferredPx: rightPreferredPxForLayout,
        detailsPreferredPx: detailsPreferredPxForLayout,
    });

    const resolvedLayout = applyPaneFocusModeLayoutOverride({
        paneFocusModeActive,
        rightOpen,
        detailsOpen,
        baseLayout: resolvedLayoutBase,
    });

    // NOTE: When both panes are open on narrow widths, `resolvePaneLayout` can return `overlayStack`
    // with `right: 'hidden'` + `details: 'overlay'`. We intentionally keep the right pane "open"
    // in state (but hidden by layout) so that closing details returns the user back to the right
    // pane on small screens.

    const dockSizing = resolveDockedPaneSizing({
        containerWidthPx,
        mainMinPx: paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinPx,
        rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        rightWidthPx: effectiveRightDockWidthPx,
        detailsWidthPx: effectiveDetailsDockWidthPx,
        rightGlobalMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        rightGlobalMaxPx: PANE_SIZING_DEFAULTS.right.maxPx,
        detailsGlobalMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        detailsGlobalMaxPx: PANE_SIZING_DEFAULTS.details.maxPx,
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
            if (prefersFullScreenOverlay) return Math.max(minPx, mainRegionWidthPx);
            if (!Number.isFinite(value)) return minPx;
            return Math.min(mainRegionWidthPx, Math.max(minPx, value));
        };

        const rightWidthPx =
            resolvedLayout.right === 'docked'
                ? dockSizing.rightWidthPx
                : resolvedLayout.right === 'overlay'
                    ? clampOverlayWidth(rightPreferredPxForLayout, PANE_SIZING_DEFAULTS.right.minPx)
                    : 0;

        const detailsWidthPx =
            resolvedLayout.details === 'docked'
                ? dockSizing.detailsWidthPx
                : resolvedLayout.details === 'overlay'
                    ? clampOverlayWidth(detailsPreferredPxForLayout, PANE_SIZING_DEFAULTS.details.minPx)
                    : 0;

        const rightMaxWidthPx =
            resolvedLayout.right === 'docked'
                ? dockSizing.rightMaxWidthPx
                : resolvedLayout.right === 'overlay'
                    ? Math.max(PANE_SIZING_DEFAULTS.right.minPx, mainRegionWidthPx)
                    : PANE_SIZING_DEFAULTS.right.maxPx;

        const detailsMaxWidthPx =
            resolvedLayout.details === 'docked'
                ? dockSizing.detailsMaxWidthPx
                : resolvedLayout.details === 'overlay'
                    ? Math.max(PANE_SIZING_DEFAULTS.details.minPx, mainRegionWidthPx)
                    : PANE_SIZING_DEFAULTS.details.maxPx;

        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx };
    }, [
        deviceType,
        dockSizing.detailsMaxWidthPx,
        dockSizing.detailsWidthPx,
        dockSizing.rightMaxWidthPx,
        dockSizing.rightWidthPx,
        detailsPreferredPxForLayout,
        mainRegionWidthPx,
        resolvedLayout.details,
        resolvedLayout.right,
        rightPreferredPxForLayout,
    ]);

    const focusModeFillPanes = paneFocusModeActive;
    const focusAwareDockSizing = React.useMemo(() => {
        let rightWidthPx = baseSizing.rightWidthPx;
        let detailsWidthPx = baseSizing.detailsWidthPx;
        let rightMaxWidthPx = baseSizing.rightMaxWidthPx;
        let detailsMaxWidthPx = baseSizing.detailsMaxWidthPx;
        let rightMinWidthPx: number | undefined = undefined;
        let detailsMinWidthPx: number | undefined = undefined;

        // While the user is actively dragging a docked pane wider than the main-region budget
        // allows, we want to let them "pull it over the content" and transition to an overlay
        // presentation. If we clamp maxWidth to the docked budget during the drag, the layout
        // resolver never sees an out-of-budget preferred width and cannot switch to overlay.
        const overlayMaxIfRightOverlay = Math.max(
            PANE_SIZING_DEFAULTS.right.minPx,
            containerWidthPx - (resolvedLayout.details === 'docked' ? detailsWidthPx : 0),
        );
        const overlayMaxIfDetailsOverlay = Math.max(
            PANE_SIZING_DEFAULTS.details.minPx,
            containerWidthPx - (resolvedLayout.right === 'docked' ? rightWidthPx : 0),
        );

        // When a pane is presented as an overlay, allow resizing up to the
        // available main-region width (so users can "pull it wider" over the content).
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

        if (resolvedLayout.right === 'docked' && rightDragWidthPx != null) {
            rightMaxWidthPx = Math.max(rightMaxWidthPx, overlayMaxIfRightOverlay);
        }
        if (resolvedLayout.details === 'docked' && detailsDragWidthPx != null) {
            detailsMaxWidthPx = Math.max(detailsMaxWidthPx, overlayMaxIfDetailsOverlay);
        }

        if (focusModeFillPanes) {
            const rightDocked = Boolean(rightPane) && resolvedLayout.right === 'docked';
            const detailsPresent = Boolean(detailsPane) && resolvedLayout.details !== 'hidden';
            const rightPresent = Boolean(rightPane) && resolvedLayout.right !== 'hidden';

            if (detailsPresent) {
                // In focus mode, avoid leaving empty space by stretching the visible details pane
                // to the maximum available width (including widths above the default global max).
                const available = Math.max(
                    PANE_SIZING_DEFAULTS.details.minPx,
                    containerWidthPx - (rightDocked ? rightWidthPx : 0),
                );
                detailsWidthPx = available;
                detailsMaxWidthPx = available;
                detailsMinWidthPx = available;
            } else if (rightPresent) {
                const available = Math.max(PANE_SIZING_DEFAULTS.right.minPx, containerWidthPx);
                rightWidthPx = available;
                rightMaxWidthPx = available;
                rightMinWidthPx = available;
            }
        }

        return {
            rightWidthPx,
            detailsWidthPx,
            rightMaxWidthPx,
            detailsMaxWidthPx,
            rightMinWidthPx,
            detailsMinWidthPx,
        };
    }, [
        baseSizing.detailsMaxWidthPx,
        baseSizing.detailsWidthPx,
        baseSizing.rightMaxWidthPx,
        baseSizing.rightWidthPx,
        containerWidthPx,
        detailsDragWidthPx,
        detailsPane,
        focusModeFillPanes,
        resolvedLayout.details,
        resolvedLayout.right,
        rightDragWidthPx,
        rightPane,
    ]);

    const onCloseRight = React.useCallback(() => {
        dispatch({ type: 'closeRight', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const onCloseDetails = React.useCallback(() => {
        dispatch({ type: 'closeDetails', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const onCloseBottom = React.useCallback(() => {
        dispatch({ type: 'closeBottom', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const onCommitRightDockWidthPx = React.useCallback((nextWidthPx: number) => {
        setRightPaneWidthPx(nextWidthPx);
        setRightPaneWidthBasisPx(containerWidthPx);
    }, [containerWidthPx, setRightPaneWidthBasisPx, setRightPaneWidthPx]);

    const onCommitDetailsDockWidthPx = React.useCallback((nextWidthPx: number) => {
        setDetailsPaneWidthPx(nextWidthPx);
        setDetailsPaneWidthBasisPx(containerWidthPx);
    }, [containerWidthPx, setDetailsPaneWidthBasisPx, setDetailsPaneWidthPx]);

    const onCommitBottomDockHeightPx = React.useCallback((nextHeightPx: number) => {
        setBottomPaneHeightPx(nextHeightPx);
        setBottomPaneHeightBasisPx(containerHeightPx);
    }, [containerHeightPx, setBottomPaneHeightBasisPx, setBottomPaneHeightPx]);

    return (
        <View
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
            onLayout={(event) => {
                const next = Math.round(event?.nativeEvent?.layout?.width ?? 0);
                if (Number.isFinite(next) && next > 0) {
                    setContainerWidthPx((prev) => (Math.abs(prev - next) > 1 ? next : prev));
                }
                const nextHeight = Math.round(event?.nativeEvent?.layout?.height ?? 0);
                if (Number.isFinite(nextHeight) && nextHeight > 0) {
                    setContainerHeightPx((prev) => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev));
                }
            }}
        >
            <MultiPaneHostWithBottom
                main={props.main}
                hideMain={paneFocusModeActive && (rightOpen || detailsOpen)}
                rightPane={rightPane}
                detailsPane={detailsPane}
                layout={resolvedLayout}
                rightDockWidthPx={focusAwareDockSizing.rightWidthPx}
                detailsDockWidthPx={focusAwareDockSizing.detailsWidthPx}
                rightDockMinWidthPx={focusAwareDockSizing.rightMinWidthPx}
                detailsDockMinWidthPx={focusAwareDockSizing.detailsMinWidthPx}
                rightDockMaxWidthPx={focusAwareDockSizing.rightMaxWidthPx}
                detailsDockMaxWidthPx={focusAwareDockSizing.detailsMaxWidthPx}
                onCloseRight={onCloseRight}
                onCloseDetails={onCloseDetails}
                onCommitRightDockWidthPx={onCommitRightDockWidthPx}
                onCommitDetailsDockWidthPx={onCommitDetailsDockWidthPx}
                onDragRightDockWidthPx={setRightDragWidthPx}
                onDragDetailsDockWidthPx={setDetailsDragWidthPx}
                bottomPane={bottomPane}
                bottomPresentation={resolvedBottomLayout.presentation}
                bottomDockHeightPx={effectiveBottomDockHeightPx}
                bottomDockMinHeightPx={PANE_SIZING_DEFAULTS.bottom.minPx}
                bottomDockMaxHeightPx={bottomResizeMaxHeightPx}
                onCloseBottom={onCloseBottom}
                onCommitBottomDockHeightPx={onCommitBottomDockHeightPx}
                onDragBottomDockHeightPx={setBottomDragHeightPx}
            />
        </View>
    );
});
