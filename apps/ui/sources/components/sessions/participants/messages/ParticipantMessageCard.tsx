import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ParticipantMessageV1 } from '@happier-dev/protocol';

import { StructuredFindText, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';
import { t } from '@/text';

function describeParticipantRecipient(payload: ParticipantMessageV1): string {
    const r = payload.recipient;
    if (r.kind === 'execution_run') {
        return r.label ?? t('session.participants.executionRun', { runId: r.runId });
    }
    if (r.kind === 'agent_team_broadcast') {
        return t('session.participants.broadcast', { teamId: r.teamId });
    }
    return r.memberLabel ?? r.memberId;
}

export function projectParticipantMessageFindText(payload: ParticipantMessageV1, messageText: string): readonly StructuredFindTextBlock[] {
    return [
        { id: 'structured-participant-recipient', text: t('session.participants.cardTo', { label: describeParticipantRecipient(payload) }) },
        { id: 'structured-participant-body', text: messageText },
    ];
}

export function ParticipantMessageCard(props: Readonly<{ payload: ParticipantMessageV1; messageText: string }>) {
    const blocks = projectParticipantMessageFindText(props.payload, props.messageText);

    return (
        <View style={styles.container}>
            <StructuredFindText selectable style={styles.toText} blockId={blocks[0]!.id} text={blocks[0]!.text} />
            <StructuredFindText selectable style={styles.bodyText} blockId={blocks[1]!.id} text={blocks[1]!.text} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 8,
    },
    toText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '600',
    },
    bodyText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
}));
