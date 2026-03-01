import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { useMessage } from '@/sync/domains/state/storage';

import { MessageView } from '@/components/sessions/transcript/MessageView';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { ToolCallsGroupRow } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

const TurnMessageRow = React.memo(function TurnMessageRow(props: {
    sessionId: string;
    messageId: string;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
}) {
    const message = useMessage(props.sessionId, props.messageId);
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
        <TranscriptEnterWrapper id={message.id} createdAt={message.createdAt}>
            <MessageView
                message={message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                activeThinkingMessageId={props.activeThinkingMessageId}
                thinkingExpanded={controlledThinking ? resolveThinkingExpanded(message.id) : undefined}
                onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
                interaction={props.interaction}
            />
        </TranscriptEnterWrapper>
    );
});

export const TurnView = React.memo((props: {
    turn: TranscriptTurn;
    metadata: Metadata | null;
    sessionId: string;
    activeThinkingMessageId: string | null;
    expandedToolCallsGroupIds: ReadonlySet<string>;
    setToolCallsGroupExpanded: (toolCallsGroupId: string, expanded: boolean) => void;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
}) => {
    return (
        <View testID="transcript-turn" style={styles.container}>
            {props.turn.userMessageId ? (
                <TurnMessageRow
                    sessionId={props.sessionId}
                    messageId={props.turn.userMessageId}
                    metadata={props.metadata}
                    activeThinkingMessageId={props.activeThinkingMessageId}
                    resolveThinkingExpanded={props.resolveThinkingExpanded}
                    setThinkingExpanded={props.setThinkingExpanded}
                    interaction={props.interaction}
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
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            resolveThinkingExpanded={props.resolveThinkingExpanded}
                            setThinkingExpanded={props.setThinkingExpanded}
                            interaction={props.interaction}
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
                        expanded={props.expandedToolCallsGroupIds.has(c.id)}
                        setExpanded={(expanded) => props.setToolCallsGroupExpanded(c.id, expanded)}
                        interaction={props.interaction}
                    />
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingTop: 6,
        paddingBottom: 6,
    },
}));
