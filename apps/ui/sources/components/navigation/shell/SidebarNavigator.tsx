import { useAuth } from '@/auth/context/AuthContext';
import * as React from 'react';
import { Stack, usePathname, useSegments } from 'expo-router';
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
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { useOnboardingJourneySessionActive } from '@/components/onboarding/tour/state/journeySession';

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

/**
 * Radius on the sidebar-facing side of the content sheet only. The window-facing edges stay
 * square so the sheet reads as flush to the window and never stacks its own curve on top of
 * the OS window's rounded corners.
 */
const CONTENT_SHEET_SEAM_RADIUS_PX = 16;

const stylesheet = StyleSheet.create((theme) => ({
    desktopDrawerRoot: {
        flex: 1,
        position: 'relative',
        // The plane the content sheet lies on. Painted here so the sheet's rounded
        // sidebar-facing corners reveal the canvas rather than whatever is behind the app.
        backgroundColor: theme.colors.background.canvas,
    },
    /**
     * The seam shadow. An inert overlay tracing the content sheet's exact footprint — same left
     * corners, transparent fill — whose only job is to cast the sheet's lift shadow leftward onto
     * the sidebar.
     *
     * It must be a separate element: react-navigation wraps the scene in an overflow:hidden
     * container (react-native-drawer-layout Drawer.native.tsx), so a shadow declared on the scene
     * itself is clipped at the seam and never reaches the sidebar. It must also be sheet-SHAPED
     * rather than a strip, or the cast runs straight past the rounded corners.
     */
    contentSheetSeamShadow: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        borderTopLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
        borderBottomLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
        zIndex: 2,
        boxShadow: theme.dark
            ? '-5px 0 22px rgba(0, 0, 0, 0.13)'
            : '-5px 0 22px rgba(0, 0, 0, 0.035)',
    },
}));

function isPublicNonHomeRoute(segments: readonly string[]): boolean {
    const normalizedSegments = segments.filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
    if (normalizedSegments.length === 0 || normalizedSegments[0] === 'index') {
        return false;
    }
    return isPublicRouteForUnauthenticated([...segments]);
}

export const SidebarNavigator = React.memo(() => {
    const styles = stylesheet;
    const auth = useAuth();
    const pathname = usePathname();
    const segments = useSegments();
    const isTablet = useIsTablet();
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    const { state: paneState, dispatch: dispatchPaneAction } = useAppPaneContext();
    // The onboarding journey host owns the whole viewport until its session ends
    // (visual spec v3 §5): the post-auth setup beats must never render beside the
    // live app sidebar/drawer. Reuse the route-based drawer-bypass seam rather than
    // adding a parallel gate — this covers every authed path (in-session hinge,
    // reload re-latch, replay) on every platform.
    const bypassDesktopDrawerShell =
        onboardingJourneyActive
        || (Platform.OS === 'web'
            && (isTerminalConnectWebPathname(pathname) || isPublicNonHomeRoute(segments)));
    const desktopDrawerEnabled = auth.isAuthenticated && isTablet && !isDesktopOverlayWindow;
    const drawerShellEnabled =
        desktopDrawerEnabled
        || (Platform.OS === 'web' && isTablet && !isDesktopOverlayWindow);
    const showPermanentDrawer = desktopDrawerEnabled && !bypassDesktopDrawerShell;
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
    const paneFocusModeChromeActive = showPermanentDrawer && focusedPaneScopeMatchesRoute;

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
        if (!showPermanentDrawer) return 0;
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

        if (!showPermanentDrawer) {
            return {
                ...base,
                drawerType: 'permanent' as const,
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
                // No right border: the seam is the content sheet's rounded edge plus its cast.
                width: drawerWidth,
                // react-native-drawer-layout stacks the permanent drawer at z-index 1, above the
                // scene, which swallows the sheet's left-cast shadow. Dropping it to the default
                // order lets DOM order decide (drawer first, scene second). drawerStyle is spread
                // after the library's own zIndex, so this is the correct override point.
                zIndex: 0,
            },
            // The content sheet: flush to the window on top/right/bottom, treated only on the edge
            // that meets the sidebar. Deliberately NO backgroundColor — each route keeps painting
            // what it paints today and this only clips it, so the seam changes geometry, not tone.
            sceneStyle: {
                borderTopLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
                borderBottomLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
                overflow: 'hidden' as const,
                ...(Platform.OS === 'web'
                    ? {}
                    : {
                        borderLeftWidth: StyleSheet.hairlineWidth,
                        borderLeftColor: theme.colors.border.default,
                    }),
            },
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [showPermanentDrawer, drawerWidth, theme.colors.border.default, theme.colors.background.canvas, theme.dark]);

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

    if (!drawerShellEnabled) {
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
            {Platform.OS === 'web' && showPermanentDrawer ? (
                <View
                    pointerEvents="none"
                    style={[styles.contentSheetSeamShadow, { left: drawerWidth }]}
                />
            ) : null}
        </DesktopMainContentDragSurface>
    );
});
