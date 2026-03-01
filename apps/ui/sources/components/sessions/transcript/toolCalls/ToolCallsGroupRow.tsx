import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { useMessagesByIds } from '@/sync/domains/state/storage';

import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { ToolCallsGroupView } from '@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView';
import { layout } from '@/components/ui/layout/layout';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

export const ToolCallsGroupRow = React.memo(function ToolCallsGroupRow(props: {
    sessionId: string;
    toolCallsGroupId: string;
    toolMessageIds: readonly string[];
    metadata: Metadata | null;
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
    interaction: TranscriptInteraction;
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
                        setExpanded={props.setExpanded}
                        interaction={props.interaction}
                    />
                </View>
            </View>
        </TranscriptEnterWrapper>
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

