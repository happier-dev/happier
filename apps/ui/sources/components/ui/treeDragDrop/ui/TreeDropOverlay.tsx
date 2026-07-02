import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { TreeDropIndicatorLine } from './TreeDropIndicatorLine';
import { TreeDropOutline } from './TreeDropOutline';
import { shouldSnapTreeDropOverlay } from './treeDropOverlayMotion';
import { useTreeDropFlashHighlight } from './useTreeDropFlashHighlight';
import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_OUTLINE,
    type TreeDropOverlaySharedValues,
} from './treeDropOverlayTypes';

/**
 * Generic list-level tree drop overlay.
 *
 * Phase 1 of `.project/plans/session-list-drag-geometry-performance-unification.md`
 * (sections 3.1, 3.4). This is ONE viewport-level, absolutely-positioned,
 * non-interactive indicator. It replaces the old row-local drop indicators: a
 * pointer move never reconciles mounted rows because the overlay's position is
 * driven entirely by numeric Reanimated shared values, not React props.
 *
 * It reuses the themed `TreeDropIndicatorLine` and `TreeDropOutline`. Position
 * glides between targets with `withTiming` (+ `motionTokens`) under normal
 * motion and snaps immediately under reduced motion. An outline appearing /
 * changing target flashes via `useTreeDropFlashHighlight`.
 *
 * The host renders this as a sibling of the scroll viewport; the overlay fills
 * that viewport and positions its indicator in viewport-overlay coordinates.
 */
export type TreeDropOverlayProps = Readonly<{
    /** Numeric, worklet-readable overlay geometry shared values. */
    shared: TreeDropOverlaySharedValues;
    /** Per-depth horizontal indent applied to the reorder line. */
    indentPx: number;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

/** High z-index so the overlay always paints above list rows/headers. */
const TREE_DROP_OVERLAY_Z_INDEX = 1000;

/** Peak extra scale applied to the outline by the appear-flash (subtle pop). */
const TREE_DROP_OUTLINE_FLASH_SCALE = 0.04;

const stylesheet = StyleSheet.create(() => ({
    root: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: TREE_DROP_OVERLAY_Z_INDEX,
    },
    indicatorContainer: {
        position: 'absolute',
    },
}));

export function TreeDropOverlay(props: TreeDropOverlayProps): React.ReactElement {
    const { shared, indentPx } = props;
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const flash = useTreeDropFlashHighlight();

    // Displayed position of the indicator. A reaction owns these so the overlay
    // SNAPS to its first target (no slide-in from a stale `overlayTop`, which
    // retains the initial 0 or the previous drag's last position while hidden)
    // and GLIDES between subsequent targets within the same drag. The animated
    // styles read only these — never `overlayTop`/`overlayLeft` directly — so
    // the snap/glide decision can't race style evaluation.
    const displayTop = useSharedValue(0);
    const displayLeft = useSharedValue(0);

    useAnimatedReaction(
        () => ({
            visible: shared.overlayVisible.value > 0,
            top: shared.overlayTop.value,
            left: shared.overlayLeft.value,
        }),
        (current, previous) => {
            const snap = shouldSnapTreeDropOverlay({
                visible: current.visible,
                previousVisible: previous ? previous.visible : null,
                reducedMotion,
            });
            if (snap) {
                displayTop.value = current.top;
                displayLeft.value = current.left;
                return;
            }
            displayTop.value = withTiming(current.top, {
                duration: reanimatedMotionTokens.durationMs.fast,
                easing: reanimatedMotionTokens.easing.standard,
            });
            displayLeft.value = withTiming(current.left, {
                duration: reanimatedMotionTokens.durationMs.fast,
                easing: reanimatedMotionTokens.easing.standard,
            });
        },
        [reducedMotion],
    );

    // Flash the outline when it first appears or moves to a new nest target.
    useAnimatedReaction(
        () => (
            shared.overlayVisible.value > 0 && shared.overlayKind.value === TREE_DROP_OVERLAY_KIND_OUTLINE
                ? shared.overlayTop.value
                : null
        ),
        (current, previous) => {
            if (current !== null && current !== previous) {
                flash.trigger();
            }
        },
    );

    const lineStyle = useAnimatedStyle(() => {
        const isLine = shared.overlayVisible.value > 0
            && shared.overlayKind.value === TREE_DROP_OVERLAY_KIND_LINE;
        const indent = Math.max(0, shared.overlayDepth.value * indentPx);
        const width = Math.max(0, shared.overlayRight.value - shared.overlayLeft.value - indent);
        return {
            top: displayTop.value,
            left: displayLeft.value + indent,
            width,
            height: shared.overlayHeight.value,
            opacity: isLine ? 1 : 0,
        };
    });

    const outlineStyle = useAnimatedStyle(() => {
        const isOutline = shared.overlayVisible.value > 0
            && shared.overlayKind.value === TREE_DROP_OVERLAY_KIND_OUTLINE;
        const width = Math.max(0, shared.overlayRight.value - shared.overlayLeft.value);
        // `flash.progress` peaks at 1 right after a nest target appears/changes,
        // then settles to 0: map it to a subtle scale pop so the outline reads
        // as actively landing on the new container.
        const flashScale = 1 + TREE_DROP_OUTLINE_FLASH_SCALE * flash.progress.value;
        return {
            top: displayTop.value,
            left: displayLeft.value,
            width,
            height: shared.overlayHeight.value,
            opacity: isOutline ? 1 : 0,
            transform: [{ scale: flashScale }],
        };
    });

    return (
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.root, props.style]}
        >
            <Animated.View
                testID={props.testID ? `${props.testID}-line` : undefined}
                pointerEvents="none"
                style={[styles.indicatorContainer, lineStyle]}
            >
                <TreeDropIndicatorLine
                    visual={{ kind: 'line', targetId: '', edge: 'top', depth: 0 }}
                    indentPx={0}
                    style={lineFillStyle}
                />
            </Animated.View>
            <Animated.View
                testID={props.testID ? `${props.testID}-outline` : undefined}
                pointerEvents="none"
                style={[styles.indicatorContainer, outlineStyle]}
            >
                <TreeDropOutline
                    visual={{ kind: 'outline', targetId: '' }}
                    style={outlineFillStyle}
                />
            </Animated.View>
        </Animated.View>
    );
}

// The indicator components own their own theming; the overlay sizes them to
// fill its animated container, which carries the resolved geometry.
const lineFillStyle = { width: '100%' as const };
const outlineFillStyle = { width: '100%' as const, height: '100%' as const };
