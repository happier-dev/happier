import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    type SharedValue,
} from 'react-native-reanimated';

import {
    useVoiceEnergyIfMounted,
    useVoiceEnergyPresenceIfMounted,
} from '@/components/voice/light/useVoiceEnergy';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { VoiceRuntimeLevelChannel } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

/**
 * Premium amplitude-reactive voice visualizer.
 *
 * The amplitude comes from the app's single energy bus
 * (`VoiceEnergyProvider`), which owns the one frame callback, the one
 * smoothing envelope (frame-rate-independent `1 - exp(-dt/τ)`) and the one
 * channel-selection policy for the whole app. This component only draws it: the
 * bars read shared values on the UI thread, so audio frames still cause zero
 * React re-renders.
 *
 * It used to own all three of those itself — a frame callback that never
 * stopped, a third smoothing envelope (ATTACK 0.45 / RELEASE 0.12) beside the
 * level store's and the provider's, and a caller-chosen channel that went stale
 * whenever the caller switched it on a mounted instance. §4.2 and §16.4 make
 * the bus the single owner of all three.
 */

const BAR_COUNT = 3;
// Below this the bar rests at its idle height.
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

function VoiceLevelBar(props: Readonly<{
    level: SharedValue<number>;
    sourceActive: SharedValue<number>;
    clockSeconds: SharedValue<number>;
    phase: number;
    fallbackPulse: boolean;
    color: string;
    width: number;
    height: number;
    animate: boolean;
}>) {
    const { animate, clockSeconds, fallbackPulse, height, level, phase, sourceActive } = props;
    const animatedStyle = useAnimatedStyle(() => {
        'worklet';
        if (!animate) {
            return { transform: [{ scaleY: IDLE_SCALE }] };
        }
        const hasSource = sourceActive.get() > 0;
        const target = resolveVoiceLevelTarget(
            level.get(),
            hasSource,
            fallbackPulse,
            // The bus clock is in seconds; the fallback pulse is shaped in ms.
            clockSeconds.get() * 1000,
        );
        const amplitudePhase = hasSource ? phase : 1;
        const scaled = IDLE_SCALE + (1 - IDLE_SCALE) * Math.min(1, target * amplitudePhase);
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
    /**
     * @deprecated Ignored — the energy bus selects the channel in its worklet,
     * with hysteresis, so a meaningful microphone amplitude wins over playback
     * (§4.2 rule 1). Switching a channel on a mounted meter is exactly the stale
     * -amplitude defect that policy exists to remove. Retained only so the
     * shipped `VoiceSurfaceHeader` keeps compiling until it drops the prop.
     */
    channel?: VoiceRuntimeLevelChannel;
    /** Gently pulse while nothing at all is producing amplitude. */
    fallbackPulse?: boolean;
    /** §4.3 escape hatch: a presentation owning its own (already smoothed) amplitude. */
    levelShared?: SharedValue<number>;
    sourceActiveShared?: SharedValue<number>;
}>) {
    const reduceMotion = useReducedMotionPreference();
    const animate = props.isActive && !reduceMotion;
    const energy = useVoiceEnergyIfMounted();
    const presence = useVoiceEnergyPresenceIfMounted();
    // Read-only zero: the amplitude of a meter with no clock, and the source
    // that is not producing it.
    const atRest = useSharedValue(0);
    const injectedSourceActive = useSharedValue(1);

    /*
     * A mounted, animating meter is one of §2.4a's visible consumers: the clock
     * runs while at least one surface is on screen and wants it. Registering on
     * `animate` rather than on mount is the same rule one level down — a meter
     * frozen by reduced motion or by `isActive: false` has nothing to draw, so
     * it must not be the reason the app is running a 60 Hz loop. Nor is a meter
     * whose amplitude was injected: that owner drives its own values.
     */
    const readsBus = props.levelShared === undefined;
    React.useEffect(() => {
        if (!presence || !animate || !readsBus) return;
        presence.acquire();
        return () => presence.release();
    }, [animate, presence, readsBus]);

    const level = props.levelShared ?? energy?.level ?? atRest;
    const sourceActive = props.sourceActiveShared
        ?? (props.levelShared ? injectedSourceActive : energy?.sourceActive)
        ?? atRest;
    const clockSeconds = energy?.clock ?? atRest;

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
                    level={level}
                    sourceActive={sourceActive}
                    clockSeconds={clockSeconds}
                    phase={BAR_PHASE[index] ?? 1}
                    fallbackPulse={props.fallbackPulse === true}
                    color={props.color}
                    width={barWidth}
                    height={barHeight}
                    animate={animate}
                />
            ))}
        </View>
    );
});
