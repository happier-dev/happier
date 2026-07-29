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
import { ToolCallsGroupRow, ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { isMessageRolledBack, type SessionRollbackRangeV1, type TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import {
    hasTranscriptSessionCommonProps,
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

type TranscriptItemOriginLookup = (messageId: string) => {
    sessionId: string;
    isReadOnlyContext: boolean;
} | null;

const TurnMessageRow = React.memo(function TurnMessageRow(props: {
    sessionId: string;
    messageId: string;
    metadata: Metadata | null;
    forcePermissionPromptsInTranscript?: boolean;
    activeThinkingMessageId: string | null;
    getMessageById?: (messageId: string) => Message | null;
    getMessageRevisionById?: (messageId: string) => number | null;
    getMessageOrigin?: TranscriptItemOriginLookup;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackRanges?: readonly SessionRollbackRangeV1[];
    resolveRollbackAction?: (messageId: string) => TranscriptRollbackAction | null;
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleMessagePin?: (pin: PersistedSessionMessagePinV1) => void;
} & Partial<TranscriptSessionCommonProps>) {
    const origin = props.getMessageOrigin?.(props.messageId) ?? null;
    const effectiveSessionId = origin?.sessionId ?? props.sessionId;
    const effectiveInteraction = deriveReadOnlyTranscriptInteraction(props.interaction, origin?.isReadOnlyContext === true);
    const sessionMessage = useMessage(effectiveSessionId, props.messageId);
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
    const rollbackRanges = props.rollbackRanges ?? [];
    const historical = isMessageRolledBack({ message, rollbackRanges });
    const canUseParentCommon = effectiveSessionId === props.sessionId && hasTranscriptSessionCommonProps(props);
    const messageView = canUseParentCommon ? (
        <MessageViewWithSessionCommon
            message={message}
            messageRevision={props.getMessageRevisionById?.(message.id) ?? null}
            metadata={props.metadata}
            sessionId={effectiveSessionId}
            forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
            approvalRequests={props.approvalRequests}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={controlledThinking ? resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
            interaction={effectiveInteraction}
            historical={historical}
            rollbackAction={props.resolveRollbackAction?.(message.id) ?? null}
            messagePins={props.messagePins}
            onToggleMessagePin={props.onToggleMessagePin}
            onToggleToolPin={props.onToggleMessagePin}
            forkCommon={props.forkCommon}
            messageDisplayCommon={props.messageDisplayCommon}
            toolChromeCommon={props.toolChromeCommon}
            toolRouteCommon={props.toolRouteCommon}
        />
    ) : (
        <MessageView
            message={message}
            messageRevision={props.getMessageRevisionById?.(message.id) ?? null}
            metadata={props.metadata}
            sessionId={effectiveSessionId}
            forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
            approvalRequests={props.approvalRequests}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={controlledThinking ? resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
            interaction={effectiveInteraction}
            historical={historical}
            rollbackAction={props.resolveRollbackAction?.(message.id) ?? null}
            messagePins={props.messagePins}
            onToggleMessagePin={props.onToggleMessagePin}
            onToggleToolPin={props.onToggleMessagePin}
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

function resolveActiveThinkingMessageIdForTurnMessage(messageId: string, activeThinkingMessageId: string | null): string | null {
    return messageId === activeThinkingMessageId ? activeThinkingMessageId : null;
}

type TurnViewProps = Readonly<{
    turn: TranscriptTurn;
    metadata: Metadata | null;
    sessionId: string;
    forcePermissionPromptsInTranscript?: boolean;
    activeThinkingMessageId: string | null;
    getMessageById?: (messageId: string) => Message | null;
    getMessageRevisionById?: (messageId: string) => number | null;
    getMessageOrigin?: TranscriptItemOriginLookup;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    setToolCallsGroupExpanded: (params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => void;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    rollbackRanges?: readonly SessionRollbackRangeV1[];
    resolveRollbackAction?: (messageId: string) => TranscriptRollbackAction | null;
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleMessagePin?: (pin: PersistedSessionMessagePinV1) => void;
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
    return (
        <View testID="transcript-turn" style={styles.container}>
            {props.turn.userMessageId ? (
                <TurnMessageRow
                    sessionId={props.sessionId}
                    messageId={props.turn.userMessageId}
                    metadata={props.metadata}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    activeThinkingMessageId={resolveActiveThinkingMessageIdForTurnMessage(props.turn.userMessageId, props.activeThinkingMessageId)}
                    getMessageById={props.getMessageById}
                    getMessageRevisionById={props.getMessageRevisionById}
                    getMessageOrigin={props.getMessageOrigin}
                    approvalRequests={props.approvalRequests}
                    resolveThinkingExpanded={props.resolveThinkingExpanded}
                    setThinkingExpanded={props.setThinkingExpanded}
                    interaction={props.interaction}
                    rollbackRanges={props.rollbackRanges}
                    resolveRollbackAction={props.resolveRollbackAction}
                    messagePins={props.messagePins}
                    onToggleMessagePin={props.onToggleMessagePin}
                    forkCommon={props.forkCommon}
                    messageDisplayCommon={props.messageDisplayCommon}
                    toolChromeCommon={props.toolChromeCommon}
                    toolRouteCommon={props.toolRouteCommon}
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
                            activeThinkingMessageId={resolveActiveThinkingMessageIdForTurnMessage(c.messageId, props.activeThinkingMessageId)}
                            getMessageById={props.getMessageById}
                            getMessageRevisionById={props.getMessageRevisionById}
                            getMessageOrigin={props.getMessageOrigin}
                            approvalRequests={props.approvalRequests}
                            resolveThinkingExpanded={props.resolveThinkingExpanded}
                            setThinkingExpanded={props.setThinkingExpanded}
                            interaction={props.interaction}
                            rollbackRanges={props.rollbackRanges}
                            resolveRollbackAction={props.resolveRollbackAction}
                            messagePins={props.messagePins}
                            onToggleMessagePin={props.onToggleMessagePin}
                            forkCommon={props.forkCommon}
                            messageDisplayCommon={props.messageDisplayCommon}
                            toolChromeCommon={props.toolChromeCommon}
                            toolRouteCommon={props.toolRouteCommon}
                        />
                    );
                }
                const origin = props.getMessageOrigin?.(c.toolMessageIds[0] ?? '') ?? null;
                const interaction = deriveReadOnlyTranscriptInteraction(props.interaction, origin?.isReadOnlyContext === true);
                return (
                    <ToolCallsGroupRowWithSessionCommon
                        key={c.id}
                        sessionId={props.sessionId}
                        toolCallsGroupId={c.id}
                        toolMessageIds={c.toolMessageIds}
                        metadata={props.metadata}
                        forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                        getMessageById={props.getMessageById}
                        approvalRequests={props.approvalRequests}
                        expanded={c.toolMessageIds.some((id) => props.expandedToolCallsAnchorMessageIds.has(id))}
                        onSetExpanded={props.setToolCallsGroupExpanded}
                        interaction={interaction}
                        messagePins={props.messagePins}
                        onToggleToolPin={props.onToggleMessagePin}
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
