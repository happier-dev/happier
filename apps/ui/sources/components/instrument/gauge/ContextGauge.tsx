import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, {
    runOnJS,
    useAnimatedReaction,
    useAnimatedStyle,
    useDerivedValue,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

import { t } from '@/text';
import { resolveTokenUsageToneColor } from '@/components/sessions/usage/tokenUsageTone';

import { INSTRUMENT_DURATIONS, INSTRUMENT_PRESS_SCALE, INSTRUMENT_SPRINGS } from '../motion/motionTokens';
import { instrumentThresholdImpact } from '../motion/haptics';
import { useMotionPreferences } from '../motion/useMotionPreferences';
import { GaugeRing } from './GaugeRing';
import { LiquidFill, isLiquidFillSupported } from './LiquidFill';
import {
    clampUsedPct,
    crossedHapticThreshold,
    resolveUsageTone,
    usageToneToTokenUsageTone,
    type UsageTone,
} from './gaugeMath';

/**
 * The in-session context gauge. Public instrument-kit primitive consumed by the
 * session instrument strip (L5).
 *
 * - Tier 1 (`full` effects, native, Skia): liquid vessel via `LiquidFill`.
 * - Tier 2 (everything else): animated stroke-sweep ring via `GaugeRing`.
 * - Fill changes spring-animate (`standard`); crossing 75% / 90% fires one
 *   haptic tick and one scale pulse.
 * - `stale` (model switch): track + dot, no fill, explanatory a11y label.
 *
 * Motion caps come exclusively from `useMotionPreferences` — this component
 * never reads raw settings.
 */

export type ContextGaugeSize = 16 | 20 | 28;

export type ContextGaugeProps = Readonly<{
    /** Used percentage 0–100; a number or a live shared value (keep the kind stable across renders). */
    usedPct: SharedValue<number> | number;
    /** Optional tone override; by default derived from `usedPct` via `resolveUsageTone`. */
    tone?: UsageTone;
    size?: ContextGaugeSize;
    isStreaming?: boolean;
    /** Context usage unknown after a model switch. */
    stale?: boolean;
    onPress?: () => void;
    testID?: string;
}>;

const MIN_HIT_SIZE = 40;

function roundToLabelBucket(pct: number): number {
    return Math.round(pct / 5) * 5;
}

export const ContextGauge = React.memo(function ContextGauge(props: ContextGaugeProps) {
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const size = props.size ?? 20;
    const stale = props.stale === true;
    const isStreaming = props.isStreaming === true;
    const animateFill = motion.level !== 'minimal';

    // Normalize the number | SharedValue input into one target shared value.
    const isSharedInput = typeof props.usedPct === 'object';
    const numericTarget = typeof props.usedPct === 'number' ? props.usedPct : 0;
    const numericTargetSV = useSharedValue(numericTarget);
    React.useEffect(() => {
        numericTargetSV.value = numericTarget;
    }, [numericTarget, numericTargetSV]);
    const externalSV = isSharedInput ? (props.usedPct as SharedValue<number>) : null;
    const target = useDerivedValue(
        () => clampUsedPct(externalSV ? externalSV.value : numericTargetSV.value),
        [externalSV],
    );

    // Spring-smoothed fill + one-shot threshold effects.
    const fillPct = useSharedValue(clampUsedPct(
        typeof props.usedPct === 'number' ? props.usedPct : props.usedPct.value,
    ));
    const pulseScale = useSharedValue(1);
    const hapticsEnabled = motion.hapticsEnabled;

    const fireThresholdFeedback = React.useCallback(() => {
        instrumentThresholdImpact(hapticsEnabled);
    }, [hapticsEnabled]);

    useAnimatedReaction(
        () => target.value,
        (current, previous) => {
            if (previous == null) {
                fillPct.value = current;
                return;
            }
            if (current === previous) return;
            fillPct.value = animateFill
                ? withSpring(current, INSTRUMENT_SPRINGS.standard)
                : current;
            if (crossedHapticThreshold(previous, current) !== null) {
                runOnJS(fireThresholdFeedback)();
                if (animateFill) {
                    pulseScale.value = withSequence(
                        withTiming(1.06, { duration: INSTRUMENT_DURATIONS.pulse / 2 }),
                        withSpring(1, INSTRUMENT_SPRINGS.snappy),
                    );
                }
            }
        },
        [animateFill, fireThresholdFeedback],
    );

    // Tone → theme color, resolved on the UI thread so shared-value updates recolor
    // without a React render. The calm resting accent is the signature teal `text.link`.
    const okColor = theme.colors.text.link;
    const warnColor = theme.colors.state.warning.foreground;
    const dangerColor = theme.colors.state.danger.foreground;
    const toneOverride = props.tone ?? null;
    const strokeColor = useDerivedValue(() => {
        const tone = toneOverride ?? resolveUsageTone(fillPct.value);
        return resolveTokenUsageToneColor({
            tone: usageToneToTokenUsageTone(tone),
            neutralColor: okColor,
            warningColor: warnColor,
            criticalColor: dangerColor,
        });
    }, [dangerColor, okColor, toneOverride, warnColor]);

    const pulseStyle = useAnimatedStyle(() => ({
        transform: [{ scale: pulseScale.value }],
    }));

    // Tier selection: liquid only at `full` level, non-stale, and where Skia runs.
    const useLiquid = motion.effectsEnabled && !stale && isLiquidFillSupported();

    // A11y label follows the live value in coarse 5% buckets: SharedValue-driven
    // updates refresh the announced percentage without a per-frame re-render.
    const [labelPct, setLabelPct] = React.useState(() => roundToLabelBucket(clampUsedPct(
        typeof props.usedPct === 'number' ? props.usedPct : props.usedPct.value,
    )));
    const labelPctRef = React.useRef(labelPct);
    const updateLabelBucket = React.useCallback((bucket: number) => {
        if (labelPctRef.current === bucket) return;
        labelPctRef.current = bucket;
        setLabelPct(bucket);
    }, []);
    useAnimatedReaction(
        () => {
            const raw = clampUsedPct(externalSV ? externalSV.value : numericTargetSV.value);
            return Math.round(raw / 5) * 5;
        },
        (bucket, previous) => {
            if (previous == null || bucket !== previous) {
                runOnJS(updateLabelBucket)(bucket);
            }
        },
        [externalSV, updateLabelBucket],
    );
    const accessibilityLabel = stale
        ? t('instrument.contextGauge.staleLabel')
        : t('instrument.contextGauge.usedLabel', { percent: labelPct });

    const body = (
        <Animated.View style={pulseStyle}>
            {useLiquid ? (
                <LiquidFill
                    fillPct={fillPct}
                    size={size}
                    isStreaming={isStreaming}
                    okColor={okColor}
                    warnColor={warnColor}
                    dangerColor={dangerColor}
                    trackColor={theme.colors.border.default}
                    testID={props.testID ? `${props.testID}-liquid` : undefined}
                />
            ) : (
                <GaugeRing
                    fillPct={fillPct}
                    strokeColor={strokeColor}
                    size={size}
                    trackColor={theme.colors.border.default}
                    stale={stale}
                    staleDotColor={theme.colors.text.tertiary}
                    testID={props.testID ? `${props.testID}-ring` : undefined}
                />
            )}
        </Animated.View>
    );

    if (!props.onPress) {
        return (
            <View
                testID={props.testID}
                accessible
                accessibilityRole="image"
                accessibilityLabel={accessibilityLabel}
                style={styles.root}
            >
                {body}
            </View>
        );
    }

    const hitSlop = Math.max(0, Math.ceil((MIN_HIT_SIZE - size) / 2));
    return (
        <PressableScale
            testID={props.testID}
            accessibilityLabel={accessibilityLabel}
            onPress={props.onPress}
            hitSlop={hitSlop}
            pressAnimationEnabled={animateFill}
        >
            {body}
        </PressableScale>
    );
});

type PressableScaleProps = Readonly<{
    children: React.ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    hitSlop: number;
    pressAnimationEnabled: boolean;
    testID?: string;
}>;

function PressableScale(props: PressableScaleProps) {
    const pressScale = useSharedValue(1);
    const pressStyle = useAnimatedStyle(() => ({
        transform: [{ scale: pressScale.value }],
    }));
    const enabled = props.pressAnimationEnabled;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            hitSlop={props.hitSlop}
            onPress={props.onPress}
            onPressIn={() => {
                if (enabled) pressScale.value = withSpring(INSTRUMENT_PRESS_SCALE, INSTRUMENT_SPRINGS.snappy);
            }}
            onPressOut={() => {
                if (enabled) pressScale.value = withSpring(1, INSTRUMENT_SPRINGS.snappy);
            }}
            style={styles.root}
        >
            <Animated.View style={pressStyle}>{props.children}</Animated.View>
        </Pressable>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
