import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { Icon } from '@/components/ui/icons/Icon';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { DesktopShellWindowControlsHost } from '../desktopChrome/DesktopShellWindowControlsHost';
import {
    DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX,
} from '../desktopChrome/desktopChromeMetrics';
import { useDesktopSidebarHistoryNavigationAvailability } from '../desktopChrome/useDesktopSidebarHistoryNavigationAvailability';
import { useResolvedDesktopWindowControls } from '../desktopChrome/useResolvedDesktopWindowControls';
import { SidebarCollapseIcon, SidebarExpandIcon } from '../SidebarIcons';
import { APP_RAIL_WIDTH_PX, APP_SHELL_TITLE_STRIP_HEIGHT_PX } from './appRailMetrics';
import { AppShellThemeToggle } from './AppShellThemeToggle';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceTitleBar } from '@/components/appShell/workspace/titleBar/WorkspaceTitleBar';
import { WORKSPACE_BAR_CONTROL_GAP_PX } from '@/components/appShell/workspace/titleBar/workspaceBarGeometry';

/**
 * The strip across the top of the window (lab `xrail-R1`): the window's own controls where the host
 * draws them (macOS traffic lights, or custom controls), the Happier logo over the rail column (it
 * opens the home screen), then back, forward, the column toggle and the light/dark toggle. On the web
 * the logo is the top-left corner. Hiding the column keeps the rail. The strip is a window drag region
 * on desktop; with the workspace open it also carries the top-row panes' tabs, each over its pane
 * (workspace lab T/S), and the gaps between them stay part of the drag region.
 */
export const AppShellTitleStrip = React.memo(function AppShellTitleStrip(props: Readonly<{
    columnVisible: boolean;
    /** False where the open destination has no column to show or hide. */
    columnToggleAvailable: boolean;
    onToggleColumn: () => void;
    navigation?: Readonly<{
        canGoBack: boolean;
        canGoForward: boolean;
        back: () => void;
        forward: () => void;
        openHref: (href: string) => void;
    }>;
    /**
     * The destination catalog, when the open workspace's top-row tabs live in this strip (workspace
     * lab T). The strip then carries those tabs after its own controls.
     */
    workspaceCatalog?: readonly CompactAppDestination[];
    /** Interactive trailing chrome; its measured span is reserved from workspace tabs. */
    trailing?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const dragProps = useDesktopWindowDragMouseProps();
    const history = useDesktopSidebarHistoryNavigationAvailability();
    const windowControls = useResolvedDesktopWindowControls({ variant: 'expanded', desktopWindowControls: undefined, hasDesktopWindowControlsOverride: false });
    const home = React.useCallback(() => {
        if (props.navigation) { props.navigation.openHref('/'); return; }
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) fireAndForget(result, { tag: 'AppShellTitleStrip.home' });
    }, [props.navigation, router]);
    const back = React.useCallback(() => {
        if (props.navigation) { props.navigation.back(); return; }
        const result = runGuardedNavigation(() => router.back());
        if (result !== true) fireAndForget(result, { tag: 'AppShellTitleStrip.back' });
    }, [props.navigation, router]);
    const forward = React.useCallback(() => {
        if (props.navigation) { props.navigation.forward(); return; }
        const result = runGuardedNavigation(() => {
            (globalThis as { history?: { forward?: () => void } }).history?.forward?.();
        });
        if (result !== true) fireAndForget(result, { tag: 'AppShellTitleStrip.forward' });
    }, [props.navigation]);
    const [clusterEndPx, setClusterEndPx] = React.useState(0);
    const [trailingStartPx, setTrailingStartPx] = React.useState<number | undefined>(undefined);
    const onTrailingLayout = React.useCallback((event: { nativeEvent: { layout: { x: number } } }) => {
        const next = Math.max(0, Math.round(event.nativeEvent.layout.x) - WORKSPACE_BAR_CONTROL_GAP_PX);
        setTrailingStartPx((current) => current === next ? current : next);
    }, []);
    const onClusterLayout = React.useCallback((event: { nativeEvent: { layout: { x: number; width: number } } }) => {
        const { x, width } = event.nativeEvent.layout;
        const next = Math.round(x + width);
        setClusterEndPx((current) => (current === next ? current : next));
    }, []);
    const glyphColor = theme.colors.chrome.header.foreground;
    const toggleLabel = props.columnVisible ? t('common.collapse') : t('common.expand');
    const stripHeightPx = Math.max(APP_SHELL_TITLE_STRIP_HEIGHT_PX, resolveTouchTargetFloorPx() ?? 0);
    return (
        <View {...dragProps} testID="app-shell-title-strip" style={[styles.strip, { height: stripHeightPx }]}>
            <DesktopShellWindowControlsHost>{windowControls}</DesktopShellWindowControlsHost>
            <View style={styles.logoSlot}>
                <Pressable
                    testID="app-shell-logo"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.home')}
                    hitSlop={8}
                    onPress={home}
                >
                    <HeaderLogo size={20} />
                </Pressable>
            </View>
            <View style={styles.controls} onLayout={onClusterLayout}>
                <IconButton
                    testID="app-shell-back"
                    variant="plain"
                    size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    accessibilityLabel={t('common.previous')}
                    disabled={!(props.navigation?.canGoBack ?? history.canNavigateBack)}
                    icon={<Icon name="arrow-left" size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />}
                    onPress={back}
                />
                <IconButton
                    testID="app-shell-forward"
                    variant="plain"
                    size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    accessibilityLabel={t('common.next')}
                    disabled={!(props.navigation?.canGoForward ?? history.canNavigateForward)}
                    icon={<Icon name="arrow-right" size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />}
                    onPress={forward}
                />
                {props.columnToggleAvailable ? (
                    <IconButton
                        testID="app-shell-column-toggle"
                        variant="plain"
                        size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                        accessibilityLabel={toggleLabel}
                        tooltip={toggleLabel}
                        tooltipPlacement="bottom"
                        icon={props.columnVisible
                            ? <SidebarCollapseIcon size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />
                            : <SidebarExpandIcon size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />}
                        onPress={props.onToggleColumn}
                    />
                ) : null}
                <AppShellThemeToggle
                    buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    glyphSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                    color={glyphColor}
                />
                <ActionOperationActivityButton
                    testID="app-shell-action-operations"
                    buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                />
            </View>
            {props.workspaceCatalog ? (
                <WorkspaceTitleBar
                    catalog={props.workspaceCatalog}
                    clusterEndPx={clusterEndPx}
                    stripHeightPx={stripHeightPx}
                    trailingStartPx={props.trailing ? trailingStartPx : undefined}
                />
            ) : null}
            {props.trailing ? (
                <View testID="app-shell-title-strip-trailing" style={styles.trailing} onLayout={onTrailingLayout}
                    {...(Platform.OS === 'web' ? { dataSet: { desktopWindowNoDrag: 'true' } } : {})}>
                    {props.trailing}
                </View>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    strip: {
        position: 'relative',
        height: APP_SHELL_TITLE_STRIP_HEIGHT_PX,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 12,
        gap: 4,
    },
    // Centred over the rail, so the logo heads the rail's column of icons.
    logoSlot: {
        width: APP_RAIL_WIDTH_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    trailing: {
        marginLeft: 'auto',
        flexShrink: 1,
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
