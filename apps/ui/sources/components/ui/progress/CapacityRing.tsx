import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedProps,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Svg, Circle, Defs, Path, Pattern } from 'react-native-svg';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Canonical circular progress ring (gauge). Renders one or more CONCENTRIC arcs
 * (outermost first) over a faint track, with a centered content slot — the shared
 * primitive behind token-usage rings AND the connected-service capacity gauges
 * (where each ring is one usage limit), so the ring geometry never drifts.
 *
 * Tone → color resolution stays with the caller (each arc takes a resolved
 * `color`): this primitive has no opinion about any domain's tone vocabulary.
 *
 * `segments` is the ring's donut form: the parts of ONE whole on the outer radius, end to end
 * clockwise from 12 o'clock (a storage breakdown). A `hatched` part is one set aside — what would
 * go in a cleanup — drawn as its colour's diagonal hatch so it reads apart from the solid parts.
 */
export type CapacityRingProps = Readonly<{
    /** Single-arc fill fraction 0..1 (used when `rings` is not provided). */
    ratio?: number;
    /** Single-arc resolved color (used when `rings` is not provided). */
    color?: string;
    /** Concentric arcs, OUTERMOST first. Overrides `ratio`/`color` when non-empty. */
    rings?: ReadonlyArray<{ ratio: number; color: string }>;
    /** Parts of one whole (fractions 0..1, in order) on the outer radius. Overrides `rings`/`ratio` when non-empty. */
    segments?: ReadonlyArray<CapacityRingSegment>;
    /** Gap between adjacent parts, in px along the ring. Defaults to 2. */
    segmentGap?: number;
    /** Outer diameter in px. */
    size?: number;
    strokeWidth?: number;
    /** Resolved track (unfilled) color. Defaults to the theme's default border. */
    trackColor?: string;
    /** Centered content (e.g. the capacity % text). */
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** testID for the `Svg` element. */
    ringTestID?: string;
    /** testID for the OUTERMOST progress arc `Circle`. */
    progressTestID?: string;
    accessibilityLabel?: string;
}>;

/** `opacity` steps one ink into a family of tones (a breakdown's greys) without inventing colours. */
export type CapacityRingSegment = Readonly<{ fraction: number; color: string; opacity?: number; pattern?: 'solid' | 'hatched' }>;

/** Radial gap between adjacent concentric arcs. */
const RING_GAP = 2.5;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

export function CapacityRing(props: CapacityRingProps) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const size = props.size ?? 40;
    const strokeWidth = props.strokeWidth ?? 3;
    const trackColor = props.trackColor ?? theme.colors.border.default;
    const outerRadius = (size - strokeWidth) / 2;

    const hatchId = `capacity-ring-hatch-${React.useId().replace(/[^a-z0-9]/giu, '')}`;
    const segments = props.segments && props.segments.length > 0 ? props.segments : null;

    const arcs = props.rings && props.rings.length > 0
        ? props.rings
        : [{ ratio: props.ratio ?? 0, color: props.color ?? trackColor }];

    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
            accessibilityLabel={props.accessibilityLabel}
            style={[styles.root, { width: size, height: size, borderRadius: size / 2 }, props.style]}
        >
            <Svg
                testID={props.ringTestID}
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={styles.ring}
            >
                {segments ? (
                    <CapacityRingSegments
                        segments={segments}
                        size={size}
                        radius={outerRadius}
                        strokeWidth={strokeWidth}
                        gap={props.segmentGap ?? 2}
                        trackColor={trackColor}
                        hatchId={hatchId}
                    />
                ) : arcs.map((arc, index) => {
                    const radius = outerRadius - index * (strokeWidth + RING_GAP);
                    if (radius < strokeWidth) return null;
                    const circumference = 2 * Math.PI * radius;
                    return (
                        <React.Fragment key={index}>
                            <Circle
                                cx={size / 2}
                                cy={size / 2}
                                r={radius}
                                fill="none"
                                stroke={trackColor}
                                strokeWidth={strokeWidth}
                            />
                            <AnimatedCapacityArc
                                testID={index === 0 ? props.progressTestID : undefined}
                                cx={size / 2}
                                cy={size / 2}
                                r={radius}
                                color={arc.color}
                                strokeWidth={strokeWidth}
                                circumference={circumference}
                                dashOffset={circumference * (1 - clamp01(arc.ratio))}
                                reducedMotion={reducedMotion}
                                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                            />
                        </React.Fragment>
                    );
                })}
            </Svg>
            {props.children != null ? (
                <View pointerEvents="none" style={styles.centerOverlay}>
                    {props.children}
                </View>
            ) : null}
        </View>
    );
}

/**
 * The donut: one track, then each non-empty part as a dash of its share of the circumference, offset
 * to where the previous part ended. Parts are still (a breakdown is read, not watched filling).
 */
function CapacityRingSegments(props: Readonly<{
    segments: ReadonlyArray<CapacityRingSegment>;
    size: number;
    radius: number;
    strokeWidth: number;
    gap: number;
    trackColor: string;
    hatchId: string;
}>) {
    const center = props.size / 2;
    const circumference = 2 * Math.PI * props.radius;
    const hatched = props.segments.find(segment => segment.pattern === 'hatched' && clamp01(segment.fraction) > 0);
    // Pattern space follows the stroke, so the hatch keeps one pitch whatever the ring's size.
    const pitch = Math.max(3, props.strokeWidth / 3);
    let start = 0;
    return (
        <>
            {hatched ? (
                <Defs>
                    <Pattern id={props.hatchId} width={pitch} height={pitch} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <Path d={`M0,0 L0,${pitch}`} stroke={hatched.color} strokeWidth={Math.max(1, pitch / 2.5)} />
                    </Pattern>
                </Defs>
            ) : null}
            <Circle cx={center} cy={center} r={props.radius} fill="none" stroke={props.trackColor} strokeWidth={props.strokeWidth} />
            {props.segments.map((segment, index) => {
                const fraction = clamp01(segment.fraction);
                const offset = start;
                start += fraction;
                if (fraction === 0) return null;
                const length = Math.max(0, fraction * circumference - props.gap);
                return (
                    <Circle
                        key={index}
                        cx={center}
                        cy={center}
                        r={props.radius}
                        fill="none"
                        stroke={segment.pattern === 'hatched' ? `url(#${props.hatchId})` : segment.color}
                        strokeOpacity={segment.opacity}
                        strokeWidth={props.strokeWidth}
                        strokeLinecap="butt"
                        strokeDasharray={`${length} ${circumference}`}
                        strokeDashoffset={-offset * circumference}
                        transform={`rotate(-90 ${center} ${center})`}
                    />
                );
            })}
        </>
    );
}

type AnimatedCapacityArcProps = Readonly<{
    testID?: string;
    cx: number;
    cy: number;
    r: number;
    color: string;
    strokeWidth: number;
    circumference: number;
    dashOffset: number;
    reducedMotion: boolean;
    transform: string;
}>;

function AnimatedCapacityArc(props: AnimatedCapacityArcProps) {
    const dashOffset = useSharedValue(props.dashOffset);
    const previousTargetRef = React.useRef(props.dashOffset);
    const previousReducedMotionRef = React.useRef(props.reducedMotion);

    React.useEffect(() => {
        cancelAnimation(dashOffset);
        const targetChanged = previousTargetRef.current !== props.dashOffset;
        const motionBecameAvailable = previousReducedMotionRef.current && !props.reducedMotion;
        previousTargetRef.current = props.dashOffset;
        previousReducedMotionRef.current = props.reducedMotion;

        if (props.reducedMotion) {
            dashOffset.value = props.dashOffset;
        } else if (targetChanged || motionBecameAvailable) {
            dashOffset.value = withTiming(props.dashOffset, {
                duration: reanimatedMotionTokens.durationMs.base,
                easing: reanimatedMotionTokens.easing.standard,
            });
        }

        return () => {
            cancelAnimation(dashOffset);
        };
    }, [dashOffset, props.dashOffset, props.reducedMotion]);

    const animatedProps = useAnimatedProps(() => ({
        strokeDashoffset: dashOffset.value,
    }));

    return (
        <AnimatedCircle
            testID={props.testID}
            cx={props.cx}
            cy={props.cy}
            r={props.r}
            fill="none"
            stroke={props.color}
            strokeWidth={props.strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${props.circumference} ${props.circumference}`}
            transform={props.transform}
            animatedProps={animatedProps}
        />
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        position: 'relative',
        justifyContent: 'center',
        alignItems: 'center',
    },
    ring: {
        position: 'absolute',
        top: 0,
        left: 0,
    },
    centerOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        justifyContent: 'center',
        alignItems: 'center',
    },
}));
