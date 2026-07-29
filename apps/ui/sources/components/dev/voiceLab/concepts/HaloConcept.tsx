import * as React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ControlRow, TactilePressable } from '../ConceptControls';
import { Bloom, Grain } from '../VoiceLight';
import { TranscriptStream } from '../TranscriptStream';
import { useVoiceLabEnergy } from '../useVoiceLabEnergy';
import { controlsForState } from '../voiceLabModel';
import { VOICE_MOTION, light, useVoiceLabTokens, VOICE_LIGHT } from '../voiceLabTokens';
import type { VoiceConceptProps } from '../conceptTypes';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));
const SPHERE = 52;

/**
 * The sphere itself — a small body of Happier's own light.
 *
 * Dimensionality comes from four stacked layers rather than a gradient trick: an
 * outer atmosphere, a two-stop body, an offset specular, and a rim. The specular
 * sits up-left of centre, which is what makes the eye read it as a lit sphere
 * instead of a coloured circle.
 */
const Sphere = React.memo(function Sphere(props: Readonly<{
    size: number;
    stop: keyof typeof VOICE_LIGHT;
    stopSecondary: keyof typeof VOICE_LIGHT;
}>) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();
    const { size } = props;

    const body = useAnimatedStyle(() => {
        'worklet';
        const lum = energy.luminosity.get();
        const amp = energy.level.get();
        const flow = energy.flow.get();
        // Outward flow inflates the sphere; inward flow draws it in slightly.
        const swell = 1 + amp * (0.05 + Math.max(0, flow) * 0.06) - Math.max(0, -flow) * amp * 0.025;
        return { opacity: 0.4 + lum * 0.6, transform: [{ scale: swell }] };
    });

    // The terminator tilts toward the energy: light gathers low when Happier is
    // listening, and lifts when it speaks. State is legible with colour removed.
    const terminator = useAnimatedStyle(() => {
        'worklet';
        const flow = energy.flow.get();
        const amp = energy.level.get();
        return {
            opacity: 0.5 + amp * 0.3,
            transform: [{ translateY: size * 0.12 * -flow }, { scale: 1 + amp * 0.08 }],
        };
    });

    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            {/* Atmosphere — the light the sphere throws onto whatever is behind it. */}
            <Bloom
                size={size * 2.4}
                blur={size * 0.42}
                stop={props.stop}
                alpha={0.3}
                polarity={1}
                reactivity={1.1}
            />
            <Bloom
                size={size * 1.5}
                blur={size * 0.2}
                stop={props.stopSecondary}
                alpha={0.34}
                polarity={-1}
                reactivity={0.8}
                phase={2.1}
            />

            <Animated.View
                style={[
                    {
                        width: size,
                        height: size,
                        borderRadius: size,
                        overflow: 'hidden',
                        borderWidth: 0.5,
                        borderColor: light(props.stop, 0.5, tokens),
                    },
                    body,
                ]}
            >
                <LinearGradient
                    colors={[VOICE_LIGHT[props.stop], VOICE_LIGHT[props.stopSecondary]]}
                    start={{ x: 0.25, y: 0 }}
                    end={{ x: 0.75, y: 1 }}
                    style={{ position: 'absolute', inset: 0 }}
                />
                {/* Terminator: the shadowed limb that gives the sphere its volume. */}
                <Animated.View style={[{ position: 'absolute', inset: 0 }, terminator]}>
                    <View
                        style={{
                            position: 'absolute',
                            width: size * 1.5,
                            height: size * 1.5,
                            borderRadius: size * 1.5,
                            left: -size * 0.1,
                            top: size * 0.42,
                            backgroundColor: 'rgba(10,8,20,0.55)',
                            filter: `blur(${size * 0.22}px)`,
                        }}
                    />
                </Animated.View>
                {/* Specular, offset up-left. Small, tight, and never fully white. */}
                <View
                    style={{
                        position: 'absolute',
                        width: size * 0.42,
                        height: size * 0.34,
                        borderRadius: size,
                        left: size * 0.16,
                        top: size * 0.1,
                        backgroundColor: 'rgba(255,252,245,0.72)',
                        filter: `blur(${size * 0.12}px)`,
                    }}
                />
                <Grain radius={size} opacity={0.05} />
            </Animated.View>
        </View>
    );
});

/**
 * HALO — Voice as an app-level companion that lives in space.
 *
 * The structural claim: Global Voice is not part of any one screen's layout. It
 * is an object with a position, it survives navigation, and it expands out of
 * its own body rather than opening a panel somewhere else. Collapsed it is a
 * 52pt sphere; tapped it unfurls into a conversation anchored to itself, so the
 * sphere never disappears and the user never loses the thread.
 *
 * It is a deliberate sibling of the existing pet overlay — same layer, same
 * drag-and-snap physics — which is exactly why the two need a stated
 * coexistence policy rather than both drifting into the same corner.
 */
export function HaloConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();
    const { state } = props;
    const controls = controlsForState(state.id, props.provider, props.surface === 'session');

    // Drag with magnetic corner snap, entirely on the UI thread.
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const dragging = useSharedValue(0);
    const [bounds, setBounds] = React.useState({ w: 320, h: 420 });

    const pan = React.useMemo(
        () =>
            Gesture.Pan()
                .onBegin(() => {
                    'worklet';
                    dragging.set(withTiming(1, { duration: 120 }));
                    startX.set(x.get());
                    startY.set(y.get());
                })
                .onUpdate((e) => {
                    'worklet';
                    // 1:1 with the pointer. Anything else feels like lag.
                    x.set(startX.get() + e.translationX);
                    y.set(startY.get() + e.translationY);
                })
                .onFinalize((e) => {
                    'worklet';
                    dragging.set(withTiming(0, { duration: 180 }));
                    // Project the throw, then snap to the nearest horizontal edge.
                    const projectedX = x.get() + e.velocityX * 0.12;
                    const projectedY = y.get() + e.velocityY * 0.12;
                    const maxX = 0;
                    const minX = -(bounds.w - SPHERE - 32);
                    const midX = (minX + maxX) / 2;
                    const targetX = projectedX < midX ? minX : maxX;
                    const targetY = Math.max(-(bounds.h - SPHERE - 32), Math.min(0, projectedY));
                    x.set(withSpring(targetX, { damping: 22, stiffness: 190, velocity: e.velocityX }));
                    y.set(withSpring(targetY, { damping: 24, stiffness: 200, velocity: e.velocityY }));
                }),
        [bounds.h, bounds.w, dragging, startX, startY, x, y],
    );

    const floaterStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: x.get() },
            { translateY: y.get() },
            { scale: 1 + dragging.get() * 0.06 },
        ],
    }));

    const panel = useSharedValue(props.expanded ? 1 : 0);
    React.useEffect(() => {
        panel.set(
            energy.reduced
                ? (props.expanded ? 1 : 0)
                : withTiming(props.expanded ? 1 : 0, {
                    duration: props.expanded ? VOICE_MOTION.spatial.durationMs : VOICE_MOTION.exit.durationMs,
                    easing: EASE_SPATIAL,
                }),
        );
    }, [energy.reduced, panel, props.expanded]);

    // The pane grows out of the sphere's own centre, so the expansion reads as
    // the object unfurling rather than a modal arriving from nowhere.
    const panelStyle = useAnimatedStyle(() => {
        'worklet';
        const p = panel.get();
        return {
            opacity: p,
            pointerEvents: p > 0.5 ? 'auto' : 'none',
            transform: [
                { translateX: (1 - p) * 96 },
                { translateY: (1 - p) * 40 },
                { scale: 0.86 + p * 0.14 },
            ],
        } as any;
    });

    return (
        <View
            style={{ flex: 1 }}
            onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                setBounds({ w: Math.round(width), h: Math.round(height) });
            }}
        >
            <View style={{ position: 'absolute', right: 16, bottom: 16, alignItems: 'flex-end' }}>
                {/* The floater is as wide as its panel, so the sphere needs its
                    own end-alignment to stay on the anchored edge. */}
                <Animated.View style={[{ alignItems: 'flex-end' }, floaterStyle]}>
                    {/* The conversation, anchored above the sphere. */}
                    <Animated.View
                        style={[
                            {
                                width: Math.min(316, bounds.w - 32),
                                height: Math.min(360, bounds.h - 110),
                                marginBottom: 12,
                                borderRadius: 20,
                                overflow: 'hidden',
                                backgroundColor: tokens.dark ? 'rgba(28,24,24,0.92)' : 'rgba(255,255,255,0.94)',
                                borderWidth: 1,
                                borderColor: tokens.rule,
                                boxShadow: tokens.dark
                                    ? '0 24px 64px -18px rgba(0,0,0,0.7), 0 2px 8px rgba(0,0,0,0.35)'
                                    : '0 24px 64px -20px rgba(30,20,10,0.24), 0 2px 8px rgba(0,0,0,0.08)',
                                // Anchored to the sphere's centre, bottom-right.
                                transformOrigin: 'bottom right',
                            } as any,
                            panelStyle,
                        ]}
                    >
                        <View style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} pointerEvents="none">
                            <Bloom
                                size={340}
                                blur={70}
                                stop={state.stop}
                                alpha={0.16}
                                polarity={1}
                                reactivity={0.5}
                                style={{ right: -110, bottom: -150 }}
                            />
                            <Grain radius={20} />
                        </View>

                        <View style={{ padding: 14, gap: 2 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Text
                                    style={{
                                        ...Typography.default('semiBold'),
                                        fontSize: 14,
                                        letterSpacing: -0.15,
                                        color: tokens.ink,
                                        flex: 1,
                                    }}
                                >
                                    {state.label}
                                </Text>
                            </View>
                            {state.caption ? (
                                <Text
                                    numberOfLines={1}
                                    style={{ ...Typography.default(), fontSize: 12, color: tokens.inkMuted }}
                                >
                                    {state.caption}
                                </Text>
                            ) : null}
                        </View>

                        <View style={{ flex: 1, paddingHorizontal: 14 }}>
                            <TranscriptStream />
                        </View>

                        <View style={{ padding: 14, paddingTop: 10 }}>
                            <ControlRow controls={controls} onAction={props.onAction} />
                        </View>
                    </Animated.View>

                    <GestureDetector gesture={pan}>
                        <View>
                            <TactilePressable
                                static
                                accessibilityLabel={`Voice. ${state.label}. ${state.caption ?? ''}`}
                                accessibilityHint={props.expanded ? 'Collapses the conversation' : 'Opens the conversation'}
                                onPress={props.onToggleExpanded}
                            >
                                <Sphere size={SPHERE} stop={state.stop} stopSecondary={state.stopSecondary} />
                            </TactilePressable>
                        </View>
                    </GestureDetector>
                </Animated.View>
            </View>

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
