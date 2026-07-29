import * as React from 'react';
import { StyleSheet as RNStyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, {
    interpolateColor,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { INSTRUMENT_DURATIONS, INSTRUMENT_SPRINGS } from './motion/motionTokens';
import { useMotionPreferences } from './motion/useMotionPreferences';

/**
 * Odometer-style number readout. Each digit column rolls vertically to its new
 * glyph with the `standard` spring (old glyph slides out, new slides in behind a
 * masked overflow); separators / suffix glyphs crossfade. A value change
 * re-renders ONLY the changed digit columns (cells are memoized; direction and
 * emphasis-flash travel via shared values, so unchanged cells keep identical
 * props). At `minimal` level or with animated numbers disabled, renders a plain
 * text swap with zero animation machinery.
 */

export type AnimatedNumberProps = Readonly<{
    value: number;
    /** Formats the raw value for display (L3's `usageNumbers` formatter once it lands). */
    format: (value: number) => string;
    /** Single 1.0→1.06→1.0 scale pulse + brief tint flash on change. */
    emphasisPulse?: boolean;
    /** Tint the emphasis flash with this color instead of the default `text.link` accent. */
    emphasisColor?: string;
    /** Roll direction; `'auto'` = up when the new value is greater. */
    direction?: 'auto';
    /** Text style for the glyphs (font size/weight/color). Keep referentially stable. */
    textStyle?: StyleProp<TextStyle>;
    testID?: string;
}>;

const DIGIT_RE = /[0-9]/;

type GlyphCellProps = Readonly<{
    char: string;
    /** True → vertical roll; false → crossfade (separators, suffixes). */
    isDigit: boolean;
    /** False → instant swap without any transition. */
    animate: boolean;
    /** +1 rolls up (increase), -1 rolls down. Shared so cells never re-render on flips. */
    dir: SharedValue<number>;
    /** 1 → tint flash active, decays to 0. Shared across all cells. */
    flash: SharedValue<number>;
    baseColor: string;
    flashColor: string;
    textStyle?: StyleProp<TextStyle>;
}>;

const GlyphCell = React.memo(function GlyphCell(props: GlyphCellProps) {
    const { char, isDigit, animate, dir, flash, baseColor, flashColor, textStyle } = props;
    // The glyph currently targeted by the animation (mid-flight it is `char`).
    const targetRef = React.useRef(char);
    const [outgoingChar, setOutgoingChar] = React.useState<string | null>(null);
    const progress = useSharedValue(1);
    const cellHeight = useSharedValue(0);

    const clearOutgoing = React.useCallback(() => {
        setOutgoingChar(null);
    }, []);

    React.useEffect(() => {
        if (targetRef.current === char) return;
        const previous = targetRef.current;
        targetRef.current = char;
        if (!animate) {
            setOutgoingChar(null);
            return;
        }
        // Interruptible: a change mid-roll drops the oldest glyph and re-rolls
        // from the currently displayed one.
        setOutgoingChar(previous);
        progress.value = 0;
        progress.value = withSpring(1, INSTRUMENT_SPRINGS.standard, (finished) => {
            if (finished) runOnJS(clearOutgoing)();
        });
    }, [animate, char, clearOutgoing, progress]);

    const incomingStyle = useAnimatedStyle(() => {
        const travel = isDigit ? (1 - progress.value) * cellHeight.value * dir.value : 0;
        return {
            opacity: progress.value,
            transform: [{ translateY: travel }],
            color: interpolateColor(flash.value, [0, 1], [baseColor, flashColor]),
        };
    });

    const outgoingStyle = useAnimatedStyle(() => {
        const travel = isDigit ? -progress.value * cellHeight.value * dir.value : 0;
        return {
            opacity: 1 - progress.value,
            transform: [{ translateY: travel }],
            color: interpolateColor(flash.value, [0, 1], [baseColor, flashColor]),
        };
    });

    return (
        <View style={styles.cell}>
            {/* Width/height driver: keeps the column sized by the (tabular) glyph. */}
            <Text
                style={[styles.glyph, textStyle, styles.widthDriver]}
                onLayout={(event) => {
                    cellHeight.value = event.nativeEvent.layout.height;
                }}
            >
                {char}
            </Text>
            <Animated.Text style={[styles.glyphBase, styles.glyph, textStyle, styles.overlayGlyph, incomingStyle]}>
                {char}
            </Animated.Text>
            {outgoingChar !== null ? (
                <Animated.Text style={[styles.glyphBase, styles.glyph, textStyle, styles.overlayGlyph, outgoingStyle]}>
                    {outgoingChar}
                </Animated.Text>
            ) : null}
        </View>
    );
});

export const AnimatedNumber = React.memo(function AnimatedNumber(props: AnimatedNumberProps) {
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const animate = motion.animatedNumbersEnabled;
    const formatted = props.format(props.value);

    const dir = useSharedValue(1);
    const flash = useSharedValue(0);
    const pulseScale = useSharedValue(1);

    // Direction must be resolved BEFORE the cells' change effects fire (child
    // effects run before parent effects), so it is written during render behind
    // an idempotent previous-value guard.
    const prevValueRef = React.useRef(props.value);
    if (prevValueRef.current !== props.value) {
        dir.value = props.value >= prevValueRef.current ? 1 : -1;
        prevValueRef.current = props.value;
    }

    const emphasisPulse = props.emphasisPulse === true;
    const prevFormattedRef = React.useRef(formatted);
    React.useEffect(() => {
        if (prevFormattedRef.current === formatted) return;
        prevFormattedRef.current = formatted;
        if (!animate || !emphasisPulse) return;
        flash.value = 1;
        flash.value = withTiming(0, { duration: INSTRUMENT_DURATIONS.pulse });
        pulseScale.value = withSequence(
            withTiming(1.06, { duration: INSTRUMENT_DURATIONS.pulse / 2 }),
            withSpring(1, INSTRUMENT_SPRINGS.snappy),
        );
    }, [animate, emphasisPulse, flash, formatted, pulseScale]);

    const pulseStyle = useAnimatedStyle(() => ({
        transform: [{ scale: pulseScale.value }],
    }));

    const baseColor = React.useMemo(() => {
        const flat = RNStyleSheet.flatten(props.textStyle) as TextStyle | undefined;
        return typeof flat?.color === 'string' ? flat.color : theme.colors.text.primary;
    }, [props.textStyle, theme.colors.text.primary]);
    const flashColor = props.emphasisColor ?? theme.colors.text.link;

    if (!animate) {
        return (
            <Text
                testID={props.testID}
                accessibilityLabel={formatted}
                style={[styles.glyph, props.textStyle]}
                numberOfLines={1}
            >
                {formatted}
            </Text>
        );
    }

    const chars = Array.from(formatted);
    const lastIndex = chars.length - 1;

    return (
        <Animated.View
            testID={props.testID}
            accessible
            accessibilityLabel={formatted}
            style={[styles.row, pulseStyle]}
        >
            <View
                style={styles.row}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
            >
                {chars.map((char, index) => (
                    <GlyphCell
                        // Key by position from the RIGHT so the ones column stays the
                        // ones column when the value gains/loses a leading glyph.
                        key={lastIndex - index}
                        char={char}
                        isDigit={DIGIT_RE.test(char)}
                        animate={animate}
                        dir={dir}
                        flash={flash}
                        baseColor={baseColor}
                        flashColor={flashColor}
                        textStyle={props.textStyle}
                    />
                ))}
            </View>
        </Animated.View>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'baseline',
    },
    cell: {
        position: 'relative',
        overflow: 'hidden',
    },
    glyph: {
        fontVariant: ['tabular-nums'],
    },
    glyphBase: {
        ...Typography.default(),
    },
    widthDriver: {
        opacity: 0,
    },
    overlayGlyph: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        textAlign: 'center',
    },
}));
