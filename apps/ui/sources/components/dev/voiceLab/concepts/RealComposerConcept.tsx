import * as React from 'react';
import { VOICE_LAB_TRANSCRIPT } from '../voiceLabModel';
import { View } from 'react-native';

import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { TactilePressable } from '@/components/voice/controls/VoiceControls';
import { PlanetOrb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { TranscriptStream } from '@/components/voice/surface/VoiceTranscriptStream';
import { light, onPlanetInk, useVoiceLightTokens } from '@/components/voice/light/voiceLightTokens';
import type { VoiceConceptProps } from '../conceptTypes';
import { Icon } from '@/components/ui/icons/Icon';

/** The composer's action button is 32pt; the Voice planet matches it exactly. */
const PLANET = 26;

/** A design fixture, not a session: it offers no suggestion kinds and so detects no triggers. */
const REAL_COMPOSER_CONCEPT_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [];

/**
 * REAL COMPOSER — the proposal mounted on the actual `AgentInput`.
 *
 * Not a replica. This renders the shipped composer with fixture props, so what
 * you are judging is the real chip row, the real send/dictate/stop button, the
 * real panel radius, and the real responsive behaviour.
 *
 * **What this proves:** the real composer mounts standalone and accepts the
 * three additive optional seams this fixture consumes: `fieldAccessory`,
 * `trailingAccessory`, and `submitDictation={false}`.
 *
 * **What it does NOT prove:** production adoption. These seams have no non-lab
 * consumer today, and this fixture does not select a placement or authorize
 * production wiring.
 *
 * The composer decisions exercised here are:
 *
 *   `fieldAccessory` pins Dictation to the text field.
 *   `trailingAccessory` places Voice immediately before submit/stop.
 *   `submitDictation={false}` prevents Dictation from shadowing Stop when empty.
 *
 * With those opt-in props, "stop the turn" and "end Voice" are both reachable
 * in the fixture. Omitted props preserve the existing composer behavior.
 */
export function RealComposerConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLightTokens();
    const { state } = props;
    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const live = !dormant && state.id !== 'error' && state.id !== 'ended';
    const agentWorking = state.id === 'working';

    // The composer is uncontrolled from the lab's point of view; typing here
    // proves the send/stop/dictation swap for real.
    const [value, setValue] = React.useState('');
    // Dictation is a momentary capture, not a session — local to the demo.
    const [dictating, setDictating] = React.useState(false);
    /*
     * The two-row case, on demand.
     *
     * `showSecondaryControlsRow` is true whenever the composer has machine, path
     * or resume *handlers* — which the in-session composer never has, and the New
     * Session composer always does. Without this switch the stacked trailing
     * cluster (Voice below Send) is unreachable in the lab, and the decision it
     * demonstrates could not be judged.
     */
    const [twoRow, setTwoRow] = React.useState(false);
    const noopPopoverHandler = React.useCallback(() => undefined, []);

    return (
        <View style={{ flex: 1, alignSelf: 'stretch' }}>
            <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 8 }}>
                <TranscriptStream entries={VOICE_LAB_TRANSCRIPT} />
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingBottom: 6 }}>
                <TactilePressable
                    accessibilityLabel={twoRow ? 'Show the in-session composer' : 'Show the New Session composer'}
                    accessibilityHint="Switches between the one-row and two-row action bar"
                    onPress={() => setTwoRow((v) => !v)}
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        backgroundColor: twoRow ? light('violet', 0.14, tokens) : 'transparent',
                    }}
                >
                    <Text style={{ ...Typography.default(), fontSize: 11, color: tokens.inkMuted }}>
                        {twoRow ? 'New session · 2 rows' : 'In session · 1 row'}
                    </Text>
                </TactilePressable>
            </View>

            {/* The live partial rides above the composer rather than replacing
                its text, so speech never collides with a typed draft. */}
            {live && state.id === 'user_speaking' ? (
                <View style={{ paddingHorizontal: 20, paddingBottom: 2 }}>
                    <Text
                        numberOfLines={1}
                        style={{
                            ...Typography.default(),
                            fontSize: 13,
                            lineHeight: 18,
                            color: tokens.inkMuted,
                            fontStyle: 'italic',
                            opacity: 0.8,
                        }}
                    >
                        so after that let’s take the activity count next
                    </Text>
                </View>
            ) : null}

            <AgentInput
                value={value}
                onChangeText={setValue}
                placeholder="Reply to Codex…"
                onSend={() => setValue('')}
                // A session id is what makes the real dictation mic appear in the
                // trailing slot (`voiceEnabled && props.sessionId`).
                sessionId="voice-lab-fixture-session"
                sessionActive
                // Working ⇒ the trailing slot becomes Stop, exactly as in production.
                showAbortButton={agentWorking}
                onAbort={agentWorking ? () => undefined : undefined}
                agentLabel="Codex"
                machineName="leeroy-mbp"
                currentPath="happier/dev"
                // Handlers — not the labels — are what promote the action bar to
                // two rows, so this is the switch the New Session composer flips.
                onMachineClick={twoRow ? noopPopoverHandler : undefined}
                onPathClick={twoRow ? noopPopoverHandler : undefined}
                autocompleteKinds={REAL_COMPOSER_CONCEPT_SUGGESTION_KINDS}
                autocompleteSuggestions={async () => []}
                // The submit button means exactly one thing — send, or stop.
                // Speech has its own control, so it no longer shadows the stop.
                submitDictation={false}
                // Dictation appends words to THIS field and does nothing else,
                // so it belongs to the field — pinned to its corner, stacked
                // under the expand toggle by the composer itself.
                fieldAccessory={
                    <DictationMark active={dictating} onPress={() => setDictating((v) => !v)} />
                }
                trailingAccessory={
                    <VoiceControl live={live} muted={props.muted} stop={state.stop} label={state.label} onPress={() => props.onAction(live ? 'end' : 'start')} />
                }
            />

            {/*
              * Binding, not transport. Teleport / Codex direct-to-session /
              * global-bound-here are properties of the conversation, so they read
              * as one quiet line rather than more buttons in an already dense row.
              */}
            {live ? (
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 20,
                        paddingBottom: 8,
                    }}
                >
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

/**
 * Two controls, separated by **what they act on** — which is the distinction a
 * tap/hold gesture on one button could never make visible.
 *
 *   **Dictation** acts on the *field*. It appends words to the input and does
 *   nothing else, so it lives at the field's own corner, in the expand toggle's
 *   stack. Momentary: a mic, then a capture mark while recording.
 *
 *   **Voice** acts on the *session*. It opens a conversation that can reply and
 *   delegate work, so it lives in the action row beside send. Persistent: the
 *   breathing planet, for as long as the conversation is.
 *
 * Placement carries the meaning. Two round buttons side by side never could,
 * and neither could one button with a hidden second gesture.
 */
const VoiceControl = React.memo(function VoiceControl(props: Readonly<{
    live: boolean;
    muted: boolean;
    stop: Parameters<typeof light>[0];
    label: string;
    onPress: () => void;
}>) {
    const tokens = useVoiceLightTokens();
    const SLOT = 32;
    /*
     * The planet fills its slot, matching the send button's weight exactly —
     * drawn under-size it reads as a smaller, weaker sibling of the submit
     * rather than its peer.
     *
     * The breath has somewhere to go because the slot does **not** clip: a 12%
     * inhale overshoots by ~2pt per edge, which the row's 8pt gap absorbs.
     * Clipping is what made this planet look static, not its size.
     */
    const BODY = SLOT;

    return (
        <TactilePressable
            accessibilityLabel={props.live ? `${props.label}. End the conversation` : 'Talk with Codex'}
            accessibilityHint={
                props.live
                    ? 'Stops the spoken conversation. The coding turn keeps running.'
                    : 'Opens a spoken conversation in this session'
            }
            onPress={props.onPress}
            style={{
                width: SLOT,
                height: SLOT,
                borderRadius: SLOT,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: props.live ? 0 : 1,
                borderColor: tokens.rule,
            }}
        >
            {props.live ? (
                <View>
                    <PlanetOrb size={BODY} tint={props.stop} tintAmount={0.07} atmosphere={false} />
                    <View
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: BODY * 0.24,
                            right: BODY * 0.24,
                            top: BODY * 0.38,
                            height: BODY * 0.24,
                        }}
                    >
                        <VoiceWaveform
                            stop={props.stop}
                            slots={5}
                            height={BODY * 0.24}
                            barWidth={1.5}
                            color={onPlanetInk(tokens)}
                        />
                    </View>
                    {props.muted ? (
                        <View
                            style={{
                                position: 'absolute',
                                right: -1,
                                bottom: -1,
                                width: 9,
                                height: 9,
                                borderRadius: 9,
                                backgroundColor: light('warm', 1, tokens),
                            }}
                        />
                    ) : null}
                </View>
            ) : (
                <MiniWave color={tokens.inkMuted} />
            )}
        </TactilePressable>
    );
});

/** Dictation: a mic at rest, a capture mark while recording. */
const DictationMark = React.memo(function DictationMark(props: Readonly<{
    active: boolean;
    onPress: () => void;
}>) {
    const tokens = useVoiceLightTokens();
    return (
        <TactilePressable
            accessibilityLabel={props.active ? 'Stop dictating and insert' : 'Dictate into the message'}
            onPress={props.onPress}
            style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: props.active ? light('warm', 0.18, tokens) : 'transparent',
            }}
        >
            {props.active ? (
                <View
                    style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: light('warm', 1, tokens) }}
                />
            ) : (
                <Icon name="microphone" size={16} color={tokens.inkMuted} />
            )}
        </TactilePressable>
    );
});


/** The resting Voice glyph: the meter's silhouette, not a play triangle. */
const MiniWave = React.memo(function MiniWave(props: Readonly<{ color: string }>) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1.5, height: 12 }}>
            {[0.45, 1, 0.68, 0.34].map((h, i) => (
                <View
                    key={i}
                    style={{ width: 2, height: 12 * h, borderRadius: 2, backgroundColor: props.color }}
                />
            ))}
        </View>
    );
});
