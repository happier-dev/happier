import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, {
    cancelAnimation,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type WithTimingConfig,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Generic accordion row. Owns WAI-ARIA disclosure semantics (the caller's
 * header `Item` becomes the toggle button via `headerProps`) plus a fluid,
 * Reanimated height/opacity body reveal that animates ONLY the toggled item.
 *
 * Integration with `ItemGroup`: `withItemGroupDividers` clones each top-level
 * element child with a computed `showDivider` and wraps it in an
 * `ItemGroupRowPositionProvider`. ExpandableItem therefore returns a SINGLE
 * non-Fragment wrapper so it occupies exactly one row slot. ExpandableItem owns
 * its inter-item hairline itself (the header `Item`'s own divider is suppressed)
 * so the separation paints consistently across platforms — a header-drawn
 * divider collapses to a zero-height line on web/Android.
 *
 * Dividers appear ONLY between items, NEVER inside one. An expanded item shows
 * no line between its header and its body. The injected `showDivider` therefore
 * drives a single inter-item separator placed after the row content:
 *   - collapsed -> a hairline BELOW the header (when not the last row)
 *   - expanded  -> a hairline BELOW the body (when not the last row)
 */
export interface ExpandableItemHeaderState {
    expanded: boolean;
    toggle: () => void;
    headerProps: {
        onPress: () => void;
        accessibilityRole: 'button';
        accessibilityState: { expanded: boolean };
    };
}

export type ExpandableItemHeaderRender =
    | React.ReactNode
    | ((state: ExpandableItemHeaderState) => React.ReactNode);

export interface ExpandableItemProps {
    expanded: boolean;
    onExpandedChange: (next: boolean) => void;
    header: ExpandableItemHeaderRender;
    children?: React.ReactNode;
    reorderHandle?: React.ReactNode;
    showDivider?: boolean;
    testID?: string;
    reducedMotion?: boolean;
}

const EXPAND_ANIMATION_DURATION_MS = 220;
const TIMING_CONFIG: WithTimingConfig = { duration: EXPAND_ANIMATION_DURATION_MS };

// Sub-pixel layout jitter must not re-arm the reveal animation. Only a real
// change in the body's natural height (async quota skeleton -> real meters)
// re-drives the pinned expand.
const HEIGHT_EPSILON = 1;

// Thinnest line that still paints on every platform. The previous
// `Platform.select({ ios: 0.33, default: 0 })` collapsed to zero height on
// web/Android, leaving account rows with no visible separation.
const HAIRLINE = StyleSheet.hairlineWidth || 0.5;

// The separator uses the canonical `border.default` token (there is no
// dedicated subtle/divider token), softened with a low opacity so the
// inter-item hairline reads as a faint line rather than a hard rule.
const HAIRLINE_OPACITY = 0.6;

const stylesheet = StyleSheet.create((theme) => ({
    wrapper: {
        // A single row slot inside the ItemGroup surface. No corner/position
        // provider here: the header Item reads the injected row position.
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    reorderHandle: {
        justifyContent: 'center',
    },
    headerFlex: {
        flex: 1,
        minWidth: 0,
    },
    bodyClip: {
        overflow: 'hidden',
    },
    rowSeparator: {
        height: HAIRLINE,
        backgroundColor: theme.colors.border.default,
        opacity: HAIRLINE_OPACITY,
        marginLeft: 16,
    },
}));

export const ExpandableItem = React.memo<ExpandableItemProps>((props) => {
    const { expanded, onExpandedChange, header, children, reorderHandle, testID } = props;
    const showDivider = props.showDivider ?? true;
    const styles = stylesheet;

    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;

    const toggle = React.useCallback(() => {
        onExpandedChange(!expanded);
    }, [expanded, onExpandedChange]);

    const headerProps = React.useMemo<ExpandableItemHeaderState['headerProps']>(() => ({
        onPress: toggle,
        accessibilityRole: 'button',
        accessibilityState: { expanded },
    }), [toggle, expanded]);

    // --- body reveal animation (only this item animates) ---
    const measuredHeightRef = React.useRef(0);
    const animatedHeight = useSharedValue(0);
    const animatedOpacity = useSharedValue(expanded ? 1 : 0);
    const isMountedRef = React.useRef(true);
    // `pendingExpandRef` is purely the "has the expand armed at all yet?" guard
    // (true from the expand effect until the first height command is issued).
    // It is NOT the sole gate for correctness — `handleBodyLayout` reconciles a
    // pinned, in-flight expand to the freshest height even after arming.
    const pendingExpandRef = React.useRef(false);
    const prevExpandedRef = React.useRef(expanded);
    // The height the pinned expand animation is currently heading to. Compared
    // against fresh layout measurements to decide whether a reconcile is needed.
    const animationTargetRef = React.useRef(0);
    // Mirror of `heightPinned` readable synchronously inside `handleBodyLayout`
    // (onLayout can fire against a closure captured before a re-render).
    const heightPinnedRef = React.useRef(false);

    const [bodyMounted, setBodyMounted] = React.useState(expanded);
    const [heightPinned, setHeightPinned] = React.useState(false);

    const applyHeightPinned = React.useCallback((next: boolean) => {
        heightPinnedRef.current = next;
        setHeightPinned(next);
    }, []);

    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            cancelAnimation(animatedHeight);
            cancelAnimation(animatedOpacity);
        };
    }, [animatedHeight, animatedOpacity]);

    const settleExpanded = React.useCallback(() => {
        if (!isMountedRef.current) return;
        // Release the pin so the body renders at natural height and can grow.
        applyHeightPinned(false);
    }, [applyHeightPinned]);

    const settleCollapsed = React.useCallback(() => {
        if (!isMountedRef.current) return;
        setBodyMounted(false);
        applyHeightPinned(false);
    }, [applyHeightPinned]);

    // Drive (or re-drive) the pinned expand toward `target`, recording it so a
    // later layout can tell whether the animation is already heading there.
    const armExpandTiming = React.useCallback((target: number) => {
        animationTargetRef.current = target;
        animatedHeight.value = withTiming(target, TIMING_CONFIG, (finished) => {
            'worklet';
            if (finished) runOnJS(settleExpanded)();
        });
    }, [animatedHeight, settleExpanded]);

    React.useEffect(() => {
        if (prevExpandedRef.current === expanded) return;
        prevExpandedRef.current = expanded;

        if (expanded) {
            setBodyMounted(true);
            if (reducedMotion) {
                animatedOpacity.value = 1;
                applyHeightPinned(false);
                return;
            }
            animatedHeight.value = 0;
            applyHeightPinned(true);
            pendingExpandRef.current = true;
            animationTargetRef.current = 0;
            animatedOpacity.value = withTiming(1, TIMING_CONFIG);
            const target = measuredHeightRef.current;
            if (target > 0) {
                pendingExpandRef.current = false;
                // Fast path: arm immediately to the last known height. This may
                // be STALE (the body's async content can now settle at a
                // different height); `handleBodyLayout` reconciles it below.
                armExpandTiming(target);
            }
            return;
        }

        // Collapse.
        if (reducedMotion) {
            animatedOpacity.value = 0;
            settleCollapsed();
            return;
        }
        pendingExpandRef.current = false;
        animationTargetRef.current = 0;
        animatedHeight.value = measuredHeightRef.current > 0 ? measuredHeightRef.current : 0;
        applyHeightPinned(true);
        animatedOpacity.value = withTiming(0, TIMING_CONFIG);
        animatedHeight.value = withTiming(0, TIMING_CONFIG, (finished) => {
            'worklet';
            if (finished) runOnJS(settleCollapsed)();
        });
    }, [expanded, reducedMotion, animatedHeight, animatedOpacity, applyHeightPinned, armExpandTiming, settleCollapsed]);

    const handleBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const measured = event.nativeEvent.layout.height;
        if (measured <= 0) return;
        measuredHeightRef.current = measured;
        if (reducedMotion) return;

        if (pendingExpandRef.current) {
            // Initial arm: the expand effect deferred to the first real height.
            pendingExpandRef.current = false;
            armExpandTiming(measured);
            return;
        }

        // Reconcile an in-flight expand. The body's async content (a quota
        // skeleton settling into real meters/reset rows) can change the natural
        // height AFTER the animation armed — previously the reveal undershot to
        // the stale height ("half-expand") until the timing finished. While the
        // height is still pinned, chase the freshest measurement instead. Once
        // settled (unpinned) the `height: undefined` release valve owns natural
        // growth, so we must not re-pin here.
        if (
            expanded
            && heightPinnedRef.current
            && Math.abs(measured - animationTargetRef.current) > HEIGHT_EPSILON
        ) {
            armExpandTiming(measured);
        }
    }, [expanded, reducedMotion, armExpandTiming]);

    const bodyAnimatedStyle = useAnimatedStyle(() => {
        // ALWAYS return the same set of keys. Reanimated's native updater does not
        // reset a property that simply disappears from the returned object, so
        // dropping `height` (rather than setting it to `undefined`) freezes the
        // native view at the height captured during the open animation — which is
        // short when the body's content (e.g. an async quota snapshot) grows after
        // the first onLayout. Returning `height: undefined` when unpinned releases
        // the constraint so the body settles at its natural, full height.
        return {
            opacity: animatedOpacity.value,
            height: heightPinned ? animatedHeight.value : undefined,
        };
    }, [heightPinned]);

    // The header `Item` never draws its own row-separator: its divider is a
    // zero-height line on web/Android, so ExpandableItem owns the single
    // inter-item hairline itself to guarantee a consistent, faint separation
    // across platforms. No line is ever drawn inside an item.
    const resolvedHeader = typeof header === 'function'
        ? header({ expanded, toggle, headerProps })
        : header;
    const headerNode = React.isValidElement(resolvedHeader)
        ? React.cloneElement(
            resolvedHeader as React.ReactElement<{ showDivider?: boolean }>,
            { showDivider: false },
        )
        : resolvedHeader;

    return (
        <View testID={testID} style={styles.wrapper}>
            {reorderHandle != null ? (
                <View style={styles.headerRow}>
                    <View style={styles.reorderHandle}>{reorderHandle}</View>
                    <View style={styles.headerFlex}>{headerNode}</View>
                </View>
            ) : (
                headerNode
            )}

            {bodyMounted ? (
                <Animated.View
                    testID={testID ? `${testID}:body` : undefined}
                    style={[styles.bodyClip, bodyAnimatedStyle]}
                >
                    <View onLayout={handleBodyLayout}>
                        {children}
                    </View>
                </Animated.View>
            ) : null}

            {showDivider ? (
                <View
                    testID={testID ? `${testID}:row-divider` : undefined}
                    style={styles.rowSeparator}
                />
            ) : null}
        </View>
    );
});

ExpandableItem.displayName = 'ExpandableItem';
