import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ControlRow, TactilePressable } from '@/components/voice/controls/VoiceControls';
import { Bloom, Grain, LightRule, PlanetLimb } from '@/components/voice/light/VoiceLight';
import { TranscriptStream } from '@/components/voice/surface/VoiceTranscriptStream';
import { useVoiceEnergy } from '@/components/voice/light/useVoiceEnergy';
import { controlsForState, VOICE_LAB_TRANSCRIPT } from '../voiceLabModel';
import { VOICE_MOTION, light, useVoiceLightTokens } from '@/components/voice/light/voiceLightTokens';
import type { VoiceConceptProps } from '../conceptTypes';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));

/**
 * AURORA — Voice as the sidebar's own horizon.
 *
 * The structural claim: Voice is not an object placed *in* the sidebar, it is a
 * band *of* the sidebar. At rest it is a single lit hairline under the app
 * header — the quietest possible presence, and zero card chrome. As the
 * conversation becomes real the band opens downward into a shallow sky with the
 * planet limb rising from its lower edge, exactly the composition the
 * onboarding hero already uses.
 *
 * Because the object is an edge rather than a card, it can occupy 1px when
 * nothing is happening and 260px when everything is — without ever appearing or
 * disappearing, which is what makes the transition feel continuous.
 */
function AuroraBand(props: VoiceConceptProps) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const [width, setWidth] = React.useState(320);
    const onLayout = React.useCallback((e: LayoutChangeEvent) => {
        const next = Math.round(e.nativeEvent.layout.width);
        setWidth((prev) => (prev === next ? prev : next));
    }, []);

    const { state } = props;
    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const conversational = props.expanded && !dormant;

    const height = dormant ? 46 : conversational ? 268 : 98;
    const animatedHeight = useSharedValue(height);
    React.useEffect(() => {
        animatedHeight.set(
            energy.reduced
                ? height
                : withTiming(height, { duration: VOICE_MOTION.spatial.durationMs, easing: EASE_SPATIAL }),
        );
    }, [animatedHeight, energy.reduced, height]);

    const bandStyle = useAnimatedStyle(() => ({ height: animatedHeight.get() }));

    // The sky brightens with the state's own luminosity rather than switching on.
    const skyStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: 0.18 + energy.luminosity.get() * 0.82 };
    });

    const bandHeight = height;
    const controls = controlsForState(state.id, props.provider, props.surface === 'session');

    return (
        <View onLayout={onLayout} style={{ alignSelf: 'stretch' }}>
            <Animated.View style={[{ overflow: 'hidden', justifyContent: 'flex-end' }, bandStyle]}>
                {/* The sky. Light rises from the lower edge like a planet limb. */}
                <Animated.View
                    pointerEvents="none"
                    style={[{ position: 'absolute', inset: 0, overflow: 'hidden' }, skyStyle]}
                >
                    {/* Atmosphere: light thrown upward by the body, above the arc. */}
                    <Bloom
                        size={width * 1.5}
                        blur={width * 0.3}
                        stop={state.stop}
                        alpha={0.5}
                        polarity={1}
                        reactivity={1}
                        style={{ left: -width * 0.25, top: bandHeight * 0.2 }}
                    />
                    {/* The body itself. */}
                    <PlanetLimb
                        width={width}
                        height={bandHeight}
                        stop={state.stop}
                        stopSecondary={state.stopSecondary}
                        // The crown keeps to the bottom third so the arc never
                        // rises into the type.
                        crownRatio={conversational ? 0.14 : 0.36}
                    />
                    {/* The sky must not hard-cut under the app header, so it
                        resolves into the sidebar surface at its top edge. */}
                    <LinearGradient
                        colors={[tokens.hostSurface, tokens.hostSurfaceTransparent]}
                        locations={[0, 1]}
                        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 18 }}
                    />
                    <Grain />
                </Animated.View>

                {/*
                  * Type sits IN the sky, above the horizon — the light rises
                  * behind the words rather than under them. The bottom third of
                  * the band belongs to the limb and stays clear of text.
                  */}
                <View
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 0,
                        paddingHorizontal: 14,
                        paddingTop: dormant ? 9 : 11,
                    }}
                >
                    {conversational ? (
                        <View style={{ height: 148, marginBottom: 10 }}>
                            <TranscriptStream entries={VOICE_LAB_TRANSCRIPT} compact />
                        </View>
                    ) : null}

                    {/* The status block is the tap target. Every other control is
                        its sibling, so no interactive element is ever nested. */}
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                        <TactilePressable
                            static
                            accessibilityLabel={`${state.label}. ${state.caption ?? ''}`}
                            accessibilityHint={dormant ? 'Starts Voice' : 'Opens the voice conversation'}
                            onPress={dormant ? () => props.onAction('start') : props.onToggleExpanded}
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
                        <View style={{ alignItems: 'flex-end', gap: 7 }}>
                            {!dormant ? (
                                <ControlRow
                                    controls={controls}
                                    compact={!conversational}
                                    onAction={props.onAction}
                                />
                            ) : null}
                        </View>
                    </View>
                </View>
            </Animated.View>

            {/* The rule is the resting state: one lit line, no card. */}
            <LightRule
                stop={state.stop}
                height={dormant ? 1 : 2}
                travel={state.id === 'connecting' || state.id === 'reconnecting' || state.id === 'preparing'}
            />

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

export function AuroraConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLightTokens();

    // In-session, the horizon attaches to the composer's top edge instead of the
    // sidebar's, so the same identity reads as "attached to this conversation".
    if (props.surface === 'session') {
        return (
            <View style={{ alignSelf: 'stretch' }}>
                <AuroraBand {...props} />
                <View
                    style={{
                        marginHorizontal: 12,
                        marginTop: 8,
                        marginBottom: 10,
                        minHeight: 44,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        justifyContent: 'center',
                        paddingHorizontal: 12,
                        backgroundColor: tokens.dark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
                    }}
                >
                    <Text style={{ ...Typography.default(), fontSize: 13, color: tokens.inkFaint }}>
                        Reply to Codex…
                    </Text>
                </View>
            </View>
        );
    }

    return <AuroraBand {...props} />;
}
