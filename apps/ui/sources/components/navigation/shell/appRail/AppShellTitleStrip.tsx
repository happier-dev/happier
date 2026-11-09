import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
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
import { usePaneArrangement, usePaneArrangementAvailable } from '@/components/appShell/panes/arrangement/usePaneArrangement';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { AppShellThemeToggle } from './AppShellThemeToggle';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceTitleBar } from '@/components/appShell/workspace/titleBar/WorkspaceTitleBar';
import { WORKSPACE_BAR_CONTROL_GAP_PX } from '@/components/appShell/workspace/titleBar/workspaceBarGeometry';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
    const presentationActive = useLayoutPresentationActive();
    const presentationActiveRef = React.useRef(presentationActive);
    presentationActiveRef.current = presentationActive;
    const dragProps = useDesktopWindowDragMouseProps();
    const history = useDesktopSidebarHistoryNavigationAvailability();
    const windowControls = useResolvedDesktopWindowControls({ variant: 'expanded', desktopWindowControls: undefined, hasDesktopWindowControlsOverride: false });
    const home = React.useCallback(() => {
        if (props.navigation) { props.navigation.openHref('/'); return; }
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) fireAndForget(result, { tag: 'AppShellTitleStrip.home' });
    }, [props.navigation, router]);
    const back = React.useCallback(() => {
        const result = runGuardedNavigation(() => props.navigation ? props.navigation.back() : router.back(), 'history');
        if (result !== true) fireAndForget(result, { tag: 'AppShellTitleStrip.back' });
    }, [props.navigation, router]);
    const forward = React.useCallback(() => {
        const result = runGuardedNavigation(() => {
            if (props.navigation) { props.navigation.forward(); return; }
            (globalThis as { history?: { forward?: () => void } }).history?.forward?.();
        }, 'history');
        if (result !== true) fireAndForget(result, { tag: 'AppShellTitleStrip.forward' });
    }, [props.navigation]);
    const [clusterEndPx, setClusterEndPx] = React.useState(0);
    // The trailing accessories sit at the strip's end, so their start follows from the strip's and
    // their own widths. Both are sizes, which the web reports on every change; the accessories' own
    // position is not (widening the window moves them without resizing them).
    const [stripWidthPx, setStripWidthPx] = React.useState<number | undefined>(undefined);
    const [trailingWidthPx, setTrailingWidthPx] = React.useState<number | undefined>(undefined);
    const onStripLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        if (!presentationActiveRef.current) return;
        const next = Math.round(event.nativeEvent.layout.width);
        setStripWidthPx((current) => current === next ? current : next);
    }, []);
    const onTrailingLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        if (!presentationActiveRef.current) return;
        const next = Math.round(event.nativeEvent.layout.width);
        setTrailingWidthPx((current) => current === next ? current : next);
    }, []);
    const trailingStartPx = stripWidthPx === undefined || trailingWidthPx === undefined ? undefined
        : Math.max(0, stripWidthPx - TITLE_STRIP_END_PADDING_PX - trailingWidthPx - WORKSPACE_BAR_CONTROL_GAP_PX);
    const onClusterLayout = React.useCallback((event: { nativeEvent: { layout: { x: number; width: number } } }) => {
        if (!presentationActiveRef.current) return;
        const { x, width } = event.nativeEvent.layout;
        const next = Math.round(x + width);
        setClusterEndPx((current) => (current === next ? current : next));
    }, []);
    const glyphColor = theme.colors.chrome.header.foreground;
    const toggleLabel = props.columnVisible ? t('common.collapse') : t('common.expand');
    return (
        <View {...dragProps} testID="app-shell-title-strip" style={styles.strip} onLayout={onStripLayout}>
            <DesktopShellWindowControlsHost>{windowControls}</DesktopShellWindowControlsHost>
            <View style={styles.logoSlot}>
                <HappierPressable
                    testID="app-shell-logo"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.home')}
                    onPress={home}
                >
                    <HeaderLogo size={20} />
                </HappierPressable>
            </View>
            <View style={styles.controls} onLayout={onClusterLayout}>
                <IconButton
                    testID="app-shell-back"
                    variant="plain"
                    size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    interactiveTargetGapPx={TITLE_STRIP_CONTROL_GAP_PX}
                    accessibilityLabel={t('common.previous')}
                    disabled={!(props.navigation?.canGoBack ?? history.canNavigateBack)}
                    icon={<Icon name="arrow-left" size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />}
                    onPress={back}
                />
                <IconButton
                    testID="app-shell-forward"
                    variant="plain"
                    size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    interactiveTargetGapPx={TITLE_STRIP_CONTROL_GAP_PX}
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
                        interactiveTargetGapPx={TITLE_STRIP_CONTROL_GAP_PX}
                        accessibilityLabel={toggleLabel}
                        tooltip={toggleLabel}
                        tooltipPlacement="bottom"
                        icon={props.columnVisible
                            ? <SidebarCollapseIcon size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />
                            : <SidebarExpandIcon size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={glyphColor} />}
                        onPress={props.onToggleColumn}
                    />
                ) : null}
                <PaneArrangementToggle glyphColor={glyphColor} />
                <AppShellThemeToggle
                    buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    interactiveTargetGapPx={TITLE_STRIP_CONTROL_GAP_PX}
                    glyphSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                    color={glyphColor}
                />
                <ActionOperationActivityButton
                    testID="app-shell-action-operations"
                    buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
                    interactiveTargetGapPx={TITLE_STRIP_CONTROL_GAP_PX}
                    iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                />
            </View>
            {props.workspaceCatalog ? (
                <WorkspaceTitleBar
                    catalog={props.workspaceCatalog}
                    clusterEndPx={clusterEndPx}
                    stripHeightPx={APP_SHELL_TITLE_STRIP_HEIGHT_PX}
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

/**
 * "Editor first" as a pressed/unpressed toggle (lab ade-shell T1): in the strip's layout group,
 * right of the column button, because both say how the window is laid out. Shown only where the
 * focused destination follows the arrangement; it is the group's last item, so nothing shifts.
 */
const PaneArrangementToggle = React.memo(function PaneArrangementToggle(props: Readonly<{ glyphColor: string }>) {
    const available = usePaneArrangementAvailable();
    const { arrangement, toggle } = usePaneArrangement();
    const shortcut = useKeyboardShortcutLabel('panes.arrangement.toggle');
    if (!available) return null;
    const editorFirst = arrangement === 'editor';
    const label = editorFirst ? t('settingsAppearance.paneArrangementSession') : t('settingsAppearance.paneArrangementEditor');
    return (
        <IconButton
            testID="app-shell-arrangement-toggle"
            variant="plain"
            size={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX}
            interactiveTargetGapPx={TITLE_STRIP_CONTROL_GAP_PX}
            accessibilityLabel={t('settingsAppearance.paneArrangementEditor')}
            checked={editorFirst}
            selected={editorFirst}
            tooltip={shortcut ? `${label} · ${shortcut}` : label}
            tooltipPlacement="bottom"
            icon={<Icon name="square-split-horizontal" size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={props.glyphColor} />}
            onPress={toggle}
        />
    );
});

/** The gap between the strip's controls: their hit areas split it, so neighbours never overlap. */
const TITLE_STRIP_CONTROL_GAP_PX = 8;

/** The strip's own end inset, after its trailing accessories. */
const TITLE_STRIP_END_PADDING_PX = 12;

const stylesheet = StyleSheet.create(() => ({
    strip: {
        position: 'relative',
        height: APP_SHELL_TITLE_STRIP_HEIGHT_PX,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: TITLE_STRIP_END_PADDING_PX,
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
        gap: TITLE_STRIP_CONTROL_GAP_PX,
    },
    trailing: {
        marginLeft: 'auto',
        flexShrink: 1,
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
