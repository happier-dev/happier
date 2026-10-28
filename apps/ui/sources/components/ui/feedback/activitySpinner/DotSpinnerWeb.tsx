import * as React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';

import {
    DOT_SPINNER_STILL_OPACITY,
    getDotSpinnerFrames,
    readDotSeries,
    unwrapHueSeries,
    type DotSpinnerFrames,
    type DotSpinnerInk,
} from './dotSpinnerFrames';
import { type DotSpinnerStyleId, type DotSpinnerTiming, type SpinnerDot } from './dotSpinnerStyles';
import type { DotSpinnerMotion } from './dotSpinnerMotion';

const BREATH_ANIMATION_NAME = 'happierActivitySpinnerBreath';

type WebAnimationStyle = ViewStyle & {
    animationDirection?: 'alternate';
    animationDuration?: string;
    animationIterationCount?: string;
    animationName?: string;
    animationTimingFunction?: string;
};

const BREATH_STYLE: WebAnimationStyle = {
    animationName: BREATH_ANIMATION_NAME,
    animationDuration: '1200ms',
    animationDirection: 'alternate',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
};

/** One discrete value per sampled frame: the table already holds what shows at each step. */
const STEP_EASING = 'steps(1, end)';

/**
 * The looping aurora gradient's width in units of the spinner size. At 12, a dot (a sixth of the
 * size wide) spans a seventy-secondth of one gradient lap, so it reads as one colour while the dots
 * between them still sit on clearly different stops.
 */
const AURORA_GRADIENT_WIDTH_FACTOR = 12;

type DotPose = Readonly<{
    style: React.CSSProperties;
    /** Null in the still and breathing poses, which schedule no animation. */
    keyframes: Keyframe[] | null;
}>;

/**
 * Each sampled frame becomes one keyframe; `steps(1, end)` holds it until the next boundary.
 *
 * The offsets deliberately stop at (N-1)/N and never reach 1: WAAPI fills the missing final
 * keyframe with the property's underlying value — the inline style — which `buildDotPose` pins to
 * the series' frame 0. The table holds exactly one loop, so the tail segment [(N-1)/N, 1] eases
 * back to frame 0's own value and the cycle closes on itself; an inline style holding anything
 * other than frame 0 would render a wrong pose through that tail and jump at the loop boundary.
 */
function steppedKeyframes(series: readonly number[], project: (value: number) => Keyframe): Keyframe[] {
    return series.map((value, frame) => ({ ...project(value), offset: frame / series.length }));
}

function dotGeometry(dot: SpinnerDot, size: number): React.CSSProperties {
    const pitch = size / 3;
    const diameter = size / 6;
    return {
        position: 'absolute',
        left: (dot.col + 0.5) * pitch - diameter / 2,
        top: (dot.row + 0.5) * pitch - diameter / 2,
        width: diameter,
        height: diameter,
        borderRadius: diameter / 2,
    };
}

/**
 * What one dot renders right now. The style is the pose's static base — the animation's first frame
 * while playing (so nothing flashes before the effect starts, and a host without the Web Animations
 * API still shows the mark), the still pose otherwise. While playing it is also load-bearing as the
 * animation's *last* frame: the keyframes stop one frame short of offset 1, so the tail segment
 * falls back to this inline value — see `steppedKeyframes` for why it must stay frame 0.
 */
function buildDotPose(frames: DotSpinnerFrames, index: number, size: number, ink: DotSpinnerInk, animate: boolean): DotPose {
    const geometry = dotGeometry(frames.dots[index]!, size);
    const brightness = readDotSeries(frames, frames.opacity, index);
    const opacity = animate ? brightness[0]! : DOT_SPINNER_STILL_OPACITY;

    if ('color' in ink || frames.hue == null) {
        const color = 'color' in ink ? ink.color : ink.aurora[0];
        return {
            style: { ...geometry, backgroundColor: color, opacity },
            keyframes: animate ? steppedKeyframes(brightness, (value) => ({ opacity: value })) : null,
        };
    }

    // Aurora travels by shifting a looping accent gradient under the dots, never by fading them:
    // their brightness barely changes across the motion, only their position on it does.
    const gradientWidth = size * AURORA_GRADIENT_WIDTH_FACTOR;
    const position = (hue: number): string => `${hue * gradientWidth}px 0px`;
    const hueSeries = unwrapHueSeries(readDotSeries(frames, frames.hue, index));
    return {
        style: {
            ...geometry,
            opacity,
            backgroundImage: `linear-gradient(90deg, ${ink.aurora[0]}, ${ink.aurora[1]}, ${ink.aurora[2]}, ${ink.aurora[0]})`,
            backgroundSize: `${gradientWidth}px 100%`,
            backgroundPosition: position(hueSeries[0]!),
        },
        keyframes: animate
            ? steppedKeyframes(hueSeries, (value) => ({ backgroundPosition: position(value) }))
            : null,
    };
}

/**
 * The web dots: one absolutely-positioned `<span>` per dot of the chosen mark, driven by the Web
 * Animations API. Keyframes come straight from the shared frame table, so no style sheet, SVG, or
 * image ever enters the document for this spinner (the old frame-sheet cache kept a ≈20 KB SVG data
 * URI in a `<style>` rule that WebKit re-parsed on every rendering update). Every animation's
 * `startTime` is pinned to the document timeline's origin, so all copies on the page step on the
 * same frame boundaries however far apart they mounted. The still and breathing poses schedule no
 * per-dot animation: the still pose is the static style, and the breath fades the whole mark
 * through one CSS animation on the host.
 */
export function DotSpinnerWeb(props: Readonly<{
    styleId: DotSpinnerStyleId;
    timing: DotSpinnerTiming;
    size: number;
    ink: DotSpinnerInk;
    motion: DotSpinnerMotion;
    viewProps: ViewProps;
}>) {
    const { styleId, timing, size, ink, motion, viewProps } = props;
    const frames = getDotSpinnerFrames(styleId, timing);
    const animate = motion === 'animate';
    const spanRefs = React.useRef<Array<HTMLSpanElement | null>>([]);

    const poses = React.useMemo(
        () => frames.dots.map((_, index) => buildDotPose(frames, index, size, ink, animate)),
        [animate, frames, ink, size],
    );

    React.useLayoutEffect(() => {
        if (!animate) return undefined;
        const animations: Animation[] = [];
        spanRefs.current.forEach((span, index) => {
            const keyframes = poses[index]?.keyframes;
            if (!span || typeof span.animate !== 'function' || !keyframes) return;
            const animation = span.animate(
                keyframes,
                { duration: frames.cycleMs, iterations: Infinity, easing: STEP_EASING },
            );
            animation.startTime = 0;
            animations.push(animation);
        });
        return () => {
            for (const animation of animations) animation.cancel();
        };
    }, [animate, frames.cycleMs, poses]);

    const boxStyle: WebAnimationStyle = { width: size, height: size, alignSelf: 'center', overflow: 'hidden' };

    return (
        <View {...viewProps} style={[boxStyle, motion === 'breathe' ? BREATH_STYLE : null, viewProps.style]}>
            {poses.map((pose, index) => React.createElement('span', {
                key: frames.dots[index]!.id,
                ref: (element: HTMLSpanElement | null) => { spanRefs.current[index] = element; },
                style: pose.style,
            }))}
        </View>
    );
}
