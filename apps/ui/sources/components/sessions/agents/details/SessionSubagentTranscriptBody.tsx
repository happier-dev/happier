import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionExecutionRunDetailsView } from '@/components/sessions/runs/details/SessionExecutionRunDetailsView';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { resolveSessionSubagentDetailsDescriptor } from './descriptors/resolveSessionSubagentDetailsDescriptor';
import type { SessionSubagentTranscriptBodyProps } from './descriptors/types';

const stylesheet = StyleSheet.create((theme) => ({
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 24,
    },
    emptyText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        textAlign: 'center',
    },
}));

export const SessionSubagentTranscriptBody = React.memo((props: SessionSubagentTranscriptBodyProps) => {
    const styles = stylesheet;
    const descriptor = resolveSessionSubagentDetailsDescriptor({
        subagent: props.subagent,
        message: props.message,
    });

    if (descriptor.id === 'execution_run' && props.subagent.runRef?.runId) {
        return (
            <SessionExecutionRunDetailsView
                sessionId={props.sessionId}
                runId={props.subagent.runRef.runId}
                presentation="panel"
                showInfoCard={false}
                showSendComposer={false}
            />
        );
    }

    if (props.message?.kind === 'tool-call') {
        return (
            <SessionMessageDetailsView
                sessionId={props.sessionId}
                session={props.session}
                message={props.message}
                showComposer={false}
            />
        );
    }

    return (
        <View style={styles.empty}>
            <Text style={styles.emptyText}>{t('session.subagents.details.unavailable')}</Text>
        </View>
    );
});
