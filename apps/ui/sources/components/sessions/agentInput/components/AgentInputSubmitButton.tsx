import { Image } from 'expo-image';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import type { VoiceDictationSnapshot } from '@/voice/dictation/VoiceDictationController';
import { Icon } from '@/components/ui/icons/Icon';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { MessageSendMode } from '@/sync/domains/session/control/submitMode';
import type { AgentInputSendIntentOptions } from '../agentInputSendOptions';
import type { Theme } from '@/theme';

import { readArmedRouteContinuationLabel, resolveArmedSubmitPresentation, type ArmedRouteContinuation } from './agentContinuationSubmitPresentation';

/**
 * How far the submit control's hit area may reach above and below it. Stacked, Send sits above Voice
 * with a 1 to 2 px gap, so its reach below is 0 (Voice reaches that gap itself) and above it has the
 * composer's free space. The shape wrapper has to clip while it resizes, and a clip would eat that
 * reach, so the wrapper pads by exactly this amount and cancels it with equal negative margins: the
 * clip box is as tall as the reach, the layout is as tall as the control.
 */
const SUBMIT_HIT_REACH = { top: 6, bottom: 0, left: 0, right: 0 } as const;

/** The armed button's own box gives way to its clip so the label truncates (RoundButton's pressable is flexShrink 0). */
const ARMED_SUBMIT_SHRINKABLE_STYLE = { flexShrink: 1, minWidth: 0 } as const;

const stylesheet = StyleSheet.create(() => ({
    shapeClip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        overflow: 'hidden',
        // Gives way with the cluster so an armed label ellipsizes instead of overflowing
        // onto the chip rail; the circular send is fixed-width and never shrinks.
        flexShrink: 1,
        minWidth: 0,
        marginLeft: 8,
        marginRight: 8,
        paddingTop: SUBMIT_HIT_REACH.top,
        paddingBottom: SUBMIT_HIT_REACH.bottom,
        marginTop: -SUBMIT_HIT_REACH.top,
        marginBottom: -SUBMIT_HIT_REACH.bottom,
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
            .easing(reanimatedMotionTokens.layoutEasing.standard)
            .reduceMotion(ReduceMotion.Never);
    }, [reducedMotion]);

    return (
        <Animated.View layout={layout} style={styles.shapeClip}>
            {props.children}
        </Animated.View>
    );
}

function getSendModeTitle(mode: MessageSendMode): string {
    return mode === 'agent_queue' ? t('session.pendingMessages.actions.steerNow')
        : mode === 'interrupt' ? t('session.pendingMessages.actions.sendNowInterrupt') : t('agentInput.sendOptions.queue');
}

export const AgentInputSubmitButton = React.memo(function AgentInputSubmitButton(props: Readonly<{
    testID: string;
    /** Resolved appearance for static composer previews; live inputs use the current theme. */
    appearance?: Theme;
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
    dictationAvailable?: boolean;
    dictationStatus: VoiceDictationSnapshot['status'];
    /**
     * The Agent the in-session picker has armed, or null for an ordinary send.
     *
     * Pressing send with a target armed does not only send: it stops the current
     * runtime and continues this Session with that Agent. The control therefore
     * says so, at the moment of consequence.
     */
    armedContinuationTarget?: Readonly<{ agentId: string; label: string }> | null;
    /**
     * A route or model change for the running Agent, armed for the next message
     * (D15): pressing send restarts it on that source, then sends.
     */
    armedRouteContinuation?: ArmedRouteContinuation | null;
    /**
     * Cancels the armed route/model change (D15) and keeps the one the Session runs on. Shown beside
     * the send control for as long as a route is armed, whichever shape the control has.
     */
    onUnarmRoute?: (() => void) | null;
    unarmRoutePending?: boolean;
    /** Exact selected picker mark for an external/machine-qualified target. */
    armedContinuationIdentityMark?: React.ReactNode;
    onSend: (options?: AgentInputSendIntentOptions) => void;
    sendMenuModes?: readonly MessageSendMode[];
    sendMenuShortcuts?: Partial<Record<MessageSendMode, string>>;
    onStop?: () => void;
}>) {
    const { theme: currentTheme } = useUnistyles();
    const theme = props.appearance ?? currentTheme;
    const dictationActive = props.dictationStatus !== 'idle';
    const sendMenuAnchorRef = React.useRef<View>(null);
    const [sendMenuOpen, setSendMenuOpen] = React.useState(false);
    const sendMenuEnabled = props.hasSendableContent && !props.disabled && !props.isSending
        && !dictationActive && !props.armedContinuationTarget && !props.armedRouteContinuation
        && Boolean(props.sendMenuModes?.length);
    const openSendMenu = () => {
        if (!sendMenuEnabled) return;
        hapticsLight();
        setSendMenuOpen(true);
    };
    React.useEffect(() => { setSendMenuOpen(false); }, [props.sessionId, sendMenuEnabled]);
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
    const disabled = props.disabled || (showDictation && props.dictationAvailable === false);

    // The armed switch only reaches the button while the button is actually a
    // send. Dictation and Stop are other actions, and labelling either
    // "Continue with {Agent}" would promise something that press does not do.
    // An empty composer is NOT one of those: the control is still the send, just
    // an inert one, so it keeps naming the switch it would take.
    // The composer's engine chip reads the SAME armed target and only skips this
    // narrowing, so the two cannot name different Agents.
    const canonicalIdentityMark = React.isValidElement<Record<string, unknown>>(
        props.armedContinuationIdentityMark,
    ) ? props.armedContinuationIdentityMark : null;
    const armed = resolveArmedSubmitPresentation({
        armedContinuationTarget: props.armedContinuationTarget,
        armedRouteContinuation: props.armedRouteContinuation,
        otherActionHoldsSubmit: showDictation || showStopWhenEmpty,
        hasIdentityMark: canonicalIdentityMark !== null,
    });
    const armedContinuation = armed?.presentation ?? null;

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

    // An armed Agent wins over a route change (its transition carries its own model), so the route's
    // cancel shows only while the route is what the next message applies.
    const unarmRoute = props.armedRouteContinuation && !props.armedContinuationTarget && props.onUnarmRoute ? (
        <IconButton
            testID="agent-input-route-unarm"
            iconName="x"
            variant="plain"
            size={28}
            iconSize={14}
            accessibilityLabel={t('session.agentContinuation.routeUnarm', { source: readArmedRouteContinuationLabel(props.armedRouteContinuation) })}
            tooltip={t('session.agentContinuation.routeUnarm', { source: readArmedRouteContinuationLabel(props.armedRouteContinuation) })}
            tooltipPlacement="top"
            disabled={props.unarmRoutePending === true || props.isSending === true}
            onPress={props.onUnarmRoute}
        />
    ) : null;

    if (armedContinuation) {
        const canonicalMark = armed?.kind === 'agent' && canonicalIdentityMark
            ? React.cloneElement(canonicalIdentityMark, {
                size: armedContinuation.markSize,
                testID: 'agent-input-continuation-submit-logo',
            })
            : undefined;
        const mark = canonicalMark ?? (armedContinuation.markAgentId ? (
            // The same mark the Agent rail used to offer this target, at the
            // registry's own optical size and tinted by the button's token, so
            // it reads at the weight the reader just saw.
            <AgentIcon
                agentId={armedContinuation.markAgentId}
                size={armedContinuation.markSize}
                color={theme.colors.button.primary.tint}
            />
        ) : undefined);
        return (
            <AgentInputSubmitShape>
                {unarmRoute}
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
                    style={ARMED_SUBMIT_SHRINKABLE_STYLE}
                    leading={armedContinuation.markPlacement === 'leading' ? mark : undefined}
                    trailing={armedContinuation.markPlacement === 'trailing' ? mark : undefined}
                    loading={props.isSending}
                    disabled={disabled}
                    onPress={submitPress}
                />
            </AgentInputSubmitShape>
        );
    }

    return (
        <View
            ref={sendMenuAnchorRef}
            collapsable={false}
            {...(Platform.OS === 'web' && sendMenuEnabled ? {
                onContextMenu: (event: React.MouseEvent) => {
                    event.preventDefault();
                    openSendMenu();
                },
                onKeyDown: (event: React.KeyboardEvent) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10') && !(event.altKey && event.key === 'ArrowDown')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    openSendMenu();
                },
            } : {})}
        >
          <AgentInputSubmitShape>
        {unarmRoute}
        <PrimaryCircleIconButton
            appearance={props.appearance}
            testID={props.testID}
            active={!disabled && (props.hasSendableContent || props.isSending || showDictation || showStopWhenEmpty)}
            loading={props.isSending || dictationTranscribing || (showStopWhenEmpty && props.isStopping)}
            disabled={disabled}
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
                    : sendMenuEnabled ? t('agentInput.sendOptions.hint') : undefined
            }
            accessibilityState={{
                busy: dictationTranscribing,
                disabled,
                ...(sendMenuEnabled ? { expanded: sendMenuOpen } : {}),
            }}
            hitReach={SUBMIT_HIT_REACH}
            onPress={submitPress}
                onLongPress={sendMenuEnabled ? openSendMenu : undefined}
            overlay={sendMenuEnabled ? ({ hovered, focused }) => (
                Platform.OS === 'web' && (hovered || focused) && !sendMenuOpen ? (
                    <DeferredAnchoredTooltip activationKey={`${hovered}:${focused}`} anchorRef={sendMenuAnchorRef} placement="top"
                        label={(props.sendMenuModes ?? []).map((mode) => {
                            const title = getSendModeTitle(mode);
                            return props.sendMenuShortcuts?.[mode] ? `${title} (${props.sendMenuShortcuts[mode]})` : title;
                        }).join('\n')} />
                ) : null
            ) : undefined}
            accessibilityActions={sendMenuEnabled ? [{ name: 'longpress', label: t('agentInput.sendOptions.title') }] : undefined}
            onAccessibilityAction={sendMenuEnabled ? (event) => {
                if (event.nativeEvent.actionName === 'longpress') openSendMenu();
            } : undefined}
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
          {sendMenuOpen && sendMenuEnabled ? (
            <DropdownMenu
                open
                onOpenChange={setSendMenuOpen}
                popoverAnchorRef={sendMenuAnchorRef}
                placement="top"
                popoverAnchorAlign="end"
                matchTriggerWidth={false}
                closeOnSelect={false}
                items={(props.sendMenuModes ?? []).map((mode) => ({
                    id: mode,
                    shortcut: props.sendMenuShortcuts?.[mode],
                    testID: `agent-input-send-option-${mode}`,
                    title: getSendModeTitle(mode),
                }))}
                onSelect={(id) => {
                    const mode = props.sendMenuModes?.find((mode) => mode === id);
                    if (!mode) return;
                    setSendMenuOpen(false);
                    props.onSend({ deliveryIntent: mode });
                }}
            />
          ) : null}
        </View>
    );
});
