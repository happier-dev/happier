import * as React from 'react';
import { Stack, usePathname } from 'expo-router';
import { View, useWindowDimensions, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { ResizableDockedPane, type ResizableDockedPaneCommitMeta } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { resolveSidebarDockMaxWidthPx, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { AppRail } from './appRail/AppRail';
import { AppShellColumn } from './appRail/AppShellColumn';
import { AppShellTitleStrip } from './appRail/AppShellTitleStrip';
import { AppShellPeekLayer, AppShellPeekProvider } from './appRail/AppShellPeek';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';
import {
    resolveAppRailEntryColumn,
    type AppShellColumn as AppShellColumnModel,
    type AppShellShownColumn,
} from './appRail/appRailModel';
import { useAppShellLocation } from './appRail/useAppShellLocation';
import { AppShellColumnContext, type AppShellColumnState } from './appRail/appShellColumnContext';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { resolvePaneFocusModeRouteScopeId } from '@/components/appShell/panes/focusMode/resolvePaneFocusModeRouteScopeId';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { AppShellMaterialFrame } from './AppShellMaterialFrame';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { useWorkspaceShellEnabled } from '@/components/appShell/workspace/useWorkspaceShellEnabled';
import { WorkspaceShell } from '@/components/appShell/workspace/WorkspaceShell';
import { createWorkspaceBarGeometry, WorkspaceBarGeometryContext } from '@/components/appShell/workspace/titleBar/workspaceBarGeometry';
import { registerShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { VoiceTopBarPresenceMount } from '@/components/voice/presence/VoiceTopBarPresence';

/** The title strip's trailing Voice node (Top bar mode); one element, so the strip's memo holds. */
const VOICE_TOP_BAR_TRAILING = <VoiceTopBarPresenceMount />;

// Like the docked column, a peeked one keeps its wheel and touch scrolling from document scroll locks.
const stopPeekScrollPropagation = (event: { stopPropagation?: () => void }) => event.stopPropagation?.();
const PEEK_SCROLL_PROPS = Platform.OS === 'web'
    ? { onWheel: stopPeekScrollPropagation, onTouchMove: stopPeekScrollPropagation }
    : {};
const renderPeekColumn = (column: AppShellColumnModel) => (
    <View style={{ flex: 1, minHeight: 0 }} {...PEEK_SCROLL_PROPS}>
        <AppShellColumn column={column} />
    </View>
);

export const SidebarNavigator = React.memo(() => {
    const pathname = usePathname();
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const workspace = useOptionalWorkspaceNavigation();
    const { state: paneState, dispatch: dispatchPaneAction } = useAppPaneContext();
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
    const sidebarCollapsed = useLocalSetting('sidebarCollapsed');
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const sidebarWidthPx = useLocalSetting('sidebarWidthPx');
    const sidebarWidthBasisPx = useLocalSetting('sidebarWidthBasisPx');
    const [, setSidebarWidthPx] = useLocalSettingMutable('sidebarWidthPx');
    const [, setSidebarWidthBasisPx] = useLocalSettingMutable('sidebarWidthBasisPx');
    const [dragSidebarWidthPx, setDragSidebarWidthPx] = React.useState<number | null>(null);
    const collapseTriggeredDuringDragRef = React.useRef(false);
    const focusedPaneScopeId = paneState.focusMode?.scopeId ?? null;
    const focusedPaneScope = focusedPaneScopeId ? paneState.scopes[focusedPaneScopeId] : undefined;
    const focusedPaneScopeHasFocusablePane = Boolean(focusedPaneScope?.right.isOpen || focusedPaneScope?.details.isOpen);
    const routePaneScopeId = React.useMemo(() => resolvePaneFocusModeRouteScopeId(pathname), [pathname]);
    const focusedPaneScopeMatchesRoute =
        focusedPaneScopeId != null
        && focusedPaneScopeId === routePaneScopeId
        && paneState.activeScopeId === focusedPaneScopeId
        && focusedPaneScopeHasFocusablePane;
    const paneFocusModeChromeActive = showSidebar && focusedPaneScopeMatchesRoute;

    const stopScrollEventPropagationOnWeb = React.useCallback((event: { stopPropagation?: () => void }) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views
        // (including the permanent sidebar). Stopping propagation here keeps scroll events
        // within the sidebar subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const sidebarMaxWidthPx = React.useMemo(() => resolveSidebarDockMaxWidthPx(windowWidth), [windowWidth]);

    const effectiveSidebarWidthPx = React.useMemo(() => {
        return resolveScaledPaneWidthPx({
            preferredWidthPx: sidebarWidthPx,
            basisContainerWidthPx: sidebarWidthBasisPx,
            containerWidthPx: windowWidth,
            minPx: SIDEBAR_DOCK_MIN_WIDTH_PX,
            maxPx: sidebarMaxWidthPx,
        });
    }, [sidebarMaxWidthPx, sidebarWidthBasisPx, sidebarWidthPx, windowWidth]);

    const effectiveSidebarCollapsed = Boolean(sidebarCollapsed || paneFocusModeChromeActive);

    React.useEffect(() => {
        if (!focusedPaneScopeId) return;
        if (focusedPaneScopeMatchesRoute) return;
        dispatchPaneAction({ type: 'exitFocusMode', scopeId: focusedPaneScopeId });
    }, [dispatchPaneAction, focusedPaneScopeId, focusedPaneScopeMatchesRoute]);

    // The column shows when the open destination has one and the person has not hidden it; the rail
    // stays either way. Hidden chrome reserves no horizontal space.
    const columnShown = showSidebar && !effectiveSidebarCollapsed && column.kind !== 'none';
    const sidebarWidth = React.useMemo(() => {
        if (!columnShown) return 0;
        return dragSidebarWidthPx ?? effectiveSidebarWidthPx;
    }, [columnShown, dragSidebarWidthPx, effectiveSidebarWidthPx]);
    const shellLeftPx = showSidebar ? APP_RAIL_WIDTH_PX + sidebarWidth : 0;
    const appShellState = React.useMemo<AppShellColumnState>(
        () => ({ present: showSidebar, columnVisible: columnShown }),
        [columnShown, showSidebar],
    );

    const handleSidebarWidthDrag = React.useCallback((nextWidthPx: number | null, dragMeta?: ResizableDockedPaneCommitMeta | null) => {
        if (nextWidthPx == null) {
            collapseTriggeredDuringDragRef.current = false;
            setDragSidebarWidthPx(null);
            return;
        }

        const shouldCollapseToCompactView =
            Platform.OS === 'web'
            && !sidebarCollapsed
            && !collapseTriggeredDuringDragRef.current
            && nextWidthPx <= SIDEBAR_DOCK_MIN_WIDTH_PX
            && dragMeta?.exceededMinPx === true;

        if (shouldCollapseToCompactView) {
            collapseTriggeredDuringDragRef.current = true;
            setDragSidebarWidthPx(null);
            setSidebarCollapsed(true);
            return;
        }

        setDragSidebarWidthPx(nextWidthPx);
    }, [setSidebarCollapsed, sidebarCollapsed]);

    const handleSidebarWidthCommit = React.useCallback((nextWidthPx: number) => {
        collapseTriggeredDuringDragRef.current = false;
        setDragSidebarWidthPx(null);
        setSidebarWidthPx(nextWidthPx);
        setSidebarWidthBasisPx(windowWidth);
    }, [setSidebarWidthBasisPx, setSidebarWidthPx, windowWidth]);

    const stackNavigationOptions = React.useMemo(() => ({
        lazy: false,
        headerShown: false,
        ...(isDesktopOverlayWindow
            ? {
                contentStyle: {
                    backgroundColor: 'transparent',
                },
            }
            : null),
    }), [isDesktopOverlayWindow]);

    const handleSetColumnVisible = React.useCallback((visible: boolean) => {
        if (visible && paneFocusModeChromeActive) dispatchPaneAction({ type: 'exitFocusMode' });
        setSidebarCollapsed(!visible);
    }, [dispatchPaneAction, paneFocusModeChromeActive, setSidebarCollapsed]);
    const handleToggleColumn = React.useCallback(() => handleSetColumnVisible(effectiveSidebarCollapsed),
        [effectiveSidebarCollapsed, handleSetColumnVisible]);
    const columnActionRef = React.useRef({ present: showSidebar, visible: columnShown,
        available: column.kind !== 'none', setVisible: handleSetColumnVisible });
    React.useLayoutEffect(() => {
        columnActionRef.current = { present: showSidebar, visible: columnShown,
            available: column.kind !== 'none', setVisible: handleSetColumnVisible };
    });
    React.useEffect(() => registerShellColumnActionOwner(() => columnActionRef.current), []);

    const columnContent = (
        <ResizableDockedPane
            widthPx={sidebarWidth}
            minWidthPx={SIDEBAR_DOCK_MIN_WIDTH_PX}
            maxWidthPx={sidebarMaxWidthPx}
            resizeEdge="right"
            onDragWidthPx={handleSidebarWidthDrag}
            onCommitWidthPx={handleSidebarWidthCommit}
        >
            <View
                style={{ flex: 1, flexShrink: 0, minHeight: 0 }}
                {...(Platform.OS === 'web'
                    ? { onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb }
                    : {})}
            >
                <AppShellColumn column={column} />
            </View>
        </ResizableDockedPane>
    );

    // Responsive chrome changes geometry, never the route navigator or its ancestry.
    return (
        <AppShellColumnContext.Provider value={appShellState}>
        <WorkspaceBarGeometryContext.Provider value={showSidebar ? workspaceBarGeometry : null}>
        <AppShellPeekProvider enabled={showSidebar} currentId={column.kind === 'none' ? null : location.railEntryId} columnShown={columnShown}>
        <InboxSummaryProvider>
        <AppShellMaterialFrame
            showChrome={showSidebar}
            dragEnabled={showSidebar && Platform.OS === 'web' && isDesktopHost()}
            leftOffsetPx={shellLeftPx}
            sidebarWidth={sidebarWidth}
            titleStrip={showSidebar ? (
                <AppShellTitleStrip key="title-strip" columnVisible={columnShown}
                    columnToggleAvailable={column.kind !== 'none'} onToggleColumn={handleToggleColumn}
                    navigation={workspace?.active ? workspace : undefined}
                    workspaceCatalog={workspace?.active ? catalog : undefined}
                    trailing={VOICE_TOP_BAR_TRAILING} />
            ) : null}
            rail={showSidebar ? <AppRail key="rail" /> : null}
            column={columnShown ? columnContent : null}
            peek={showSidebar ? <AppShellPeekLayer key="column-peek"
                widthPx={columnShown ? sidebarWidth : effectiveSidebarWidthPx}
                resolveColumn={resolvePeekColumn} renderColumn={renderPeekColumn} /> : null}
        >
            <View style={[{ flex: 1, minWidth: 0, minHeight: 0 }, workspace?.active && { display: 'none' }]}>
                <Stack screenOptions={stackNavigationOptions} />
            </View>
            {workspace?.active ? <WorkspaceShell catalog={catalog} /> : null}
        </AppShellMaterialFrame>
        </InboxSummaryProvider>
        </AppShellPeekProvider>
        </WorkspaceBarGeometryContext.Provider>
        </AppShellColumnContext.Provider>
    );
});
