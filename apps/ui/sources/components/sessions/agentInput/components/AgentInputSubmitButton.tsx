import { Image } from 'expo-image';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { describeMotionSpring, resolveMotionPresentation } from '@/components/ui/motion';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
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
 * reads as a glitch; this travels, on the app's own `rowEnter` physics, so the
 * change reads as the control becoming something else.
 *
 * The wrapper is plain content-sized layout, and the travel is a Reanimated
 * layout transition over it. It is deliberately NOT the obvious shape — measure
 * the content, then spring an animated `width`/`height` towards it — because that
 * shape contains a loop the browser hides:
 *
 *   the content is laid out inside the very box being animated, so a single-line
 *   label can only be as wide as the width the box currently has; each frame
 *   therefore measured a little wider, re-targeted the animation just ahead of
 *   where it had reached, and the target chased the value.
 *
 * On an iPhone 17 Pro (iOS 26.3, debug bundle) that converged asymptotically over
 * ~1.13s in visible steps, against the ~265ms `rowEnter` settles in — the reported
 * "very saccaded and slow". `flexShrink: 0` does not prevent it, and neither does
 * taking the content out of flow: `position: 'absolute'` still measured 162 → 213
 * and climbing, one report per frame. Web never showed it, because there a
 * non-shrinking child with single-line text keeps its max-content width, so the
 * measurement was stable and the same code ran cleanly in ~350ms.
 *
 * A layout transition has no measurement to feed back: the wrapper is laid out at
 * its natural size once and Reanimated interpolates the frame. Measured the same
 * way afterwards: ~0.13s, monotonic.
 *
 * Reduced motion is not decided here — `resolveMotionPresentation` owns that, and
 * `composerSubmitShape` settles instantly under it, so the shape still changes and
 * only the travel is removed. `ReduceMotion.Never` on the transition itself says
 * the library must not second-guess that answer by reading the device setting a
 * second time, exactly as the spring resolver does.
 */
function AgentInputSubmitShape(props: Readonly<{ children: React.ReactNode }>) {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const layout = React.useMemo(() => {
        if (resolveMotionPresentation('composerSubmitShape', reducedMotion) === 'settleInstantly') {
            return undefined;
        }
        // The role's own physics, read from the motion owner rather than restated:
        // its perceptual settle and its damping are what the transition is built from.
        const { settleMs, dampingRatio } = describeMotionSpring('rowEnter');
        return LinearTransition
            .springify()
            .duration(Math.round(settleMs))
            .dampingRatio(dampingRatio)
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
    micPressHandler?: (() => void) | undefined;
    micActive: boolean;
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
    const showStopWhenEmpty = !props.hasSendableContent && !props.micPressHandler && props.canStop === true;
    /*
     * With nothing to send, a composer that has Voice hands this button to the
     * microphone — `submitPress` routes there before it ever reaches Stop, whether
     * or not the mic is already listening. Text takes the button back.
     */
    const micHoldsSubmit = Boolean(props.micPressHandler) && !props.hasSendableContent;

    // The armed switch only reaches the button while the button is actually a
    // send. The mic and Stop are other actions, and labelling either
    // "Continue with {Agent}" would promise something that press does not do.
    // An empty composer is NOT one of those: with no mic and no running turn the
    // control is still the send, just an inert one, so it keeps naming the switch
    // it would take.
    // The composer's engine chip reads the SAME armed target and only skips this
    // narrowing, so the two cannot name different Agents.
    const armedTarget = resolveArmedSubmitContinuation({
        armedContinuationTarget: props.armedContinuationTarget,
        otherActionHoldsSubmit: micHoldsSubmit || showStopWhenEmpty,
    });
    const armedContinuation = armedTarget
        ? resolveAgentContinuationSubmitPresentation({
            agentId: armedTarget.agentId,
            agentLabel: armedTarget.label,
        })
        : null;

    const submitPress = React.useCallback(() => {
        hapticsLight();
        if (props.hasSendableContent) {
            props.onSend();
        } else if (props.micPressHandler) {
            props.micPressHandler();
        } else if (showStopWhenEmpty) {
            props.onStop?.();
        }
    }, [props.hasSendableContent, props.micPressHandler, props.onSend, props.onStop, showStopWhenEmpty]);

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
                active={props.hasSendableContent || props.isSending || Boolean(props.micPressHandler) || showStopWhenEmpty}
                loading={props.isSending || (showStopWhenEmpty && props.isStopping)}
                disabled={props.disabled}
                accessibilityLabel={
                    props.hasSendableContent
                        ? (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                        : (
                            props.micPressHandler
                                ? t('voiceAssistant.label')
                                : showStopWhenEmpty
                                    ? t('runs.stop.stopRunA11y')
                                : (props.submitAccessibilityLabel ?? (props.sessionId ? t('common.send') : t('newSession.title')))
                        )
                }
                accessibilityHint={
                    (!props.hasSendableContent && !props.micPressHandler && !showStopWhenEmpty)
                        ? t('session.inputPlaceholder')
                        : undefined
                }
                accessibilityState={{
                    disabled: Boolean(props.disabled),
                }}
                hitSlop={SUBMIT_HIT_SLOP}
                onPress={submitPress}
            >
                {props.hasSendableContent ? (
                    <Icon
                        name="arrow-up"
                        size={16}
                        color={theme.colors.button.primary.tint}
                        style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                    />
                ) : props.micPressHandler ? (
                    props.micActive ? (
                        <Icon name="stop-circle" size={20} color={theme.colors.button.primary.tint} />
                    ) : (
                        <Image
                            source={require('@/assets/images/icon-voice-white.png')}
                            style={{ width: 24, height: 24 }}
                            tintColor={theme.colors.button.primary.tint}
                        />
                    )
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
