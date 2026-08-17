import { Image } from 'expo-image';
import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

import { resolveAgentContinuationSubmitPresentation } from './agentContinuationSubmitPresentation';

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

    // The armed switch only reaches the button while the button is actually a
    // send. The mic and Stop states are other actions, and labelling them
    // "Continue with {Agent}" would promise something that press does not do.
    const armedContinuation = props.armedContinuationTarget && props.hasSendableContent
        ? resolveAgentContinuationSubmitPresentation({
            agentId: props.armedContinuationTarget.agentId,
            agentLabel: props.armedContinuationTarget.label,
        })
        : null;

    return (
        <PrimaryCircleIconButton
            testID={props.testID}
            active={props.hasSendableContent || props.isSending || Boolean(props.micPressHandler) || showStopWhenEmpty}
            loading={props.isSending || (showStopWhenEmpty && props.isStopping)}
            disabled={props.disabled}
            accessibilityLabel={
                armedContinuation
                    ? armedContinuation.accessibilityLabel
                    : props.hasSendableContent
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
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                if (props.hasSendableContent) {
                    props.onSend();
                } else {
                    if (props.micPressHandler) {
                        props.micPressHandler();
                    } else if (showStopWhenEmpty) {
                        props.onStop?.();
                    }
                }
            }}
            style={{ marginLeft: 8, marginRight: 8 }}
        >
            {armedContinuation?.markAgentId ? (
                // The same mark the Agent rail already used to offer this target,
                // at the registry's own optical size and tinted by the button's
                // token, so it sits on the primary fill exactly like the arrow it
                // replaces and reads at the weight the reader just saw.
                <AgentIcon
                    agentId={armedContinuation.markAgentId}
                    size={armedContinuation.markSize}
                    color={theme.colors.button.primary.tint}
                />
            ) : props.hasSendableContent ? (
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
    );
});
