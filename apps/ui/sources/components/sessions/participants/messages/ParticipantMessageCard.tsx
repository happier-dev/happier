import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ParticipantMessageV1 } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { Text } from '@/components/ui/text/Text';
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

function readUserVisibleMessageText(message: Message): string | null {
    if (message.kind !== 'user-text') return null;
    const text = (message.displayText ?? message.text ?? '').trim();
    return text.length > 0 ? text : null;
}

export function ParticipantMessageCard(props: Readonly<{ payload: ParticipantMessageV1; message: Message }>) {
    const messageText = readUserVisibleMessageText(props.message);
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
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 8,
    },
    toText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    bodyText: {
        color: theme.colors.text,
        fontSize: 13,
    },
}));
