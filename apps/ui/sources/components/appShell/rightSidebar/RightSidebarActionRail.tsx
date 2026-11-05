import * as React from 'react';
import { Platform, StyleSheet as NativeStyleSheet, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import Color from 'color';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { PANE_ACTION_RAIL_WIDTH, PaneActionRailContext } from '@/components/appShell/panes/PaneActionRailContext';
import { APP_SHELL_SHEET_RADIUS_PX, AppShellMaterialPlane, AppShellSheetCorners, useAppShellCanvasCoat } from '@/components/navigation/shell/appShellMaterialPlane';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE, Icon, type IconName } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { t } from '@/text';
import { Modal } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveNavigationOverflow, resolveNavigationPlacements, type DetailNavigationAddress, type NavigationDefaultPlacement, type NavigationPlacement, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { PluginRightSidebarCountState, PluginRightSidebarCountsState, pluginRightSidebarCountHasContent, formatPluginRightSidebarCount,
    type PluginRightSidebarLabelledCount, type PluginRightSidebarCountDescriptor } from './rightSidebarPluginCount';
import { PluginDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { AppShellTailSlot } from '@/components/navigation/shell/appShellTail';
import { DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX } from '@/components/navigation/shell/desktopChrome/desktopChromeMetrics';
import { resolveAppRailBadgeTone, resolveStrongestAppRailBadge, type AppRailBadgeSignal, type RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';

export type RightSidebarRailAction = Readonly<{
    id: string;
    label: string;
    icon: IconName;
    active: boolean;
    disabled?: boolean;
    disabledReason?: string;
    onPress: () => void;
    badgeCount?: number;
    badge?: React.ReactNode;
    badgeSignal?: AppRailBadgeSignal;
    /** Domain-owned scalar subscriptions are mounted only in the overflow badge leaf. */
    renderBadgeSignal?: (renderSignal: RailBadgeSignalRenderer) => React.ReactNode;
    pluginCount?: PluginRightSidebarCountDescriptor;
    tooltipContent?: React.ReactNode;
    /** A short trailing fact on its overflow row (the machine Computer opens), before any count. */
    detail?: string;
    /**
     * What the action works on (the session rail: code · the session · the machine). A hairline
     * separates consecutive actions of different groups; the order stays the caller's.
     */
    group?: string;
    defaultPlacement?: NavigationDefaultPlacement;
    hasContent?: boolean | null;
    allowedPlacements?: readonly NavigationPlacement[];
}>;

const ACTION_GAP = 4;
/** The concave fillet where the open panel's tab meets the panel's edge. */
const PANEL_TAB_FILLET_PX = 8;
const RAIL_PADDING = 4;
/** The rail's action square on every platform; a finger reaches past it through the shared hit area. */
const RAIL_ACTION_SIZE_PX = 36;
const SEPARATOR_MARGIN = 4;

const styles = StyleSheet.create((theme) => ({
    overflowTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexShrink: 1,
    },
    overflowDetail: {
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    rail: {
        width: PANE_ACTION_RAIL_WIDTH,
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
    actions: { alignItems: 'center', paddingVertical: RAIL_PADDING, gap: ACTION_GAP },
    cell: { alignItems: 'center', justifyContent: 'center' },
    // In the title strip's trailing controls it keeps their gap; an empty slot takes no width.
    moreInTitleBar: { marginRight: theme.space.s8 },
    separator: {
        alignSelf: 'stretch',
        marginHorizontal: theme.space.s10,
        marginVertical: SEPARATOR_MARGIN,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    // On the canvas the first action starts level with the panel's sheet (its own, or the page it joins) (lab
    // csrail R1), so its tab continues that sheet's top edge.
    actionsOnCanvas: { paddingTop: 0 },
    /**
     * The open panel's tab (owner F3): one shape with the panel's own sheet. It reaches from the rail's
     * inner edge (where the panel's sheet ends) to the control's far side, rounds only away from the panel,
     * and meets the panel's edge with concave fillets above and below, like a folder tab on its side.
     */
    tab: { position: 'absolute', left: 0, top: 0, width: PANE_ACTION_RAIL_WIDTH },
    tabMaterial: { position: 'absolute', left: 0, top: 0, bottom: 0 },
    tabBody: {
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
        borderTopRightRadius: APP_SHELL_SHEET_RADIUS_PX, borderBottomRightRadius: APP_SHELL_SHEET_RADIUS_PX,
        overflow: 'hidden',
    },
    // The active action's 2 px ink edge sits on the rail's inner side, toward its panel.
    marker: {
        position: 'absolute', top: 0, bottom: 0,
        width: 2, borderRadius: 1, backgroundColor: theme.colors.text.primary,
    },
}));

type RightSidebarActionRailProps = Readonly<{
    actions: readonly RightSidebarRailAction[];
    surfaceId: 'sessionRail' | 'workspaceRail' | DetailNavigationAddress;
    testID?: string;
    testIDPrefix?: string;
    /** A detail page kind with its own Customize screen (Desktop / Phone, every list) opens it here. */
    onOpenCustomizer?: () => void;
}>;

function PluginCountActions(props: Readonly<{ actions: readonly RightSidebarRailAction[];
    preferences: NavigationPlacementPreferences;
    children: (actions: readonly RightSidebarRailAction[]) => React.ReactNode }>): React.ReactElement {
    const items = React.useMemo(() => props.actions.flatMap(action => action.pluginCount
        && (action.pluginCount.tab.countResourceId || action.pluginCount.tab.counts) && !action.disabled
        ? [{ id: action.id, descriptor: action.pluginCount, active: props.preferences.placements[action.id] !== 'hidden' }] : []),
    [props.actions, props.preferences]);
    return <PluginRightSidebarCountsState items={items} select={pluginRightSidebarCountHasContent}>
        {values => props.children(props.actions.map(action => action.pluginCount
            && (action.pluginCount.tab.countResourceId || action.pluginCount.tab.counts) && !action.disabled
            ? { ...action, hasContent: action.active ? true : values.get(action.id) ?? null } : action))}
    </PluginRightSidebarCountsState>;
}

function PluginCountBadge(props: Readonly<{ action: RightSidebarRailAction; testID?: string }>): React.ReactElement {
    return <PluginRightSidebarCountState descriptor={props.action.pluginCount!}>
        {(count, counts) => <View accessible accessibilityLabel={pluginCountLabel(props.action, count, counts)}>{!counts && count !== null && count > 0
            ? <TabBadge size="compact" variant="count" value={count} tone="neutral" testID={props.testID} />
            : <PluginDestinationBadge badge={props.action.pluginCount?.tab.badge} testID={props.testID} />}</View>}
    </PluginRightSidebarCountState>;
}

function pluginCountLabel(action: RightSidebarRailAction, count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]): string {
    const value = counts || count !== null && count > 0 ? formatPluginRightSidebarCount(count, counts) : action.pluginCount?.tab.badge?.label;
    return value ? `${action.label} ${value}` : action.label;
}

type RailButtonProps = Readonly<{ action: RightSidebarRailAction; prefix: string; size: number; mirrored: boolean;
    panelAttached: boolean; tooltipPlacement: 'left' | 'right'; inactiveGlyphColor: string; customize: () => void }>;

function RailActionButton(props: RailButtonProps): React.ReactElement {
    const descriptor = props.action.pluginCount;
    return descriptor && (descriptor.tab.countResourceId || descriptor.tab.counts) && !props.action.disabled
        ? <PluginRightSidebarCountState descriptor={descriptor}>
            {(count, counts) => <RailActionButtonView {...props} count={count} counts={counts} />}
        </PluginRightSidebarCountState>
        : <RailActionButtonView {...props} count={props.action.badgeCount ?? null} />;
}

function RailActionButtonView(props: RailButtonProps & Readonly<{ count: number | null; counts?: readonly PluginRightSidebarLabelledCount[] }>): React.ReactElement {
    const { theme } = useUnistyles();
    const { action, prefix } = props;
    const label = action.pluginCount ? pluginCountLabel(action, props.count, props.counts) : action.label;
    const badge = action.pluginCount ? !props.counts && props.count !== null && props.count > 0
        ? <TabBadge size="compact" variant="count" value={props.count} tone="neutral" testID={`${prefix}:${action.id}:badge`} />
        : <PluginDestinationBadge badge={action.pluginCount.tab.badge} testID={`${prefix}:${action.id}:badge`} />
        : actionBadge(action, `${prefix}:${action.id}:badge`);
    // The open panel's own tab carries the selection; everywhere else the 2 px edge marker does.
    const tab = action.active && props.panelAttached;
    return <IconButton testID={`${prefix}:${action.id}`} accessibilityLabel={label} tooltip={action.disabledReason ?? label}
        tooltipContent={action.tooltipContent} tooltipPlacement={props.tooltipPlacement} selected={action.active}
        selectedBackground={false} disabled={action.disabled} onPress={action.onPress} onLongPress={props.customize}
        variant="plain" size={props.size} iconSize={18} interactiveTargetVerticalGapPx={ACTION_GAP} icon={<View pointerEvents="none">
            {action.active && !tab ? <View testID={`${prefix}:${action.id}:marker`} style={[styles.marker, props.mirrored ? { right: -9 } : { left: -9 }]} /> : null}
            <Icon name={action.icon} size={ICON_SIZE.md} color={action.active ? theme.colors.text.primary : props.inactiveGlyphColor} />
            {badge}
        </View>} />;
}

function actionBadge(action: RightSidebarRailAction, testID?: string): React.ReactNode {
    if ((action.pluginCount?.tab.countResourceId || action.pluginCount?.tab.counts) && !action.disabled) return <PluginCountBadge action={action} testID={testID} />;
    if (action.pluginCount) return <PluginDestinationBadge badge={action.pluginCount.tab.badge} testID={testID} />;
    return <>{action.badge}{(action.badgeCount ?? 0) > 0
        ? <TabBadge size="compact" variant="count" value={action.badgeCount ?? 0} tone="neutral" testID={testID} /> : null}</>;
}

/**
 * An overflow row's trailing column (lab csrail R1): its detail, then its own count — the plugin count read,
 * the domain-owned scalar leaf (Services, Board) or the static badge. A dot-only signal stays on the More trigger.
 */
function OverflowRowTrailing(props: Readonly<{ action: RightSidebarRailAction; value: PluginCountValue | undefined; testID: string }>): React.ReactElement {
    const { action, value } = props;
    const count = (signal: AppRailBadgeSignal | null) => signal?.kind === 'count' && signal.value > 0
        ? <TabBadge size="compact" variant="count" value={signal.value} tone={signal.tone === 'attention' ? 'attention' : 'neutral'} testID={props.testID} />
        : null;
    const pluginCounted = Boolean((action.pluginCount?.tab.countResourceId || action.pluginCount?.tab.counts) && !action.disabled);
    const badge = typeof value === 'number' && value > 0
        ? count({ kind: 'count', value, tone: 'neutral' })
        : action.renderBadgeSignal && !pluginCounted ? action.renderBadgeSignal(count) : actionBadge(action, props.testID);
    return <View style={styles.overflowTrailing}>
        {action.detail ? <Text variant="meta" numberOfLines={1} style={styles.overflowDetail}>{action.detail}</Text> : null}
        {badge}
    </View>;
}

function staticBadgeSignal(action: RightSidebarRailAction): AppRailBadgeSignal | null {
    if (action.badgeSignal) return action.badgeSignal;
    if ((action.badgeCount ?? 0) > 0) return { kind: 'count', value: action.badgeCount!, tone: 'neutral' };
    const badge = action.pluginCount?.tab.badge;
    return badge ? { kind: 'dot', tone: resolveAppRailBadgeTone({ source: 'plugin', tone: badge.tone }) } : null;
}

type PluginCountValue = number | null | readonly PluginRightSidebarLabelledCount[];
const selectPluginCountValue = (count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]): PluginCountValue => counts ?? count;

function PluginOverflowCounts(props: Readonly<{ actions: readonly RightSidebarRailAction[];
    children: (values: ReadonlyMap<string, PluginCountValue>) => React.ReactNode }>): React.ReactElement {
    const items = React.useMemo(() => props.actions.flatMap(action => {
        const descriptor = action.pluginCount;
        return descriptor && (descriptor.tab.countResourceId || descriptor.tab.counts) && !action.disabled
            ? [{ id: action.id, descriptor }] : [];
    }), [props.actions]);
    return <PluginRightSidebarCountsState items={items} select={selectPluginCountValue}>{props.children}</PluginRightSidebarCountsState>;
}

function OverflowBadgeSignals(props: Readonly<{ actions: readonly RightSidebarRailAction[]; values: ReadonlyMap<string, PluginCountValue>;
    children: (signal: AppRailBadgeSignal | null, labels: readonly string[]) => React.ReactNode }>): React.ReactElement {
        const signals = props.actions.flatMap(action => {
            if (action.renderBadgeSignal && !((action.pluginCount?.tab.countResourceId || action.pluginCount?.tab.counts) && !action.disabled)) return [];
            const count = props.values.get(action.id);
            return [typeof count === 'number' && count > 0
                ? { kind: 'count' as const, value: count, tone: 'neutral' as const } : staticBadgeSignal(action)];
        });
        const labels = props.actions.flatMap(action => {
            const value = props.values.get(action.id);
            return value !== undefined && value !== null && typeof value !== 'number'
                ? [`${action.label} ${formatPluginRightSidebarCount(null, value)}`] : [];
        });
        return <OverflowCustomBadgeSignals actions={props.actions} strongest={resolveStrongestAppRailBadge(signals)}>
            {signal => props.children(signal, labels)}
        </OverflowCustomBadgeSignals>;
}

function OverflowCustomBadgeSignals(props: Readonly<{ actions: readonly RightSidebarRailAction[]; index?: number;
    strongest?: AppRailBadgeSignal | null; children: RailBadgeSignalRenderer }>): React.ReactElement {
    const index = props.index ?? 0;
    const action = props.actions[index];
    if (!action) return <>{props.children(props.strongest ?? null)}</>;
    const next: RailBadgeSignalRenderer = signal => <OverflowCustomBadgeSignals actions={props.actions} index={index + 1}
        strongest={resolveStrongestAppRailBadge([props.strongest ?? null, signal])}>{props.children}</OverflowCustomBadgeSignals>;
    return <>{action.renderBadgeSignal && !((action.pluginCount?.tab.countResourceId || action.pluginCount?.tab.counts) && !action.disabled)
        ? action.renderBadgeSignal(next) : next(null)}</>;
}

function OverflowTrigger(props: Readonly<{ actions: readonly RightSidebarRailAction[]; prefix: string; open: boolean;
    toggle: () => void; customize: () => void; size: number; tooltipPlacement: 'left' | 'right' | 'bottom'; values: ReadonlyMap<string, PluginCountValue> }>): React.ReactElement {
    return <OverflowBadgeSignals actions={props.actions} values={props.values}>{(signal, labels) => {
        const baseLabel = signal?.kind === 'count' ? `${t('common.more')} ${formatExactCount(signal.value)}` : t('common.more');
        const label = labels.length > 0 ? `${baseLabel}, ${labels.join(', ')}` : baseLabel;
        return <IconButton testID={`${props.prefix}:more`} accessibilityLabel={label} tooltip={label}
            tooltipPlacement={props.tooltipPlacement} expanded={props.open} selected={props.actions.some(action => action.active)}
            selectedBackground={false} onPress={props.toggle} onLongPress={props.customize} variant="plain" size={props.size} interactiveTargetVerticalGapPx={ACTION_GAP}
            icon={<View pointerEvents="none"><Icon name="dots-three" size={ICON_SIZE.md} />{signal ? signal.kind === 'count'
                ? <TabBadge size="compact" variant="count" value={signal.value} tone={signal.tone === 'attention' ? 'attention' : 'neutral'} testID={`${props.prefix}:more:badge`} />
                : <TabBadge variant="dot" tone={signal.tone === 'attention' ? 'attention' : 'neutral'} testID={`${props.prefix}:more:badge`} /> : null}</View>} />;
    }}</OverflowBadgeSignals>;
}

export function RightSidebarActionRail(props: RightSidebarActionRailProps): React.ReactElement {
    const { preferences } = useNavigationSurfacePlacement(props.surfaceId);
    const customize = (resolvedActions: readonly RightSidebarRailAction[]) => {
        if (props.onOpenCustomizer) { props.onOpenCustomizer(); return; }
        const staticActions = resolvedActions.map(({ pluginCount, badge: _badge, tooltipContent: _tooltip, renderBadgeSignal: _signal, ...action }) => ({ ...action,
            badge: pluginCount?.tab.badge ? <PluginDestinationBadge badge={pluginCount.tab.badge} /> : undefined,
            badgeSignal: staticBadgeSignal({ ...action, pluginCount }) ?? undefined,
            onPress: () => {} }));
        const renderPreview = (previewPreferences: NavigationPlacementPreferences) => <RightSidebarActionRailView
            {...props} actions={staticActions} preferences={previewPreferences} onCustomize={() => {}} />;
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
            Modal.show({ component: NavigationPlacementCustomizer, props: {
                surfaceId: typeof props.surfaceId === 'string' ? props.surfaceId : 'workspaceRail',
                address: props.surfaceId,
                items: resolvedActions.map((action) => ({ id: action.id, title: action.label, icon: action.icon, group: action.group,
                    defaultPlacement: action.defaultPlacement, hasContent: action.hasContent, allowedPlacements: action.allowedPlacements })),
                renderPreview,
                testID: `${props.testIDPrefix ?? 'right-sidebar-action-rail'}:customizer`,
            } });
        }), { tag: 'RightSidebarActionRail.customize' });
    };
    return <PluginContextualResourceStoreProvider><PluginCountActions actions={props.actions} preferences={preferences}>
        {actions => <RightSidebarActionRailView {...props} actions={actions} preferences={preferences} onCustomize={customize} />}
    </PluginCountActions></PluginContextualResourceStoreProvider>;
}

/**
 * One rail cell's presence (P2 R14, lab csrail R1): an Automatic tab that gains content enters its
 * group slot by growing and fading in, and one that empties leaves the same way reversed. Later cells
 * are displaced, never reordered. Reduced motion places it at once; everything else mounts still.
 */
function RailCellPresence(props: Readonly<{ entering: boolean; leaving: boolean; cellSize: number; onLeft?: () => void;
    onOffset?: (offsetPx: number) => void; children: React.ReactNode }>) {
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(props.entering && !reducedMotion ? 0 : 1);
    const onLeftRef = React.useRef(props.onLeft);
    onLeftRef.current = props.onLeft;
    const onLeft = React.useCallback(() => onLeftRef.current?.(), []);
    React.useEffect(() => {
        const { durationMs, easing } = reanimatedMotionTokens;
        if (props.leaving) {
            if (reducedMotion) { progress.value = 0; onLeft?.(); return; }
            progress.value = withTiming(0, { duration: durationMs.fast, easing: easing.exit }, (finished) => {
                'worklet';
                if (finished && onLeft) runOnJS(onLeft)();
            });
            return;
        }
        if (reducedMotion) progress.value = 1;
        else if (progress.value < 1) progress.value = withTiming(1, { duration: durationMs.base, easing: easing.standard });
    }, [onLeft, progress, props.leaving, reducedMotion]);
    const cellSize = props.cellSize;
    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        height: progress.value * cellSize,
        transform: [{ scale: 0.92 + 0.08 * progress.value }],
    }), [cellSize]);
    const onOffset = props.onOffset;
    return <Animated.View pointerEvents={props.leaving ? 'none' : 'auto'} style={[styles.cell, style]}
        onLayout={onOffset ? (event) => onOffset(event.nativeEvent.layout.y) : undefined}>{props.children}</Animated.View>;
}


/** The tab meets its panel square on the leading side; only its trailing corners round. */
const TAB_LEADING_CORNERS = ['tl', 'bl'] as const;

/** How far the canvas coats run past the rail; the rail column clips them to its own box. */
const CANVAS_COAT_REACH_PX = 4096;

/** The canvas under the rail (R11-1): the coat the app rail stands on, painted through the shell's plane owner. */
function RailCanvasCoat(props: Readonly<{ testID: string; style: ViewStyle }>) {
    const coat = useAppShellCanvasCoat();
    return <View pointerEvents="none" style={[{ position: 'absolute' }, props.style]}>
        <AppShellMaterialPlane testID={props.testID} group={coat.group} color={coat.color} translucentColor={coat.translucentColor}
            style={NativeStyleSheet.absoluteFillObject} />
    </View>;
}

/**
 * The open panel's sheet: `MultiPaneHost` gives every docked panel an opaque `surface.base` sheet, so the tab
 * paints that same sheet, never glass (in the desktop app, glass in the shell's tail is cleared over the bare window).
 */
function PanelMaterial() {
    const { theme } = useUnistyles();
    return <View pointerEvents="none" style={[NativeStyleSheet.absoluteFillObject, { backgroundColor: theme.colors.surface.base }]} />;
}

const filletMask = (edge: 'top' | 'bottom', inside: boolean) => {
    const r = PANEL_TAB_FILLET_PX;
    const [hole, fill] = inside ? ['#000', 'transparent'] : ['transparent', '#000'];
    return `radial-gradient(circle at ${edge === 'top' ? '100% 0%' : '100% 100%'}, ${hole} ${r - 0.5}px, ${fill} ${r + 0.5}px)`;
};

/** A concave fillet joining the tab's edge to the panel's straight edge, in the panel's material. */
function PanelTabFillet(props: Readonly<{ edge: 'top' | 'bottom' }>) {
    const r = PANEL_TAB_FILLET_PX;
    const mask = filletMask(props.edge, false);
    const maskStyle = {
        position: 'absolute', left: 0, width: r, height: r,
        ...(props.edge === 'top' ? { top: -r } : { bottom: -r }),
        maskImage: mask, WebkitMaskImage: mask,
    } satisfies ViewStyle & Pick<React.CSSProperties, 'maskImage' | 'WebkitMaskImage'>;
    return <View pointerEvents="none" style={maskStyle}><PanelMaterial /></View>;
}

/**
 * The canvas around the tab: above and below it, beside it, and inside each fillet's curve. It moves with
 * the tab, so the canvas is never painted under the tab or its fillets and they lie on what the panel lies on.
 */
function TabCanvasCoats(props: Readonly<{ prefix: string; size: number; tabWidth: number; flushTop: boolean }>) {
    const coat = useAppShellCanvasCoat();
    const r = PANEL_TAB_FILLET_PX;
    const reach = CANVAS_COAT_REACH_PX;
    const filletRow = (edge: 'top' | 'bottom') => {
        const mask = filletMask(edge, true);
        const top = edge === 'top' ? -r : props.size;
        return <React.Fragment key={edge}>
            <RailCanvasCoat testID={`${props.prefix}:canvas:${edge}-row`} style={{ top, height: r, left: r, right: 0 }} />
            <RailCanvasCoat testID={`${props.prefix}:canvas:${edge}-fillet`} style={{ top, height: r, left: 0, width: r,
                maskImage: mask, WebkitMaskImage: mask } as ViewStyle} />
        </React.Fragment>;
    };
    const aboveEnd = props.flushTop ? 0 : -r;
    return <>
        <RailCanvasCoat testID={`${props.prefix}:canvas:above`} style={{ top: aboveEnd - reach, height: reach, left: 0, right: 0 }} />
        {props.flushTop ? null : filletRow('top')}
        <RailCanvasCoat testID={`${props.prefix}:canvas:beside`} style={{ top: 0, height: props.size, left: props.tabWidth, right: 0 }} />
        {/* Outside the tab's rounded trailing corners: canvas, never the window behind the app (bare on the desktop). */}
        <AppShellSheetCorners testIDPrefix={`${props.prefix}:canvas:tab`} leading={coat} trailing={coat}
            inset={{ right: PANE_ACTION_RAIL_WIDTH - props.tabWidth }} omit={TAB_LEADING_CORNERS} />
        {filletRow('bottom')}
        <RailCanvasCoat testID={`${props.prefix}:canvas:below`} style={{ top: props.size + r, height: reach, left: 0, right: 0 }} />
    </>;
}

/**
 * The open panel's tab: one element for the rail, so switching panels moves it to the new action, and
 * opening the panel brings it in with the panel. It paints the panel's own material over what the panel
 * lies on (the canvas is left out beneath it), so panel and tab read as one shape (R11-2).
 */
function RailPanelTab(props: Readonly<{ offsetPx: number | null; size: number; flushTop: boolean; canvasPrefix: string | null; testID: string }>) {
    const reducedMotion = useReducedMotionPreference();
    const y = useSharedValue(props.offsetPx ?? 0);
    const opacity = useSharedValue(0);
    const placed = React.useRef(false);
    React.useEffect(() => {
        if (props.offsetPx === null) return;
        const { durationMs, easing } = reanimatedMotionTokens;
        if (!placed.current || reducedMotion) {
            placed.current = true;
            y.value = props.offsetPx;
            opacity.value = reducedMotion ? 1 : withTiming(1, { duration: durationMs.base, easing: easing.standard });
            return;
        }
        y.value = withTiming(props.offsetPx, { duration: durationMs.base, easing: easing.standard });
    }, [opacity, props.offsetPx, reducedMotion, y]);
    const travel = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
    const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
    const tabWidth = (PANE_ACTION_RAIL_WIDTH + props.size) / 2;
    return <Animated.View testID={props.testID} pointerEvents="none" style={[styles.tab, { height: props.size }, travel]}>
        {props.canvasPrefix ? <TabCanvasCoats prefix={props.canvasPrefix} size={props.size} tabWidth={tabWidth} flushTop={props.flushTop} /> : null}
        <Animated.View style={[styles.tabMaterial, { width: tabWidth }, fade]}>
            <View testID={`${props.testID}:sheet`} style={styles.tabBody}><PanelMaterial /></View>
            {/* The first action's tab continues the panel's top edge (the panel squares that corner): no top fillet. */}
            {props.flushTop ? null : <PanelTabFillet edge="top" />}
            <PanelTabFillet edge="bottom" />
        </Animated.View>
    </Animated.View>;
}

type RailCellGhost = Readonly<{ action: RightSidebarRailAction; index: number }>;

/**
 * Which cells move because their content changed: an Automatic tab whose known content turned on
 * (enters) or off (leaves). The first unknown → known answer and every other change apply still.
 */
function useRailCellPresence(catalog: readonly RightSidebarRailAction[], shown: readonly RightSidebarRailAction[],
    preferences: NavigationPlacementPreferences, availableSize: number | null) {
    const previous = React.useRef<Readonly<{
        catalog: ReadonlyMap<string, RightSidebarRailAction>;
        shown: readonly RightSidebarRailAction[];
        shownIds: ReadonlySet<string>;
        preferences: NavigationPlacementPreferences;
        availableSize: number | null;
    }> | null>(null);
    const [ghosts, setGhosts] = React.useState<readonly RailCellGhost[]>([]);
    const prior = previous.current;
    const byId = new Map(catalog.map(action => [action.id, action]));
    const shownIds = new Set(shown.map(action => action.id));
    // Compare inputs, not effective placements: Automatic itself changes effective placement.
    // Fresh equivalent preferences are not a customization change.
    const presentationUnchanged = prior !== null && prior.availableSize === availableSize
        && prior.preferences.orderedIds.length === preferences.orderedIds.length
        && prior.preferences.orderedIds.every((id, index) => preferences.orderedIds[index] === id)
        && Object.keys(prior.preferences.placements).length === Object.keys(preferences.placements).length
        && Object.entries(preferences.placements).every(([id, placement]) => prior.preferences.placements[id] === placement);
    const contentChanged = (id: string, from: boolean, to: boolean) => {
        const before = prior?.catalog.get(id);
        const after = byId.get(id);
        return presentationUnchanged && before?.defaultPlacement === 'auto' && after?.defaultPlacement === 'auto'
            && before.hasContent === from && after.hasContent === to;
    };
    const entering = new Set<string>();
    if (prior) {
        for (const action of shown) {
            if (!prior.shownIds.has(action.id) && contentChanged(action.id, false, true)) entering.add(action.id);
        }
    }
    // A pending exit must not outlive admission, known content, or a fit/customization change.
    const retainedGhosts = ghosts.filter(({ action }) => presentationUnchanged && !shownIds.has(action.id)
        && byId.get(action.id)?.defaultPlacement === 'auto' && byId.get(action.id)?.hasContent === false);
    React.useLayoutEffect(() => {
        previous.current = { catalog: byId, shown, shownIds, preferences, availableSize };
        if (!prior) return;
        const left: RailCellGhost[] = [];
        prior.shown.forEach((action, index) => {
            if (!shownIds.has(action.id) && contentChanged(action.id, true, false)) left.push({ action, index });
        });
        const next = [...retainedGhosts, ...left];
        if (next.length !== ghosts.length || next.some((ghost, index) => ghost !== ghosts[index])) setGhosts(next);
    });
    const removeGhost = React.useCallback((id: string) => setGhosts(current => {
        const next = current.filter(ghost => ghost.action.id !== id);
        return next.length === current.length ? current : next;
    }), []);
    return { entering, ghosts: retainedGhosts, removeGhost };
}

/** Controlled controls reused by the live rail and its static customization preview. */
export function RightSidebarActionRailView(props: RightSidebarActionRailProps & Readonly<{
    preferences: NavigationPlacementPreferences; onCustomize: (actions: readonly RightSidebarRailAction[]) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const prefix = props.testIDPrefix ?? 'right-sidebar-action-rail';
    // The rail mirrors with its column (Editor first puts it at the window's left edge).
    const railContext = React.useContext(PaneActionRailContext);
    const mirrored = railContext?.mirrored === true;
    const onCanvas = railContext?.onCanvas === true;
    const panelAttached = railContext?.panelAttached === true;
    const tooltipPlacement = mirrored ? 'right' : 'left';
    // Inactive glyphs sit one ink step down so the rail reads as its panel's tab strip and the app
    // rail stays the primary navigation (lab ade-shell RL decision C): halfway between secondary and
    // tertiary ink, which keeps non-text contrast where tertiary alone would fail.
    const inactiveGlyphColor = React.useMemo(
        () => Color(theme.colors.text.secondary).mix(Color(theme.colors.text.tertiary), 0.5).rgb().string(),
        [theme.colors.text.secondary, theme.colors.text.tertiary],
    );
    const [height, setHeight] = React.useState<number | null>(null);
    const [moreOpen, setMoreOpen] = React.useState(false);
    const size = RAIL_ACTION_SIZE_PX;
    const placements = resolveNavigationPlacements(props.actions, props.preferences);
    // Cells include a gap; the content has no trailing gap after the final cell.
    const availableSize = height === null ? null : Math.max(0, height - 2 * RAIL_PADDING + (onCanvas ? RAIL_PADDING : 0) + ACTION_GAP);
    const visible = resolveNavigationOverflow(placements.pinned, placements.overflow, {
        availableSize,
        itemSize: size + ACTION_GAP,
        separatorSize: 2 * SEPARATOR_MARGIN + ACTION_GAP + StyleSheet.hairlineWidth,
    });
    const customize = () => {
        setMoreOpen(false);
        props.onCustomize(props.actions);
    };
    const presence = useRailCellPresence(props.actions, visible.shown, props.preferences, availableSize);
    // Where each shown action sits, so the open panel's tab can stand at (and travel to) its action.
    const [cellOffsets, setCellOffsets] = React.useState<Readonly<Record<string, number>>>({});
    const reportCellOffset = React.useCallback((id: string, offsetPx: number) => {
        setCellOffsets(current => current[id] === offsetPx ? current : { ...current, [id]: offsetPx });
    }, []);
    const panelTabAction = panelAttached ? visible.shown.find(action => action.active) ?? null : null;
    const panelTabAtTop = panelTabAction !== null && visible.shown[0] === panelTabAction;
    const onPanelTabAtTop = railContext?.onPanelTabAtTop;
    React.useLayoutEffect(() => {
        onPanelTabAtTop?.(panelTabAtTop);
    }, [onPanelTabAtTop, panelTabAtTop]);
    React.useLayoutEffect(() => () => onPanelTabAtTop?.(false), [onPanelTabAtTop]);
    // Read from placement, not fit: a short window that folds its pinned actions into More keeps its More. A signal
    // More could carry keeps the rail too, so a count is never lost with the column.
    const vacant = placements.pinned.length === 0 && presence.ghosts.length === 0
        && !props.actions.some(action => action.active || action.pluginCount?.tab.countResourceId || action.pluginCount?.tab.counts
            || action.renderBadgeSignal || staticBadgeSignal(action));
    const onVacantChange = railContext?.onVacantChange;
    const moreHost = vacant ? railContext?.vacantMoreHost ?? null : null;
    React.useLayoutEffect(() => { onVacantChange?.(vacant); }, [onVacantChange, vacant]);
    React.useLayoutEffect(() => () => onVacantChange?.(false), [onVacantChange]);
    const cells: Array<Readonly<{ action: RightSidebarRailAction; leaving: boolean }>> = visible.shown.map(action => ({ action, leaving: false }));
    for (const ghost of presence.ghosts) {
        if (cells.some(cell => cell.action.id === ghost.action.id)) continue;
        cells.splice(Math.min(ghost.index, cells.length), 0, { action: ghost.action, leaving: true });
    }
    const moreItems = (values: ReadonlyMap<string, PluginCountValue>): readonly DropdownMenuItem[] => [
        ...visible.overflow.map((action) => {
            const value = values.get(action.id);
            const countLabel = value !== undefined && value !== null && typeof value !== 'number'
                ? formatPluginRightSidebarCount(null, value) : undefined;
            return {
            id: action.id, title: action.label, disabled: action.disabled, subtitle: action.disabledReason ?? countLabel,
            // The rail's groups stay groups in its menu (lab csrail R1), separated by the menu's own seam.
            category: action.group ?? 'other',
            testID: `${prefix}:overflow:${action.id}`,
            icon: <Icon name={action.icon} size={ICON_SIZE.sm} />,
            rightElement: <OverflowRowTrailing action={action} value={value} testID={`${prefix}:overflow:${action.id}:badge`} />,
        }; }),
        { id: 'customize', title: t('navigationPlacement.customize'), icon: <Icon name="sliders-horizontal" size={ICON_SIZE.sm} />, testID: `${prefix}:customize`, category: 'customize' },
    ];
    return (
        <View
            testID={props.testID ?? 'right-sidebar-action-rail'}
            accessibilityRole="toolbar"
            accessibilityLabel={t('common.actions')}
            style={styles.rail}
            // A vacant rail's hidden column reports no height; its last one stands until it returns.
            onLayout={(event) => { const next = event.nativeEvent.layout.height; if (next > 0) setHeight(next); }}
            {...(Platform.OS === 'web' ? { onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); customize(); } } : {})}
        >
            <View style={[styles.actions, onCanvas ? styles.actionsOnCanvas : null]}>
            {/* On the canvas the rail paints nothing of its own: it stands on the canvas the app rail stands on, left out under its panel's tab. */}
            {onCanvas && !panelTabAction ? <RailCanvasCoat testID={`${prefix}:canvas`}
                style={{ top: -CANVAS_COAT_REACH_PX, bottom: -CANVAS_COAT_REACH_PX, left: 0, right: 0 }} /> : null}
            {panelTabAction ? <RailPanelTab testID={`${prefix}:${panelTabAction.id}:tab`} size={size} flushTop={panelTabAtTop}
                canvasPrefix={onCanvas ? prefix : null}
                offsetPx={cellOffsets[panelTabAction.id] ?? null} /> : null}
            {cells.map(({ action, leaving }, index) => (
                <React.Fragment key={action.id}>
                {index > 0 && action.group !== undefined && action.group !== cells[index - 1]!.action.group ? (
                    <View testID={`${prefix}:separator:${action.group}`} style={styles.separator} />
                ) : null}
                <RailCellPresence entering={presence.entering.has(action.id)} leaving={leaving} cellSize={size}
                    onOffset={leaving ? undefined : (offsetPx) => reportCellOffset(action.id, offsetPx)}
                    onLeft={leaving ? () => presence.removeGhost(action.id) : undefined}>
                    <RailActionButton action={action} prefix={leaving ? `${prefix}:leaving` : prefix} size={size} mirrored={mirrored} panelAttached={panelAttached}
                        tooltipPlacement={tooltipPlacement} inactiveGlyphColor={inactiveGlyphColor} customize={customize} />
                </RailCellPresence>
                </React.Fragment>
            ))}
            {visible.overflow.length > 0 || (visible.shown.length === 0 && props.actions.length > 0) ? <AppShellTailSlot host={moreHost}><View style={moreHost ? styles.moreInTitleBar : null}><PluginOverflowCounts actions={visible.overflow}>
                {values => <DropdownMenu
                open={moreOpen}
                onOpenChange={setMoreOpen}
                items={moreItems(values)}
                separateCategories
                selectedId={visible.overflow.find((action) => action.active)?.id ?? null}
                onSelect={(id) => { setMoreOpen(false); if (id === 'customize') customize(); else visible.overflow.find((action) => action.id === id)?.onPress(); }}
                placement={moreHost ? 'bottom' : tooltipPlacement}
                matchTriggerWidth={false}
                trigger={({ toggle, open }) => <OverflowTrigger actions={visible.overflow} prefix={prefix} open={open}
                    toggle={toggle} customize={customize} size={moreHost ? DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX : size}
                    tooltipPlacement={moreHost ? 'bottom' : tooltipPlacement} values={values} />}
            />}</PluginOverflowCounts></View></AppShellTailSlot> : null}
            </View>
        </View>
    );
}
