import { useAuth } from '@/auth/context/AuthContext';
import * as React from 'react';
import { Stack, usePathname } from 'expo-router';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet } from '@/utils/platform/responsive';
import { SidebarView } from './SidebarView';
import { CollapsedSidebarView } from './CollapsedSidebarView';
import { View, useWindowDimensions, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { ResizableDockedPane, type ResizableDockedPaneCommitMeta } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveSidebarDockMaxWidthPx, SIDEBAR_COLLAPSED_WIDTH_PX, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { resolvePaneFocusModeRouteScopeId } from '@/components/appShell/panes/focusMode/resolvePaneFocusModeRouteScopeId';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';

const TERMINAL_CONNECT_ROUTE = '/terminal/connect';

function isTerminalConnectWebPathname(pathname: string | null | undefined): boolean {
    const route = String(pathname ?? '').split('?')[0]?.replace(/\/+$/, '');
    return route === TERMINAL_CONNECT_ROUTE;
}

const stylesheet = StyleSheet.create(() => ({
    desktopDrawerRoot: {
        flex: 1,
        position: 'relative',
    },
}));

export type SidebarNavigatorProps = Readonly<{
    desktopUpdateIndicator?: React.ReactNode;
}>;

export const SidebarNavigator = React.memo((props: SidebarNavigatorProps) => {
    const styles = stylesheet;
    const auth = useAuth();
    const isTablet = useIsTablet();
    const pathname = usePathname();
    const isDesktopPetOverlayWindow = isDesktopPetOverlayWindowContext();
    const bypassDesktopDrawerShell = Platform.OS === 'web' && isTerminalConnectWebPathname(pathname);
    const desktopDrawerEnabled = auth.isAuthenticated && isTablet && !isDesktopPetOverlayWindow;
    const showPermanentDrawer = desktopDrawerEnabled;
    const routeScopeId = React.useMemo(() => resolvePaneFocusModeRouteScopeId(pathname), [pathname]);
    const { state: paneState, dispatch: dispatchPaneAction } = useAppPaneContext();
    const focusedScopeId = paneState.focusMode.scopeId;
    const focusedScope = focusedScopeId ? paneState.scopes[focusedScopeId] : undefined;
    const paneFocusModeChromeActive =
        Boolean(focusedScopeId)
        && focusedScopeId === routeScopeId
        && paneState.activeScopeId === focusedScopeId
        && Boolean(focusedScope?.right.isOpen || focusedScope?.details.isOpen);
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
    const effectiveSidebarCollapsed = Boolean(sidebarCollapsed || paneFocusModeChromeActive);

    React.useEffect(() => {
        if (!focusedScopeId) return;
        if (focusedScopeId !== routeScopeId) {
            dispatchPaneAction({ type: 'exitFocusMode', scopeId: focusedScopeId });
            return;
        }
        if (!focusedScope?.right.isOpen && !focusedScope?.details.isOpen) {
            dispatchPaneAction({ type: 'exitFocusMode', scopeId: focusedScopeId });
        }
    }, [
        dispatchPaneAction,
        focusedScope?.details.isOpen,
        focusedScope?.right.isOpen,
        focusedScopeId,
        routeScopeId,
    ]);

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
            && !effectiveSidebarCollapsed
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
    }, [effectiveSidebarCollapsed, setSidebarCollapsed]);

    const handleSidebarWidthCommit = React.useCallback((nextWidthPx: number) => {
        collapseTriggeredDuringDragRef.current = false;
        setDragSidebarWidthPx(null);
        setSidebarWidthPx(nextWidthPx);
        setSidebarWidthBasisPx(windowWidth);
    }, [setSidebarWidthBasisPx, setSidebarWidthPx, windowWidth]);

    const handleCollapsedSidebarExpand = React.useCallback(() => {
        if (paneFocusModeChromeActive) {
            dispatchPaneAction({ type: 'exitFocusMode' });
        }
        setSidebarCollapsed(false);
    }, [dispatchPaneAction, paneFocusModeChromeActive, setSidebarCollapsed]);

    const handleCollapsedSidebarExitFocusMode = React.useCallback(() => {
        if (paneFocusModeChromeActive) {
            dispatchPaneAction({ type: 'exitFocusMode' });
        }
    }, [dispatchPaneAction, paneFocusModeChromeActive]);

    const stackNavigationOptions = React.useMemo(() => ({
        lazy: false,
        headerShown: false,
    }), []);

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

        // When the desktop drawer is disabled, ensure we do not
        // keep the permanent drawer layout slot around. Some drawer implementations can reserve
        // space even when the style width is set to 0. Switching to a front drawer avoids that
        // layout reservation while still preserving navigation state (no remount).
        if (!showPermanentDrawer) {
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
                backgroundColor: theme.colors.groupped.background,
                borderRightWidth: StyleSheet.hairlineWidth,
                borderRightColor: theme.colors.divider,
                width: drawerWidth,
            },
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [desktopDrawerEnabled, showPermanentDrawer, drawerWidth, theme.colors.divider, theme.colors.groupped.background]);

    // Always render SidebarView but hide it when not needed
    const drawerContent = React.useCallback(
        () => {
            if (effectiveSidebarCollapsed) {
                return (
                    <CollapsedSidebarView
                        desktopUpdateIndicator={props.desktopUpdateIndicator}
                        focusModeActive={paneFocusModeChromeActive}
                        onExitFocusMode={handleCollapsedSidebarExitFocusMode}
                        onRequestExpand={handleCollapsedSidebarExpand}
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
                        <SidebarView
                            sidebarWidthPx={drawerWidth}
                            desktopUpdateIndicator={props.desktopUpdateIndicator}
                        />
                    </View>
                </ResizableDockedPane>
            );
        },
        [
            drawerWidth,
            effectiveSidebarCollapsed,
            handleCollapsedSidebarExpand,
            handleCollapsedSidebarExitFocusMode,
            handleSidebarWidthCommit,
            handleSidebarWidthDrag,
            paneFocusModeChromeActive,
            props.desktopUpdateIndicator,
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
