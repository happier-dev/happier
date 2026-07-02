import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useMessage } from '@/sync/domains/state/storage';

import { MessageView, MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { useMappingHelper } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { isMessageRolledBack, type SessionRollbackRangeV1, type TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import {
    hasTranscriptSessionCommonProps,
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

const TurnMessageRow = React.memo(function TurnMessageRow(props: {
    sessionId: string;
    messageId: string;
    metadata: Metadata | null;
    forcePermissionPromptsInTranscript?: boolean;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    activeThinkingMessageId: string | null;
    getMessageById?: (messageId: string) => Message | null;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    resolveRollbackAction?: (messageId: string) => TranscriptRollbackAction | null;
} & Partial<TranscriptSessionCommonProps>) {
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
    const historical = isMessageRolledBack({ message, rollbackRanges: props.rollbackRanges ?? [] });
    const canUseParentCommon = providedMessage == null && hasTranscriptSessionCommonProps(props);
    const messageView = canUseParentCommon ? (
        <MessageViewWithSessionCommon
            message={message}
            metadata={props.metadata}
            sessionId={props.sessionId}
            forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
            approvalRequests={props.approvalRequests}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={controlledThinking ? resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
            interaction={props.interaction}
            historical={historical}
            rollbackAction={props.resolveRollbackAction?.(message.id) ?? null}
            forkCommon={props.forkCommon}
            messageDisplayCommon={props.messageDisplayCommon}
            toolChromeCommon={props.toolChromeCommon}
            toolRouteCommon={props.toolRouteCommon}
        />
    ) : (
        <MessageView
            message={message}
            metadata={props.metadata}
            sessionId={props.sessionId}
            forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
            approvalRequests={props.approvalRequests}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={controlledThinking ? resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
            interaction={props.interaction}
            historical={historical}
            rollbackAction={props.resolveRollbackAction?.(message.id) ?? null}
        />
    );

    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${message.id}`}>
            <View testID={`transcript-message-${message.id}`}>
                <TranscriptEnterWrapper id={message.id} createdAt={message.createdAt}>
                    {messageView}
                </TranscriptEnterWrapper>
            </View>
        </View>
    );
});

type TurnViewProps = Readonly<{
    turn: TranscriptTurn;
    metadata: Metadata | null;
    sessionId: string;
    forcePermissionPromptsInTranscript?: boolean;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    activeThinkingMessageId: string | null;
    getMessageById?: (messageId: string) => Message | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    setToolCallsGroupExpanded: (params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => void;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    resolveRollbackAction?: (messageId: string) => TranscriptRollbackAction | null;
}>;

export const TurnView = React.memo((props: TurnViewProps) => {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    return (
        <TurnViewWithSessionCommon
            {...props}
            forkCommon={transcriptSessionCommon.fork}
            messageDisplayCommon={transcriptSessionCommon.messageDisplay}
            toolChromeCommon={transcriptSessionCommon.toolChrome}
            toolRouteCommon={transcriptSessionCommon.toolRoute}
        />
    );
});

export const TurnViewWithSessionCommon = React.memo((props: TurnViewProps & TranscriptSessionCommonProps) => {
    const { getMappingKey } = useMappingHelper();
    return (
        <View testID="transcript-turn" style={styles.container}>
            {props.turn.userMessageId ? (
                <TurnMessageRow
                    sessionId={props.sessionId}
                    messageId={props.turn.userMessageId}
                    metadata={props.metadata}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    approvalRequests={props.approvalRequests}
                    activeThinkingMessageId={props.activeThinkingMessageId}
                    getMessageById={props.getMessageById}
                    resolveThinkingExpanded={props.resolveThinkingExpanded}
                    setThinkingExpanded={props.setThinkingExpanded}
                    interaction={props.interaction}
                    rollbackRanges={props.rollbackRanges}
                    resolveRollbackAction={props.resolveRollbackAction}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={props.toolRouteCommon}
                />
            ) : null}
            {props.turn.content.map((c, index) => {
                if (c.kind === 'message') {
                    return (
                        <TurnMessageRow
                            key={getMappingKey(c.messageId, index)}
                            sessionId={props.sessionId}
                            messageId={c.messageId}
                            metadata={props.metadata}
                            forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                            approvalRequests={props.approvalRequests}
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            getMessageById={props.getMessageById}
                            resolveThinkingExpanded={props.resolveThinkingExpanded}
                            setThinkingExpanded={props.setThinkingExpanded}
                            interaction={props.interaction}
                            rollbackRanges={props.rollbackRanges}
                            resolveRollbackAction={props.resolveRollbackAction}
                            forkCommon={props.forkCommon}
                            messageDisplayCommon={props.messageDisplayCommon}
                            toolChromeCommon={props.toolChromeCommon}
                            toolRouteCommon={props.toolRouteCommon}
                        />
                    );
                }
                return (
                    <ToolCallsGroupRowWithSessionCommon
                        key={getMappingKey(c.id, index)}
                        sessionId={props.sessionId}
                        toolCallsGroupId={c.id}
                        toolMessageIds={c.toolMessageIds}
                        metadata={props.metadata}
                        forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                        approvalRequests={props.approvalRequests}
                        getMessageById={props.getMessageById}
                        expanded={c.toolMessageIds.some((id) => props.expandedToolCallsAnchorMessageIds.has(id))}
                        onSetExpanded={props.setToolCallsGroupExpanded}
                        interaction={props.interaction}
                        forkCommon={props.forkCommon}
                        messageDisplayCommon={props.messageDisplayCommon}
                        toolChromeCommon={props.toolChromeCommon}
                        toolRouteCommon={props.toolRouteCommon}
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
