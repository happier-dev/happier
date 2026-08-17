import * as React from 'react';
import { I18nManager, Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
// Selection equality and the RTL-aware roving destination are NOT owned here. `plugin-ui` is the
// single owner for both rules so that core's tablist and the public `HappierTabs` adapter cannot
// drift apart, and `sharedFamilyOwnership.test.ts` names this file as the required core consumer of
// `resolveHappierTabKeySelection` — importing it is the contract, not a convenience.
import { isHappierTabSelected, resolveHappierTabKeySelection } from '@happier-dev/plugin-ui/presentation';

import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { INSTRUMENT_SPRINGS, useMotionPreferences } from '@/components/instrument';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

/**
 * The glyph size for an icon-only segmented bar.
 *
 * Owned here rather than at the call site because the bar reserves the matching slot height below:
 * the two numbers have to move together, and when they lived apart the icons were sized to the
 * LABEL's optical height (16) and then drawn smaller still, so an iconic bar read lighter than the
 * textual one it replaced. A tab is a primary control in its pane — it takes the standard toolbar
 * step.
 */
export const SEGMENTED_TAB_ICON_SIZE_PX = ICON_SIZE.md;

/**
 * Padding-driven visible heights. These are the numbers that decide how tall the control LOOKS, and
 * they are the only ones allowed to: a segment must never carry a `minHeight`, because a minimum
 * sized for a *touch target* silently becomes the drawn box and inflates every consumer.
 */
const SEGMENT_PADDING_VERTICAL_PX = { default: 7, compact: 4 } as const;

/**
 * The label's optical slot. Nominal — Inter's line box at these sizes — and used only to reason
 * about the press frame below. When the user scales text up the real segment grows past it, which
 * only makes the target larger.
 */
const SEGMENT_LABEL_SLOT_PX = { default: 14, compact: 12 } as const;

/**
 * The track's inset, and therefore the entire vertical budget of the press frame below.
 *
 * One constant because it is one fact wearing three hats: the gap the track paints around its
 * segments, the inset the sliding thumb rides at, and the only space the frame is allowed to claim.
 */
const SEGMENT_TRACK_PADDING_PX = 2;

/**
 * The per-segment width floor.
 *
 * NOT the platform touch target. Segments are flush siblings inside one track, so a 44/48 floor
 * multiplies: the six-step effort control needed 6 x 44 + 4 = 268px of track, and because
 * `minWidth` beats `flexShrink` a narrower card overflowed rather than sharing the row. DESIGN.md
 * routes a dense pointer layout to the applicable WCAG requirement instead, and SC 2.5.8 (Level AA)
 * asks for 24 CSS px — six of those need 148px, which fits. Raising this would require every
 * consumer to guarantee `segments x floor + 4` of width, which none of them can.
 */
const SEGMENT_MIN_WIDTH_PX = 24;

export type SegmentedTab<T extends string = string> = Readonly<{
    id: T;
    label: string;
    /**
     * Optional glyph. When every tab in a bar supplies one, the bar renders icons alone and the
     * label becomes the accessible name — a four-word row of text costs more vertical space than
     * the tabs are worth in a narrow docked panel. Mixed bars keep their labels, so this stays
     * opt-in and the other consumers are unaffected.
     */
    icon?: React.ReactNode;
}>;

export type SegmentedTabBarProps<T extends string = string> = Readonly<{
    tabs: ReadonlyArray<SegmentedTab<T>>;
    activeTabId: T;
    onSelectTab: (tabId: T) => void;
    /** Optional testID prefix – tabs get `${testIDPrefix}:${tab.id}` */
    testIDPrefix?: string;
    /** Compact mode with reduced padding and smaller font */
    compact?: boolean;
    /**
     * Animate ONE shared thumb that spring-translates between segments instead
     * of swapping each tab's own active background (design-vision toggles:
     * "sliding segmented thumb, not text-swap"). Motion-gated: at the minimal
     * level the thumb jumps without a spring.
     */
    slidingThumb?: boolean;
    /**
     * `'equal'` (default): segments share the row width evenly.
     * `'content'`: each segment hugs its label so short labels never
     * ellipsize (e.g. a "Tokens/Cost" metric toggle).
     */
    segmentSizing?: 'equal' | 'content';
    /** Optional active-label style override for specific consumers */
    activeLabelStyle?: StyleProp<TextStyle>;
    /** Accessible name for the tab group. */
    accessibilityLabel?: string;
    /**
     * Renders the whole bar as a non-interactive, dimmed control that still ANNOUNCES itself as
     * disabled. Owned here rather than left to callers: wrapping the bar in
     * `pointerEvents: 'none'` plus an opacity style silences the pointer but leaves every
     * segment announcing as an enabled tab to a screen reader, and leaves it in the tab order.
     */
    disabled?: boolean;
}>;

type TabRect = Readonly<{ x: number; width: number }>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        flexGrow: 1,
        minWidth: 0,
    },
    containerContent: {
        width: 'auto',
        flexGrow: 0,
        alignSelf: 'flex-start',
    },
    inner: {
        flexDirection: 'row',
        backgroundColor: theme.colors.segmentedControl.trackBackground,
        borderRadius: 9,
        padding: SEGMENT_TRACK_PADDING_PX,
        width: '100%',
        flexGrow: 1,
        minWidth: 0,
        position: 'relative',
    },
    innerCompact: {
        borderRadius: 7,
    },
    innerContent: {
        width: 'auto',
        flexGrow: 0,
    },
    // One dim on the track, not per segment: stacking opacity on each Pressable would double up
    // behind the active thumb and read as two different greys.
    innerDisabled: {
        opacity: 0.5,
    },
    /**
     * The PRESS FRAME. Transparent and paint-free: it exists only to be big enough to hit. Its
     * vertical padding is cancelled by an equal negative margin (applied per render — see the
     * vertical budget below), so the pointer box reclaims the track's inset while the row still
     * measures the drawn segment. The frame ends up exactly the size of the track: no overhang.
     *
     * This is plain box model rather than `hitSlop` on purpose: react-native-web 0.21 implements
     * `hitSlop` only in its legacy `Touchable` export — `Pressable` and `View` never read it — and
     * the desktop app IS the web bundle. A slop-declared target there is a target that does not
     * exist, which is why an earlier fix reached for a visible `minHeight` instead and made every
     * segmented control ~15px taller than it should be.
     */
    tabFrame: {
        // Equal mode: grow/shrink/basis as longhands (NOT the `flex: 1`
        // shorthand). On react-native-web the shorthand emits CSS `flex: 1`
        // which forces `flex-basis: 0%`; the content-mode longhand override
        // below then can't reliably win the basis, so content tabs collapse.
        // All-longhands here keeps `flex-basis: auto` unambiguous in content mode.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: SEGMENT_MIN_WIDTH_PX,
        // Stretch, so the drawn surface fills the frame's width exactly: the frame never grows
        // sideways (see the horizontal budget where it is computed), so the two boxes share an edge.
        alignItems: 'stretch',
        justifyContent: 'center',
    },
    tabFrameContent: {
        // Hug the label so a short 6-char label ("Tokens") never ellipsizes
        // (D-R3-3). CRITICAL: use `flexBasis: 'auto'`, never `flex: 0` — RNW
        // maps `flex: 0` to CSS `flex: 0` which sets `flex-basis: 0%`, and with
        // the surface's `overflow: 'hidden'` that collapses the segment to
        // padding-only width and CLIPS the label to nothing (the "naked Switch"
        // regression). `auto` basis sizes the segment to its content.
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
    },
    /** The box that actually paints: background, radius, focus ring, and the visible height. */
    tabSurface: {
        paddingVertical: SEGMENT_PADDING_VERTICAL_PX.default,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
        overflow: 'hidden',
    },
    tabSurfaceCompact: {
        paddingVertical: SEGMENT_PADDING_VERTICAL_PX.compact,
        borderRadius: 5,
    },
    tabSurfaceContent: {
        paddingHorizontal: 12,
    },
    tabActive: {
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    tabFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.strong,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
    thumb: {
        position: 'absolute',
        top: SEGMENT_TRACK_PADDING_PX,
        bottom: SEGMENT_TRACK_PADDING_PX,
        left: 0,
        borderRadius: 7,
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        overflow: 'hidden',
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    thumbCompact: {
        borderRadius: 5,
    },
    // Sized to the glyph, not to the label it replaces. Holding the slot at the label's 16px optical
    // height kept an iconic bar exactly as tall as a textual one, which sounds right and is not: the
    // glyph then has to shrink below its own step to fit, and the bar reads weaker than the words.
    tabIcon: {
        alignItems: 'center',
        justifyContent: 'center',
        height: SEGMENTED_TAB_ICON_SIZE_PX,
    },
    tabLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    tabLabelCompact: {
        fontSize: 10,
    },
    tabLabelActive: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
}));

/** Shared spring-translated thumb (only mounted when `slidingThumb` is on). */
function SlidingThumb(props: Readonly<{
    rect: TabRect | null;
    compact: boolean;
    testID?: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const reduced = motion.level === 'minimal';
    const thumbX = useSharedValue(props.rect?.x ?? 0);
    const thumbWidth = useSharedValue(props.rect?.width ?? 0);
    const placedRef = React.useRef(props.rect != null);

    React.useEffect(() => {
        if (!props.rect) return;
        const { x, width } = props.rect;
        if (!placedRef.current || reduced) {
            // First placement (or reduce-motion): position without travel.
            thumbX.value = x;
            thumbWidth.value = width;
            placedRef.current = true;
            return;
        }
        thumbX.value = withSpring(x, INSTRUMENT_SPRINGS.standard);
        thumbWidth.value = withSpring(width, INSTRUMENT_SPRINGS.standard);
    }, [props.rect, reduced, thumbX, thumbWidth]);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: thumbX.value }],
        width: thumbWidth.value,
    }));

    if (!props.rect) return null;

    return (
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            style={[styles.thumb, props.compact ? styles.thumbCompact : null, animatedStyle]}
        >
            <GradientSurface
                fallbackColor={theme.colors.segmentedControl.activeBackground}
                gradient={theme.colors.segmentedControl.activeGradient}
                borderRadius={props.compact ? 5 : 7}
                style={StyleSheet.absoluteFillObject}
            />
        </Animated.View>
    );
}

function SegmentedTabBarInner<T extends string>(props: SegmentedTabBarProps<T>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const compact = props.compact;
    const disabled = props.disabled === true;
    const slidingThumb = props.slidingThumb === true;
    const contentSized = props.segmentSizing === 'content';
    // Icons replace labels only when the whole bar is iconic; a half-iconic row reads as broken.
    const iconOnly = props.tabs.length > 0 && props.tabs.every((tab) => tab.icon != null);
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    /**
     * The press frame's vertical budget — bounded on BOTH sides.
     *
     * Neither axis is free. Horizontally, segments are flush siblings, so the gap is zero and any
     * sideways growth would stack two tab targets on top of one another. Vertically the segment has
     * no sibling inside the track, but the track is not the end of the world: every consumer stacks
     * this bar against something. In the model card's control list the next control's own segmented
     * bar sits ~13px below (`inlineSelectedControls` gap 10 + a 9pt title + `selectedControlGroup`
     * gap 3), so a frame overhanging the track by the 10-12px the compact floor would ask for
     * overlaps its neighbour's target outright. DESIGN.md forbids overlapping targets in the same
     * sentence that asks for 44/48, and the space to satisfy both is a CONSUMER fact this component
     * cannot see. So it claims only the space it owns: its own track padding.
     *
     * CEILING, stated plainly: the 44pt/48dp platform floor is NOT reached on any variant. What is
     * met everywhere is WCAG 2.2 Level AA SC 2.5.8 (24 x 24 CSS px), which DESIGN.md routes a dense
     * pointer layout to. Resulting target heights (drawn box + this padding on each side):
     *
     *   label  regular  28 + 4 = 32      icon  regular  34 + 4 = 38
     *   label  compact  20 + 4 = 24      icon  compact  28 + 4 = 32
     *
     * Compact-label lands exactly on the 24px floor, which is why the label slot and the surface
     * padding above are load-bearing rather than decorative. Raising this needs vertical room a
     * consumer grants, not a taller drawn control — the visible height is the user's complaint.
     */
    const drawnSegmentHeight = (compact
        ? SEGMENT_PADDING_VERTICAL_PX.compact
        : SEGMENT_PADDING_VERTICAL_PX.default) * 2
        + (iconOnly
            ? SEGMENTED_TAB_ICON_SIZE_PX
            : (compact ? SEGMENT_LABEL_SLOT_PX.compact : SEGMENT_LABEL_SLOT_PX.default));
    const targetExpandY = Math.min(
        SEGMENT_TRACK_PADDING_PX,
        Math.max(0, (minimumInteractiveTargetSize - drawnSegmentHeight) / 2),
    );
    const tabFrameTarget = React.useMemo(() => ({
        paddingVertical: targetExpandY,
        marginVertical: -targetExpandY,
    }), [targetExpandY]);

    // RN Web's Pressable hands `focused` to its own style callback only, and the ring belongs on the
    // drawn surface — around the frame it would outline a box the user cannot see.
    const [focusedTabId, setFocusedTabId] = React.useState<T | null>(null);
    const [tabRects, setTabRects] = React.useState<Readonly<Record<string, TabRect>>>({});
    const tabRefs = React.useRef(new Map<T, React.ElementRef<typeof Pressable> | null>());

    const handleTabLayout = React.useCallback((tabId: string, event: LayoutChangeEvent) => {
        const { x, width } = event.nativeEvent.layout;
        setTabRects((current) => {
            const existing = current[tabId];
            if (existing && existing.x === x && existing.width === width) return current;
            return { ...current, [tabId]: { x, width } };
        });
    }, []);

    const activeRect = tabRects[props.activeTabId] ?? null;
    const activateTabAt = React.useCallback((index: number, focus: boolean) => {
        if (props.disabled === true) return;
        const tab = props.tabs[index];
        if (!tab) return;
        props.onSelectTab(tab.id);
        if (focus) tabRefs.current.get(tab.id)?.focus?.();
    }, [props]);
    const handleTabKeyDown = React.useCallback((tabIndex: number, event: any) => {
        if (Platform.OS !== 'web') return;
        if (props.disabled === true) return;
        const key = event?.nativeEvent?.key ?? event?.key;
        const nextIndex = resolveHappierTabKeySelection({
            tabs: props.tabs,
            currentIndex: tabIndex,
            key,
            rtl: I18nManager.isRTL,
        });
        if (nextIndex === null || props.tabs.length === 0) return;
        event?.preventDefault?.();
        activateTabAt(nextIndex, nextIndex !== tabIndex);
    }, [activateTabAt, props.disabled, props.tabs.length]);

    return (
        <View style={[styles.container, contentSized ? styles.containerContent : null]}>
            <View
                style={[
                    styles.inner,
                    compact ? styles.innerCompact : null,
                    contentSized ? styles.innerContent : null,
                    disabled ? styles.innerDisabled : null,
                ]}
                accessibilityRole="tablist"
                accessibilityLabel={props.accessibilityLabel}
            >
                {slidingThumb ? (
                    <SlidingThumb
                        rect={activeRect}
                        compact={compact === true}
                        testID={props.testIDPrefix ? `${props.testIDPrefix}:thumb` : undefined}
                    />
                ) : null}
                {props.tabs.map((tab, tabIndex) => {
                    const active = isHappierTabSelected(props.activeTabId, tab.id);
                    const showOwnActiveSurface = active && !slidingThumb;
                    const webKeyDownProps = Platform.OS === 'web'
                        ? ({ onKeyDown: (event: any) => handleTabKeyDown(tabIndex, event) } as Record<string, unknown>)
                        : {};
                    return (
                        <Pressable
                            key={tab.id}
                            ref={(node) => {
                                if (node) tabRefs.current.set(tab.id, node);
                                else tabRefs.current.delete(tab.id);
                            }}
                            testID={props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}` : undefined}
                            disabled={disabled}
                            onPress={() => {
                                if (disabled) return;
                                props.onSelectTab(tab.id);
                            }}
                            onFocus={() => setFocusedTabId(tab.id)}
                            onBlur={() => setFocusedTabId((current) => (current === tab.id ? null : current))}
                            {...webKeyDownProps}
                            onLayout={slidingThumb ? (event) => handleTabLayout(tab.id, event) : undefined}
                            style={[
                                styles.tabFrame,
                                contentSized ? styles.tabFrameContent : null,
                                tabFrameTarget,
                            ]}
                            {...(iconOnly ? ({ title: tab.label } as object) : {})}
                            accessibilityRole="tab"
                            accessibilityLabel={tab.label}
                            accessibilityState={{ selected: active, disabled }}
                            aria-selected={active}
                            aria-disabled={disabled || undefined}
                            tabIndex={Platform.OS === 'web' ? (disabled || !active ? -1 : 0) : undefined}
                        >
                            <View
                                style={[
                                    styles.tabSurface,
                                    compact ? styles.tabSurfaceCompact : null,
                                    contentSized ? styles.tabSurfaceContent : null,
                                    showOwnActiveSurface ? styles.tabActive : null,
                                    !disabled && focusedTabId === tab.id ? styles.tabFocused : null,
                                ]}
                            >
                                {showOwnActiveSurface ? (
                                    <GradientSurface
                                        fallbackColor={theme.colors.segmentedControl.activeBackground}
                                        gradient={theme.colors.segmentedControl.activeGradient}
                                        borderRadius={compact ? 5 : 7}
                                        style={StyleSheet.absoluteFillObject}
                                    />
                                ) : null}
                                {iconOnly ? (
                                    <View style={styles.tabIcon}>{tab.icon}</View>
                                ) : (
                                    <Text
                                        numberOfLines={1}
                                        ellipsizeMode="tail"
                                        style={[
                                            styles.tabLabel,
                                            compact ? styles.tabLabelCompact : null,
                                            active ? styles.tabLabelActive : null,
                                            active ? props.activeLabelStyle : null,
                                        ]}
                                    >
                                        {tab.label}
                                    </Text>
                                )}
                            </View>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

export const SegmentedTabBar = React.memo(SegmentedTabBarInner) as typeof SegmentedTabBarInner;
