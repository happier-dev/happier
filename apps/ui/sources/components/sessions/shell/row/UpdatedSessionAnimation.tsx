import React from 'react';
import { StyleSheet, type LayoutChangeEvent, type TextProps } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    interpolate,
    interpolateColor,
    makeMutable,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useIsHostVisible } from '@/hooks/ui/useIsHostVisible';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    UPDATED_ANIMATION_BREATH_MS,
    UPDATED_ANIMATION_OUTLINE_WIDTH,
    UPDATED_ANIMATION_SWEEP_MS,
    resolveUpdatedAnimationPalette,
    withAlpha,
    type UpdatedAnimationTone,
    type UpdatedSessionAnimation,
} from './updatedSessionAnimation';

/** The glow's resting edge, so a calm moment of the breath still reads as flagged. */
const GLOW_EDGE_WIDTH = 3;
const GLOW_EDGE_REST_OPACITY = 0.35;
const GLOW_TINT_PEAK_OPACITY = 0.22;
/** The sweep band's width as a share of the row. */
const SWEEP_BAND_SHARE = 0.45;
const SWEEP_PEAK_ALPHA = 0.55;

const styles = StyleSheet.create({
    layer: {
        ...StyleSheet.absoluteFillObject,
        overflow: 'hidden',
    },
    fill: {
        ...StyleSheet.absoluteFillObject,
    },
    outline: {
        ...StyleSheet.absoluteFillObject,
        borderWidth: UPDATED_ANIMATION_OUTLINE_WIDTH,
    },
    glowEdge: {
        ...StyleSheet.absoluteFillObject,
        borderWidth: GLOW_EDGE_WIDTH,
    },
    sweepBand: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
    },
});

// Reanimated state is built on first use rather than at import: the row imports this module for every
// session, and only a row that is actually animating should touch Reanimated.
let animatedText: ReturnType<typeof Animated.createAnimatedComponent<typeof Text>> | null = null;
function getAnimatedText() {
    animatedText ??= Animated.createAnimatedComponent(Text);
    return animatedText;
}

/**
 * One clock per motion, shared by the whole list. Every animating row reads the same shared value,
 * so rows move together, there is one UI-thread animation however many rows qualify, and it stops
 * when the last one unmounts (`apps/ui/AGENTS.md`: every loop declares its stop condition).
 */
function createClock(run: (value: SharedValue<number>) => void) {
    let shared: SharedValue<number> | null = null;
    let holders = 0;
    const get = () => (shared ??= makeMutable(0));
    const acquire = () => {
        holders += 1;
        if (holders === 1) run(get());
        return () => {
            holders -= 1;
            if (holders === 0) {
                cancelAnimation(get());
                get().value = 0;
            }
        };
    };
    return { get, acquire };
}

const breathClock = createClock((value) => {
    value.value = withRepeat(
        withTiming(1, { duration: UPDATED_ANIMATION_BREATH_MS / 2, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
    );
});

const sweepClock = createClock((value) => {
    value.value = withRepeat(
        withTiming(1, { duration: UPDATED_ANIMATION_SWEEP_MS, easing: Easing.inOut(Easing.quad) }),
        -1,
        false,
    );
});

/** Reduced motion keeps the state visible but still: a fixed point of each motion. */
const stillValues = new Map<number, SharedValue<number>>();
function getStillValue(at: number): SharedValue<number> {
    let value = stillValues.get(at);
    if (!value) {
        value = makeMutable(at);
        stillValues.set(at, value);
    }
    return value;
}

type Clock = ReturnType<typeof createClock>;

/**
 * The progress a row follows, and whether it holds its clock open.
 * `animationEnabled` is the row's own gate (offscreen rows do not drive the clock).
 */
function useClockProgress(clock: Clock, stillAt: number, animationEnabled: boolean, holdsClock: boolean): SharedValue<number> {
    const hostVisible = useIsHostVisible();
    const reducedMotion = useReducedMotionPreference();
    const animate = animationEnabled && hostVisible && !reducedMotion;

    React.useEffect(() => {
        if (!animate || !holdsClock) return;
        return clock.acquire();
    }, [animate, clock, holdsClock]);

    return reducedMotion ? getStillValue(stillAt) : clock.get();
}

type LayerProps = Readonly<{
    testID?: string;
    animation: Exclude<UpdatedSessionAnimation, 'none'>;
    tone: UpdatedAnimationTone;
    animationEnabled: boolean;
    /** The row's own corner radii, so the outline follows the curve instead of being clipped by it. */
    topRadius: number;
    bottomRadius: number;
}>;

/**
 * The animated layer behind a row's content. Decorative: never announced, never takes a press.
 * Which style it draws is chosen here once, so the row only decides whether it is mounted.
 */
export const UpdatedSessionAnimationLayer = React.memo(function UpdatedSessionAnimationLayer(props: LayerProps) {
    const radii = {
        borderTopLeftRadius: props.topRadius,
        borderTopRightRadius: props.topRadius,
        borderBottomLeftRadius: props.bottomRadius,
        borderBottomRightRadius: props.bottomRadius,
    };
    return (
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            style={[styles.layer, radii]}
        >
            {props.animation === 'fade' ? <FadeLayer {...props} radii={radii} /> : null}
            {props.animation === 'glow' ? <GlowLayer {...props} radii={radii} /> : null}
            {props.animation === 'sweep' ? <SweepLayer {...props} /> : null}
        </Animated.View>
    );
});

type Radii = Readonly<{
    borderTopLeftRadius: number;
    borderTopRightRadius: number;
    borderBottomLeftRadius: number;
    borderBottomRightRadius: number;
}>;

/** Surface and ink invert in step with the breath, inside a steady outline in the state colour. */
function FadeLayer(props: LayerProps & Readonly<{ radii: Radii }>) {
    const { theme } = useUnistyles();
    const palette = resolveUpdatedAnimationPalette(theme, props.tone);
    const progress = useClockProgress(breathClock, 1, props.animationEnabled, true);
    const fillStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

    return (
        <>
            <Animated.View style={[styles.fill, { backgroundColor: palette.invertedSurface }, fillStyle]} />
            <Animated.View style={[styles.outline, props.radii, { borderColor: palette.toneColor }]} />
        </>
    );
}

/** A tinted wash and edge in the state colour that swell and ease with the breath. No inversion. */
function GlowLayer(props: LayerProps & Readonly<{ radii: Radii }>) {
    const { theme } = useUnistyles();
    const palette = resolveUpdatedAnimationPalette(theme, props.tone);
    const progress = useClockProgress(breathClock, 1, props.animationEnabled, true);
    const tintStyle = useAnimatedStyle(() => ({ opacity: progress.value * GLOW_TINT_PEAK_OPACITY }));
    const edgeStyle = useAnimatedStyle(() => ({
        opacity: interpolate(progress.value, [0, 1], [GLOW_EDGE_REST_OPACITY, 1]),
    }));

    return (
        <>
            <Animated.View style={[styles.fill, { backgroundColor: palette.toneColor }, tintStyle]} />
            <Animated.View style={[styles.glowEdge, props.radii, { borderColor: palette.toneColor }, edgeStyle]} />
        </>
    );
}

/** A band of the state colour glides across the row. No inversion; darker on dark themes. */
function SweepLayer(props: LayerProps) {
    const { theme } = useUnistyles();
    const palette = resolveUpdatedAnimationPalette(theme, props.tone);
    const rowWidth = useSharedValue(0);
    // Holds at the middle of the pass under reduced motion, so the row still carries a band of colour.
    const progress = useClockProgress(sweepClock, 0.5, props.animationEnabled, true);
    const bandStyle = useAnimatedStyle(() => {
        const bandWidth = rowWidth.value * SWEEP_BAND_SHARE;
        return {
            width: bandWidth,
            transform: [{ translateX: interpolate(progress.value, [0, 1], [-bandWidth, rowWidth.value]) }],
        };
    });
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        rowWidth.value = event.nativeEvent.layout.width;
    }, [rowWidth]);

    return (
        <Animated.View style={styles.fill} onLayout={handleLayout}>
            <Animated.View style={[styles.sweepBand, bandStyle]}>
                <LinearGradient
                    colors={['transparent', withAlpha(palette.sweepColor, SWEEP_PEAK_ALPHA), 'transparent']}
                    locations={[0, 0.5, 1]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={styles.fill}
                />
            </Animated.View>
        </Animated.View>
    );
}

/**
 * Fade style only: a row's text ink crossing from its resting colour to the inverted ink in step
 * with the surface, so the text is readable at every point of the breath. Used in place of `Text`
 * while a fading row waits; the swap remounts a stateless text leaf, and only when the row's
 * attention state flips.
 */
export const UpdatedAnimationText = React.memo(function UpdatedAnimationText(props: TextProps & Readonly<{
    restColor: string;
    tone: UpdatedAnimationTone;
    animationEnabled: boolean;
}>) {
    const { restColor, tone, animationEnabled, style, ...textProps } = props;
    const { theme } = useUnistyles();
    const { invertedInk } = resolveUpdatedAnimationPalette(theme, tone);
    // The layer owns the clock; the text only follows it.
    const progress = useClockProgress(breathClock, 1, animationEnabled, false);
    const animatedStyle = useAnimatedStyle(() => ({
        color: interpolateColor(progress.value, [0, 1], [restColor, invertedInk]),
    }));

    const AnimatedText = getAnimatedText();
    return <AnimatedText {...textProps} style={[style, animatedStyle]} />;
});
