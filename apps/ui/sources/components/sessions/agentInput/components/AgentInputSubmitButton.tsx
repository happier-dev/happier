import { Image } from 'expo-image';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import type { VoiceDictationSnapshot } from '@/voice/dictation/VoiceDictationController';
import { Icon } from '@/components/ui/icons/Icon';

import {
    resolveAgentContinuationSubmitPresentation,
    resolveArmedSubmitContinuation,
} from './agentContinuationSubmitPresentation';

/**
 * The submit control's touch target reaches above and below its box.
 *
 * The shape wrapper has to clip while it resizes, and a clip would eat that
 * reach, so the wrapper is grown by exactly the same amount and pulled back by a
 * matching negative margin: the row's layout is untouched and the hit area still
 * lands inside the clip.
 */
const SUBMIT_HIT_SLOP = { top: 5, bottom: 10, left: 0, right: 0 } as const;

const stylesheet = StyleSheet.create(() => ({
    shapeClip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        overflow: 'hidden',
        flexShrink: 0,
        marginLeft: 8,
        marginRight: 8,
        marginTop: -SUBMIT_HIT_SLOP.top,
        marginBottom: -SUBMIT_HIT_SLOP.bottom,
        paddingTop: SUBMIT_HIT_SLOP.top,
        paddingBottom: SUBMIT_HIT_SLOP.bottom,
    },
}));

/**
 * A box that travels to its content's size instead of jumping to it.
 *
 * The send control has two shapes — a circular send, and the armed
 * "Continue with {Agent}" button that hugs its logo and label — and swapping
 * between them is a change of several pixels to nearly two hundred. Snapping
 * reads as a glitch; this travels, on the app's own standard curve, so the change
 * reads as the control becoming something else.
 *
 * The wrapper is plain content-sized layout, and the travel is a Reanimated
 * layout transition over it. It is deliberately NOT the obvious shape — measure
 * the content, then animate a `width`/`height` towards it — because that shape
 * contains a loop the browser hides:
 *
 *   the content is laid out inside the very box being animated, so a single-line
 *   label can only be as wide as the width the box currently has; each frame
 *   therefore measured a little wider, re-targeted the animation just ahead of
 *   where it had reached, and the target chased the value.
 *
 * Measured on iOS (iPhone 17 Pro, iOS 26.3, debug bundle) against the equivalent
 * remote-dev build: ~1.13s of visible steps instead of the intended ~0.27s — the
 * reported "very saccaded and slow". `flexShrink: 0` does not prevent it, and
 * neither does taking the content out of flow: `position: 'absolute'` still
 * measured 162 → 213 and climbing, one report per frame. Web never showed it,
 * because there a non-shrinking child with single-line text keeps its max-content
 * width, so the measurement was stable and the same code ran cleanly.
 *
 * A layout transition has no measurement to feed back: the wrapper is laid out at
 * its natural size once and Reanimated interpolates the frame. Measured the same
 * way afterwards: ~0.13s, monotonic.
 *
 * Under reduced motion the control still becomes the other shape — that is the
 * fact it carries — and only the travel is removed. `ReduceMotion.Never` keeps
 * that decision here rather than letting the library read the device setting a
 * second time and disagree with the app's own preference.
 */
function AgentInputSubmitShape(props: Readonly<{ children: React.ReactNode }>) {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const layout = React.useMemo(() => {
        if (reducedMotion) return undefined;
        return LinearTransition
            .duration(reanimatedMotionTokens.durationMs.base)
            .easing(reanimatedMotionTokens.easing.standard.factory())
            .reduceMotion(ReduceMotion.Never);
    }, [reducedMotion]);

    return (
        <Animated.View layout={layout} style={styles.shapeClip}>
            {props.children}
        </Animated.View>
    );
}

export const AgentInputSubmitButton = React.memo(function AgentInputSubmitButton(props: Readonly<{
    testID: string;
    sessionId?: string;
    submitAccessibilityLabel?: string;
    disabled: boolean;
    isSending?: boolean;
    isStopping?: boolean;
    hasSendableContent: boolean;
    canStop?: boolean;
    /**
     * Whether Stop is reachable elsewhere in the composer.
     *
     * The action bar renders a dedicated abort chip whenever
     * `onAbort && showAbortButton && !actionBarIsCollapsed`
     * (`controls/buildCoreAgentInputControlNodes.tsx:184`). When that chip is on
     * screen, taking this button for a second Stop costs the microphone and buys
     * a duplicate — so the empty-composer stop only claims the button when Stop
     * genuinely has nowhere else to go.
     */
    hasDedicatedStopControl?: boolean;
    dictationPressHandler?: (() => void) | undefined;
    dictationStatus: VoiceDictationSnapshot['status'];
    /**
     * The Agent the in-session picker has armed, or null for an ordinary send.
     *
     * Pressing send with a target armed does not only send: it stops the current
     * runtime and continues this Session with that Agent. The control therefore
     * says so, at the moment of consequence.
     */
    armedContinuationTarget?: Readonly<{ agentId: string; label: string }> | null;
    onSend: () => void;
    onStop?: () => void;
}>) {
    const { theme } = useUnistyles();
    const dictationActive = props.dictationStatus !== 'idle';
    const dictationTranscribing = props.dictationStatus === 'transcribing';
    /*
     * Stopping a running turn outranks *starting* Dictation on an empty composer —
     * but only when claiming the button actually costs something.
     *
     * Three cases, and the middle one is the whole point:
     *  - No mic on this button at all (`submitDictation={false}`, so no
     *    `dictationPressHandler`): Stop takes it. Nothing is displaced.
     *  - Mic present AND the dedicated abort chip is on screen
     *    (`buildCoreAgentInputControlNodes.tsx:184`): leave the mic. Taking the
     *    button here buys a duplicate Stop and pays for it with the microphone.
     *  - Mic present and no chip (collapsed action bar): Stop takes it, because
     *    otherwise the stop is genuinely unreachable.
     *
     * An in-flight Dictation always keeps the button, or the user cannot end it.
     */
    const stopWouldDisplaceDictation = Boolean(props.dictationPressHandler)
        && props.hasDedicatedStopControl === true;
    const showStopWhenEmpty = !props.hasSendableContent
        && !dictationActive
        && props.canStop === true
        && !stopWouldDisplaceDictation;
    const showDictation = Boolean(props.dictationPressHandler)
        && (dictationActive || (!props.hasSendableContent && !showStopWhenEmpty));

    // The armed switch only reaches the button while the button is actually a
    // send. Dictation and Stop are other actions, and labelling either
    // "Continue with {Agent}" would promise something that press does not do.
    // An empty composer is NOT one of those: the control is still the send, just
    // an inert one, so it keeps naming the switch it would take.
    // The composer's engine chip reads the SAME armed target and only skips this
    // narrowing, so the two cannot name different Agents.
    const armedTarget = resolveArmedSubmitContinuation({
        armedContinuationTarget: props.armedContinuationTarget,
        otherActionHoldsSubmit: showDictation || showStopWhenEmpty,
    });
    const armedContinuation = armedTarget
        ? resolveAgentContinuationSubmitPresentation({
            agentId: armedTarget.agentId,
            agentLabel: armedTarget.label,
        })
        : null;

    const submitPress = React.useCallback(() => {
        if (dictationTranscribing) return;
        hapticsLight();
        if (dictationActive && showDictation) {
            props.dictationPressHandler?.();
        } else if (props.hasSendableContent) {
            props.onSend();
        } else if (showDictation) {
            props.dictationPressHandler?.();
        } else if (showStopWhenEmpty) {
            props.onStop?.();
        }
    }, [
        dictationActive,
        dictationTranscribing,
        props.dictationPressHandler,
        props.hasSendableContent,
        props.onSend,
        props.onStop,
        showDictation,
        showStopWhenEmpty,
    ]);

    if (armedContinuation) {
        const mark = armedContinuation.markAgentId ? (
            // The same mark the Agent rail used to offer this target, at the
            // registry's own optical size and tinted by the button's token, so
            // it reads at the weight the reader just saw.
            <AgentIcon
                agentId={armedContinuation.markAgentId}
                size={armedContinuation.markSize}
                color={theme.colors.button.primary.tint}
            />
        ) : undefined;
        return (
            <AgentInputSubmitShape>
                <RoundButton
                    testID={props.testID}
                    size="small"
                    // "Continue with [mark]". Pressing this does not only send — it
                    // continues the Session with another Agent — so the control says
                    // so on its face rather than only in a popover the reader has
                    // dismissed. The Agent's identity is carried once, by the mark
                    // standing where the sentence names it, which keeps the control
                    // from growing to the width of the longest name in the catalog.
                    title={armedContinuation.label}
                    // The full sentence, always in words: this press commits an Agent
                    // switch, and a glyph reads as nothing to a screen reader.
                    accessibilityLabel={armedContinuation.accessibilityLabel}
                    // Named but not yet pressable. The circular send explains that
                    // same state with this exact hint, and the armed shape is the
                    // same control, so it says the same thing rather than leaving a
                    // screen reader with a disabled button and no reason.
                    accessibilityHint={props.hasSendableContent ? undefined : t('session.inputPlaceholder')}
                    leading={armedContinuation.markPlacement === 'leading' ? mark : undefined}
                    trailing={armedContinuation.markPlacement === 'trailing' ? mark : undefined}
                    loading={props.isSending}
                    disabled={props.disabled}
                    onPress={submitPress}
                />
            </AgentInputSubmitShape>
        );
    }

    return (
        <AgentInputSubmitShape>
        <PrimaryCircleIconButton
            testID={props.testID}
            active={props.hasSendableContent || props.isSending || showDictation || showStopWhenEmpty}
            loading={props.isSending || dictationTranscribing || (showStopWhenEmpty && props.isStopping)}
            disabled={props.disabled}
            accessibilityLabel={
                dictationTranscribing
                    ? t('voiceAssistant.transcribing')
                    : dictationActive && showDictation
                    ? t('voiceAssistant.endDictation')
                    : props.hasSendableContent
                    ? (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                    : (
                        showDictation
                            ? t('voiceAssistant.startDictation')
                            : showStopWhenEmpty
                                ? t('agentInput.stopCodingTurn')
                            : (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                    )
            }
            accessibilityHint={
                (!props.hasSendableContent && !showDictation && !showStopWhenEmpty)
                    ? t('session.inputPlaceholder')
                    : undefined
            }
            accessibilityState={{
                busy: dictationTranscribing,
                disabled: Boolean(props.disabled),
            }}
            hitSlop={SUBMIT_HIT_SLOP}
            onPress={submitPress}
        >
            {dictationActive && showDictation ? (
                <Icon name="stop-circle" size={20} color={theme.colors.button.primary.tint} />
            ) : props.hasSendableContent ? (
                <Icon
                    name="arrow-up"
                    size={16}
                    color={theme.colors.button.primary.tint}
                    style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                />
            ) : showDictation ? (
                <Image
                    source={require('@/assets/images/icon-voice-white.png')}
                    style={{ width: 24, height: 24 }}
                    tintColor={theme.colors.button.primary.tint}
                />
            ) : showStopWhenEmpty ? (
                <Icon name="stop" size={16} weight="fill" color={theme.colors.button.primary.tint} />
            ) : (
                <Icon
                    name="arrow-up"
                    size={16}
                    color={theme.colors.button.primary.tint}
                    style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                />
            )}
        </PrimaryCircleIconButton>
        </AgentInputSubmitShape>
    );
});
