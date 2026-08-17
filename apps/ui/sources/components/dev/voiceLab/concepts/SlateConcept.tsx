import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ControlRow, TactilePressable } from '@/components/voice/controls/VoiceControls';
import { TranscriptStream } from '@/components/voice/surface/VoiceTranscriptStream';
import { useVoiceEnergy } from '@/components/voice/light/useVoiceEnergy';
import { controlsForState, VOICE_LAB_TRANSCRIPT } from '../voiceLabModel';
import { light, useVoiceLightTokens } from '@/components/voice/light/voiceLightTokens';
import type { VoiceConceptProps } from '../conceptTypes';

/**
 * The only moving part: a rule under the status word whose lit fraction tracks
 * speech energy. It reads as a level meter without ever drawing a waveform,
 * and it degrades to a static rule under reduced motion.
 */
const TypeRule = React.memo(function TypeRule(props: Readonly<{
    stop: Parameters<typeof light>[0];
    width: number;
    active: boolean;
}>) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();

    const fill = useAnimatedStyle(() => {
        'worklet';
        const amp = energy.level.get();
        const lum = energy.luminosity.get();
        const flow = energy.flow.get();
        return {
            opacity: props.active ? 0.4 + lum * 0.6 : 0.3,
            // Inward energy fills from the right, outward from the left, so the
            // direction of the conversation is readable in the rule alone.
            transform: [
                { scaleX: props.active ? 0.14 + amp * 0.86 : 0.14 },
                { translateX: 0 },
            ],
            transformOrigin: flow < 0 ? 'right' : 'left',
        } as any;
    });

    return (
        <View style={{ width: props.width, height: 1.5, marginTop: 7, overflow: 'hidden' }}>
            <View style={{ position: 'absolute', inset: 0, backgroundColor: tokens.rule }} />
            <Animated.View
                style={[
                    { position: 'absolute', inset: 0, backgroundColor: light(props.stop, 0.9, tokens) },
                    fill,
                ]}
            />
        </View>
    );
});

/**
 * SLATE — the typographic control concept.
 *
 * The structural claim: no orb, no glow, no atmosphere. State lives entirely in
 * type — size, weight, tracking, colour, and a single rule — and the transcript
 * *is* the interface. This is the concept the expressive directions have to beat:
 * it is the cheapest to build, the calmest to sit beside for eight hours, the
 * easiest to make accessible, and the hardest to make memorable.
 *
 * Judge the others against this one, not against the current card.
 */
export function SlateConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLightTokens();
    const { state } = props;
    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const controls = controlsForState(state.id, props.provider, props.surface === 'session');
    const conversational = props.expanded && !dormant;

    return (
        <View style={{ alignSelf: 'stretch' }}>
            <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: conversational ? 8 : 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                    {/* The status word is the tap target; nothing interactive nests inside it. */}
                    <TactilePressable
                        static
                        accessibilityLabel={`${state.label}. ${state.caption ?? ''}`}
                        accessibilityHint={dormant ? 'Starts Voice' : 'Opens the voice conversation'}
                        onPress={dormant ? () => props.onAction('start') : props.onToggleExpanded}
                        style={{ flexShrink: 1, minHeight: 26, justifyContent: 'center' }}
                    >
                        <Text
                            numberOfLines={1}
                            style={{
                                ...Typography.default('semiBold'),
                                // Display-scale status. Tight tracking at size is what
                                // makes type feel designed rather than defaulted.
                                fontSize: dormant ? 15 : 21,
                                lineHeight: dormant ? 20 : 25,
                                letterSpacing: dormant ? -0.15 : -0.5,
                                color: tokens.ink,
                            }}
                        >
                            {state.label}
                        </Text>
                    </TactilePressable>
                    <View style={{ flex: 1 }} />
                </View>

                <TypeRule stop={state.stop} width={dormant ? 28 : 64} active={!dormant} />

                {state.caption ? (
                    <Text
                        numberOfLines={2}
                        style={{
                            ...Typography.default(),
                            fontSize: 13,
                            lineHeight: 18,
                            letterSpacing: -0.05,
                            color: tokens.inkMuted,
                            marginTop: 9,
                        }}
                    >
                        {state.caption}
                    </Text>
                ) : null}

                {!dormant ? (
                    <View style={{ marginTop: 12 }}>
                        <ControlRow controls={controls} compact={!conversational} onAction={props.onAction} />
                    </View>
                ) : null}
            </View>

            {conversational ? (
                <View
                    style={{
                        height: 190,
                        paddingHorizontal: 14,
                        paddingTop: 12,
                        borderTopWidth: 1,
                        borderTopColor: tokens.rule,
                    }}
                >
                    <TranscriptStream entries={VOICE_LAB_TRANSCRIPT} />
                </View>
            ) : null}

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
