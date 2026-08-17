import { Image } from 'expo-image';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
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
    resolveArmedComposerContinuation,
} from './agentContinuationSubmitPresentation';

/** The circular send affordance's box, unchanged. */
const SUBMIT_CIRCLE_SIZE = 32;

/**
 * The submit control's touch target reaches above and below its box.
 *
 * The shape wrapper has to clip while it resizes, and a clip would eat that
 * reach, so the wrapper is grown by exactly the same amount and pulled back by a
 * matching negative margin: the row's layout is untouched and the hit area still
 * lands inside the clip.
 */
const SUBMIT_HIT_SLOP = { top: 5, bottom: 10, left: 0, right: 0 } as const;
const SUBMIT_CLIP_EXTRA_HEIGHT = SUBMIT_HIT_SLOP.top + SUBMIT_HIT_SLOP.bottom;

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
    shapeContent: {
        flexShrink: 0,
    },
}));

/**
 * A box that follows its content's size instead of jumping to it.
 *
 * The send control has two shapes — a circular send, and the armed
 * "Continue with {Agent}" button that hugs its logo and label — and swapping
 * between them is a change of several pixels to nearly two hundred. Snapping
 * reads as a glitch; this travels, on the app's own standard curve, so the change
 * reads as the control becoming something else.
 *
 * It measures rather than being told: the content lays out at its natural size
 * (`flexShrink: 0` inside a clipped row), reports it, and the wrapper travels to
 * it. One mechanism serves both directions and a label that changes while armed,
 * and it needs no second copy of the button's metrics.
 *
 * Under reduced motion the control still becomes the other shape — that is the
 * fact it carries — and only the travel is removed.
 */
function AgentInputSubmitShape(props: Readonly<{ children: React.ReactNode }>) {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const [contentSize, setContentSize] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const width = useSharedValue(SUBMIT_CIRCLE_SIZE);
    const height = useSharedValue(SUBMIT_CIRCLE_SIZE + SUBMIT_CLIP_EXTRA_HEIGHT);
    const targetWidth = contentSize?.width ?? SUBMIT_CIRCLE_SIZE;
    // The clip is taller than the control by exactly the reach of its hit area, so
    // the box it animates to is the content plus that reach.
    const targetHeight = (contentSize?.height ?? SUBMIT_CIRCLE_SIZE) + SUBMIT_CLIP_EXTRA_HEIGHT;

    React.useEffect(() => {
        if (reducedMotion) {
            width.value = targetWidth;
            height.value = targetHeight;
            return;
        }
        const timing = {
            duration: reanimatedMotionTokens.durationMs.base,
            easing: reanimatedMotionTokens.easing.standard,
        };
        width.value = withTiming(targetWidth, timing);
        height.value = withTiming(targetHeight, timing);
    }, [height, reducedMotion, targetHeight, targetWidth, width]);

    const animatedStyle = useAnimatedStyle(() => ({ width: width.value, height: height.value }));

    return (
        <Animated.View style={[styles.shapeClip, animatedStyle]}>
            <View
                style={styles.shapeContent}
                onLayout={(event) => {
                    const measuredWidth = Math.round(event.nativeEvent.layout.width);
                    const measuredHeight = Math.round(event.nativeEvent.layout.height);
                    if (measuredWidth <= 0 || measuredHeight <= 0) return;
                    setContentSize((current) => (
                        current?.width === measuredWidth && current?.height === measuredHeight
                            ? current
                            : { width: measuredWidth, height: measuredHeight }
                    ));
                }}
            >
                {props.children}
            </View>
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
    // send. Dictation, Stop and the empty-composer states are other actions, and
    // labelling them "Continue with {Agent}" would promise something that press
    // does not do.
    // The composer's engine chip reads the SAME decision, so the two cannot say
    // different things about the armed target.
    const armedTarget = resolveArmedComposerContinuation({
        armedContinuationTarget: props.armedContinuationTarget,
        hasSendableContent: props.hasSendableContent,
        dictationHoldsSubmit: showDictation,
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
        return (
            <AgentInputSubmitShape>
                <RoundButton
                    testID={props.testID}
                    size="small"
                    // The words, visible and accessible. Pressing this does not only
                    // send — it continues the Session with another Agent — and a control
                    // that changes what a Session runs says so on its face rather than
                    // only in a popover the reader has dismissed.
                    title={armedContinuation.accessibilityLabel}
                    accessibilityLabel={armedContinuation.accessibilityLabel}
                    leading={armedContinuation.markAgentId ? (
                        // The same mark the Agent rail used to offer this target, at the
                        // registry's own optical size and tinted by the button's token, so
                        // it reads at the weight the reader just saw.
                        <AgentIcon
                            agentId={armedContinuation.markAgentId}
                            size={armedContinuation.markSize}
                            color={theme.colors.button.primary.tint}
                        />
                    ) : undefined}
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
