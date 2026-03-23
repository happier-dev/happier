import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { useMessage } from '@/sync/domains/state/storage';

import { MessageView } from '@/components/sessions/transcript/MessageView';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { ToolCallsGroupRow } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

const TurnMessageRow = React.memo(function TurnMessageRow(props: {
    sessionId: string;
    messageId: string;
    metadata: Metadata | null;
    forcePermissionPromptsInTranscript?: boolean;
    activeThinkingMessageId: string | null;
    getMessageById?: (messageId: string) => Message | null;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    historical?: boolean;
    resolveRollbackAction?: (messageId: string) => TranscriptRollbackAction | null;
}) {
    const sessionMessage = useMessage(props.sessionId, props.messageId);
    const providedMessage = typeof props.getMessageById === 'function' ? props.getMessageById(props.messageId) : null;
    const message = providedMessage ?? sessionMessage;
    if (!message) return null;

    const resolveThinkingExpanded =
        typeof props.resolveThinkingExpanded === 'function' ? props.resolveThinkingExpanded : null;
    const setThinkingExpanded =
        typeof props.setThinkingExpanded === 'function' ? props.setThinkingExpanded : null;
    const controlledThinking =
        message.kind === 'agent-text' &&
        message.isThinking === true &&
        resolveThinkingExpanded != null &&
        setThinkingExpanded != null;

    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${message.id}`}>
            <View testID={`transcript-message-${message.id}`}>
                <TranscriptEnterWrapper id={message.id} createdAt={message.createdAt}>
                    <MessageView
                        message={message}
                        metadata={props.metadata}
                        sessionId={props.sessionId}
                        forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                        activeThinkingMessageId={props.activeThinkingMessageId}
                        thinkingExpanded={controlledThinking ? resolveThinkingExpanded(message.id) : undefined}
                        onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
                        interaction={props.interaction}
                        historical={props.historical}
                        rollbackAction={props.resolveRollbackAction?.(message.id) ?? null}
                    />
                </TranscriptEnterWrapper>
            </View>
        </View>
    );
});

export const TurnView = React.memo((props: {
    turn: TranscriptTurn;
    metadata: Metadata | null;
    sessionId: string;
    forcePermissionPromptsInTranscript?: boolean;
    activeThinkingMessageId: string | null;
    getMessageById?: (messageId: string) => Message | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    setToolCallsGroupExpanded: (params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => void;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    isMessageHistorical?: (messageId: string) => boolean;
    resolveRollbackAction?: (messageId: string) => TranscriptRollbackAction | null;
}) => {
    return (
        <View testID="transcript-turn" style={styles.container}>
            {props.turn.userMessageId ? (
                <TurnMessageRow
                    sessionId={props.sessionId}
                    messageId={props.turn.userMessageId}
                    metadata={props.metadata}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    activeThinkingMessageId={props.activeThinkingMessageId}
                    getMessageById={props.getMessageById}
                    resolveThinkingExpanded={props.resolveThinkingExpanded}
                    setThinkingExpanded={props.setThinkingExpanded}
                    interaction={props.interaction}
                    historical={props.isMessageHistorical?.(props.turn.userMessageId) === true}
                    resolveRollbackAction={props.resolveRollbackAction}
                />
            ) : null}
            {props.turn.content.map((c) => {
                if (c.kind === 'message') {
                    return (
                        <TurnMessageRow
                            key={c.messageId}
                            sessionId={props.sessionId}
                            messageId={c.messageId}
                            metadata={props.metadata}
                            forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            getMessageById={props.getMessageById}
                            resolveThinkingExpanded={props.resolveThinkingExpanded}
                            setThinkingExpanded={props.setThinkingExpanded}
                            interaction={props.interaction}
                            historical={props.isMessageHistorical?.(c.messageId) === true}
                            resolveRollbackAction={props.resolveRollbackAction}
                        />
                    );
                }
                return (
                    <ToolCallsGroupRow
                        key={c.id}
                        sessionId={props.sessionId}
                        toolCallsGroupId={c.id}
                        toolMessageIds={c.toolMessageIds}
                        metadata={props.metadata}
                        forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                        getMessageById={props.getMessageById}
                        expanded={c.toolMessageIds.some((id) => props.expandedToolCallsAnchorMessageIds.has(id))}
                        onSetExpanded={props.setToolCallsGroupExpanded}
                        interaction={props.interaction}
                    />
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
    },
}));
