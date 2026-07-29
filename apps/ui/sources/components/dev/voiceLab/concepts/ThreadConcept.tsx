import * as React from 'react';
import { View } from 'react-native';
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
 * The composer's own top edge, lit.
 *
 * A single 2pt strip is the entire persistent chrome. Speech energy travels
 * along it: inward from both ends while the user is heard, outward from the
 * centre while Happier speaks. Direction alone tells you who has the floor.
 */
const SpeechEdge = React.memo(function SpeechEdge(props: Readonly<{
    stop: Parameters<typeof light>[0];
    active: boolean;
}>) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();

    const core = useAnimatedStyle(() => {
        'worklet';
        const amp = energy.level.get();
        const flow = energy.flow.get();
        const lum = energy.luminosity.get();
        // Outward: the lit segment widens from the centre.
        // Inward: it narrows toward the centre as the user's voice gathers.
        const spread = flow >= 0
            ? 0.18 + amp * 0.62 + Math.max(0, flow) * 0.16
            : Math.max(0.08, 0.5 - amp * 0.34);
        return {
            opacity: props.active ? 0.35 + lum * 0.65 : 0.22,
            transform: [{ scaleX: spread }],
        };
    });

    return (
        <View style={{ height: 2, overflow: 'hidden' }}>
            <View style={{ position: 'absolute', inset: 0, backgroundColor: tokens.rule }} />
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        inset: 0,
                        backgroundColor: light(props.stop, 0.95, tokens),
                        filter: 'blur(0.5px)',
                    },
                    core,
                ]}
            />
        </View>
    );
});

/**
 * THREAD — Voice as a state of the conversation, not a widget on top of it.
 *
 * The structural claim: in-session Voice should have **no object at all**. The
 * composer you already type into becomes the thing you speak into: it keeps its
 * exact geometry, its placeholder resolves into the live partial transcript, and
 * its top edge lights up with the speech. Spoken turns land as first-class
 * transcript messages with a lit left edge, so there is one conversation rather
 * than a voice window sitting beside a coding window.
 *
 * This is the only concept where ending Voice changes nothing spatially — the
 * composer was never replaced, so there is nothing to put back.
 */
export function ThreadConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();
    const { state } = props;
    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const controls = controlsForState(state.id, props.provider, props.surface === 'session');

    const voiceMode = useSharedValue(dormant ? 0 : 1);
    React.useEffect(() => {
        voiceMode.set(
            energy.reduced
                ? (dormant ? 0 : 1)
                : withTiming(dormant ? 0 : 1, {
                    duration: dormant ? VOICE_MOTION.exit.durationMs : VOICE_MOTION.spatial.durationMs,
                    easing: EASE_SPATIAL,
                }),
        );
    }, [dormant, energy.reduced, voiceMode]);

    // The placeholder and the live line cross-fade in place. The composer's
    // height never changes, so nothing below it moves.
    const placeholderStyle = useAnimatedStyle(() => ({ opacity: 1 - voiceMode.get() }));
    const liveStyle = useAnimatedStyle(() => ({
        opacity: voiceMode.get(),
        transform: [{ translateY: (1 - voiceMode.get()) * 4 }],
    }));

    const glowStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: voiceMode.get() * (0.3 + energy.luminosity.get() * 0.7) };
    });

    return (
        <View style={{ flex: 1, alignSelf: 'stretch' }}>
            <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 8 }}>
                <TranscriptStream />
            </View>

            {/* The composer. Same geometry in both modes. */}
            <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingTop: 6 }}>
                <View
                    style={{
                        borderRadius: 14,
                        overflow: 'hidden',
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        backgroundColor: tokens.dark ? 'rgba(34,28,28,0.9)' : '#ffffff',
                        boxShadow: tokens.dark
                            ? '0 8px 26px -12px rgba(0,0,0,0.6)'
                            : '0 8px 26px -14px rgba(30,20,10,0.18)',
                    } as any}
                >
                    <SpeechEdge stop={state.stop} active={!dormant} />

                    <Animated.View
                        pointerEvents="none"
                        style={[{ position: 'absolute', inset: 0, overflow: 'hidden' }, glowStyle]}
                    >
                        <Bloom
                            size={280}
                            blur={64}
                            stop={state.stop}
                            alpha={0.3}
                            polarity={1}
                            reactivity={1}
                            style={{ left: '50%', marginLeft: -140, top: -196 }}
                        />
                        <Grain radius={14} />
                    </Animated.View>

                    {/* Fixed-height text well so voice never shifts the layout. */}
                    <View style={{ minHeight: 46, justifyContent: 'center', paddingHorizontal: 13, paddingVertical: 10 }}>
                        <Animated.View style={[{ position: 'absolute', left: 13, right: 13 }, placeholderStyle]}>
                            <Text style={{ ...Typography.default(), fontSize: 14, color: tokens.inkFaint }}>
                                Reply to Codex…
                            </Text>
                        </Animated.View>
                        <Animated.View style={liveStyle}>
                            <Text
                                numberOfLines={2}
                                style={{
                                    ...Typography.default(),
                                    fontSize: 14,
                                    lineHeight: 19,
                                    letterSpacing: -0.1,
                                    color: tokens.ink,
                                    // Partial speech is never presented as final text.
                                    opacity: state.id === 'user_speaking' ? 0.78 : 1,
                                    fontStyle: state.id === 'user_speaking' ? 'italic' : 'normal',
                                }}
                            >
                                {state.id === 'user_speaking'
                                    ? 'so after that let’s take the activity count next'
                                    : (state.caption ?? state.label)}
                            </Text>
                        </Animated.View>
                    </View>

                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                            paddingHorizontal: 10,
                            paddingBottom: 9,
                        }}
                    >
                        <TactilePressable
                            accessibilityLabel={dormant ? 'Start Voice' : `${state.label}. Open voice controls`}
                            onPress={dormant ? () => props.onAction('start') : props.onToggleExpanded}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 6,
                                minHeight: 26,
                                paddingHorizontal: 9,
                                borderRadius: 999,
                                backgroundColor: dormant
                                    ? 'transparent'
                                    : light(state.stop, tokens.dark ? 0.18 : 0.14, tokens),
                                borderWidth: dormant ? 1 : 0,
                                borderColor: tokens.rule,
                            }}
                        >
                            <View
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 6,
                                    backgroundColor: light(state.stop, 1, tokens),
                                }}
                            />
                            <Text
                                style={{
                                    ...Typography.default('semiBold'),
                                    fontSize: 11.5,
                                    color: dormant ? tokens.inkMuted : tokens.ink,
                                }}
                            >
                                {dormant ? 'Voice' : state.label}
                            </Text>
                        </TactilePressable>

                        <View style={{ flex: 1 }} />
                    </View>

                    {props.expanded && !dormant ? (
                        <View
                            style={{
                                paddingHorizontal: 10,
                                paddingBottom: 10,
                                paddingTop: 2,
                                borderTopWidth: 1,
                                borderTopColor: tokens.rule,
                            }}
                        >
                            <View style={{ height: 8 }} />
                            <ControlRow controls={controls} onAction={props.onAction} />
                        </View>
                    ) : null}
                </View>
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
