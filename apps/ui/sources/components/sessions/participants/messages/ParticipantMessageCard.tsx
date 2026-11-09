import { Typography } from '@/constants/Typography';
import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ParticipantMessageV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { Message } from '@happier-dev/session-core/messages';

import { StructuredFindText, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { findTranscriptExecutionRunState } from '@/sync/domains/session/subagents/executionRuns/deriveTranscriptExecutionRunStateIndex';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { t } from '@/text';

function describeParticipantRecipient(payload: ParticipantMessageV1, messages: readonly Message[] = []): string {
    const r = payload.recipient;
    if (r.kind === 'execution_run') {
        if (!r.label) {
            const run = findTranscriptExecutionRunState(messages, r.runId);
            if (run && (run.intent || run.displayLabel)) return resolveExecutionRunTitle({ intent: run.intent,
                ...(run.displayLabel ? { display: { title: run.displayLabel } } : {}) }, 'recipient');
        }
        return r.label ?? t('session.participants.executionRun', { runId: r.runId });
    }
    if (r.kind === 'agent_team_broadcast') {
        return t('session.participants.broadcast', { teamId: r.teamId });
    }
    return r.memberLabel ?? r.memberId;
}

export function projectParticipantMessageFindText(payload: ParticipantMessageV1, messageText: string, messages?: readonly Message[]): readonly StructuredFindTextBlock[] {
    return participantMessageBlocks(messageText, describeParticipantRecipient(payload, messages));
}

function participantMessageBlocks(messageText: string, recipientLabel: string): readonly StructuredFindTextBlock[] {
    return [
        { id: 'structured-participant-recipient', text: t('session.participants.cardTo', { label: recipientLabel }) },
        { id: 'structured-participant-body', text: messageText },
    ];
}

function useParticipantRecipientLabel(payload: ParticipantMessageV1): string {
    const source = useOptionalSessionTranscriptSource();
    const activeServerId = useActiveServerSnapshot(source?.kind === 'app').serverId;
    const language = usePreferredLanguage();
    const selector = React.useMemo(() => {
        const address = source ? normalizeSessionAddress(source.serverId ?? activeServerId, source.sessionId) : null;
        let version: number | undefined;
        let home: unknown;
        let present = false;
        let label = describeParticipantRecipient(payload);
        return (state: StorageState) => {
            if (source?.kind !== 'app' || payload.recipient.kind !== 'execution_run' || payload.recipient.label) return label;
            const transcript = state.sessionMessages[source.sessionId];
            const nextVersion = transcript?.subagentSourceVersion ?? transcript?.messagesVersion ?? 0;
            const nextHome = state.sessions[source.sessionId]?.serverId;
            const nextPresent = Boolean(transcript && state.sessions[source.sessionId]);
            if (version !== nextVersion || home !== nextHome || present !== nextPresent) {
                version = nextVersion; home = nextHome; present = nextPresent;
                label = describeParticipantRecipient(payload, readStoredSessionMessagesForAddress(state, address, { activeServerId }));
            }
            return label;
        };
    }, [source, payload, activeServerId, language]);
    const label = getStorage()(selector);
    if (source?.kind !== 'readOnly') return label;
    const messages = source.useMessagesById({ textUpdates: false });
    return describeParticipantRecipient(payload, Object.values(messages));
}

export function ParticipantMessageCard(props: Readonly<{ payload: ParticipantMessageV1; messageText: string }>) {
    const blocks = participantMessageBlocks(props.messageText, useParticipantRecipientLabel(props.payload));

    return (
        <View style={styles.container}>
            <StructuredFindText selectable style={styles.toText} blockId={blocks[0]!.id} text={blocks[0]!.text} />
            <StructuredFindText selectable style={styles.bodyText} blockId={blocks[1]!.id} text={blocks[1]!.text} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: theme.space.s12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: theme.space.s8,
    },
    toText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
    bodyText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
}));
