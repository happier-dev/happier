import * as React from 'react';
import { Animated, Easing, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';

const PLACEHOLDER_TOP_PADDING_PX = 18;
const PLACEHOLDER_HORIZONTAL_PADDING_PX = 16;
const PLACEHOLDER_ROW_GAP_PX = 14;
const PLACEHOLDER_BUBBLE_RADIUS_PX = 8;
const PLACEHOLDER_BUBBLE_PADDING_PX = 12;
const PLACEHOLDER_BUBBLE_LINE_GAP_PX = 8;
const PLACEHOLDER_LINE_HEIGHT_PX = 10;
const PLACEHOLDER_LINE_RADIUS_PX = 5;
const PLACEHOLDER_PULSE_MS = 900;
const PLACEHOLDER_MIN_OPACITY = 0.48;
const PLACEHOLDER_MAX_OPACITY = 0.86;

const PLACEHOLDER_ROWS: ReadonlyArray<Readonly<{
    align: 'left' | 'right';
    bubbleWidth: `${number}%`;
    lineWidths: readonly `${number}%`[];
}>> = [
    { align: 'right', bubbleWidth: '68%', lineWidths: ['84%', '58%'] },
    { align: 'left', bubbleWidth: '76%', lineWidths: ['88%', '72%', '54%'] },
    { align: 'right', bubbleWidth: '58%', lineWidths: ['74%'] },
    { align: 'left', bubbleWidth: '70%', lineWidths: ['82%', '62%'] },
];

const stylesheet = StyleSheet.create((theme) => ({
    overlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: theme.colors.surface.base,
        paddingTop: PLACEHOLDER_TOP_PADDING_PX,
        paddingHorizontal: PLACEHOLDER_HORIZONTAL_PADDING_PX,
    },
    rows: {
        width: '100%',
        alignSelf: 'center',
        gap: PLACEHOLDER_ROW_GAP_PX,
    },
    bubble: {
        maxWidth: '82%',
        borderRadius: PLACEHOLDER_BUBBLE_RADIUS_PX,
        backgroundColor: theme.colors.surface.inset,
        padding: PLACEHOLDER_BUBBLE_PADDING_PX,
        gap: PLACEHOLDER_BUBBLE_LINE_GAP_PX,
    },
    bubbleLeft: {
        alignSelf: 'flex-start',
    },
    bubbleRight: {
        alignSelf: 'flex-end',
    },
    line: {
        height: PLACEHOLDER_LINE_HEIGHT_PX,
        borderRadius: PLACEHOLDER_LINE_RADIUS_PX,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    staticSurface: {
        flex: 1,
        opacity: 0.72,
    },
    activeSurface: {
        flex: 1,
    },
}));

export type TranscriptFirstPaintPlaceholderProps = Readonly<{
    reducedMotion: boolean;
}>;

export function TranscriptFirstPaintPlaceholder(
    props: TranscriptFirstPaintPlaceholderProps,
): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const contentMaxWidth = useLayoutMaxWidth();
    const opacity = React.useRef(new Animated.Value(PLACEHOLDER_MIN_OPACITY)).current;
    React.useEffect(() => {
        if (props.reducedMotion) {
            opacity.setValue(PLACEHOLDER_MAX_OPACITY);
            return;
        }
        opacity.setValue(PLACEHOLDER_MIN_OPACITY);
        if (typeof Animated.sequence !== 'function') {
            opacity.setValue(PLACEHOLDER_MAX_OPACITY);
            return;
        }
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, {
                    toValue: PLACEHOLDER_MAX_OPACITY,
                    duration: PLACEHOLDER_PULSE_MS,
                    easing: Easing.inOut(Easing.cubic),
                    useNativeDriver: true,
                }),
                Animated.timing(opacity, {
                    toValue: PLACEHOLDER_MIN_OPACITY,
                    duration: PLACEHOLDER_PULSE_MS,
                    easing: Easing.inOut(Easing.cubic),
                    useNativeDriver: true,
                }),
            ]),
        );
        animation.start();
        return () => {
            animation.stop();
        };
    }, [opacity, props.reducedMotion]);

    const rows = (
        <View
            testID="transcript-first-paint-placeholder:rows"
            style={[styles.rows, { maxWidth: contentMaxWidth }]}
        >
            {PLACEHOLDER_ROWS.map((row, rowIndex) => (
                <View
                    key={rowIndex}
                    style={[
                        styles.bubble,
                        row.align === 'left' ? styles.bubbleLeft : styles.bubbleRight,
                        { width: row.bubbleWidth },
                    ]}
                >
                    {row.lineWidths.map((width, lineIndex) => (
                        <View
                            key={lineIndex}
                            style={[styles.line, { width }]}
                        />
                    ))}
                </View>
            ))}
        </View>
    );

    return (
        <View
            testID="transcript-first-paint-placeholder"
            pointerEvents="none"
            style={styles.overlay}
            aria-hidden={true}
            accessibilityElementsHidden={true}
            importantForAccessibility="no-hide-descendants"
        >
            {props.reducedMotion ? (
                <View
                    testID="transcript-first-paint-placeholder:static"
                    style={styles.staticSurface}
                >
                    {rows}
                </View>
            ) : (
                <Animated.View
                    testID="transcript-first-paint-placeholder:active"
                    style={[styles.activeSurface, { opacity }]}
                >
                    {rows}
                </Animated.View>
            )}
        </View>
    );
}
