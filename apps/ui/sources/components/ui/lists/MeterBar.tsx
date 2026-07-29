import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { resolveUsageTone } from '@/components/instrument/gauge/gaugeMath';

export type MeterTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface MeterBarProps {
    tone: MeterTone;
    /**
     * Fill fraction in 0..1 (clamped). Canonical semantic: fill = consumed / progress — the bar
     * GROWS as work happens (tokens consumed, quota used, agents completed). Pass the used/progress
     * ratio directly; do not invert it.
     */
    fillFraction: number;
    caption?: React.ReactNode;
    /** Track height in px (default 6). */
    height?: number;
    trackColor?: string;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

const DEFAULT_TRACK_HEIGHT_PX = 6;

export function resolveUsageMeterTone(usedPct: number): MeterTone {
    const tone = resolveUsageTone(usedPct);
    if (tone === 'danger') return 'danger';
    if (tone === 'warn') return 'warning';
    return 'neutral';
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        width: '100%',
        borderRadius: 999,
        overflow: 'hidden',
    },
    fill: {
        height: '100%',
        borderRadius: 999,
    },
    caption: {
        color: theme.colors.text.secondary,
        marginTop: 4,
        fontSize: 12,
        lineHeight: 16,
    },
}));

export const MeterBar = React.memo<MeterBarProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const height = props.height ?? DEFAULT_TRACK_HEIGHT_PX;
    const fill = clamp01(props.fillFraction);
    // Read the token directly — never apply a runtime opacity/rgba transform to a
    // theme token (web var-ification turns such transforms into silent no-ops).
    const fillColor = theme.colors.state[props.tone].foreground;
    const trackColor = props.trackColor ?? theme.colors.surface.pressedOverlay;

    return (
        <View testID={props.testID} style={props.style}>
            <View
                testID={props.testID ? `${props.testID}:track` : undefined}
                style={[styles.track, { height, backgroundColor: trackColor }]}
            >
                <View
                    testID={props.testID ? `${props.testID}:fill` : undefined}
                    style={[styles.fill, { width: `${fill * 100}%`, backgroundColor: fillColor }]}
                />
            </View>
            {props.caption != null ? (
                typeof props.caption === 'string' || typeof props.caption === 'number' ? (
                    <Text
                        testID={props.testID ? `${props.testID}:caption` : undefined}
                        style={styles.caption}
                    >
                        {props.caption}
                    </Text>
                ) : (
                    props.caption
                )
            ) : null}
        </View>
    );
});

MeterBar.displayName = 'MeterBar';
