import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    transcriptNavigationRailMarkerMotionEquals,
    type TranscriptNavigationRailMarkerMotion,
} from './resolveTranscriptNavigationRailMotion';
import type { TranscriptNavigationRailMarkerLineHandle } from './transcriptNavigationRailMotionWrite';

type WebMarkerViewProps = React.ComponentPropsWithRef<typeof View> & {
    onClick?: () => void;
    onKeyDown?: (event: unknown) => void;
    onPointerEnter?: (event: unknown) => void;
    tabIndex?: number;
};

const WebMarkerView = View as unknown as React.ComponentType<WebMarkerViewProps>;

export type TranscriptNavigationRailMarkerProps = Readonly<{
    active: boolean;
    anchorId: string;
    index: number;
    label: string;
    lineRef: (anchorId: string, handle: TranscriptNavigationRailMarkerLineHandle | null) => void;
    markerHeightPx: number;
    motion: TranscriptNavigationRailMarkerMotion;
    onFocusFromPointer: (index: number, event: unknown) => void;
    onPress: (index: number) => void;
    pinned: boolean;
    topPx: number;
    visible: boolean;
}>;

function TranscriptNavigationRailMarkerComponent(props: TranscriptNavigationRailMarkerProps) {
    const styles = stylesheet;
    const handlePointerEnter = React.useCallback((event: unknown) => {
        props.onFocusFromPointer(props.index, event);
    }, [props]);
    const handleClick = React.useCallback(() => {
        props.onPress(props.index);
    }, [props]);
    const handleLineRef = React.useCallback((handle: TranscriptNavigationRailMarkerLineHandle | null) => {
        props.lineRef(props.anchorId, handle);
    }, [props]);

    return (
        <WebMarkerView
            accessibilityLabel={props.label}
            accessibilityRole="button"
            accessibilityState={{
                selected: props.active,
            }}
            onClick={handleClick}
            onPointerEnter={handlePointerEnter}
            tabIndex={-1}
            testID={`transcript-navigation-rail.marker:${props.anchorId}`}
            style={[
                styles.markerHitArea,
                {
                    height: Math.max(12, props.markerHeightPx + 8),
                    top: props.topPx - 4,
                },
            ]}
        >
            <View
                ref={handleLineRef}
                testID={`transcript-navigation-rail.marker-line:${props.anchorId}`}
                style={[
                    styles.markerLine,
                    props.active ? styles.markerLineActive : null,
                    props.visible && !props.active ? styles.markerLineVisible : null,
                    {
                        height: props.markerHeightPx,
                        opacity: props.motion.opacity,
                        transform: [{ translateY: props.motion.translateYPx }],
                        width: props.motion.widthPx,
                    },
                ]}
            />
            {props.pinned ? (
                <View
                    testID={`transcript-navigation-rail.marker-pin:${props.anchorId}`}
                    style={[
                        styles.markerPin,
                        props.active ? styles.markerPinActive : null,
                    ]}
                />
            ) : null}
        </WebMarkerView>
    );
}

export const TranscriptNavigationRailMarker = React.memo(
    TranscriptNavigationRailMarkerComponent,
    (left, right) => (
        left.active === right.active &&
        left.anchorId === right.anchorId &&
        left.index === right.index &&
        left.label === right.label &&
        left.lineRef === right.lineRef &&
        left.markerHeightPx === right.markerHeightPx &&
        transcriptNavigationRailMarkerMotionEquals(left.motion, right.motion) &&
        left.onFocusFromPointer === right.onFocusFromPointer &&
        left.onPress === right.onPress &&
        left.pinned === right.pinned &&
        left.topPx === right.topPx &&
        left.visible === right.visible
    ),
);

const stylesheet = StyleSheet.create((theme) => ({
    markerHitArea: {
        alignItems: 'center',
        justifyContent: 'center',
        left: 0,
        position: 'absolute',
        width: 24,
    },
    markerLine: {
        // Full capsule so the line reads with rounded caps at every width.
        borderRadius: 999,
        backgroundColor: theme.colors.text.tertiary,
    },
    markerLineVisible: {
        backgroundColor: theme.colors.text.secondary,
    },
    markerLineActive: {
        backgroundColor: theme.colors.accent.blue,
    },
    markerPin: {
        position: 'absolute',
        right: 3,
        width: 4,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.text.secondary,
    },
    markerPinActive: {
        backgroundColor: theme.colors.accent.blue,
    },
}));
