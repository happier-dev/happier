import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useFrameCallback,
    useSharedValue,
    type SharedValue,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { VoiceRuntimeLevelChannel } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { useVoiceLevelSharedValue } from './useVoiceLevelSharedValue';

/**
 * Premium amplitude-reactive voice visualizer.
 *
 * The continuous audio level is bridged from the runtime-owned input/output
 * meter into a Reanimated `SharedValue`, then rendered on the UI thread. It
 * never enters React state or the view-model, so audio frames cause zero React
 * re-renders.
 *
 * Envelope: a per-frame worklet applies asymmetric attack/release smoothing and
 * an epsilon gate so silence costs (almost) nothing and onsets feel snappy.
 */

const BAR_COUNT = 3;
// Asymmetric envelope: fast attack (rise), slower release (decay) — premium feel.
const ATTACK = 0.45;
const RELEASE = 0.12;
// Below this the bar rests at its idle height and the worklet stops integrating.
const EPSILON = 0.004;
const IDLE_SCALE = 0.32;
// Per-bar phase offsets so the bars don't move in lockstep.
const BAR_PHASE = [1, 0.82, 0.9] as const;

export function resolveVoiceLevelTarget(
    source: number,
    sourceActive: boolean,
    fallbackPulse: boolean,
    timestamp: number,
): number {
    'worklet';
    if (sourceActive || !fallbackPulse) return source;
    return 0.24 + Math.sin(timestamp / 480) * 0.04;
}

function useVoiceLevelEnvelope(
    level: SharedValue<number>,
    sourceActive: SharedValue<number>,
    enabled: boolean,
    fallbackPulse: boolean,
): SharedValue<number> {
    const envelope = useSharedValue(0);

    useFrameCallback((frame) => {
        'worklet';
        if (!enabled) {
            if (envelope.get() !== 0) envelope.set(0);
            return;
        }
        const source = level.get();
        const hasSource = sourceActive.get() > 0;
        const target = resolveVoiceLevelTarget(source, hasSource, fallbackPulse, frame.timestamp);
        const current = envelope.get();
        const coefficient = target > current ? ATTACK : RELEASE;
        const next = current + (target - current) * coefficient;
        // Epsilon gate: snap to rest instead of forever chasing a tiny residue.
        envelope.set(next < EPSILON && target < EPSILON ? 0 : next);
    }, enabled);

    return envelope;
}

function VoiceLevelBar(props: Readonly<{
    envelope: SharedValue<number>;
    phase: number;
    sourceActive: SharedValue<number>;
    color: string;
    width: number;
    height: number;
    animate: boolean;
}>) {
    const { envelope, phase, sourceActive, animate, height } = props;
    const animatedStyle = useAnimatedStyle(() => {
        'worklet';
        if (!animate) {
            return { transform: [{ scaleY: IDLE_SCALE }] };
        }
        const amplitudePhase = sourceActive.get() > 0 ? phase : 1;
        const scaled = IDLE_SCALE + (1 - IDLE_SCALE) * Math.min(1, envelope.get() * amplitudePhase);
        return { transform: [{ scaleY: scaled }] };
    });

    return (
        <Animated.View
            style={[
                {
                    width: props.width,
                    height,
                    backgroundColor: props.color,
                    borderRadius: props.width,
                    overflow: 'hidden',
                },
                animatedStyle,
            ]}
        />
    );
}

export const VoiceLevelVisualizer = React.memo(function VoiceLevelVisualizer(props: Readonly<{
    isActive: boolean;
    color: string;
    size?: 'small' | 'medium';
    channel?: VoiceRuntimeLevelChannel;
    fallbackPulse?: boolean;
    levelShared?: SharedValue<number>;
    sourceActiveShared?: SharedValue<number>;
}>) {
    const reduceMotion = useReducedMotionPreference();
    const animate = props.isActive && !reduceMotion;
    const runtimeLevel = useVoiceLevelSharedValue(props.channel ?? 'input');
    const injectedSourceActive = useSharedValue(1);
    const level = props.levelShared ?? runtimeLevel.level;
    const sourceActive = props.sourceActiveShared
        ?? (props.levelShared ? injectedSourceActive : runtimeLevel.sourceActive);
    const envelope = useVoiceLevelEnvelope(level, sourceActive, animate, props.fallbackPulse === true);

    const size = props.size ?? 'small';
    const barWidth = size === 'small' ? 2 : 3;
    const barHeight = size === 'small' ? 12 : 16;
    const gap = size === 'small' ? 1.5 : 2;

    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: 'row', alignItems: 'center', gap, height: barHeight }}
        >
            {Array.from({ length: BAR_COUNT }, (_, index) => (
                <VoiceLevelBar
                    key={index}
                    envelope={envelope}
                    phase={BAR_PHASE[index] ?? 1}
                    sourceActive={sourceActive}
                    color={props.color}
                    width={barWidth}
                    height={barHeight}
                    animate={animate}
                />
            ))}
        </View>
    );
});
