import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

const TRACK_HEIGHT = 2;

// When loading begins before the engine reports a real fraction we still show a
// visible sliver so the surface never reads as frozen, growing toward this cap.
const INDETERMINATE_WIDTH = 0.15;
const MIN_VISIBLE_WIDTH = 0.04;

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
        backgroundColor: 'transparent',
        overflow: 'hidden',
        zIndex: 2,
    },
    fill: {
        height: TRACK_HEIGHT,
        backgroundColor: theme.colors.accent.blue,
    },
    glow: {
        shadowColor: theme.colors.accent.blue,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9,
        shadowRadius: 4,
    },
}));

function clampFraction(value: number): number {
    if (!Number.isFinite(value)) return INDETERMINATE_WIDTH;
    if (value <= 0) return MIN_VISIBLE_WIDTH;
    if (value >= 1) return 1;
    return Math.max(value, MIN_VISIBLE_WIDTH);
}

function resolveWidthPercent(progress: number | null): `${number}%` {
    const fraction = progress == null ? INDETERMINATE_WIDTH : clampFraction(progress);
    return `${Math.round(fraction * 100)}%`;
}

export function BrowserLoadProgressBar(props: Readonly<{
    progress: number | null;
    loading: boolean;
    reducedMotion?: boolean;
    testID?: string;
}>): React.ReactElement | null {
    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;
    const testID = props.testID ?? 'browser-load-progress';

    if (!props.loading) {
        return null;
    }

    return (
        <View
            testID={testID}
            accessibilityRole="progressbar"
            pointerEvents="none"
            style={stylesheet.track}
        >
            <View
                testID={`${testID}-fill`}
                style={[
                    stylesheet.fill,
                    { width: resolveWidthPercent(props.progress) },
                    reducedMotion ? null : stylesheet.glow,
                ]}
            />
        </View>
    );
}
