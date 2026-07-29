import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ControlRow, TactilePressable } from '../ConceptControls';
import { Bloom, Grain } from '../VoiceLight';
import { TranscriptStream } from '../TranscriptStream';
import { useVoiceLabEnergy } from '../useVoiceLabEnergy';
import { controlsForState } from '../voiceLabModel';
import { VOICE_MOTION, light, useVoiceLabTokens } from '../voiceLabTokens';
import type { VoiceConceptProps } from '../conceptTypes';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));

/**
 * A meniscus: the top arc of a very wide circle, clipped by the vessel.
 *
 * Making the liquid a real curved surface rather than a bar chart is what keeps
 * it from becoming decorative waveform chrome — the surface has one continuous
 * shape, and everything the voice does deforms *that* shape.
 */
const Meniscus = React.memo(function Meniscus(props: Readonly<{
    width: number;
    stop: Parameters<typeof light>[0];
    alpha: number;
    /** Height of the resting liquid surface, in points from the vessel floor. */
    restPx: number;
    /** How strongly amplitude raises and domes this layer. */
    gain: number;
    phase: number;
    blur?: number;
}>) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();
    // A very wide circle gives a shallow, believable surface curve.
    const arc = Math.max(props.width * 2.6, 520);

    const animated = useAnimatedStyle(() => {
        'worklet';
        const amp = energy.level.get();
        const lum = energy.luminosity.get();
        const flow = energy.flow.get();
        const t = energy.clock.get();

        // Swell: the assistant speaking domes the surface upward.
        // Draw: the user speaking pulls it down and inward.
        const swell = amp * props.gain * (0.5 + Math.max(0, flow) * 0.9);
        const draw = Math.max(0, -flow) * amp * props.gain * 0.32;

        // Slow lateral drift so the surface never looks frozen or looped.
        const drift = Math.sin(t * 0.37 + props.phase) * 8;
        // Roll: a shallow tilt, as a real liquid settles.
        const roll = Math.sin(t * 0.61 + props.phase * 1.7) * (0.6 + amp * 1.8);

        return {
            opacity: 0.25 + lum * 0.75,
            transform: [
                { translateX: drift },
                { translateY: -(swell - draw) * 26 },
                { rotateZ: `${roll}deg` },
                { scaleY: 1 + swell * 0.22 },
            ],
        };
    });

    return (
        <Animated.View
            pointerEvents="none"
            style={[
                {
                    position: 'absolute',
                    width: arc,
                    height: arc,
                    borderRadius: arc,
                    left: (props.width - arc) / 2,
                    // Only the crown of the circle sits inside the vessel: place the
                    // circle so its top edge lands exactly at the resting surface.
                    bottom: props.restPx - arc,
                    backgroundColor: light(props.stop, props.alpha, tokens),
                    filter: props.blur ? `blur(${props.blur}px)` : undefined,
                } as any,
                animated,
            ]}
        />
    );
});

/**
 * TIDE — Voice as a body of liquid light in a vessel.
 *
 * The structural claim: the presence is a *substance*, not a light or a line. It
 * has a surface, a volume, and inertia. The user's voice draws the surface down
 * and inward; Happier's voice domes it upward; an interruption sends a
 * displacement across it; delegated work makes it go still and deep with a slow
 * undercurrent. Nothing about the state is communicated by a badge.
 *
 * This is the most expressive direction and the highest risk: a substance that
 * is always moving is exactly what becomes exhausting on the twentieth hour of
 * coding, so it deliberately goes almost completely still whenever nobody is
 * speaking.
 */
export function TideConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();
    const { state } = props;
    const [width, setWidth] = React.useState(300);
    const onLayout = React.useCallback((e: LayoutChangeEvent) => {
        const next = Math.round(e.nativeEvent.layout.width);
        setWidth((prev) => (prev === next ? prev : next));
    }, []);

    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const conversational = props.expanded && !dormant;
    const controls = controlsForState(state.id, props.provider, props.surface === 'session');

    const height = dormant ? 52 : conversational ? 272 : 104;
    const animatedHeight = useSharedValue(height);
    React.useEffect(() => {
        animatedHeight.set(
            energy.reduced
                ? height
                : withTiming(height, { duration: VOICE_MOTION.spatial.durationMs, easing: EASE_SPATIAL }),
        );
    }, [animatedHeight, energy.reduced, height]);
    const vesselStyle = useAnimatedStyle(() => ({ height: animatedHeight.get() }));

    // Caustics: light scattered under the surface. They drift slowly and only
    // brighten with amplitude, so a silent vessel is genuinely calm.
    const causticStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: 0.2 + energy.level.get() * 0.55 };
    });

    return (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }} onLayout={onLayout}>
                <Animated.View
                    style={[
                        {
                            borderRadius: 18,
                            overflow: 'hidden',
                            borderWidth: 1,
                            borderColor: tokens.rule,
                            backgroundColor: tokens.dark ? 'rgba(20,18,26,0.72)' : 'rgba(250,249,252,0.9)',
                            justifyContent: 'flex-end',
                        },
                        vesselStyle,
                    ]}
                >
                    <View style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} pointerEvents="none">
                        {/* Depth first, surface last. */}
                        <Meniscus width={width - 24} stop={state.stopSecondary} alpha={0.26} restPx={height * 0.62} gain={0.6} phase={0} blur={16} />
                        <Meniscus width={width - 24} stop={state.stop} alpha={0.34} restPx={height * 0.5} gain={1} phase={2.4} blur={6} />
                        <Meniscus width={width - 24} stop={state.stop} alpha={0.5} restPx={height * 0.4} gain={1.3} phase={4.1} />

                        <Animated.View style={[{ position: 'absolute', inset: 0 }, causticStyle]}>
                            <Bloom size={130} blur={38} stop={state.stop} alpha={0.4} polarity={1} reactivity={1.2} style={{ left: 18, bottom: -34 }} />
                            <Bloom size={96} blur={30} stop={state.stopSecondary} alpha={0.36} polarity={-1} reactivity={0.9} phase={3.2} style={{ right: 22, bottom: -24 }} />
                        </Animated.View>
                        <Grain radius={18} />
                    </View>

                    {conversational ? (
                        <View style={{ height: 150, paddingHorizontal: 13, marginBottom: 6 }}>
                            <TranscriptStream compact />
                        </View>
                    ) : null}

                    <View style={{ paddingHorizontal: 13, paddingBottom: 12 }}>
                        {/* Tap target and controls are siblings — never nested. */}
                        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
                            <TactilePressable
                                static
                                accessibilityLabel={`${state.label}. ${state.caption ?? ''}`}
                                accessibilityHint={dormant ? 'Starts Voice' : 'Opens the voice conversation'}
                                onPress={dormant ? () => props.onAction('start') : props.onToggleExpanded}
                                style={{ flex: 1, minWidth: 0, minHeight: 34, justifyContent: 'flex-end' }}
                            >
                                <Text
                                    numberOfLines={1}
                                    style={{
                                        ...Typography.default('semiBold'),
                                        fontSize: 15,
                                        lineHeight: 19,
                                        letterSpacing: -0.15,
                                        color: tokens.ink,
                                    }}
                                >
                                    {state.label}
                                </Text>
                                {state.caption ? (
                                    <Text
                                        numberOfLines={1}
                                        style={{
                                            ...Typography.default(),
                                            fontSize: 12,
                                            lineHeight: 16,
                                            color: tokens.inkMuted,
                                            marginTop: 1,
                                        }}
                                    >
                                        {state.caption}
                                    </Text>
                                ) : null}
                            </TactilePressable>
                        </View>

                        {!dormant ? (
                            <View style={{ marginTop: 9 }}>
                                <ControlRow controls={controls} compact={!conversational} onAction={props.onAction} />
                            </View>
                        ) : null}
                    </View>
                </Animated.View>

            <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', left: -10_000 }}
            >
                <Text>{state.announcement}</Text>
            </View>
        </View>
    );
}
