import * as React from 'react';
import { I18nManager, Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
// Selection equality and the RTL-aware roving destination are NOT owned here. `plugin-ui` is the
// single owner for both rules so that core's tablist and the public `HappierTabs` adapter cannot
// drift apart, and `sharedFamilyOwnership.test.ts` names this file as the required core consumer of
// `resolveHappierTabKeySelection` — importing it is the contract, not a convenience.
import {
    HAPPIER_FOCUS_RING_DELEGATED_STYLE,
    happierFocusRingStyle,
    isHappierFocusVisible,
    HAPPIER_SEGMENTED_METRICS,
    HAPPIER_FIELD_BOX_METRICS,
    isHappierTabSelected,
    resolveHappierTabKeySelection,
    useHappierMaterialColorResolver,
    happierMaterialGradient,
} from '@happier-dev/plugin-ui/presentation';

import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { GradientSurface, type SurfaceGradient } from '@/components/ui/surfaces/GradientSurface';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
// The motion modules directly, not the instrument barrel: a segmented control must not load the
// gauge and chart components (and their SVG dependency) that the barrel also exports.
import { INSTRUMENT_SPRINGS } from '@/components/instrument/motion/motionTokens';
import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';
import { isTouchPrimaryPointer, resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';

import { resolveSegmentedTabFit } from './segmentedTabFit';

/**
 * The glyph size for an icon-only segmented bar.
 *
 * Owned here rather than at the call site because the bar reserves the matching slot height below:
 * the two numbers have to move together, and when they lived apart the icons were sized to the
 * LABEL's optical height (16) and then drawn smaller still, so an iconic bar read lighter than the
 * textual one it replaced. A tab is a primary control in its pane — it takes the standard toolbar
 * step.
 */
export const SEGMENTED_TAB_ICON_SIZE_PX = ICON_SIZE.sm;

/**
 * The segmented geometry (track inset, radii, padding-driven heights, label slot and type, segment
 * width floor) is shared presentation: the plugin segmented `Select` draws the same shape. This bar
 * keeps what is its own — the sliding spring thumb, icon-only bars, the press-frame budget below and
 * the theme's gradient/shadow on the active surface.
 *
 * Padding-driven visible heights. These are the numbers that decide how tall the control LOOKS, and
 * they are the only ones allowed to: a segment must never carry a `minHeight`, because a minimum
 * sized for a *touch target* silently becomes the drawn box and inflates every consumer.
 */
const SEGMENT_PADDING_VERTICAL_PX = HAPPIER_SEGMENTED_METRICS.segmentPaddingVerticalPx;

/**
 * The label's optical slot. Nominal — Inter's line box at these sizes — and used only to reason
 * about the press frame below. When the user scales text up the real segment grows past it, which
 * only makes the target larger.
 */
const SEGMENT_LABEL_SLOT_PX = HAPPIER_SEGMENTED_METRICS.labelSlotPx;

/**
 * The track's inset, and therefore the entire vertical budget of the press frame below.
 *
 * One constant because it is one fact wearing three hats: the gap the track paints around its
 * segments, the inset the sliding thumb rides at, and the only space the frame is allowed to claim.
 */
const SEGMENT_TRACK_PADDING_PX = HAPPIER_SEGMENTED_METRICS.trackPaddingPx;

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
const SEGMENT_MIN_WIDTH_PX = HAPPIER_SEGMENTED_METRICS.segmentMinWidthPx;

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
    /**
     * This one option cannot be chosen right now. It stays visible and announces itself as disabled;
     * presses and arrow keys skip it.
     */
    disabled?: boolean;
    /** Why this disabled option cannot be chosen, announced with its name. */
    unavailableReason?: string;
    /**
     * A formatted count after the label ("Changes 14"), in the quieter tertiary ink so the label stays
     * the name. Announced with the label.
     */
    count?: string;
    /** A short recommendation or availability badge, included in the accessible name. */
    badge?: string;
}>;

export type SegmentedTabBarProps<T extends string = string> = Readonly<{
    tabs: ReadonlyArray<SegmentedTab<T>>;
    activeTabId: T;
    onSelectTab: (tabId: T) => void;
    /** Optional testID prefix – tabs get `${testIDPrefix}:${tab.id}` */
    testIDPrefix?: string;
    /** Compact mode with reduced padding and smaller font */
    compact?: boolean;
    /** Configuration choices align their type with the adjacent full-size fields. */
    labelSize?: 'default' | 'field';
    /**
     * `pills`: separate pills for list filters. `plain`: a destination's page tabs — no track, each
     * glyph beside its label, the chosen tab on the ink selection fill (lab `p-overview` header).
     * All keep the same selection and keyboard semantics.
     */
    presentation?: 'segmented' | 'pills' | 'plain';
    /**
     * Fit the row to its measured width instead of scrolling or squeezing (D44): glyphs drop first,
     * then the trailing tabs that no longer fit move behind one More menu, which keeps their
     * selected state. Selection, focus and the chosen tab are unchanged by a resize.
     */
    overflow?: Readonly<{ label: string; testID?: string }>;
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
    /** Expand each segment to the platform touch-target floor when its consumer owns enough room. */
    targetSize?: 'platform';
    /** Accessible name for the group. */
    accessibilityLabel?: string;
    /**
     * What the bar is. `'tablist'` (default) is a view switch: each segment is a tab that shows a
     * different view of the same content. `'radiogroup'` is a value choice (a setting, a mode, a
     * field): each segment is a radio announcing whether it is checked. A tablist promises panels a
     * value choice never has, so the two must not share a role.
     */
    role?: 'tablist' | 'radiogroup';
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
        // Width fills the row; growing on the parent's main axis also steals height in a column.
        flexGrow: 0,
        minWidth: 0,
    },
    tabCaption: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' },
    containerContent: {
        width: 'auto',
        maxWidth: '100%',
        flexGrow: 0,
        alignSelf: 'flex-start',
    },
    inner: {
        flexDirection: 'row',
        backgroundColor: theme.colors.segmentedControl.trackBackground,
        borderRadius: HAPPIER_SEGMENTED_METRICS.trackRadiusPx.default,
        padding: SEGMENT_TRACK_PADDING_PX,
        width: '100%',
        flexGrow: 1,
        minWidth: 0,
        position: 'relative',
    },
    innerCompact: {
        borderRadius: HAPPIER_SEGMENTED_METRICS.trackRadiusPx.compact,
    },
    innerContent: {
        width: 'auto',
        maxWidth: '100%',
        flexGrow: 0,
    },
    innerPills: {
        backgroundColor: 'transparent',
        gap: HAPPIER_SEGMENTED_METRICS.pills.gapPx,
        flexWrap: 'wrap',
    },
    pillSurface: {
        borderRadius: HAPPIER_SEGMENTED_METRICS.pills.radiusPx,
        paddingVertical: HAPPIER_SEGMENTED_METRICS.pills.paddingVerticalPx,
        paddingHorizontal: HAPPIER_SEGMENTED_METRICS.pills.paddingHorizontalPx,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    pillActive: {
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.surface.inset,
    },
    innerPlain: {
        backgroundColor: 'transparent',
        padding: 0,
        gap: HAPPIER_SEGMENTED_METRICS.plain.gapPx,
        flexWrap: 'nowrap',
    },
    plainSurface: {
        borderRadius: HAPPIER_SEGMENTED_METRICS.plain.radiusPx,
        paddingVertical: HAPPIER_SEGMENTED_METRICS.plain.paddingVerticalPx,
        paddingHorizontal: HAPPIER_SEGMENTED_METRICS.plain.paddingHorizontalPx,
    },
    plainActive: {
        backgroundColor: theme.colors.surface.selected,
    },
    plainCaption: {
        gap: HAPPIER_SEGMENTED_METRICS.plain.iconGapPx,
    },
    plainLabel: {
        fontSize: HAPPIER_SEGMENTED_METRICS.plain.labelFontSizePx,
        lineHeight: HAPPIER_SEGMENTED_METRICS.plain.labelSlotPx,
    },
    plainThumb: {
        top: 0,
        bottom: 0,
        borderWidth: 0,
        borderRadius: HAPPIER_SEGMENTED_METRICS.plain.radiusPx,
        backgroundColor: theme.colors.surface.selected,
        shadowOpacity: 0,
        elevation: 0,
    },
    measureLayer: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    pillLabel: {
        fontSize: HAPPIER_SEGMENTED_METRICS.pills.labelFontSizePx,
        lineHeight: HAPPIER_SEGMENTED_METRICS.pills.labelSlotPx,
    },
    // One dim on the track, not per segment: stacking opacity on each Pressable would double up
    // behind the active thumb and read as two different greys.
    innerDisabled: {
        opacity: HAPPIER_SEGMENTED_METRICS.disabledOpacity,
    },
    /** One unavailable segment in an otherwise usable bar: the same dim as a disabled bar. */
    tabDisabled: {
        opacity: HAPPIER_SEGMENTED_METRICS.disabledOpacity,
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
        flexShrink: 1,
        flexBasis: 'auto',
    },
    /** The box that actually paints: background, radius, focus ring, and the visible height. */
    tabSurface: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
        paddingVertical: SEGMENT_PADDING_VERTICAL_PX.default,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: HAPPIER_SEGMENTED_METRICS.segmentRadiusPx.default,
        overflow: 'hidden',
    },
    // An icon bar is as tall as a label bar (the lab draws both at 28 in a 32 track): the glyph's own
    // slot plus padding that makes up the label slot's difference.
    tabSurfaceIcon: {
        paddingVertical: (SEGMENT_LABEL_SLOT_PX.default + SEGMENT_PADDING_VERTICAL_PX.default * 2 - SEGMENTED_TAB_ICON_SIZE_PX) / 2,
    },
    tabSurfaceIconCompact: {
        paddingVertical: Math.max(0, (SEGMENT_LABEL_SLOT_PX.compact + SEGMENT_PADDING_VERTICAL_PX.compact * 2 - SEGMENTED_TAB_ICON_SIZE_PX) / 2),
    },
    tabSurfaceCompact: {
        paddingVertical: SEGMENT_PADDING_VERTICAL_PX.compact,
        borderRadius: HAPPIER_SEGMENTED_METRICS.segmentRadiusPx.compact,
    },
    tabSurfaceContent: {
        paddingHorizontal: HAPPIER_SEGMENTED_METRICS.segmentPaddingHorizontalPx,
    },
    tabActive: {
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    thumb: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        position: 'absolute',
        top: SEGMENT_TRACK_PADDING_PX,
        bottom: SEGMENT_TRACK_PADDING_PX,
        left: 0,
        borderRadius: HAPPIER_SEGMENTED_METRICS.segmentRadiusPx.default,
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        overflow: 'hidden',
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    thumbCompact: {
        borderRadius: HAPPIER_SEGMENTED_METRICS.segmentRadiusPx.compact,
    },
    // Sized to the glyph, not to the label it replaces. Holding the slot at the label's 16px optical
    // height kept an iconic bar exactly as tall as a textual one, which sounds right and is not: the
    // glyph then has to shrink below its own step to fit, and the bar reads weaker than the words.
    tabIcon: {
        alignItems: 'center',
        justifyContent: 'center',
        height: SEGMENTED_TAB_ICON_SIZE_PX,
    },
    // The label's line box is its slot, so the drawn segment is exactly padding + slot.
    tabLabel: {
        flexShrink: 1,
        fontSize: HAPPIER_SEGMENTED_METRICS.labelFontSizePx.default,
        lineHeight: SEGMENT_LABEL_SLOT_PX.default,
        color: theme.colors.text.secondary,
    },
    tabLabelCompact: {
        fontSize: HAPPIER_SEGMENTED_METRICS.labelFontSizePx.compact,
        lineHeight: SEGMENT_LABEL_SLOT_PX.compact,
    },
    tabLabelField: {
        fontSize: HAPPIER_FIELD_BOX_METRICS.fontSizePx,
        lineHeight: HAPPIER_FIELD_BOX_METRICS.lineHeightPx,
        color: theme.colors.text.primary,
    },
    tabCount: {
        color: theme.colors.text.tertiary,
        fontWeight: '400',
        fontVariant: ['tabular-nums'],
    },
    tabLabelActive: {
        color: theme.colors.text.primary,
        fontWeight: HAPPIER_SEGMENTED_METRICS.labelActiveFontWeight,
    },
}));

/**
 * Shared spring-translated thumb (only mounted when `slidingThumb` is on, once its segment is
 * measured). It mounts AT that first rect: a thumb mounted earlier starts zero-wide and paints one
 * frame as a stray hairline on the track's leading edge before its first placement lands.
 */
function SlidingThumb(props: Readonly<{
    rect: TabRect;
    compact: boolean;
    plain?: boolean;
    testID?: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const motion = useMotionPreferences();
    const reduced = motion.level === 'minimal';
    const thumbX = useSharedValue(props.rect.x);
    const thumbWidth = useSharedValue(props.rect.width);

    React.useEffect(() => {
        const { x, width } = props.rect;
        if (reduced) {
            // Reduce-motion: position without travel.
            thumbX.value = x;
            thumbWidth.value = width;
            return;
        }
        thumbX.value = withSpring(x, INSTRUMENT_SPRINGS.standard);
        thumbWidth.value = withSpring(width, INSTRUMENT_SPRINGS.standard);
    }, [props.rect, reduced, thumbX, thumbWidth]);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: thumbX.value }],
        width: thumbWidth.value,
    }));

    return (
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            style={[styles.thumb, props.compact ? styles.thumbCompact : null, props.plain ? styles.plainThumb : null, { backgroundColor: paintColor(props.plain ? theme.colors.surface.selected : theme.colors.segmentedControl.activeBackground) }, animatedStyle]}
        >
            {props.plain ? null : <GradientSurface
                fallbackColor={paintColor(theme.colors.segmentedControl.activeBackground)}
                gradient={happierMaterialGradient(theme.colors.segmentedControl.activeGradient, paintColor)}
                borderRadius={HAPPIER_SEGMENTED_METRICS.segmentRadiusPx[props.compact ? 'compact' : 'default']}
                style={StyleSheet.absoluteFillObject}
            />}
        </Animated.View>
    );
}

function SegmentedTabBarInner<T extends string>(props: SegmentedTabBarProps<T>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const pills = props.presentation === 'pills';
    const plain = props.presentation === 'plain';
    const compact = pills || plain ? false : props.compact;
    const disabled = props.disabled === true;
    const slidingThumb = !pills && (plain || props.slidingThumb === true);
    const valueChoice = props.role === 'radiogroup';
    const contentSized = pills || plain || props.segmentSizing === 'content';
    // Icons replace labels only when the whole bar is iconic; a half-iconic row reads as broken.
    // Page tabs keep both: the glyph leads its label.
    const iconOnly = !plain && props.tabs.length > 0 && props.tabs.every((tab) => tab.icon != null);
    const overflow = props.overflow;
    const [rowWidth, setRowWidth] = React.useState<number | null>(null);
    const [measured, setMeasured] = React.useState<Readonly<Record<string, number>>>({});
    const recordMeasure = React.useCallback((key: string, event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        setMeasured((current) => (current[key] === width ? current : { ...current, [key]: width }));
    }, []);
    const fit = React.useMemo(() => {
        if (!overflow) return { icons: true, visibleCount: props.tabs.length };
        const complete = props.tabs.every((tab) => measured[`i:${tab.id}`] !== undefined && measured[`l:${tab.id}`] !== undefined)
            && measured.more !== undefined;
        return resolveSegmentedTabFit({
            available: complete ? rowWidth : null,
            withIcons: props.tabs.map((tab) => measured[`i:${tab.id}`] ?? 0),
            labelsOnly: props.tabs.map((tab) => measured[`l:${tab.id}`] ?? 0),
            gap: plain ? HAPPIER_SEGMENTED_METRICS.plain.gapPx : 0,
            more: measured.more ?? 0,
        });
    }, [measured, overflow, plain, props.tabs, rowWidth]);
    const showIcons = plain && fit.icons;
    const visibleTabs = React.useMemo(() => (overflow ? props.tabs.slice(0, fit.visibleCount) : props.tabs), [fit.visibleCount, overflow, props.tabs]);
    const hiddenTabs = React.useMemo(() => (overflow ? props.tabs.slice(fit.visibleCount) : []), [fit.visibleCount, overflow, props.tabs]);
    const activeHidden = hiddenTabs.some((tab) => isHappierTabSelected(props.activeTabId, tab.id));
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    // The consumer's room grant takes effect only where a finger is the pointer: under a mouse or a
    // trackpad the control keeps its dense padding-driven height (32 for labels), which is what the
    // lab draws and what WCAG 2.2 SC 2.5.8 asks of a dense pointer layout.
    const platformTarget = props.targetSize === 'platform' && isTouchPrimaryPointer(Platform.OS);

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
     * DEFAULT CEILING, stated plainly: the 44pt/48dp platform floor is not reached by the dense
     * default. What is met everywhere is WCAG 2.2 Level AA SC 2.5.8 (24 x 24 CSS px), which
     * DESIGN.md routes a dense pointer layout to. Resulting default target heights (drawn box +
     * this padding on each side):
     *
     *   label  regular  28 + 4 = 32      icon  regular  34 + 4 = 38
     *   label  compact  20 + 4 = 24      icon  compact  28 + 4 = 32
     *
     * Compact-label lands exactly on the 24px floor, which is why the label slot and the surface
     * padding above are load-bearing rather than decorative. `targetSize="platform"` is the
     * explicit grant from a consumer that owns enough horizontal and vertical room; only then does
     * the surface take the extra height and each flush segment take the 44/48 width floor.
     */
    // Icon and label bars draw at one height (see `tabSurfaceIcon`), never less than the glyph.
    const drawnSegmentHeight = Math.max(
        (compact ? SEGMENT_PADDING_VERTICAL_PX.compact : SEGMENT_PADDING_VERTICAL_PX.default) * 2
            + (props.labelSize === 'field' ? HAPPIER_FIELD_BOX_METRICS.lineHeightPx : compact ? SEGMENT_LABEL_SLOT_PX.compact : SEGMENT_LABEL_SLOT_PX.default),
        iconOnly ? SEGMENTED_TAB_ICON_SIZE_PX : 0,
    );
    const targetExpandY = Math.min(
        SEGMENT_TRACK_PADDING_PX,
        Math.max(0, (minimumInteractiveTargetSize - drawnSegmentHeight) / 2),
    );
    const tabFrameTarget = React.useMemo(() => ({
        paddingVertical: targetExpandY,
        marginVertical: -targetExpandY,
        ...(platformTarget ? { minWidth: minimumInteractiveTargetSize } : {}),
    }), [minimumInteractiveTargetSize, platformTarget, targetExpandY]);
    const tabSurfaceTarget = React.useMemo(() => platformTarget ? ({
        minHeight: minimumInteractiveTargetSize - SEGMENT_TRACK_PADDING_PX * 2,
    }) : null, [minimumInteractiveTargetSize, platformTarget]);

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

    const activeRect = (activeHidden ? tabRects[OVERFLOW_KEY] : tabRects[props.activeTabId]) ?? null;
    // Roving tabindex: the active segment takes focus; when the value names no enabled segment (a
    // custom value, or a choice that cannot apply now) the first enabled one does, so the group
    // never drops out of the tab order.
    const activeEnabledIndex = visibleTabs.findIndex((tab) => tab.disabled !== true && isHappierTabSelected(props.activeTabId, tab.id));
    const focusableIndex = activeEnabledIndex >= 0 ? activeEnabledIndex : visibleTabs.findIndex((tab) => tab.disabled !== true);
    const activateTabAt = React.useCallback((index: number, focus: boolean) => {
        if (props.disabled === true) return;
        const tab = visibleTabs[index];
        if (!tab || tab.disabled === true) return;
        props.onSelectTab(tab.id);
        if (focus) tabRefs.current.get(tab.id)?.focus?.();
    }, [props, visibleTabs]);
    const handleTabKeyDown = React.useCallback((tabIndex: number, event: any) => {
        if (Platform.OS !== 'web') return;
        if (props.disabled === true) return;
        const key = event?.nativeEvent?.key ?? event?.key;
        const nextIndex = resolveHappierTabKeySelection({
            tabs: visibleTabs,
            currentIndex: tabIndex,
            key,
            rtl: I18nManager.isRTL,
        });
        if (nextIndex === null || visibleTabs.length === 0) return;
        event?.preventDefault?.();
        activateTabAt(nextIndex, nextIndex !== tabIndex);
    }, [activateTabAt, props.disabled, visibleTabs]);

    return (
        <View
            style={[styles.container, contentSized && !overflow ? styles.containerContent : null]}
            onLayout={overflow ? (event) => {
                const width = event.nativeEvent.layout.width;
                setRowWidth((current) => (current === width ? current : width));
            } : undefined}
        >
            {overflow ? (
                // The tabs' natural widths, with and without glyphs, measured off-screen so the visible
                // row can decide what fits without first drawing a row that does not.
                <View style={styles.measureLayer} pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    {props.tabs.map((tab) => (
                        <React.Fragment key={tab.id}>
                            <View onLayout={(event) => recordMeasure(`i:${tab.id}`, event)}>
                                <PlainTabCaption tab={tab} icon active={false} measuring />
                            </View>
                            <View onLayout={(event) => recordMeasure(`l:${tab.id}`, event)}>
                                <PlainTabCaption tab={tab} icon={false} active={false} measuring />
                            </View>
                        </React.Fragment>
                    ))}
                    <View onLayout={(event) => recordMeasure('more', event)}>
                        <PlainTabCaption tab={{ id: OVERFLOW_KEY, label: overflow.label }} icon={false} active={false} measuring more />
                    </View>
                </View>
            ) : null}
            <View
                style={[
                    styles.inner,
                    compact ? styles.innerCompact : null,
                    contentSized ? styles.innerContent : null,
                    pills ? styles.innerPills : null,
                    plain ? styles.innerPlain : null,
                    !pills && !plain ? { backgroundColor: paintColor(theme.colors.segmentedControl.trackBackground) } : null,
                    disabled ? styles.innerDisabled : null,
                ]}
                accessibilityRole={valueChoice ? 'radiogroup' : 'tablist'}
                accessibilityLabel={props.accessibilityLabel}
            >
                {slidingThumb && activeRect ? (
                    <SlidingThumb
                        rect={activeRect}
                        compact={compact === true}
                        plain={plain}
                        testID={props.testIDPrefix ? `${props.testIDPrefix}:thumb` : undefined}
                    />
                ) : null}
                {visibleTabs.map((tab, tabIndex) => {
                    const active = isHappierTabSelected(props.activeTabId, tab.id);
                    const tabDisabled = disabled || tab.disabled === true;
                    const showOwnActiveSurface = active && !slidingThumb;
                    const tabName = [tab.label, tab.count, tab.badge].filter(Boolean).join(' ');
                    const unavailableReason = tab.disabled === true ? tab.unavailableReason : undefined;
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
                            disabled={tabDisabled}
                            onPress={() => {
                                if (tabDisabled) return;
                                props.onSelectTab(tab.id);
                            }}
                            // The ring is for keyboard focus only; a click on a segment focuses it too.
                            onFocus={(event) => setFocusedTabId(isHappierFocusVisible(event?.target) ? tab.id : null)}
                            onBlur={() => setFocusedTabId((current) => (current === tab.id ? null : current))}
                            {...webKeyDownProps}
                            onLayout={slidingThumb ? (event) => handleTabLayout(tab.id, event) : undefined}
                            style={[
                                styles.tabFrame,
                                contentSized ? styles.tabFrameContent : null,
                                tabFrameTarget,
                                HAPPIER_FOCUS_RING_DELEGATED_STYLE,
                            ]}
                            {...(iconOnly ? ({ title: tab.label } as object) : {})}
                            accessibilityRole={valueChoice ? 'radio' : 'tab'}
                            accessibilityLabel={unavailableReason ? `${tabName}, ${unavailableReason}` : tabName}
                            accessibilityState={valueChoice
                                ? { checked: active, disabled: tabDisabled }
                                : { selected: active, disabled: tabDisabled }}
                            {...(valueChoice ? { 'aria-checked': active } : { 'aria-selected': active })}
                            aria-disabled={tabDisabled || undefined}
                            tabIndex={Platform.OS === 'web' ? (disabled || tabIndex !== focusableIndex ? -1 : 0) : undefined}
                        >
                            <View
                                style={[
                                    styles.tabSurface,
                                    compact ? styles.tabSurfaceCompact : null,
                                    iconOnly ? (compact ? styles.tabSurfaceIconCompact : styles.tabSurfaceIcon) : null,
                                    tabSurfaceTarget,
                                    contentSized ? styles.tabSurfaceContent : null,
                                    showOwnActiveSurface && !pills && !plain ? styles.tabActive : null,
                                    plain ? styles.plainSurface : null,
                                    plain && showOwnActiveSurface ? styles.plainActive : null,
                                    pills ? styles.pillSurface : null,
                                    pills && active ? styles.pillActive : null,
                                    showOwnActiveSurface ? { backgroundColor: paintColor(pills ? theme.colors.surface.inset : plain ? theme.colors.surface.selected : theme.colors.segmentedControl.activeBackground) } : null,
                                    happierFocusRingStyle({ visible: !tabDisabled && focusedTabId === tab.id, color: theme.colors.border.focus }),
                                    !disabled && tab.disabled === true ? styles.tabDisabled : null,
                                ]}
                            >
                                {showOwnActiveSurface && !pills && !plain ? (
                                    <GradientSurface
                                        fallbackColor={paintColor(theme.colors.segmentedControl.activeBackground)}
                                        gradient={happierMaterialGradient(theme.colors.segmentedControl.activeGradient, paintColor)}
                                        borderRadius={HAPPIER_SEGMENTED_METRICS.segmentRadiusPx[compact ? 'compact' : 'default']}
                                        style={StyleSheet.absoluteFillObject}
                                    />
                                ) : null}
                                {plain ? (
                                    <PlainTabCaption tab={tab} icon={showIcons} active={active} />
                                ) : iconOnly ? (
                                    <View style={styles.tabIcon}>{tab.icon}</View>
                                ) : (
                                    <View style={styles.tabCaption}>
                                    {/* A mark that identifies one option (a dashboard's owner) leads its label. */}
                                    {tab.icon ? <View style={styles.tabIcon}>{tab.icon}</View> : null}
                                    <Text
                                        // Value choices keep their full names visible when the row
                                        // stacks into a narrow slot; view tabs remain single-line.
                                        numberOfLines={valueChoice ? undefined : 1}
                                        ellipsizeMode="tail"
                                        style={[
                                            styles.tabLabel,
                                            compact ? styles.tabLabelCompact : null,
                                            props.labelSize === 'field' ? styles.tabLabelField : null,
                                            pills ? styles.pillLabel : null,
                                            active ? styles.tabLabelActive : null,
                                            active ? props.activeLabelStyle : null,
                                        ]}
                                    >
                                        {tab.label}
                                        {tab.count ? <Text style={styles.tabCount}>{` ${tab.count}`}</Text> : null}
                                    </Text>
                                    {tab.badge ? <StatusPill variant="info" hideDot label={tab.badge} /> : null}
                                    </View>
                                )}
                            </View>
                        </Pressable>
                    );
                })}
                {overflow && hiddenTabs.length > 0 ? (
                    <SegmentedTabOverflowMore
                        label={overflow.label}
                        testID={overflow.testID ?? (props.testIDPrefix ? `${props.testIDPrefix}:more` : undefined)}
                        tabs={hiddenTabs}
                        activeTabId={props.activeTabId}
                        active={activeHidden}
                        disabled={disabled}
                        onSelectTab={props.onSelectTab}
                        onLayout={(event) => handleTabLayout(OVERFLOW_KEY, event)}
                    />
                ) : null}
            </View>
        </View>
    );
}

/** The key under which the More trigger's own box is laid out for the sliding selection. */
const OVERFLOW_KEY = '\u0000more';

/** A page tab's caption: its glyph (when the row has room), label and quiet count. */
function PlainTabCaption(props: Readonly<{
    tab: Pick<SegmentedTab, 'label' | 'icon' | 'count' | 'id'>;
    icon: boolean;
    active: boolean;
    /** Off-screen measuring copy: drawn with the surface's own padding so widths match. */
    measuring?: boolean;
    more?: boolean;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const caption = (
        <View style={[styles.tabCaption, styles.plainCaption]}>
            {props.icon && props.tab.icon ? <View style={styles.tabIcon}>{props.tab.icon}</View> : null}
            {props.more ? <Icon name="dots-three" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> : null}
            <Text numberOfLines={1} style={[styles.tabLabel, styles.plainLabel, props.active ? styles.tabLabelActive : null]}>
                {props.tab.label}
                {props.tab.count ? <Text style={styles.tabCount}>{` ${props.tab.count}`}</Text> : null}
            </Text>
        </View>
    );
    return props.measuring ? <View style={[styles.tabSurface, styles.plainSurface]}>{caption}</View> : caption;
}

/** The tabs that no longer fit, in one menu; it is the selected tab's place while that tab is inside. */
function SegmentedTabOverflowMore<T extends string>(props: Readonly<{
    label: string;
    testID?: string;
    tabs: ReadonlyArray<SegmentedTab<T>>;
    activeTabId: T;
    active: boolean;
    disabled: boolean;
    onSelectTab: (tabId: T) => void;
    onLayout: (event: LayoutChangeEvent) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [focusVisible, setFocusVisible] = React.useState(false);
    const items = React.useMemo(() => props.tabs.map((tab) => ({
        id: tab.id,
        title: tab.count ? `${tab.label} ${tab.count}` : tab.label,
        icon: tab.icon ?? undefined,
        checked: isHappierTabSelected(props.activeTabId, tab.id),
        disabled: tab.disabled === true,
        testID: props.testID ? `${props.testID}:${tab.id}` : undefined,
    })), [props.activeTabId, props.tabs, props.testID]);
    const activeTab = props.tabs.find((tab) => isHappierTabSelected(props.activeTabId, tab.id)) ?? null;
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={activeTab?.id ?? null}
            onSelect={(id) => { setOpen(false); props.onSelectTab(id as T); }}
            placement="bottom"
            matchTriggerWidth={false}
            trigger={({ toggle }) => (
                <Pressable
                    testID={props.testID}
                    disabled={props.disabled}
                    onPress={toggle}
                    onLayout={props.onLayout}
                    onFocus={(event) => setFocusVisible(isHappierFocusVisible(event?.target))}
                    onBlur={() => setFocusVisible(false)}
                    style={[styles.tabFrameContent, HAPPIER_FOCUS_RING_DELEGATED_STYLE]}
                    accessibilityRole="button"
                    accessibilityLabel={activeTab ? `${props.label}, ${activeTab.label}` : props.label}
                    accessibilityState={{ expanded: open, selected: props.active }}
                    {...(Platform.OS === 'web' ? ({ 'aria-haspopup': 'menu', 'aria-expanded': open } as Record<string, unknown>) : {})}
                >
                    <View style={[styles.tabSurface, styles.plainSurface, happierFocusRingStyle({ visible: focusVisible, color: theme.colors.border.focus })]}>
                        <PlainTabCaption tab={{ id: OVERFLOW_KEY, label: props.label }} icon={false} active={props.active} more />
                    </View>
                </Pressable>
            )}
        />
    );
}

export const SegmentedTabBar = React.memo(SegmentedTabBarInner) as typeof SegmentedTabBarInner;
