import { useAuth } from '@/auth/context/AuthContext';
import * as React from 'react';
import { Stack, usePathname } from 'expo-router';
import * as ExpoRouterDrawer from 'expo-router/drawer';
import { useIsTablet } from '@/utils/platform/responsive';
import { SidebarView } from './SidebarView';
import { CollapsedSidebarView } from './CollapsedSidebarView';
import { View, useWindowDimensions, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { ResizableDockedPane, type ResizableDockedPaneCommitMeta } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveSidebarDockMaxWidthPx, SIDEBAR_COLLAPSED_WIDTH_PX, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { resolvePaneFocusModeRouteScopeId } from '@/components/appShell/panes/focusMode/resolvePaneFocusModeRouteScopeId';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';

type DrawerNavigatorComponent = typeof ExpoRouterDrawer.Drawer;

function resolveDrawerComponent(module: typeof ExpoRouterDrawer): DrawerNavigatorComponent {
    const candidateModule = module as Record<string, unknown>;
    if ('default' in candidateModule && candidateModule.default) {
        return candidateModule.default as DrawerNavigatorComponent;
    }
    if ('Drawer' in candidateModule && candidateModule.Drawer) {
        return candidateModule.Drawer as DrawerNavigatorComponent;
    }
    throw new Error('expo-router/drawer did not expose a usable Drawer component');
}

const Drawer = resolveDrawerComponent(ExpoRouterDrawer);

const stylesheet = StyleSheet.create(() => ({
    desktopDrawerRoot: {
        flex: 1,
        position: 'relative',
    },
}));

export const SidebarNavigator = React.memo(() => {
    const styles = stylesheet;
    const auth = useAuth();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const { state: paneState, dispatch: dispatchPaneAction } = useAppPaneContext();
    const bypassDesktopDrawerShell = Platform.OS === 'web' && isTerminalConnectWebPathname(pathname);
    const desktopDrawerEnabled = auth.isAuthenticated && isTablet && !isDesktopOverlayWindow;
    const showPermanentDrawer = desktopDrawerEnabled;
    const { theme } = useUnistyles();
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
    const paneFocusModeChromeActive = desktopDrawerEnabled && focusedPaneScopeMatchesRoute;

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views
        // (including the permanent sidebar drawer). Stopping propagation here keeps scroll events
        // within the drawer subtree so native scrolling works.
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

    // Calculate drawer width only when needed
    const drawerWidth = React.useMemo(() => {
        if (!showPermanentDrawer) return 280; // default width; hidden drawers are not rendered
        if (effectiveSidebarCollapsed) return SIDEBAR_COLLAPSED_WIDTH_PX;
        return dragSidebarWidthPx ?? effectiveSidebarWidthPx;
    }, [dragSidebarWidthPx, effectiveSidebarCollapsed, effectiveSidebarWidthPx, showPermanentDrawer]);

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

    const drawerNavigationOptions = React.useMemo(() => {
        const base = {
            lazy: false,
            headerShown: false,
            swipeEnabled: false,
        };

        if (!desktopDrawerEnabled) {
            return {
                ...base,
                drawerType: 'front' as const,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }

        return {
            ...base,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: theme.colors.background.canvas,
                borderRightWidth: StyleSheet.hairlineWidth,
                borderRightColor: theme.colors.border.default,
                width: drawerWidth,
            },
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [desktopDrawerEnabled, showPermanentDrawer, drawerWidth, theme.colors.border.default, theme.colors.background.canvas]);

    const handleExitFocusMode = React.useCallback(() => {
        dispatchPaneAction({ type: 'exitFocusMode' });
    }, [dispatchPaneAction]);

    const handleRequestExpand = React.useCallback(() => {
        if (paneFocusModeChromeActive) {
            dispatchPaneAction({ type: 'exitFocusMode' });
        }
        setSidebarCollapsed(false);
    }, [dispatchPaneAction, paneFocusModeChromeActive, setSidebarCollapsed]);

    // Always render SidebarView but hide it when not needed
    const drawerContent = React.useCallback(
        () => {
            if (effectiveSidebarCollapsed) {
                return (
                    <CollapsedSidebarView
                        focusModeActive={paneFocusModeChromeActive}
                        onExitFocusMode={handleExitFocusMode}
                        onRequestExpand={handleRequestExpand}
                    />
                );
            }
            return (
                <ResizableDockedPane
                    widthPx={drawerWidth}
                    minWidthPx={SIDEBAR_DOCK_MIN_WIDTH_PX}
                    maxWidthPx={sidebarMaxWidthPx}
                    resizeEdge="right"
                    onDragWidthPx={handleSidebarWidthDrag}
                    onCommitWidthPx={handleSidebarWidthCommit}
                >
                    <View
                        style={{ flex: 1, flexShrink: 0, minHeight: 0 }}
                        {...(Platform.OS === 'web'
                            ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                            : {})}
                    >
                        <SidebarView sidebarWidthPx={drawerWidth} />
                    </View>
                </ResizableDockedPane>
            );
        },
        [
            drawerWidth,
            effectiveSidebarCollapsed,
            handleExitFocusMode,
            handleRequestExpand,
            handleSidebarWidthCommit,
            handleSidebarWidthDrag,
            paneFocusModeChromeActive,
            sidebarMaxWidthPx,
        ]
    );

    if (!desktopDrawerEnabled || bypassDesktopDrawerShell) {
        return <Stack screenOptions={stackNavigationOptions} />;
    }

    return (
        <DesktopMainContentDragSurface
            enabled={Platform.OS === 'web' && isTauriDesktop()}
            leftOffsetPx={drawerWidth}
            style={styles.desktopDrawerRoot}
        >
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={showPermanentDrawer ? drawerContent : undefined}
            />
        </DesktopMainContentDragSurface>
    );
});
