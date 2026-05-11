import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionSubagentOverviewCard } from '@/components/sessions/agents/details/SessionSubagentOverviewCard';
import { SessionSubagentTranscriptBody } from '@/components/sessions/agents/details/SessionSubagentTranscriptBody';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunDeliveryActionChip } from '@/components/sessions/agentInput/routing/createExecutionRunDeliveryActionChip';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { Text } from '@/components/ui/text/Text';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { useMessage, useResolvedSessionMessageRouteId, useSession } from '@/sync/domains/state/storage';
import { useSessionMessages } from '@/sync/store/hooks';
import { t } from '@/text';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        gap: 12,
    },
    empty: {
        flex: 1,
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

export const SessionSubagentDetailsView = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    subagentId: string;
}>) => {
    const styles = stylesheet;
    const session = useSession(props.sessionId);
    const { messages } = useSessionMessages(props.sessionId);
    const { subagents } = useSessionSubagents({
        sessionId: props.sessionId,
        session,
        messages,
    });

    const subagent = React.useMemo(() => {
        return subagents.find((candidate) => candidate.id === props.subagentId) ?? null;
    }, [props.subagentId, subagents]);

    const routeMessageId = subagent?.transcript.toolMessageRouteId ?? '';
    const resolvedMessageId = useResolvedSessionMessageRouteId(props.sessionId, routeMessageId);
    const message = useMessage(props.sessionId, resolvedMessageId ?? routeMessageId);
    const [executionRunDelivery, setExecutionRunDelivery] = React.useState<'prompt' | 'steer_if_supported' | 'interrupt'>('steer_if_supported');
    const transcriptInteraction = React.useMemo(() => {
        if (!session) return { canSendMessages: false } as const;
        return deriveTranscriptInteractionFromSession({
            accessLevel: session.accessLevel,
            canApprovePermissions: session.canApprovePermissions,
            active: session.active,
            presence: session.presence,
        });
    }, [session]);

    React.useEffect(() => {
        setExecutionRunDelivery('steer_if_supported');
    }, [subagent?.id]);

    if (!session || !subagent) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>{t('session.subagents.details.unavailable')}</Text>
            </View>
        );
    }

    const canShowComposer = subagent.capabilities.canSend && subagent.recipient !== null && subagent.status === 'running';
    const extraActionChips = (
        subagent.recipient?.kind === 'execution_run'
            ? [createExecutionRunDeliveryActionChip({
                recipient: subagent.recipient,
                delivery: executionRunDelivery,
                onDeliveryChange: setExecutionRunDelivery,
            })] satisfies readonly AgentInputExtraActionChip[]
            : undefined
    );

    return (
        <View style={styles.container}>
            <SessionSubagentOverviewCard subagent={subagent} />
            <SessionSubagentTranscriptBody
                sessionId={props.sessionId}
                scopeId={props.scopeId}
                session={session}
                subagent={subagent}
                message={message}
            />
            {canShowComposer ? (
                <SessionParticipantComposer
                    sessionId={props.sessionId}
                    canSendMessages={transcriptInteraction.canSendMessages}
                    recipient={subagent.recipient}
                    executionRunDelivery={executionRunDelivery}
                    extraActionChips={extraActionChips}
                />
            ) : null}
        </View>
    );
});
