import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';
import { HappierPressable, HAPPIER_FOCUS_RING_DELEGATED_STYLE } from '@happier-dev/plugin-ui/presentation';
import { ScrollView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { HorizontalScrollEdgeMask } from '@/components/ui/scroll/HorizontalScrollEdgeMask';
import { resolveHorizontalScrollEdgeMaskRamps, resolveHorizontalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { usePublishCockpitBarScrolls } from './cockpitBarScrollState';
import { COCKPIT_TRACK_MORE_SLOT, resolveCockpitTrackRevealTarget, resolveCockpitTrackRevealX } from './cockpitTrackReveal';
import { CockpitBarFoldedContext } from '../pageBarChromeFold';


const styles = StyleSheet.create((theme) => ({
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 1,
        zIndex: 1,
    },
    iconContainer: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Selection highlight filling the whole active tab (icon + label); the capsule's own padding is the gap
    // to its rim. A subtle overlay of the foreground colour so it reads softly over the glass material.
    activePill: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        borderRadius: 16,
        backgroundColor: theme.colors.text.primary,
        opacity: 0.05,
    },
    label: {
        marginTop: theme.space.s4,
        ...Typography.variant('micro'),
    },
    labelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.text.secondary,
    },
    // The leading tab stays put while the rest scroll; a short hairline marks where the track starts.
    trackDivider: {
        width: StyleSheet.hairlineWidth,
        alignSelf: 'center',
        height: 20,
        marginHorizontal: theme.space.s2,
        backgroundColor: theme.colors.border.default,
    },
    track: {
        flexGrow: 0,
        flexShrink: 1,
    },
    trackContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    trackTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));

export type CockpitTabBadge =
    | Readonly<{ kind: 'count'; value: number }>
    /** Something new behind this tab (the main bar's Inbox and Sessions dots). */
    | Readonly<{ kind: 'dot' }>
    /** Something on this surface is waiting for the person (the Companion's amber dot). */
    | Readonly<{ kind: 'attention' }>
    | Readonly<{ kind: 'diff'; added: number; removed: number; changedFileCount: number }>
    /** A tab's own short status count ("2", "17", "1.8K"); its full words travel in the accessible name. */
    | Readonly<{ kind: 'text'; value: string }>;

export type CockpitTabBarTabDefinition<TSurface extends string> = Readonly<{
    id: TSurface;
    label: string;
    icon: IconName | Readonly<{
        render: (params: Readonly<{
            active: boolean;
            size: number;
            tintColor: string;
        }>) => React.ReactNode;
    }>;
    badge?: CockpitTabBadge;
    /**
     * A detail bar's tab names itself while selected even with labels off (owner 11-06, phone detail bars): its
     * tabs are a page's own sections, not the app's fixed destinations. The main and Session bars stay icon-only (R1).
     */
    namesItselfWhenSelected?: boolean;
    /** The announced name when it says more than the visible label ("Companion, 1 waiting for you"). */
    accessibilityLabel?: string;
    disabled?: boolean;
    unavailableReason?: string;
}>;

type CockpitTabBarProps<TSurface extends string> = Readonly<{
    activeSurface: TSurface;
    barTestId: string;
    tabs: readonly CockpitTabBarTabDefinition<TSurface>[];
    tabTestIdPrefix: string;
    onSurfacePress: (surface: TSurface) => void;
    /** A held tab (right-click on web): the one way into a tab's own menu, for every bar. `anchor` is the tab. */
    onTabLongPress?: (surface: TSurface, anchor: unknown) => void;
    trailing?: React.ReactNode;
    /**
     * `scroll` when the tabs do not fit the capsule: the first tab stays fixed and the rest (with
     * `trailing`) scroll sideways under an edge fade. The bar's presentation decides this from its width
     * (`resolveDetailPhoneBarFit`, the main bar's own slot count); `fit` (the default) renders one row.
     */
    layout?: 'fit' | 'scroll';
    /** A sibling capsule beside the bar, never a tab (the main bar's "+"; see `FloatingTabBarSurface`). */
    trailingAccessory?: React.ReactNode;
    /** The detail bars' opaque band; the main bar floats over the page without one. */
    opaqueBand?: boolean;
    /**
     * Actions that belong to the BAND rather than to any one tab — today, the lateral
     * session swipe's non-gesture equivalent.
     *
     * They are attached to every tab because a tab is the only thing here a screen
     * reader can focus: the band's own container is `pointerEvents="box-none"` and is
     * not an accessibility element, so actions placed on it would never reach the
     * VoiceOver rotor or the TalkBack context menu. `SessionItem` uses the same shape —
     * actions ride the row's existing `Pressable` rather than a new element — so this
     * adds no resting pixels and no extra focus stop.
     */
    bandAccessibilityActions?: readonly Readonly<{ name: string; label: string }>[];
    onBandAccessibilityAction?: (actionName: string) => void;
}>;

/** The live bar: every phone bar renders through it, and it publishes whether it owns the horizontal axis. */
export function CockpitTabBar<TSurface extends string>(props: CockpitTabBarProps<TSurface> & Readonly<{
    /** The main bar sizes its fitting icons to the room its "+" leaves. */
    metrics?: TabBarMetrics;
}>) {
    const insets = useChromeSafeAreaInsets();
    const settingsMetrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    // One bottom chrome at a time (FIN N4): inside a page's own bottom bar only the bar's More stands.
    const folded = React.useContext(CockpitBarFoldedContext);
    usePublishCockpitBarScrolls(!folded && cockpitTabBarScrolls(props));
    if (folded) return <>{props.trailing}</>;
    return <CockpitTabBarView {...props} bottomInset={insets.bottom} metrics={props.metrics ?? settingsMetrics} />;
}

function cockpitTabBarScrolls(props: Pick<CockpitTabBarProps<string>, 'layout' | 'tabs'>): boolean {
    return props.layout === 'scroll' && props.tabs.length > 1;
}

/** Shared controls with captured chrome inputs, including static placement previews. */
export function CockpitTabBarView<TSurface extends string>(props: CockpitTabBarProps<TSurface> & Readonly<{
    bottomInset: number;
    metrics: TabBarMetrics;
}>) {
    const { theme } = useUnistyles();
    const { metrics } = props;
    const anchors = React.useRef(new Map<string, unknown>());
    const renderTab = (tab: CockpitTabBarTabDefinition<TSurface>) => {
        const active = tab.id === props.activeSurface;
        const tintColor = active ? theme.colors.text.primary : theme.colors.text.secondary;
        const hold = props.onTabLongPress && !tab.disabled ? () => props.onTabLongPress?.(tab.id, anchors.current.get(tab.id) ?? null) : undefined;
        return (
            <HappierPressable
                key={tab.id}
                testID={`${props.tabTestIdPrefix}${tab.id}`}
                controlRef={(node) => {
                    if (node) anchors.current.set(tab.id, node);
                    else anchors.current.delete(tab.id);
                }}
                onPress={() => props.onSurfacePress(tab.id)}
                {...(hold ? { onLongPress: hold, onContextMenu: (event: { preventDefault?: () => void }) => { event.preventDefault?.(); hold(); } } : {})}
                disabled={tab.disabled}
                style={(state) => [styles.tab, {
                    minWidth: metrics.tabMinWidth,
                    paddingVertical: metrics.tabPaddingVertical,
                    paddingHorizontal: metrics.tabPaddingHorizontal,
                    borderRadius: metrics.activePillRadius,
                }, HAPPIER_FOCUS_RING_DELEGATED_STYLE,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                accessibilityRole="tab"
                accessibilityLabel={tab.accessibilityLabel ?? tab.label}
                accessibilityHint={tab.unavailableReason}
                selected={active}
                accessibilityActions={props.bandAccessibilityActions}
                onAccessibilityAction={props.onBandAccessibilityAction
                    ? (event) => props.onBandAccessibilityAction?.(event.nativeEvent.actionName)
                    : undefined}
            >
                {active ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
                <View style={styles.iconContainer}>
                    {typeof tab.icon === 'string' ? (
                        <Icon name={tab.icon} size={metrics.iconSize} color={tintColor} />
                    ) : (
                        tab.icon.render({ active, size: metrics.iconSize, tintColor })
                    )}
                    {renderTabBadge(tab.badge, `${props.tabTestIdPrefix}${tab.id}-badge`)}
                </View>
                {metrics.showLabels || (active && tab.namesItselfWhenSelected === true) ? (
                    <Text style={[styles.label, active ? styles.labelActive : styles.labelInactive]}>
                        {tab.label}
                    </Text>
                ) : null}
            </HappierPressable>
        );
    };
    const scrolls = cockpitTabBarScrolls(props);

    return (
        <FloatingTabBarSurface testID={props.barTestId} bottomInset={props.bottomInset} opaqueBand={props.opaqueBand ?? true}
            trailingAccessory={props.trailingAccessory}>
            <Animated.View accessibilityRole="tablist" style={[styles.innerContainer, { gap: metrics.rowGap }]}>
                {scrolls ? (
                    <>
                        {props.tabs[0] ? renderTab(props.tabs[0]) : null}
                        <View style={styles.trackDivider} />
                        <CockpitTabBarTrack activeId={resolveCockpitTrackRevealTarget(props.tabs.map(tab => tab.id), props.activeSurface) ?? undefined}>
                            {props.tabs.slice(1).map(tab => (
                                <CockpitTabBarTrackItem key={tab.id} id={tab.id}>{renderTab(tab)}</CockpitTabBarTrackItem>
                            ))}
                            {props.trailing ? (
                                <CockpitTabBarTrackItem id={COCKPIT_TRACK_MORE_SLOT} style={styles.trackTrailing}>{props.trailing}</CockpitTabBarTrackItem>
                            ) : null}
                        </CockpitTabBarTrack>
                    </>
                ) : (
                    <>
                        {props.tabs.map(renderTab)}
                        {props.trailing}
                    </>
                )}
            </Animated.View>
        </FloatingTabBarSurface>
    );
}

/** The track's edge fade: its own items fade out, so none reads as cut off at the bar's end. */
const TRACK_EDGE_FADE = { fadeSize: 16 } as const;

/**
 * The scrolling part of an overflowing bar. Gesture-handler's ScrollView so it takes part in
 * arbitration with the band's pan, which stays off the horizontal axis while the bar scrolls
 * (`usePublishCockpitBarScrolls`). The fades say "more this way" only while there is more. They mask
 * the track's own pixels (CSS mask on web, `HorizontalScrollEdgeMask` natively): a painted fade has no
 * colour to paint over the bar's glass, and the last item read as hidden under the "+" beside it.
 */
const TrackRevealContext = React.createContext<((id: string, x: number, width: number) => void) | null>(null);

/** Reports where a tab sits in the track, so the track can bring the selected one into view. */
function CockpitTabBarTrackItem(props: Readonly<{ id: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }>) {
    const report = React.useContext(TrackRevealContext);
    return (
        <View style={props.style} onLayout={report ? (event) => report(props.id, event.nativeEvent.layout.x, event.nativeEvent.layout.width) : undefined}>
            {props.children}
        </View>
    );
}

function CockpitTabBarTrack(props: Readonly<{ children: React.ReactNode; activeId?: string }>) {
    const fades = useScrollEdgeFades({ enabledEdges: { left: true, right: true }, overflowThreshold: 4, edgeThreshold: 2 });
    // The selected tab is scrolled into view (Plan 30 §457) when it, or the track's width, changes; a person's own
    // scroll is left alone until then.
    const scrollRef = React.useRef<React.ComponentRef<typeof ScrollView> | null>(null);
    const offset = React.useRef(0);
    const viewport = React.useRef(0);
    const layouts = React.useRef(new Map<string, Readonly<{ x: number; width: number }>>());
    const reveal = React.useCallback(() => {
        const active = props.activeId === undefined ? undefined : layouts.current.get(props.activeId);
        if (!active || viewport.current <= 0) return;
        const x = resolveCockpitTrackRevealX({ ...active, offset: offset.current, viewport: viewport.current, fade: TRACK_EDGE_FADE.fadeSize });
        if (x !== null) scrollRef.current?.scrollTo({ x, animated: false });
    }, [props.activeId]);
    React.useEffect(reveal, [reveal]);
    const report = React.useCallback((id: string, x: number, width: number) => {
        layouts.current.set(id, { x, width });
        if (id === props.activeId) reveal();
    }, [props.activeId, reveal]);
    const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = event.nativeEvent.contentOffset.x;
        fades.onScroll(event);
    };
    const [nativeWidth, setNativeWidth] = React.useState(0);
    const edges = React.useMemo(() => ({ top: false, bottom: false, left: fades.visibility.left, right: fades.visibility.right }),
        [fades.visibility.left, fades.visibility.right]);
    const webMask = React.useMemo(() => Platform.OS === 'web' ? resolveHorizontalScrollEdgeMaskStyle(edges, TRACK_EDGE_FADE) : undefined, [edges]);
    const nativeRamps = React.useMemo(() => Platform.OS === 'web' ? null : resolveHorizontalScrollEdgeMaskRamps(edges, TRACK_EDGE_FADE), [edges]);
    const onViewportLayout = (event: LayoutChangeEvent) => {
        fades.onViewportLayout(event);
        viewport.current = event.nativeEvent.layout.width;
        reveal();
        if (Platform.OS !== 'web') setNativeWidth(event.nativeEvent.layout.width);
    };
    const track = (
        <ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={webMask ?? undefined}
            contentContainerStyle={styles.trackContent}
            onContentSizeChange={fades.onContentSizeChange}
            onScroll={onScroll}
            scrollEventThrottle={32}
        >
            <TrackRevealContext.Provider value={report}>{props.children}</TrackRevealContext.Provider>
        </ScrollView>
    );
    return (
        <View style={styles.track} onLayout={onViewportLayout}>
            {Platform.OS !== 'web' && fades.canScrollX
                ? <HorizontalScrollEdgeMask ramps={nativeRamps} width={nativeWidth}>{track}</HorizontalScrollEdgeMask>
                : track}
        </View>
    );
}

type CockpitTabBarActionProps = Readonly<{
    testID: string;
    label: string;
    icon: IconName;
    expanded?: boolean;
    /** The open surface lives behind this action (a tool opened from More): it reads as the active tab. */
    selected?: boolean;
    onPress: () => void;
}>;

export const CockpitTabBarAction = React.forwardRef<View, CockpitTabBarActionProps>((props, ref) => {
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    return <CockpitTabBarActionView {...props} metrics={metrics} ref={ref} />;
});
CockpitTabBarAction.displayName = 'CockpitTabBarAction';

export const CockpitTabBarActionView = React.forwardRef<View, CockpitTabBarActionProps & Readonly<{ metrics: TabBarMetrics }>>((props, ref) => {
    const { theme } = useUnistyles();
    const { metrics } = props;
    return (
        <HappierPressable
            controlRef={(node) => {
                // The shared portable focus handle is this concrete native/Web View.
                const view = node as View | null;
                if (typeof ref === 'function') ref(view);
                else if (ref) ref.current = view;
            }}
            testID={props.testID}
            onPress={props.onPress}
            style={(state) => [styles.tab, {
                minWidth: metrics.tabMinWidth,
                paddingVertical: metrics.tabPaddingVertical,
                paddingHorizontal: metrics.tabPaddingHorizontal,
                borderRadius: metrics.activePillRadius,
            }, HAPPIER_FOCUS_RING_DELEGATED_STYLE,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
            accessibilityRole={props.selected ? 'tab' : 'button'}
            accessibilityLabel={props.label}
            expanded={props.expanded}
            selected={props.selected === true}
        >
            {props.selected ? <View pointerEvents="none" style={[styles.activePill, { borderRadius: metrics.activePillRadius }]} /> : null}
            <View style={styles.iconContainer}>
                <Icon name={props.icon} size={metrics.iconSize} color={props.selected ? theme.colors.text.primary : theme.colors.text.secondary} />
            </View>
            {metrics.showLabels ? (
                <Text style={[styles.label, props.selected ? styles.labelActive : styles.labelInactive]}>{props.label}</Text>
            ) : null}
        </HappierPressable>
    );
});
CockpitTabBarActionView.displayName = 'CockpitTabBarActionView';

function renderTabBadge(badge: CockpitTabBadge | undefined, testID: string): React.ReactNode {
    if (!badge) {
        return null;
    }
    if (badge.kind === 'count') {
        return <TabBadge variant="count" value={badge.value} tone="neutral" testID={testID} />;
    }
    if (badge.kind === 'dot') {
        return <TabBadge variant="dot" testID={testID} />;
    }
    if (badge.kind === 'text') {
        return <TabBadge variant="count" value={0} text={badge.value} tone="neutral" testID={testID} />;
    }
    if (badge.kind === 'attention') {
        return <TabBadge variant="dot" tone="attention" testID={testID} />;
    }
    return (
        <TabBadge
            variant="diff"
            added={badge.added}
            removed={badge.removed}
            changedFileCount={badge.changedFileCount}
            testID={testID}
        />
    );
}
