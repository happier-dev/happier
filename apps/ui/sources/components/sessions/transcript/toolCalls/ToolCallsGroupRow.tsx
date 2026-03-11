import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { useMessagesByIds } from '@/sync/domains/state/storage';

import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { ToolCallsGroupView } from '@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView';
import { TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { layout } from '@/components/ui/layout/layout';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

export const ToolCallsGroupRow = React.memo(function ToolCallsGroupRow(props: {
    sessionId: string;
    toolCallsGroupId: string;
    toolMessageIds: readonly string[];
    metadata: Metadata | null;
    getMessageById?: (messageId: string) => Message | null;
    expanded: boolean;
    onSetExpanded: (params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => void;
    interaction: TranscriptInteraction;
}) {
    const toolMessagesRaw = useMessagesByIds(props.sessionId, props.toolMessageIds);
    const toolMessages = React.useMemo(() => {
        const byId = new Map<string, ToolCallMessage>();
        for (const message of toolMessagesRaw) {
            if (message.kind !== 'tool-call') continue;
            byId.set(message.id, message);
        }
        if (typeof props.getMessageById === 'function') {
            for (const messageId of props.toolMessageIds) {
                if (byId.has(messageId)) continue;
                const localMessage = props.getMessageById(messageId);
                if (localMessage?.kind === 'tool-call') {
                    byId.set(messageId, localMessage);
                }
            }
        }
        return props.toolMessageIds
            .map((messageId) => byId.get(messageId) ?? null)
            .filter((message): message is ToolCallMessage => message?.kind === 'tool-call');
    }, [props.getMessageById, props.toolMessageIds, toolMessagesRaw]);

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

    const setExpanded = React.useCallback((expanded: boolean) => {
        props.onSetExpanded({ toolCallsGroupId: props.toolCallsGroupId, toolMessageIds: props.toolMessageIds, expanded });
    }, [props.onSetExpanded, props.toolCallsGroupId, props.toolMessageIds]);
    const webPrependAnchorId = props.toolMessageIds[props.toolMessageIds.length - 1] ?? props.toolCallsGroupId;

    return (
        <View testID={`${TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX}${webPrependAnchorId}`}>
            <TranscriptEnterWrapper id={props.toolCallsGroupId} createdAt={createdAt}>
                <View style={styles.centered}>
                    <View style={styles.centeredContent}>
                        <ToolCallsGroupView
                            id={props.toolCallsGroupId}
                            status={status}
                            toolMessages={toolMessages}
                            metadata={props.metadata}
                            sessionId={props.sessionId}
                            expanded={props.expanded}
                            setExpanded={setExpanded}
                            interaction={props.interaction}
                        />
                    </View>
                </View>
            </TranscriptEnterWrapper>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
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
