import * as React from 'react';
import { VOICE_LAB_TRANSCRIPT } from '../voiceLabModel';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { TactilePressable } from '@/components/voice/controls/VoiceControls';
import { PlanetOrb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { TranscriptStream } from '@/components/voice/surface/VoiceTranscriptStream';
import { useVoiceEnergy } from '@/components/voice/light/useVoiceEnergy';
import { VOICE_MOTION, light, onPlanetInk, useVoiceLightTokens } from '@/components/voice/light/voiceLightTokens';
import type { VoiceConceptProps } from '../conceptTypes';

const EASE = Easing.bezier(...(VOICE_MOTION.local.bezier as [number, number, number, number]));
/** The shipped composer's action button is 32pt inside a 44pt target. */
const ACTION = 32;

/**
 * COMPOSER — in-session Voice as the composer's own leading control.
 *
 * The claim this concept is making, and the reason it is not a redesign:
 *
 * **Voice does not belong in the send slot.** That slot already carries three
 * meanings — send, dictate, stop — resolved by
 * `showDictation = Boolean(dictationPressHandler) && (!hasSendableContent || dictationActive)`.
 * Adding Voice makes it four, and two of them collide at exactly the moment
 * they matter most: while the agent is working the slot is **Stop turn**, which
 * is a different stop from **End Voice**, and both want to be reachable.
 * Dictation also legitimately owns that slot when the composer is empty, and it
 * is a separate owner pinned by `dictationConsumer.architecture.test.ts`.
 *
 * And it cannot take the leading edge either: in a real session the left chip
 * row already carries model, mode, target, permission, account, attach,
 * mention, branch and diff. It is full.
 *
 * So the right side becomes a **two-slot cluster**:
 *
 *      [ … left chips … ]              (Voice)  (Send/Stop)
 *
 *  - Voice is a *mode*, send/stop is a *submit* — different verbs, different
 *    controls, both live at once while the agent works;
 *  - the send button goes back to meaning exactly one thing, which un-shadows
 *    `showStopWhenEmpty` (dead today whenever Voice is enabled — see
 *    `AgentInputSubmitButton.tsx:29-31`);
 *  - when Voice is live its slot becomes the planet with the meter **inside**
 *    it — one meter, not a planet with a meter beside it.
 *
 * Shipping this needs one additive optional prop on `AgentInput`, rendered
 * immediately before `AgentInputSubmitButton`. Nothing else changes.
 *
 * Open question this raises, deliberately not decided here: dictation currently
 * owns the send slot when the composer is empty. If Voice takes its own slot,
 * dictation either keeps the send slot (two speech affordances side by side) or
 * folds into the Voice control as a long-press. That is a product call.
 */
export function ComposerConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const { state } = props;
    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const live = !dormant && state.id !== 'error' && state.id !== 'ended';
    // Two independent axes, exactly as the real composer has them: is the agent
    // working, and does the composer have sendable content.
    const agentWorking = state.id === 'working';
    const hasContent = false;

    const voiceMode = useSharedValue(live ? 1 : 0);
    React.useEffect(() => {
        voiceMode.set(
            energy.reduced
                ? (live ? 1 : 0)
                : withTiming(live ? 1 : 0, { duration: VOICE_MOTION.local.durationMs, easing: EASE }),
        );
    }, [energy.reduced, live, voiceMode]);

    const edgeStyle = useAnimatedStyle(() => {
        'worklet';
        const amp = energy.level.get();
        const flow = energy.flow.get();
        const spread = flow >= 0 ? 0.2 + amp * 0.6 : Math.max(0.1, 0.52 - amp * 0.34);
        return { opacity: voiceMode.get(), transform: [{ scaleX: spread }] };
    });

    const placeholderStyle = useAnimatedStyle(() => ({ opacity: 1 - voiceMode.get() }));
    const liveLineStyle = useAnimatedStyle(() => ({ opacity: voiceMode.get() }));

    return (
        <View style={{ flex: 1, alignSelf: 'stretch' }}>
            <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 8 }}>
                <TranscriptStream entries={VOICE_LAB_TRANSCRIPT} />
            </View>

            <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingTop: 6 }}>
                <View
                    style={{
                        // COMPOSER_SURFACE_RADIUS in the shipped composer.
                        borderRadius: 16,
                        overflow: 'hidden',
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        backgroundColor: tokens.dark ? 'rgba(34,28,28,0.92)' : '#ffffff',
                        boxShadow: tokens.dark
                            ? '0 8px 26px -12px rgba(0,0,0,0.6)'
                            : '0 8px 26px -14px rgba(30,20,10,0.18)',
                    } as never}
                >
                    {/* The composer's own top edge carries the speech. */}
                    <View style={{ height: 2, overflow: 'hidden' }}>
                        <View style={{ position: 'absolute', inset: 0, backgroundColor: tokens.rule }} />
                        <Animated.View
                            style={[
                                { position: 'absolute', inset: 0, backgroundColor: light(state.stop, 0.95, tokens) },
                                edgeStyle,
                            ]}
                        />
                    </View>

                    {/* Text well. Fixed height, so starting Voice moves nothing. */}
                    <View style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 13, paddingVertical: 10 }}>
                        <Animated.View style={[{ position: 'absolute', left: 13, right: 13 }, placeholderStyle]}>
                            <Text style={{ ...Typography.default(), fontSize: 14, color: tokens.inkFaint }}>
                                Reply to Codex…
                            </Text>
                        </Animated.View>
                        <Animated.View style={liveLineStyle}>
                            <Text
                                numberOfLines={1}
                                style={{
                                    ...Typography.default(),
                                    fontSize: 14,
                                    lineHeight: 19,
                                    color: tokens.ink,
                                    // Partial speech is never presented as final.
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
                            paddingHorizontal: 8,
                            paddingBottom: 8,
                        }}
                    >
                        {/*
                          * LEFT — the real composer's chip row. In a live session
                          * this carries model, mode, target, permission, account,
                          * attach, mention, branch and diff. It is full, which is
                          * exactly why Voice cannot live here.
                          */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                            {['Opus 5', 'Build', 'Auto'].map((chip) => (
                                <Text
                                    key={chip}
                                    numberOfLines={1}
                                    style={{ ...Typography.default(), fontSize: 12.5, color: tokens.inkMuted }}
                                >
                                    {chip}
                                </Text>
                            ))}
                            <Text style={{ ...Typography.default(), fontSize: 12.5, color: tokens.inkFaint }}>
                                ⋯
                            </Text>
                        </View>

                        {/*
                          * RIGHT — the cluster this concept proposes. Two slots,
                          * never one: Voice is a *mode*, send/stop is a *submit*,
                          * and while the agent works they are both live at once.
                          *
                          * `AgentInput` has no trailing slot today, so shipping
                          * this needs one additive optional prop rendered
                          * immediately before `AgentInputSubmitButton`.
                          */}
                        <TactilePressable
                            accessibilityLabel={live ? 'End Voice' : 'Start Voice'}
                            accessibilityHint={
                                live
                                    ? 'Stops the spoken conversation. The coding turn keeps running.'
                                    : 'Starts a spoken conversation in this session'
                            }
                            onPress={() => props.onAction(live ? 'end' : 'start')}
                            style={{
                                width: ACTION,
                                height: ACTION,
                                borderRadius: ACTION,
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderWidth: live ? 0 : 1,
                                borderColor: tokens.rule,
                                // Deliberately unclipped: the planet fills this slot, so
                                // `overflow: hidden` would eat every inhale and the body
                                // would read as static. The row's gap absorbs the ~2pt
                                // overshoot.
                            }}
                        >
                            {live ? (
                                <View>
                                    <PlanetOrb size={ACTION} tint={state.stop} tintAmount={0.07} atmosphere={false} />
                                    {/* The meter is inside the body — one meter,
                                        not a planet with a meter beside it. */}
                                    <View
                                        pointerEvents="none"
                                        style={{
                                            position: 'absolute',
                                            left: ACTION * 0.24,
                                            right: ACTION * 0.24,
                                            top: ACTION * 0.38,
                                            height: ACTION * 0.24,
                                        }}
                                    >
                                        <VoiceWaveform
                                            stop={state.stop}
                                            slots={5}
                                            height={ACTION * 0.24}
                                            barWidth={1.6}
                                            color={onPlanetInk(tokens)}
                                        />
                                    </View>
                                </View>
                            ) : (
                                <MiniWave color={tokens.inkMuted} />
                            )}
                        </TactilePressable>

                        {/*
                          * SEND / STOP — strictly submit. With Voice owning its
                          * own slot, the dictation glyph no longer needs to share
                          * this button, so "stop the turn" stops being shadowed.
                          */}
                        <View
                            style={{
                                width: ACTION,
                                height: ACTION,
                                borderRadius: ACTION,
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: tokens.dark ? '#EFEFEF' : '#0A0A0A',
                            }}
                        >
                            {agentWorking ? (
                                <View
                                    style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: 2.5,
                                        backgroundColor: tokens.dark ? '#131111' : '#FFFFFF',
                                    }}
                                />
                            ) : (
                                <Arrow color={tokens.dark ? '#131111' : '#FFFFFF'} />
                            )}
                        </View>
                    </View>
                </View>

                {/*
                  * Binding, not transport. Which session Voice is bound to — and
                  * whether it is Codex speaking straight into this session or a
                  * global conversation that can teleport here — is a property of
                  * the conversation, not a button. It reads as one quiet line
                  * under the composer and only while Voice is live.
                  */}
                {live ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 7, paddingHorizontal: 4 }}>
                        <View
                            style={{
                                width: 5,
                                height: 5,
                                borderRadius: 5,
                                backgroundColor: light(state.stop, 1, tokens),
                            }}
                        />
                        <Text numberOfLines={1} style={{ ...Typography.default(), fontSize: 11, color: tokens.inkFaint }}>
                            {props.provider.id === 'happier.agent.codex/realtime-codex'
                                ? 'Speaking directly into this session'
                                : 'Global voice · bound to this session'}
                        </Text>
                    </View>
                ) : null}
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

/** The resting Voice glyph: the meter's silhouette, not a play triangle. */
const MiniWave = React.memo(function MiniWave(props: Readonly<{ color: string }>) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1.5, height: 12 }}>
            {[0.45, 1, 0.68, 0.34].map((h, i) => (
                <View
                    key={i}
                    style={{
                        width: 2,
                        height: 12 * h,
                        borderRadius: 2,
                        backgroundColor: props.color,
                    }}
                />
            ))}
        </View>
    );
});
/** The submit arrow, so send reads as send and nothing else. */
const Arrow = React.memo(function Arrow(props: Readonly<{ color: string }>) {
    return (
        <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 2, height: 11, borderRadius: 2, backgroundColor: props.color }} />
            <View
                style={{
                    position: 'absolute',
                    top: 1.5,
                    width: 8,
                    height: 8,
                    borderLeftWidth: 2,
                    borderTopWidth: 2,
                    borderColor: props.color,
                    borderTopLeftRadius: 2,
                    transform: [{ rotate: '45deg' }],
                }}
            />
        </View>
    );
});
