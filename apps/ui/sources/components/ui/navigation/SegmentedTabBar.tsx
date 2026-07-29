import * as React from 'react';
import { I18nManager, Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { INSTRUMENT_SPRINGS, useMotionPreferences } from '@/components/instrument';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

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
        padding: 2,
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
    tab: {
        // Equal mode: grow/shrink/basis as longhands (NOT the `flex: 1`
        // shorthand). On react-native-web the shorthand emits CSS `flex: 1`
        // which forces `flex-basis: 0%`; the content-mode longhand override
        // below then can't reliably win the basis, so content tabs collapse.
        // All-longhands here keeps `flex-basis: auto` unambiguous in content mode.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 44,
        minHeight: 28,
        // Native keeps the app-standard padding-driven visible height and adds
        // hit-slop below. Web receives a real 44px minimum in `tabWebTarget`
        // because RN Web Pressable does not implement hit-slop.
        paddingVertical: 7,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
        overflow: 'hidden',
    },
    tabCompact: {
        paddingVertical: 4,
        borderRadius: 5,
        minHeight: 20,
    },
    tabWebTarget: {
        ...(Platform.select({
            web: {
                minHeight: 44,
            },
            default: {},
        }) as object),
    },
    tabContent: {
        // Hug the label so a short 6-char label ("Tokens") never ellipsizes
        // (D-R3-3). CRITICAL: use `flexBasis: 'auto'`, never `flex: 0` — RNW
        // maps `flex: 0` to CSS `flex: 0` which sets `flex-basis: 0%`, and with
        // the tab's `overflow: 'hidden'` that collapses the segment to
        // padding-only width and CLIPS the label to nothing (the "naked Switch"
        // regression). `auto` basis sizes the segment to its content.
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
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
        top: 2,
        bottom: 2,
        left: 0,
        borderRadius: 7,
        backgroundColor: theme.colors.segmentedControl.activeBackground,
        overflow: 'hidden',
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    thumbCompact: {
        borderRadius: 5,
    },
    // Matches the label's optical height so an iconic bar is the same height as a textual one.
    tabIcon: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
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
    const slidingThumb = props.slidingThumb === true;
    const contentSized = props.segmentSizing === 'content';
    // Icons replace labels only when the whole bar is iconic; a half-iconic row reads as broken.
    const iconOnly = props.tabs.length > 0 && props.tabs.every((tab) => tab.icon != null);
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const visibleTabHeight = compact ? 20 : 28;
    const verticalHitSlop = Math.max(0, (minimumInteractiveTargetSize - visibleTabHeight) / 2);
    const nativeTabHitSlop = { top: verticalHitSlop, bottom: verticalHitSlop };
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
        const tab = props.tabs[index];
        if (!tab) return;
        props.onSelectTab(tab.id);
        if (focus) tabRefs.current.get(tab.id)?.focus?.();
    }, [props]);
    const handleTabKeyDown = React.useCallback((tabIndex: number, event: any) => {
        if (Platform.OS !== 'web') return;
        const key = event?.nativeEvent?.key ?? event?.key;
        let nextIndex: number | null = null;
        const forwardOffset = I18nManager.isRTL ? -1 : 1;
        if (key === 'ArrowRight') nextIndex = (tabIndex + forwardOffset + props.tabs.length) % props.tabs.length;
        else if (key === 'ArrowLeft') nextIndex = (tabIndex - forwardOffset + props.tabs.length) % props.tabs.length;
        else if (key === 'Home') nextIndex = 0;
        else if (key === 'End') nextIndex = props.tabs.length - 1;
        // RN Web Pressable already turns Enter into one `onPress` on keyup.
        // Tabs need supplemental Space handling because Pressable only treats
        // Space as activation for button-like roles.
        else if (key === ' ' || key === 'Spacebar') nextIndex = tabIndex;
        if (nextIndex === null || props.tabs.length === 0) return;
        event?.preventDefault?.();
        activateTabAt(nextIndex, nextIndex !== tabIndex);
    }, [activateTabAt, props.tabs.length]);

    return (
        <View style={[styles.container, contentSized ? styles.containerContent : null]}>
            <View
                style={[
                    styles.inner,
                    compact ? styles.innerCompact : null,
                    contentSized ? styles.innerContent : null,
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
                    const active = props.activeTabId === tab.id;
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
                            onPress={() => props.onSelectTab(tab.id)}
                            hitSlop={Platform.OS === 'web'
                                ? undefined
                                : nativeTabHitSlop}
                            {...webKeyDownProps}
                            onLayout={slidingThumb ? (event) => handleTabLayout(tab.id, event) : undefined}
                            style={(interactionState) => {
                                const webState = interactionState as typeof interactionState & { focused?: boolean };
                                return [
                                    styles.tab,
                                    compact ? styles.tabCompact : null,
                                    contentSized ? styles.tabContent : null,
                                    styles.tabWebTarget,
                                    { minWidth: minimumInteractiveTargetSize },
                                    showOwnActiveSurface ? styles.tabActive : null,
                                    webState.focused === true ? styles.tabFocused : null,
                                ];
                            }}
                            {...(iconOnly ? ({ title: tab.label } as object) : {})}
                            accessibilityRole="tab"
                            accessibilityLabel={tab.label}
                            accessibilityState={{ selected: active }}
                            aria-selected={active}
                            tabIndex={Platform.OS === 'web' ? (active ? 0 : -1) : undefined}
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
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

export const SegmentedTabBar = React.memo(SegmentedTabBarInner) as typeof SegmentedTabBarInner;
