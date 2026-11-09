import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { resolveInPlaceMorphTiming } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { shadowLevelStyle } from '@/shadowElevation';

export type ShareMorphRect = Readonly<{ x: number; y: number; w: number; h: number }>;

/** The panel sits on the pane's gutter, inset from the pane's edges. */
const PANEL_INSET_PX = 8;

const WebInertView = View as React.ComponentType<ViewProps & Readonly<{ inert?: boolean }>>;

function lerp(from: number, to: number, progress: number): number {
    'worklet';
    return from + (to - from) * progress;
}

function clamp01(value: number): number {
    'worklet';
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The fade of what the panel covers (the pane's rows keep their place beneath it), driven by the
 * same clock as the morph so both halves of the transition stay in step.
 */
export function useShareMorphCoveredStyle(clock: SharedValue<number>, coveredEnd: SharedValue<number>) {
    return useAnimatedStyle(() => ({
        opacity: coveredEnd.value <= 0 ? 1 - clock.value : 1 - clamp01(clock.value / coveredEnd.value),
    }));
}

export type ShareMorphController = Readonly<{
    clock: SharedValue<number>;
    frame: SharedValue<number>;
    coveredEnd: SharedValue<number>;
    contentStart: SharedValue<number>;
    /** The panel is shown or on its way out (still drawn, never interactive). */
    drawn: boolean;
}>;

/**
 * Drives the Share panel's grow-in-place (lab `collab` SH): `open` is the person's intent and
 * applies at once to interactivity; the drawing follows the timeline and stops at its end.
 */
export function useShareMorph(open: boolean): ShareMorphController {
    const reducedMotion = useReducedMotionPreference();
    const clock = useSharedValue(open ? 1 : 0);
    const frame = useSharedValue(open ? 1 : 0);
    const coveredEnd = useSharedValue(1);
    const contentStart = useSharedValue(0);
    const [drawn, setDrawn] = React.useState(open);
    const first = React.useRef(true);
    React.useEffect(() => {
        if (first.current) {
            // Mounted already open (a deep link): no entrance to animate.
            first.current = false;
            return;
        }
        const timing = resolveInPlaceMorphTiming(reducedMotion);
        coveredEnd.value = timing.clockMs > 0 ? timing.coveredFadeMs / timing.clockMs : 0;
        contentStart.value = timing.clockMs > 0 ? timing.contentDelayMs / timing.clockMs : 0;
        const easing = timing.frameMs > 0 ? reanimatedMotionTokens.easing.standard : Easing.linear;
        if (open) {
            setDrawn(true);
            frame.value = timing.frameMs === 0 ? 1 : withTiming(1, { duration: timing.frameMs, easing });
            clock.value = withTiming(1, { duration: timing.clockMs, easing: Easing.linear });
            return;
        }
        frame.value = timing.frameMs === 0 ? frame.value : withTiming(0, { duration: timing.frameMs, easing });
        clock.value = withTiming(0, { duration: timing.clockMs, easing: Easing.linear });
        // The drawing stops when the timeline does. A JS timer, not the animation's completion
        // callback, owns this so an interrupted or unscheduled animation never strands a
        // half-drawn panel.
        const handle = setTimeout(() => setDrawn(false), timing.clockMs);
        return () => clearTimeout(handle);
    }, [clock, contentStart, coveredEnd, frame, open, reducedMotion]);
    return { clock, frame, coveredEnd, contentStart, drawn };
}

/**
 * The Share panel's frame: it grows from the access card's frame to the whole pane (inset to the
 * gutter), with the panel laid out once at its final size so nothing inside reflows while it grows.
 * ⌄ or Esc runs it backwards. Only this one absolutely positioned box animates layout; opacity and
 * position move on the compositor.
 *
 * While closed it stays mounted but hidden and inert, so the access editor's search and scroll
 * survive a fold and unfold.
 */
export function SessionShareMorphFrame(props: Readonly<{
    testID: string;
    open: boolean;
    morph: ShareMorphController;
    /** The access card's frame in the pane, the shape the panel grows from and folds back into. */
    origin: ShareMorphRect | null;
    /** The pane's size. */
    container: Readonly<{ w: number; h: number }> | null;
    onRequestClose: () => void;
    children: React.ReactNode;
}>): React.ReactElement {
    const { clock, frame, contentStart } = props.morph;
    const isWeb = Platform.OS === 'web';
    const container = props.container;
    const target = React.useMemo<ShareMorphRect | null>(() => (container
        ? { x: PANEL_INSET_PX, y: PANEL_INSET_PX, w: Math.max(0, container.w - PANEL_INSET_PX * 2), h: Math.max(0, container.h - PANEL_INSET_PX * 2) }
        : null), [container]);
    const originValue = useSharedValue<ShareMorphRect | null>(props.origin);
    const targetValue = useSharedValue<ShareMorphRect | null>(target);
    React.useEffect(() => { originValue.value = props.origin; }, [originValue, props.origin]);
    React.useEffect(() => { targetValue.value = target; }, [target, targetValue]);

    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.overlay,
        enabled: props.open,
        onEscape: () => {
            props.onRequestClose();
            return true;
        },
    });

    const frameStyle = useAnimatedStyle(() => {
        const to = targetValue.value;
        if (!to) return { opacity: clamp01(clock.value) };
        const from = originValue.value ?? to;
        const progress = frame.value;
        return {
            left: lerp(from.x, to.x, progress),
            top: lerp(from.y, to.y, progress),
            width: lerp(from.w, to.w, progress),
            height: lerp(from.h, to.h, progress),
            opacity: contentStart.value <= 0 ? clamp01(clock.value) : clamp01(clock.value / contentStart.value),
        };
    });
    const contentStyle = useAnimatedStyle(() => {
        const start = contentStart.value;
        return { opacity: start >= 1 ? 0 : clamp01((clock.value - start) / (1 - start)) };
    });
    const hidden = !props.open;
    return (
        <WebInertView
            testID={props.testID}
            pointerEvents={props.open ? 'auto' : 'none'}
            inert={isWeb && hidden ? true : undefined}
            aria-hidden={isWeb && hidden ? true : undefined}
            accessibilityElementsHidden={isWeb ? undefined : hidden}
            importantForAccessibility={isWeb ? undefined : hidden ? 'no-hide-descendants' : 'auto'}
            accessibilityViewIsModal={props.open}
            style={[StyleSheet.absoluteFillObject, props.morph.drawn || props.open ? null : styles.gone]}
        >
            <Animated.View style={[styles.frame, target ? null : styles.frameFill, frameStyle]}>
                <Animated.View
                    style={[
                        styles.content,
                        target ? { width: target.w, height: target.h } : styles.contentFill,
                        contentStyle,
                    ]}
                >
                    {props.children}
                </Animated.View>
            </Animated.View>
        </WebInertView>
    );
}

const styles = StyleSheet.create((theme) => ({
    gone: Platform.OS === 'web' ? { display: 'none' } : { opacity: 0 },
    frame: {
        position: 'absolute',
        overflow: 'hidden',
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        // The panel's own paint, one surface with the list it holds; `surface.elevated` is a control's
        // fill step and read as a dark grey block around a white list.
        backgroundColor: theme.colors.edge.floatingFill,
        // Raised because it is the focused, expanded object (premium-feel §4); the level is the
        // overlay step every floating surface uses.
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    frameFill: { left: PANEL_INSET_PX, top: PANEL_INSET_PX, right: PANEL_INSET_PX, bottom: PANEL_INSET_PX },
    content: { position: 'absolute', left: 0, top: 0 },
    contentFill: { right: 0, bottom: 0 },
}));
