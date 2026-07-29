import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Svg, Circle } from 'react-native-svg';

/**
 * Canonical circular progress ring (gauge). Renders one or more CONCENTRIC arcs
 * (outermost first) over a faint track, with a centered content slot — the shared
 * primitive behind token-usage rings AND the connected-service capacity gauges
 * (where each ring is one usage limit), so the ring geometry never drifts.
 *
 * Tone → color resolution stays with the caller (each arc takes a resolved
 * `color`): this primitive has no opinion about any domain's tone vocabulary.
 */
export type CapacityRingProps = Readonly<{
    /** Single-arc fill fraction 0..1 (used when `rings` is not provided). */
    ratio?: number;
    /** Single-arc resolved color (used when `rings` is not provided). */
    color?: string;
    /** Concentric arcs, OUTERMOST first. Overrides `ratio`/`color` when non-empty. */
    rings?: ReadonlyArray<{ ratio: number; color: string }>;
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

/** Radial gap between adjacent concentric arcs. */
const RING_GAP = 2.5;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

export function CapacityRing(props: CapacityRingProps) {
    const { theme } = useUnistyles();
    const size = props.size ?? 40;
    const strokeWidth = props.strokeWidth ?? 3;
    const trackColor = props.trackColor ?? theme.colors.border.default;
    const outerRadius = (size - strokeWidth) / 2;

    const arcs = props.rings && props.rings.length > 0
        ? props.rings
        : [{ ratio: props.ratio ?? 0, color: props.color ?? trackColor }];

    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            accessibilityRole="image"
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
                {arcs.map((arc, index) => {
                    const radius = outerRadius - index * (strokeWidth + RING_GAP);
                    if (radius < strokeWidth) return null;
                    const circumference = 2 * Math.PI * radius;
                    const dashOffset = circumference * (1 - clamp01(arc.ratio));
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
                            <Circle
                                testID={index === 0 ? props.progressTestID : undefined}
                                cx={size / 2}
                                cy={size / 2}
                                r={radius}
                                fill="none"
                                stroke={arc.color}
                                strokeWidth={strokeWidth}
                                strokeLinecap="round"
                                strokeDasharray={`${circumference} ${circumference}`}
                                strokeDashoffset={dashOffset}
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
