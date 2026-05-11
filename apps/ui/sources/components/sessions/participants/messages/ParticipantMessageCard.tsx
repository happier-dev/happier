import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ParticipantMessageV1 } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { Text } from '@/components/ui/text/Text';
import { readStructuredUserMessageText } from '@/components/sessions/transcript/structured/readStructuredUserMessageText';
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

export function ParticipantMessageCard(props: Readonly<{ payload: ParticipantMessageV1; message: Message }>) {
    const messageText = readStructuredUserMessageText(props.message);
    if (!messageText) return null;

    const label = describeParticipantRecipient(props.payload);

    return (
        <View style={styles.container}>
            <Text selectable style={styles.toText}>{t('session.participants.cardTo', { label })}</Text>
            <Text selectable style={styles.bodyText}>{messageText}</Text>
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
