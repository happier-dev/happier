import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ControlRow, TactilePressable, VoiceTransport } from '@/components/voice/controls/VoiceControls';
import { Bloom, Grain, PlanetLimb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { TranscriptStream } from '@/components/voice/surface/VoiceTranscriptStream';
import { useVoiceEnergy } from '@/components/voice/light/useVoiceEnergy';
import { controlsForState, VOICE_LAB_TRANSCRIPT } from '../voiceLabModel';
import { VOICE_MOTION, light, useVoiceLightTokens } from '@/components/voice/light/voiceLightTokens';
import type { VoiceConceptProps } from '../conceptTypes';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));

/**
 * HORIZON — the vessel from Tide, the sky from Aurora, and a real transport.
 *
 * The structural claim: Voice is a **window onto the Happier planet**, docked in
 * the sidebar. Tide's contained vessel gives it a deliberate edge (and keeps it
 * from competing with the app header the way a full-bleed band does); Aurora's
 * rising limb gives it the identity; and the transport makes it something you
 * can actually operate rather than merely watch.
 *
 * The trade Aurora made — no card at all — is given up on purpose here: a
 * bounded object reads as *a thing you can act on*, which is exactly what the
 * first round was missing.
 */
export function HorizonConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const { state } = props;
    const [width, setWidth] = React.useState(296);
    const onLayout = React.useCallback((e: LayoutChangeEvent) => {
        const next = Math.round(e.nativeEvent.layout.width);
        setWidth((prev) => (prev === next ? prev : next));
    }, []);

    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const live = !dormant && state.id !== 'error' && state.id !== 'ended';
    const conversational = props.expanded && !dormant;
    const controls = controlsForState(state.id, props.provider, props.surface === 'session');
    // The transport owns start/end/mute; everything else stays contextual so the
    // cluster never becomes a row of equal-weight buttons.
    const extra = controls.filter(
        (c) => c.id !== 'start' && c.id !== 'end' && c.id !== 'mute',
    );

    /*
     * Height follows what is actually rendered, not merely whether the surface
     * is dormant. `error`, `ended`, `working` and `attention` are non-dormant
     * but have no meter, and reserving the meter's row for them left a dead
     * band. The vessel only pays for the baseline when the baseline exists.
     */
    const hasMeter = live;
    /*
     * Heights are the content plus SYMMETRIC padding, not a round number with a
     * flex spacer soaking up the remainder — that is what made the gap under the
     * caption visibly deeper than the gap above the label.
     *
     *   status block = 19 (label) + 1 + 16 (caption) = 36
     *   meter row    = 8 (gap) + 20 (bars)           = 28
     */
    const PAD = 12;
    const STATUS = 36;
    const METER = 28;
    const height = conversational
        ? 286
        : PAD * 2 + STATUS + (hasMeter ? METER : 0);
    const animatedHeight = useSharedValue(height);
    React.useEffect(() => {
        animatedHeight.set(
            energy.reduced
                ? height
                : withTiming(height, { duration: VOICE_MOTION.spatial.durationMs, easing: EASE_SPATIAL }),
        );
    }, [animatedHeight, energy.reduced, height]);
    const vesselStyle = useAnimatedStyle(() => ({ height: animatedHeight.get() }));

    const skyStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: 0.2 + energy.luminosity.get() * 0.8 };
    });

    const inner = width - 24;

    return (
        <View style={{ paddingHorizontal: 12, paddingTop: 10 }} onLayout={onLayout}>
            <Animated.View
                style={[
                    {
                        borderRadius: 18,
                        overflow: 'hidden',
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        backgroundColor: tokens.dark ? 'rgba(16,15,22,0.9)' : 'rgba(252,251,253,0.96)',
                        justifyContent: 'flex-start',
                    },
                    vesselStyle,
                ]}
            >
                {/* The sky inside the vessel. */}
                <Animated.View
                    pointerEvents="none"
                    style={[{ position: 'absolute', inset: 0, overflow: 'hidden' }, skyStyle]}
                >
                    <Bloom
                        size={inner * 1.4}
                        blur={inner * 0.3}
                        stop={state.stop}
                        alpha={0.42}
                        polarity={1}
                        reactivity={1}
                        style={{ left: -inner * 0.2, top: height * 0.14 }}
                    />
                    <PlanetLimb
                        width={inner}
                        height={height}
                        stop={state.stop}
                        stopSecondary={state.stopSecondary}
                        crownRatio={conversational ? 0.13 : 0.3}
                    />
                    <LinearGradient
                        colors={[tokens.hostSurface, tokens.hostSurfaceTransparent]}
                        locations={[0, 1]}
                        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 14 }}
                    />
                    <Grain radius={18} />
                </Animated.View>

                <View style={{ paddingHorizontal: 13, paddingTop: PAD, paddingBottom: PAD, flex: 1 }}>
                    {/*
                      * The transport rides the status line rather than sitting on
                      * its own row. Status and action are the two things the
                      * surface is for, so they share the top line and the block
                      * loses ~36pt of sidebar budget. The tap target is the text
                      * block only — nothing interactive is nested.
                      */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <TactilePressable
                            static
                            accessibilityLabel={`${state.label}. ${state.caption ?? ''}`}
                            accessibilityHint={conversational ? 'Collapses the conversation' : 'Opens the conversation'}
                            onPress={props.onToggleExpanded}
                            containerStyle={{ flex: 1, minWidth: 0 }}
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
                        <VoiceTransport
                            labels={{
                                start: 'Start Voice',
                                end: 'End Voice',
                                startHint: 'Starts a spoken conversation',
                                endHint: 'Stops the spoken conversation. Coding work already started keeps running.',
                                startText: 'Start Voice',
                                endText: 'End',
                                mute: 'Microphone open. Mute',
                                unmute: 'Microphone muted. Unmute',
                            }}
                            live={live}
                            canStart={state.id !== 'unavailable'}
                            muted={props.muted}
                            canMute={live}
                            onStart={() => props.onAction('start')}
                            onEnd={() => props.onAction('end')}
                            onToggleMute={props.onToggleMute}
                            onAction={props.onAction}
                        />
                    </View>

                    {conversational ? (
                        <View style={{ flex: 1, marginTop: 10 }}>
                            <TranscriptStream entries={VOICE_LAB_TRANSCRIPT} compact />
                        </View>
                    ) : null}

                    {/*
                      * The baseline belongs to the voice. While a conversation is
                      * live the horizontal space is worth more as the meter than
                      * as a label — and the meter is the only element here that
                      * is literally the thing the surface is about.
                      */}
                    {live ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                            <VoiceWaveform stop={state.stop} height={conversational ? 24 : 20} />
                            {conversational ? <ControlRow controls={extra} onAction={props.onAction} /> : null}
                        </View>
                    ) : conversational ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                            <View style={{ flex: 1 }} />
                            <ControlRow controls={extra} onAction={props.onAction} />
                        </View>
                    ) : null}
                </View>
            </Animated.View>

            <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', left: -10_000 }}
            >
                <Text>{props.muted ? `${state.announcement} Microphone muted.` : state.announcement}</Text>
            </View>
        </View>
    );
}

/** Exported so the mobile orb can reuse the same light for its expanded sheet. */
export const horizonVesselTint = (dark: boolean) =>
    dark ? 'rgba(16,15,22,0.9)' : 'rgba(252,251,253,0.96)';

void light;
