import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import * as React from 'react';

import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { AgentInput } from '@/components/sessions/agentInput';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';
import { resolveParticipantRoutedSend } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ExecutionRunDelivery = 'prompt' | 'steer_if_supported' | 'interrupt';

// R-9: participant composers offer file/plugin references and slash commands only. No $ skills.
const PARTICIPANT_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'slashCommand'];

export const SessionParticipantComposer = React.memo((props: Readonly<{
    sessionId: string;
    canSendMessages: boolean;
    recipient: ParticipantRecipientV1 | null;
    executionRunDelivery?: ExecutionRunDelivery;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    onExecutionRunUnavailable?: () => void;
}>) => {
    const [composerText, setComposerText] = React.useState('');

    return (
        <AgentInput
            placeholder={props.canSendMessages ? t('session.inputPlaceholder') : t('session.sharing.viewOnlyMode')}
            value={composerText}
            onChangeText={setComposerText}
            sessionId={props.sessionId}
            onSend={(options) => {
                if (!props.canSendMessages) {
                    Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                    return;
                }

                const liveComposerText = options?.inputTextOverride ?? composerText;
                const text = liveComposerText.trim();
                if (text.length === 0) return;

                const previousMessage = liveComposerText;
                setComposerText('');

                fireAndForget((async () => {
                    const routed =
                        props.recipient
                            ? resolveParticipantRoutedSend({
                                text,
                                recipient: props.recipient,
                                executionRunDelivery: props.executionRunDelivery,
                            })
                            : null;

                    if (routed?.type === 'execution_run_send') {
                        const result = await sessionExecutionRunSend(props.sessionId, {
                            runId: routed.runId,
                            message: routed.message,
                            delivery: routed.delivery,
                        });
                        if (!result.ok) {
                            if (isExecutionRunNotRunningSendError(result)) {
                                props.onExecutionRunUnavailable?.();
                            }
                            setComposerText(previousMessage);
                            Modal.alert(t('common.error'), result.error ?? t('runs.send.failedToSend'));
                        }
                        return;
                    }

                    try {
                        if (routed?.type === 'session_message') {
                            await sync.submitMessage(props.sessionId, routed.text, routed.displayText, routed.metaOverrides, {
                                callerSurface: 'participant_composer',
                            });
                            return;
                        }
                        await sync.submitMessage(props.sessionId, text, undefined, undefined, {
                            callerSurface: 'participant_composer',
                        });
                    } catch (error) {
                        setComposerText(previousMessage);
                        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
                    }
                })(), { tag: 'SessionParticipantComposer.sendMessage' });
            }}
            autocompleteKinds={PARTICIPANT_COMPOSER_SUGGESTION_KINDS}
            autocompleteSuggestions={(query, signal) => resolveSessionComposerSuggestions(props.sessionId, query, {
                kinds: PARTICIPANT_COMPOSER_SUGGESTION_KINDS,
                signal,
            })}
            isSendDisabled={!props.canSendMessages}
            disabled={!props.canSendMessages}
            extraActionChips={props.extraActionChips}
        />
    );
});
