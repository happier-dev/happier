import * as React from 'react';
import { Stack } from 'expo-router';
import { View, useWindowDimensions, Platform } from 'react-native';
import { getStorage, useActiveServerAccountScope, useLocalSetting } from '@/sync/domains/state/storage';
import { ResizableDockedPane, type ResizableDockedPaneCommitMeta } from '@/components/ui/panels/ResizableDockedPane';
import { resolveFoldAlignedSidebarWidthPx, resolveSidebarDockMaxWidthPx, SIDEBAR_DEFAULT_WIDTH_PX, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { AppRail } from './appRail/AppRail';
import { AppShellColumn } from './appRail/AppShellColumn';
import { AppShellTitleStrip } from './appRail/AppShellTitleStrip';
import { AppShellTitleMoreSlot } from './appShellTail';
import { AppShellPeekCovered, AppShellPeekLayer, AppShellPeekProvider } from './appRail/AppShellPeek';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';
import {
    resolveAppRailEntryColumn,
    type AppShellColumn as AppShellColumnModel,
    type AppShellShownColumn,
} from './appRail/appRailModel';
import { useAppShellLocation } from './appRail/useAppShellLocation';
import { AppShellColumnContext, type AppShellColumnState } from './appRail/appShellColumnContext';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { usePaneRegionFocusBoundary } from '@/components/appShell/panes/paneRegion';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { AppShellMaterialFrame, resolveColumnDrawnWidthPx } from './AppShellMaterialFrame';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useShallow } from 'zustand/react/shallow';
import { useOptionalWorkspaceNavigation, useWorkspaceNavigationActive, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { useWorkspaceShellEnabled } from '@/components/appShell/workspace/useWorkspaceShellEnabled';
import { WorkspaceShell } from '@/components/appShell/workspace/WorkspaceShell';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceBarGeometry, WorkspaceBarGeometryContext } from '@/components/appShell/workspace/titleBar/workspaceBarGeometry';
import { registerShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { VoiceTopBarPresenceMount } from '@/components/voice/presence/VoiceTopBarPresence';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useWindowFoldMetrics } from '@/utils/platform/useWindowFoldMetrics';
import { NavigatorSafeAreaBleed, useHorizontalSafeArea } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { renderAppStackScreen } from '@/components/navigation/appStackScreenLayout';

/** The title strip's trailing Voice node (Top bar mode); one element, so the strip's memo holds. */
const VOICE_TOP_BAR_TRAILING = <VoiceTopBarPresenceMount />;

// Like the docked column, a peeked one keeps its wheel and touch scrolling from document scroll locks.
const stopPeekScrollPropagation = (event: { stopPropagation?: () => void }) => event.stopPropagation?.();
const PEEK_SCROLL_PROPS = Platform.OS === 'web'
    ? { onWheel: stopPeekScrollPropagation, onTouchMove: stopPeekScrollPropagation }
    : {};
const renderPeekColumn = (column: AppShellColumnModel) => (
    <View style={{ flex: 1, minHeight: 0 }} {...PEEK_SCROLL_PROPS}>
        <AppShellColumn column={column} peeked />
    </View>
);

/** The strip's history controls: its tabs subscribe in the title bar, so a tab's own write (a Session side tab) does not reach it. */
const selectTitleStripNavigation = (workspace: WorkspaceNavigationContextValue | null) => workspace?.active === true ? {
    canGoBack: workspace.canGoBack, canGoForward: workspace.canGoForward,
    back: workspace.back, forward: workspace.forward, openHref: workspace.openHref,
} : null;

/** The strip's workspace tabs and history controls subscribe here, beside the route tree rather than above it. */
function ShellTitleStrip(props: Readonly<{
    columnVisible: boolean;
    columnToggleAvailable: boolean;
    onToggleColumn: () => void;
    catalog: readonly CompactAppDestination[];
}>) {
    const navigation = useOptionalWorkspaceNavigation(useShallow(selectTitleStripNavigation));
    return <AppShellTitleStrip columnVisible={props.columnVisible}
        columnToggleAvailable={props.columnToggleAvailable} onToggleColumn={props.onToggleColumn}
        navigation={navigation ?? undefined}
        workspaceCatalog={navigation ? props.catalog : undefined}
        trailing={TITLE_STRIP_TRAILING} />;
}

const TITLE_STRIP_TRAILING_ROW = { flexDirection: 'row', alignItems: 'center' } as const;
const TITLE_STRIP_TRAILING = <View style={TITLE_STRIP_TRAILING_ROW}><AppShellTitleMoreSlot />{VOICE_TOP_BAR_TRAILING}</View>;

const ROUTE_STACK_OPTIONS = { lazy: false, headerShown: false } as const;
const DESTINATION_STACK_OPTIONS = { ...ROUTE_STACK_OPTIONS, contentStyle: { backgroundColor: 'transparent' } } as const;

export const SidebarNavigator = React.memo(function SidebarNavigator() {
    // Dedicated destinations/presenters own their surface. Do not mount the full rail's
    // subscriptions or let the workspace shell replace their app-owned route.
    if (resolveDesktopWindowContext().chrome === 'destination') {
        return <AccountNoticeInvestigationBoundary>
            <NavigatorSafeAreaBleed><Stack screenOptions={DESTINATION_STACK_OPTIONS} screenLayout={renderAppStackScreen} /></NavigatorSafeAreaBleed>
        </AccountNoticeInvestigationBoundary>;
    }
    return <FullSidebarNavigator />;
});

const FullSidebarNavigator = React.memo(() => {
    const accountScope = useActiveServerAccountScope();
    const { execute, isCurrent } = useMountedActionExecution(accountScope);
    // The route tree reads only whether the workspace hosts it; tab, title and sync
    // changes reach the title strip and workspace shell leaves that read them.
    const workspaceActive = useWorkspaceNavigationActive();
    // The onboarding journey host owns the whole viewport until its session ends
    // (visual spec v3 §5): the post-auth setup beats must never render beside the
    // live app sidebar. Reuse the route-based sidebar-bypass seam rather than
    // adding a parallel gate — this covers every authed path (in-session hinge,
    // reload re-latch, replay) on every platform.
    // The app shell (title strip, rail, the destination's column) stands around the routes on tablets
    // and desktops once someone is signed in (lab `xrail-R1`).
    const showSidebar = useWorkspaceShellEnabled();
    // The title strip carries the top-row panes' tabs; the panes report where they sit under it.
    const [workspaceBarGeometry] = React.useState(createWorkspaceBarGeometry);
    const { catalog, location } = useAppShellLocation();
    const column = location.column;
    const resolvePeekColumn = React.useCallback((destinationId: string): AppShellShownColumn | null => {
        const destination = catalog.find((candidate) => candidate.id === destinationId);
        return destination ? resolveAppRailEntryColumn(destination) : null;
    }, [catalog]);
    const { width: windowWidth } = useWindowDimensions();
    const foldMetrics = useWindowFoldMetrics();
    const horizontalSafeArea = useHorizontalSafeArea();
    const sidebarCollapsed = useLocalSetting('sidebarCollapsed');
    const sidebarWidthPx = useLocalSetting('sidebarWidthPx');
    const rightPanelPlacement = useLocalSetting('rightPanelPlacement');
    const [dragSidebarWidthPx, setDragSidebarWidthPx] = React.useState<number | null>(null);
    const [sidebarCollapseArmed, setSidebarCollapseArmed] = React.useState(false);
    const [sidebarOvershootPx, setSidebarOvershootPx] = React.useState(0);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: { stopPropagation?: () => void }) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views
        // (including the permanent sidebar). Stopping propagation here keeps scroll events
        // within the sidebar subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const sidebarMaxWidthPx = React.useMemo(() => resolveSidebarDockMaxWidthPx(windowWidth), [windowWidth]);

    const effectiveSidebarWidthPx = Math.min(sidebarMaxWidthPx, Math.max(SIDEBAR_DOCK_MIN_WIDTH_PX, sidebarWidthPx));

    // The column shows when the open destination has one and the person has not hidden it; the rail
    // stays either way. Hidden chrome reserves no horizontal space.
    const columnShown = showSidebar && !sidebarCollapsed && column.kind !== 'none';
    const foldAlignedSidebarWidthPx = columnShown ? resolveFoldAlignedSidebarWidthPx({
        foldMetrics,
        sidebarStartPx: horizontalSafeArea.left + APP_RAIL_WIDTH_PX,
    }) : null;
    const columnFocus = usePaneRegionFocusBoundary('navigation', columnShown);
    const sidebarWidth = React.useMemo(() => {
        if (!columnShown) return 0;
        return foldAlignedSidebarWidthPx ?? dragSidebarWidthPx ?? effectiveSidebarWidthPx;
    }, [columnShown, dragSidebarWidthPx, effectiveSidebarWidthPx, foldAlignedSidebarWidthPx]);
    const shellLeftPx = showSidebar ? APP_RAIL_WIDTH_PX + sidebarWidth : 0;
    const appShellState = React.useMemo<AppShellColumnState>(
        () => ({ present: showSidebar, columnVisible: columnShown }),
        [columnShown, showSidebar],
    );

    const handleSetColumnVisible = React.useCallback((visible: boolean) => {
        getStorage().getState().applyLocalSettings({ sidebarCollapsed: !visible }, { source: 'ui' });
    }, []);
    const requestSetColumnVisible = React.useCallback(async (visible: boolean) => {
        try {
            const result = await execute('shell.column.set', { visible }, { retainInvocation: true });
            if (!isCurrent() || result.ok || isActionApprovalDeclinedErrorCode(result.errorCode)
                || result.errorCode === 'action_cancelled') return;
            if (!presentActionTurnedOffNoticeIfOff(result, 'shell.column.set')) Modal.alert(t('common.error'), t('common.unavailable'));
        } catch {
            if (isCurrent()) Modal.alert(t('common.error'), t('common.unavailable'));
        }
    }, [execute, isCurrent]);

    const handleSidebarWidthDrag = React.useCallback((nextWidthPx: number | null, dragMeta?: ResizableDockedPaneCommitMeta | null) => {
        setDragSidebarWidthPx(foldAlignedSidebarWidthPx === null ? nextWidthPx : null);
        setSidebarOvershootPx(foldAlignedSidebarWidthPx === null ? dragMeta?.overshootPx ?? 0 : 0);
    }, [foldAlignedSidebarWidthPx]);

    const handleSidebarCollapse = React.useCallback(() => {
        if (foldAlignedSidebarWidthPx !== null) return;
        fireAndForget(requestSetColumnVisible(false), { tag: 'SidebarNavigator.collapse' });
    }, [foldAlignedSidebarWidthPx, requestSetColumnVisible]);

    const handleSidebarWidthCommit = React.useCallback((nextWidthPx: number) => {
        setDragSidebarWidthPx(null);
        // A resize already in progress can finish after native geometry fixes the pane to the crease.
        if (foldAlignedSidebarWidthPx !== null) return;
        getStorage().getState().applyLocalSettings({ sidebarWidthPx: nextWidthPx }, { source: 'ui' });
    }, [foldAlignedSidebarWidthPx]);
    const handleSidebarWidthReset = React.useCallback(() => {
        handleSidebarWidthCommit(SIDEBAR_DEFAULT_WIDTH_PX);
    }, [handleSidebarWidthCommit]);

    const handleToggleColumn = React.useCallback(() => {
        fireAndForget(requestSetColumnVisible(sidebarCollapsed), { tag: 'SidebarNavigator.toggleColumn' });
    }, [sidebarCollapsed, requestSetColumnVisible]);
    useKeyboardShortcutHandlers(React.useMemo(() => showSidebar && column.kind !== 'none'
        ? { 'shell.column.toggle': handleToggleColumn }
        : {}, [column.kind, handleToggleColumn, showSidebar]));
    const columnActionRef = React.useRef({ present: showSidebar, visible: columnShown,
        available: column.kind !== 'none', setVisible: handleSetColumnVisible });
    React.useLayoutEffect(() => {
        columnActionRef.current = { present: showSidebar, visible: columnShown,
            available: column.kind !== 'none', setVisible: handleSetColumnVisible };
    });
    React.useEffect(() => registerShellColumnActionOwner('navigation', () => columnActionRef.current), []);

    const columnContent = (
        <ResizableDockedPane
            widthPx={sidebarWidth}
            // The rows and the handle follow the column's rubber-banded edge, never paint past it.
            drawnWidthPx={foldAlignedSidebarWidthPx ?? (sidebarOvershootPx !== 0 ? resolveColumnDrawnWidthPx(sidebarWidth, sidebarOvershootPx) : undefined)}
            minWidthPx={foldAlignedSidebarWidthPx ?? SIDEBAR_DOCK_MIN_WIDTH_PX}
            maxWidthPx={foldAlignedSidebarWidthPx ?? sidebarMaxWidthPx}
            resizeEdge="right"
            onDragWidthPx={handleSidebarWidthDrag}
            onCommitWidthPx={handleSidebarWidthCommit}
            collapse
            onCollapseArmedChange={setSidebarCollapseArmed}
            onCollapse={handleSidebarCollapse}
            onResetRequest={handleSidebarWidthReset}
        >
            <View
                ref={columnFocus.ref}
                onFocus={columnFocus.onFocus}
                accessibilityLabel={t('settingsKeyboard.paneRegions.navigation')}
                focusable
                style={{ flex: 1, flexShrink: 0, minHeight: 0 }}
                {...(Platform.OS === 'web'
                    ? { role: 'navigation' as const, tabIndex: -1, onFocusCapture: columnFocus.onFocusCapture, onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb }
                    : {})}
            >
                <AppShellPeekCovered><AppShellColumn column={column} /></AppShellPeekCovered>
            </View>
        </ResizableDockedPane>
    );

    // A sidebar resize re-renders this navigator on every pointer move; the route tree and the
    // title strip keep their element identity so React stops here and the pages only reflow.
    const routes = React.useMemo(() => <>
        <View style={[{ flex: 1, minWidth: 0, minHeight: 0 }, workspaceActive && { display: 'none' }]}>
            <Stack screenOptions={ROUTE_STACK_OPTIONS} screenLayout={renderAppStackScreen} />
        </View>
        {workspaceActive ? <WorkspaceShell catalog={catalog} /> : null}
    </>, [catalog, workspaceActive]);
    const columnToggleAvailable = column.kind !== 'none';
    const titleStrip = React.useMemo(() => (showSidebar || workspaceActive ? (
        <ShellTitleStrip key="title-strip" columnVisible={columnShown}
            columnToggleAvailable={columnToggleAvailable} onToggleColumn={handleToggleColumn}
            catalog={catalog} />
    ) : null), [catalog, columnShown, columnToggleAvailable, handleToggleColumn, showSidebar, workspaceActive]);

    // Dedicated presenter webviews own their paint; the app's sheet would fill their clear backing.
    // Responsive chrome changes geometry, never the ordinary route navigator or its ancestry.
    return (
        <AppShellColumnContext.Provider value={appShellState}>
        <WorkspaceBarGeometryContext.Provider value={workspaceBarGeometry}>
        <AppShellPeekProvider enabled={showSidebar} currentId={column.kind === 'none' ? null : location.railEntryId} columnShown={columnShown}>
        <InboxSummaryProvider>
        <NavigatorSafeAreaBleed>
        <AppShellMaterialFrame
            showChrome={showSidebar}
            dragEnabled={showSidebar && Platform.OS === 'web' && isDesktopHost()}
            leftOffsetPx={shellLeftPx}
            sidebarWidth={sidebarWidth}
            columnResizeState={foldAlignedSidebarWidthPx === null
                ? { collapseArmed: sidebarCollapseArmed, overshootPx: sidebarOvershootPx, dragging: dragSidebarWidthPx !== null }
                : { collapseArmed: false, overshootPx: 0, dragging: false }}
            rightPanelPlacement={rightPanelPlacement}
            titleStrip={titleStrip}
            rail={showSidebar ? <AppRail key="rail" /> : null}
            column={columnShown ? columnContent : null}
            peek={showSidebar ? <AppShellPeekLayer key="column-peek"
                widthPx={columnShown ? sidebarWidth : effectiveSidebarWidthPx}
                resolveColumn={resolvePeekColumn} renderColumn={renderPeekColumn} /> : null}
        >
            {routes}
        </AppShellMaterialFrame>
        </NavigatorSafeAreaBleed>
        </InboxSummaryProvider>
        </AppShellPeekProvider>
        </WorkspaceBarGeometryContext.Provider>
        </AppShellColumnContext.Provider>
    );
});
