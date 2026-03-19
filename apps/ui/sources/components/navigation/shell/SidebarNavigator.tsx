import { useAuth } from '@/auth/context/AuthContext';
import * as React from 'react';
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

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const editorFocusModeEnabled = useLocalSetting('editorFocusModeEnabled');
    const desktopDrawerEnabled = auth.isAuthenticated && isTablet;
    const showPermanentDrawer = desktopDrawerEnabled && !editorFocusModeEnabled;
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
        if (sidebarCollapsed) return SIDEBAR_COLLAPSED_WIDTH_PX;
        return dragSidebarWidthPx ?? effectiveSidebarWidthPx;
    }, [dragSidebarWidthPx, effectiveSidebarWidthPx, showPermanentDrawer, sidebarCollapsed]);

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

        // When the desktop drawer is enabled but hidden (e.g. editor focus mode), ensure we do not
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
            if (sidebarCollapsed) {
                return <CollapsedSidebarView />;
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
        [drawerWidth, handleSidebarWidthCommit, handleSidebarWidthDrag, sidebarCollapsed, sidebarMaxWidthPx]
    );

    return (
        <Drawer
            screenOptions={drawerNavigationOptions}
            drawerContent={showPermanentDrawer ? drawerContent : undefined}
        />
    )
});
