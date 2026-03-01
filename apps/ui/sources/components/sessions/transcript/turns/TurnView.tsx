import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { useMessage, useMessagesByIds } from '@/sync/domains/state/storage';

import { MessageView } from '@/components/sessions/transcript/MessageView';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { ActivityGroupView } from '@/components/sessions/transcript/turns/activity/ActivityGroupView';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { layout } from '@/components/ui/layout/layout';

const TurnMessageRow = React.memo(function TurnMessageRow(props: {
    sessionId: string;
    messageId: string;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'readOnly' | 'notGranted';
    };
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

const TurnActivityRow = React.memo(function TurnActivityRow(props: {
    sessionId: string;
    activityId: string;
    toolMessageIds: readonly string[];
    metadata: Metadata | null;
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
    interaction: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'readOnly' | 'notGranted';
    };
}) {
    const toolMessagesRaw = useMessagesByIds(props.sessionId, props.toolMessageIds);
    const toolMessages = toolMessagesRaw.filter((m): m is ToolCallMessage => m.kind === 'tool-call');

    let status: 'running' | 'completed' | 'error' = 'completed';
    let sawError = false;
    for (const m of toolMessages) {
        if (m.tool.state === 'running') {
            status = 'running';
            break;
        }
        if (m.tool.state === 'error') sawError = true;
    }
    if (status !== 'running' && sawError) status = 'error';

    const createdAt = toolMessages[0]?.createdAt ?? Date.now();

    return (
        <TranscriptEnterWrapper id={props.activityId} createdAt={createdAt}>
            <View style={styles.centered}>
                <View style={styles.centeredContent}>
                    <ActivityGroupView
                        id={props.activityId}
                        status={status}
                        toolMessages={toolMessages}
                        metadata={props.metadata}
                        sessionId={props.sessionId}
                        expanded={props.expanded}
                        setExpanded={props.setExpanded}
                        interaction={props.interaction}
                    />
                </View>
            </View>
        </TranscriptEnterWrapper>
    );
});

export const TurnView = React.memo((props: {
    turn: TranscriptTurn;
    metadata: Metadata | null;
    sessionId: string;
    activeThinkingMessageId: string | null;
    expandedActivityGroupIds: ReadonlySet<string>;
    setActivityGroupExpanded: (activityGroupId: string, expanded: boolean) => void;
    resolveThinkingExpanded?: (messageId: string) => boolean;
    setThinkingExpanded?: (messageId: string, expanded: boolean) => void;
    interaction: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'readOnly' | 'notGranted';
    };
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
                    <TurnActivityRow
                        key={c.id}
                        sessionId={props.sessionId}
                        activityId={c.id}
                        toolMessageIds={c.toolMessageIds}
                        metadata={props.metadata}
                        expanded={props.expandedActivityGroupIds.has(c.id)}
                        setExpanded={(expanded) => props.setActivityGroupExpanded(c.id, expanded)}
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
    centered: {
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    centeredContent: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: layout.maxWidth,
    },
}));
