import * as React from 'react';
import { APP_SHELL_CONTENT_SHEET_TEST_ID } from './desktopChrome/desktopChromeMetrics';
import { Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { AtmosphereLayer } from '@/components/atmosphere/AtmosphereLayer';
import { glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';
import { appShellColumnPlaneColor, appShellColumnSurface } from './appRail/appShellColumnSurface';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SidebarCollapseIcon } from './SidebarIcons';
import { AppShellTailContext, AppShellTitleMoreHostProvider, type AppShellRightPanelPlacement, type AppShellTail } from './appShellTail';
import { AppShellContentPaneContext } from './appShellContentPane';
import { DEFAULT_RIGHT_PANEL_PLACEMENT, type RightPanelPlacement } from '@/components/appShell/panes/arrangement/useRightPanelPlacement';
import { APP_SHELL_SHEET_INSET_PX, APP_SHELL_SHEET_RADIUS_PX, AppShellMaterialPlane, AppShellSheetCorners, useAppShellCanvasCoat, type AppShellPlaneCoat } from './appShellMaterialPlane';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { HorizontalSafeAreaProvider, useHorizontalSafeArea, useHorizontalSafeAreaContentPadding } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { resolveSidebarInsetSplit } from '@/components/navigation/safeArea/horizontalSafeAreaGeometry';

/**
 * The page is the one lifted sheet: it lies on the window's canvas, inset from the window's right and
 * bottom edges with rounded corners. The rail, the title strip and the navigation column stand around
 * it on that canvas plane (labs `xrail-R1`, calm-shell `csedge.S1`).
 */
const CONTENT_SHEET_RADIUS_PX = APP_SHELL_SHEET_RADIUS_PX;
const CONTENT_SHEET_WINDOW_INSET_PX = APP_SHELL_SHEET_INSET_PX;

const stylesheet = StyleSheet.create((theme) => ({
    columnContent: { flex: 1, minHeight: 0, minWidth: 0 },
    // Armed to hide: the rows step back so the capsule's sentence leads (lab D2).
    columnArmed: { opacity: 0.38 },
    releaseLayer: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    releaseCapsule: {
        flexDirection: 'row', alignItems: 'center', gap: theme.space.s6,
        paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s6,
        borderRadius: 999, borderWidth: StyleSheet.hairlineWidth,
    },
    releaseLabel: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.primary },
    root: {
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    body: {
        flexDirection: 'row',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    chromePlane: {
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    /**
     * The page's slot beside the column. It owns the sheet's place in the row, so the page and its
     * seam move together through ordinary layout when the column's drawn width changes.
     */
    pageSlot: {
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
        minHeight: 0,
    },
    sheetColumn: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
    },
    sheetColumnInset: {
        paddingBottom: CONTENT_SHEET_WINDOW_INSET_PX,
    },
    bottomChrome: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    /**
     * The trailing slot: the window's right inset and the page's action rail before it, on the canvas like
     * the app rail; with the `canvas` placement the page's docked right panel before them.
     */
    tail: {
        flexDirection: 'row',
        flexShrink: 0,
    },
    tailInset: {
        width: CONTENT_SHEET_WINDOW_INSET_PX,
        flexShrink: 0,
        alignSelf: 'stretch',
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    tailHost: {
        flexDirection: 'row',
        flexShrink: 0,
        alignSelf: 'stretch',
    },
    content: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    contentPlane: {
        ...glassSurfacePlaneStyle(theme.colors.surface.base, 'content'),
    },
    contentSheet: {
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        overflow: 'hidden',
    },
    /** A joined right panel's first-action tab continues the page's top edge (R11-2): that corner is square. */
    contentSheetJoinedTop: { borderTopRightRadius: 0 },
    /**
     * The seam shadow. An inert overlay tracing the page sheet's exact footprint (same corners,
     * transparent fill) whose only job is to cast the sheet's lift onto the navigation plane beside it.
     * It is the sheet's sibling, not its child, so the clip never cuts the cast; it lives in the page's
     * slot, so it follows the page edge wherever the column's drawn width puts it.
     */
    contentSheetSeamShadow: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: CONTENT_SHEET_WINDOW_INSET_PX,
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        zIndex: 2,
        boxShadow: theme.colors.shadowSeamCastBoxShadow,
    },
    /** The page casts on both of its edges: the action rail stands on the canvas after it in every placement (R11-1). */
    contentSheetSeamShadowBoth: {
        boxShadow: theme.colors.shadowSeamCastBothBoxShadow,
    },
    /**
     * With the column collapsed the peek floats over the page's leading edge, right after the rail. It
     * slides out from under the rail: the rail's edge clips it, so it never crosses the icons.
     */
    peekLayer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        zIndex: 3,
        overflow: 'hidden',
    },
}));

const JOINED_TOP_TRAILING_CORNER = ['tr'] as const;

/** The page sheet stands above the bottom inset strip in its column. */
const SHEET_CORNER_INSET = { bottom: CONTENT_SHEET_WINDOW_INSET_PX } as const;

/** How much the column edge follows the pointer past its bounds while dragging (lab ade-shell D2). */
const COLUMN_RUBBER_BAND_RESISTANCE = 0.55;

/** The column's drawn width while a drag gives past a bound: a pure function of the core's overshoot. */
export function resolveColumnDrawnWidthPx(widthPx: number, overshootPx: number): number {
    return Math.max(0, widthPx + overshootPx * COLUMN_RUBBER_BAND_RESISTANCE);
}

/**
 * The armed collapse's hint (lab ade-shell D2): while the drag has passed half the column's minimum,
 * the rows fade and this capsule says what releasing does; moving back disarms it.
 */
function ColumnReleaseToHide() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View pointerEvents="none" style={styles.releaseLayer} accessibilityLiveRegion="polite">
            <View style={[styles.releaseCapsule, { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.strong }]}>
                <SidebarCollapseIcon size={16} color={theme.colors.text.primary} />
                <Text numberOfLines={1} style={styles.releaseLabel}>{t('panes.mainColumn.sidebarReleaseToHide')}</Text>
            </View>
        </View>
    );
}

/** Paint and geometry for the real shell, independent of navigation/settings subscriptions. */
export function AppShellMaterialFrame(props: Readonly<{
    showChrome: boolean;
    dragEnabled: boolean;
    leftOffsetPx: number;
    sidebarWidth: number;
    /** Resize feedback supplied by the shared core; the sidebar presentation owns its paint. */
    columnResizeState?: Readonly<{ collapseArmed: boolean; overshootPx: number; dragging: boolean }>;
    titleStrip: React.ReactNode;
    rail: React.ReactNode;
    column: React.ReactNode;
    peek: React.ReactNode;
    /** The person's right panel separation; the frame resolves it for this window (joined by a line without chrome or off the web). */
    rightPanelPlacement?: RightPanelPlacement;
    children: React.ReactNode;
}>) {
    const styles = stylesheet;
    const horizontalArea = useHorizontalSafeArea();
    const titlePadding = useHorizontalSafeAreaContentPadding();
    // The rail owns the leading window edge even while its neighbouring column is collapsed.
    const insetSplit = resolveSidebarInsetSplit(horizontalArea, { sidebarShown: Boolean(props.rail) });
    const { theme } = useUnistyles();
    // The seam lift and the tail hosts are web only, and a phone has no side panel: those keep the sheet.
    const webChrome = props.showChrome && Platform.OS === 'web';
    const separation = webChrome ? props.rightPanelPlacement ?? DEFAULT_RIGHT_PANEL_PLACEMENT : 'line';
    const placement: AppShellRightPanelPlacement = separation === 'separate' ? 'canvas' : 'sheet';
    const divider = separation === 'shadow' ? 'shadow' : 'line';
    const [rightHost, setRightHost] = React.useState<HTMLElement | null>(null);
    const [railHost, setRailHost] = React.useState<HTMLElement | null>(null);
    // On the web a View's ref is its element: the tail hosts a page's panel and rail portal into.
    const attachRightHost = React.useCallback((node: unknown) => setRightHost(node as HTMLElement | null), []);
    const attachRailHost = React.useCallback((node: unknown) => setRailHost(node as HTMLElement | null), []);
    const [titleMoreHost, setTitleMoreHost] = React.useState<HTMLElement | null>(null);
    const attachTitleMoreHost = React.useCallback((node: unknown) => setTitleMoreHost(node as HTMLElement | null), []);
    const contentSheet = React.useRef<View>(null);
    const sheetLayoutListeners = React.useRef(new Set<() => void>());
    const subscribeSheetLayout = React.useCallback((listener: () => void) => {
        sheetLayoutListeners.current.add(listener);
        return () => { sheetLayoutListeners.current.delete(listener); };
    }, []);
    const onSheetLayout = React.useCallback(() => {
        for (const listener of sheetLayoutListeners.current) listener();
    }, []);
    const contentPane = React.useMemo(() => ({ ref: contentSheet, radius: props.showChrome ? CONTENT_SHEET_RADIUS_PX : 0,
        subscribeLayout: subscribeSheetLayout }), [props.showChrome, subscribeSheetLayout]);
    const [pageSlotWidthPx, setPageSlotWidthPx] = React.useState<number | null>(null);
    const containerWidthPx = pageSlotWidthPx === null ? null : Math.max(0, pageSlotWidthPx - CONTENT_SHEET_WINDOW_INSET_PX);
    // The cutouts outside the page's corners take the coat of the plane beside them: the column (or, with it
    // hidden, the canvas) on the leading side, the canvas the rail and the window inset stand on at the trailing side.
    const columnCoat = React.useMemo<AppShellPlaneCoat>(() => ({ group: 'sidebar', color: appShellColumnPlaneColor(theme.colors), translucentColor: theme.colors.surface.selected }), [theme.colors]);
    const chromeCoat = useAppShellCanvasCoat();
    const [trailingTopJoined, setTrailingTopJoined] = React.useState(false);
    const tail = React.useMemo<AppShellTail>(() => ({
        placement,
        divider,
        railOnCanvas: webChrome,
        rightHost: placement === 'canvas' ? rightHost : null,
        railHost: webChrome ? railHost : null,
        railMoreHost: webChrome ? titleMoreHost : null,
        containerWidthPx: webChrome ? containerWidthPx : null,
        joinTrailingTopCorner: setTrailingTopJoined,
    }), [containerWidthPx, divider, placement, railHost, rightHost, titleMoreHost, webChrome]);
    const sheetTopTrailingSquare = webChrome && trailingTopJoined;
    const reducedMotion = useReducedMotionPreference();
    // Released past a bound, the edge springs back to the width it kept instead of snapping; while the
    // pointer holds it, it follows 1:1. Reduced motion: it is placed at once.
    const columnSpringBack = Platform.OS === 'web' && !reducedMotion && props.columnResizeState?.dragging !== true ? {
        transitionProperty: 'width',
        transitionDuration: `${motionTokens.spring.travel.durationMs}ms`,
        transitionTimingFunction: motionTokens.easingCss.standard,
    // react-native-web transition style keys; React Native's ViewStyle does not declare them.
    } as unknown as ViewStyle : null;
    return <DesktopMainContentDragSurface enabled={props.dragEnabled} leftOffsetPx={props.leftOffsetPx}
        style={styles.root}>
        {/* The atmosphere's picture lies under every plane; route changes only change the content coat. */}
        <AtmosphereLayer sheetRadius={CONTENT_SHEET_RADIUS_PX} chrome={props.showChrome} />
        {props.titleStrip ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={styles.chromePlane}>
            <RetainedPanelSurface isActive={props.showChrome}>
                <View style={titlePadding}><AppShellTitleMoreHostProvider value={attachTitleMoreHost}>{props.titleStrip}</AppShellTitleMoreHostProvider></View>
            </RetainedPanelSurface>
        </AppShellMaterialPlane> : null}
        <View key="shell-body" style={styles.body}>
            {props.rail ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={[styles.chromePlane, {
                width: APP_RAIL_WIDTH_PX + insetSplit.sidebar.padding,
                paddingLeft: insetSplit.sidebar.padding,
                flexShrink: 0,
            }]}>
                {props.rail}
            </AppShellMaterialPlane> : null}
            {props.column ? <AppShellMaterialPlane key="column" testID="navigation-sidebar" group="sidebar" color={appShellColumnPlaneColor(theme.colors)}
                translucentColor={theme.colors.surface.selected} style={[appShellColumnSurface.column, {
                    // Past either bound the edge gives a little (rubber band), a pure function of the drag.
                    width: resolveColumnDrawnWidthPx(props.sidebarWidth, props.columnResizeState?.overshootPx ?? 0),
                }, columnSpringBack]}>
                <View style={[styles.columnContent, props.columnResizeState?.collapseArmed ? styles.columnArmed : null]}>
                    {props.column}
                </View>
                {props.columnResizeState?.collapseArmed ? <ColumnReleaseToHide /> : null}
                {/* A peek over the open column stands in its place, on its plane (`AppShellPeekLayer`). */}
                {props.peek}
            </AppShellMaterialPlane> : null}
            <View key="page-slot" style={styles.pageSlot} onLayout={(event) => {
                const next = Math.round(event.nativeEvent.layout.width);
                setPageSlotWidthPx((previous) => (previous === next ? previous : next));
            }}>
                <View key="sheet-column" style={[styles.sheetColumn, props.showChrome && styles.sheetColumnInset]}>
                    {props.showChrome ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} pointerEvents="none" style={styles.bottomChrome} /> : null}
                    <View key="sheet" testID={APP_SHELL_CONTENT_SHEET_TEST_ID} ref={contentSheet} onLayout={onSheetLayout} style={[styles.content, props.showChrome && styles.contentSheet, sheetTopTrailingSquare && styles.contentSheetJoinedTop]}>
                        <AppShellMaterialPlane key="route-content" group="content" color={theme.colors.surface.base} translucentColor={theme.colors.surface.selected} style={[styles.content, styles.contentPlane]}>
                            <AppShellTailContext.Provider value={tail}>
                                <AppShellContentPaneContext.Provider value={contentPane}>
                                    <HorizontalSafeAreaProvider value={insetSplit.content}>{props.children}</HorizontalSafeAreaProvider>
                                </AppShellContentPaneContext.Provider>
                            </AppShellTailContext.Provider>
                        </AppShellMaterialPlane>
                    </View>
                    {props.showChrome ? <AppShellSheetCorners testIDPrefix="app-shell-sheet-corner" inset={SHEET_CORNER_INSET}
                        leading={props.column ? columnCoat : chromeCoat} trailing={chromeCoat}
                        omit={sheetTopTrailingSquare ? JOINED_TOP_TRAILING_CORNER : undefined} /> : null}
                    {Platform.OS === 'web' && props.showChrome ? <View pointerEvents="none"
                        style={[styles.contentSheetSeamShadow, styles.contentSheetSeamShadowBoth, sheetTopTrailingSquare && styles.contentSheetJoinedTop]} /> : null}
                </View>
                {/* The tail paints nothing itself: a canvas panel is its own sheet with its own coats (no canvas
                    behind its translucent page coat), the rail coats the canvas around its tab, and the window inset its strip. */}
                {props.showChrome ? <View key="tail" testID="app-shell-tail" style={styles.tail}>
                    <View ref={attachRightHost} testID="app-shell-tail-right" style={styles.tailHost} />
                    <View ref={attachRailHost} testID="app-shell-tail-rail" style={styles.tailHost} />
                    <AppShellMaterialPlane testID="app-shell-tail-inset" group={chromeCoat.group} color={chromeCoat.color}
                        translucentColor={chromeCoat.translucentColor} style={styles.tailInset} />
                </View> : null}
            </View>
            {props.peek && !props.column ? <View pointerEvents="box-none" style={[styles.peekLayer, { left: props.rail ? APP_RAIL_WIDTH_PX + insetSplit.sidebar.padding : 0 }]}>
                {props.peek}
            </View> : null}
        </View>
    </DesktopMainContentDragSurface>;
}
