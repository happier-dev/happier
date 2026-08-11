import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionSubagentOverviewCard } from '@/components/sessions/agents/details/SessionSubagentOverviewCard';
import { SessionSubagentTranscriptBody } from '@/components/sessions/agents/details/SessionSubagentTranscriptBody';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createExecutionRunDeliveryActionChip } from '@/components/sessions/agentInput/routing/createExecutionRunDeliveryActionChip';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { renderStructuredMessage } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import { Text } from '@/components/ui/text/Text';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import {
    useMessage,
    useResolvedSessionMessageRouteId,
    useSession,
    useSessionSubagentSourceMessages,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
    deriveTranscriptInteraction,
    deriveTranscriptInteractionFromSession,
} from '@/utils/sessions/deriveTranscriptInteraction';

const FAIL_CLOSED_TRANSCRIPT_INTERACTION = deriveTranscriptInteraction({ kind: 'public' });

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
    // P-2: the subagent-source projection rather than the full transcript. This view needs the
    // roster only to find one subagent by id, and the full array made every streamed token
    // re-derive it.
    const subagentSourceMessages = useSessionSubagentSourceMessages(props.sessionId);
    const { subagents } = useSessionSubagents({
        sessionId: props.sessionId,
        session,
        messages: subagentSourceMessages,
    });

    const subagent = React.useMemo(() => {
        return subagents.find((candidate) => candidate.id === props.subagentId) ?? null;
    }, [props.subagentId, subagents]);

    const routeMessageId = subagent?.transcript.toolMessageRouteId ?? '';
    const resolvedMessageId = useResolvedSessionMessageRouteId(props.sessionId, routeMessageId);
    const message = useMessage(props.sessionId, resolvedMessageId ?? routeMessageId);
    const [executionRunDelivery, setExecutionRunDelivery] = React.useState<'prompt' | 'steer_if_supported' | 'interrupt'>('steer_if_supported');
    const transcriptInteraction = React.useMemo(() => {
        if (!session) return FAIL_CLOSED_TRANSCRIPT_INTERACTION;
        return deriveTranscriptInteractionFromSession({
            accessLevel: session.accessLevel,
            canApprovePermissions: session.canApprovePermissions,
            active: session.active,
            presence: session.presence,
        });
    }, [session]);

    /**
     * The run's structured outcome (review findings, plan, delegate), rendered by the same cards
     * the `/runs/[runId]` route shows (S-2).
     *
     * It cannot come from the transcript below: `sidechainStreamText.ts` deliberately strips the
     * trailing result JSON for exactly these intents and routes the outcome to `structuredMeta`
     * (S-5), so mining the sidechain tail would fight that owner. The CLI publishes the same
     * envelope twice — into the run registry, and onto the owning tool-call message as
     * `meta.happier` (`finishExecutionRun`, re-emitted after a triage action so the message stays
     * current). Reading the message costs no RPC, survives an inactive session, and goes through
     * `renderStructuredMessage`, the transcript's own registry — no second dispatcher.
     *
     * Gated on a tool-call message because that is precisely the branch
     * `SessionSubagentTranscriptBody` sends to `SessionMessageDetailsView`. When there is no
     * tool-call message it renders `SessionExecutionRunDetailsView`, which already renders this
     * card from the run registry, so the two sources are mutually exclusive and the outcome can
     * never appear twice. A subagent with no structured outcome renders nothing here — the
     * transcript body alone, exactly as before.
     */
    const structuredResult = React.useMemo(() => {
        if (!message || message.kind !== 'tool-call') return null;
        return renderStructuredMessage({
            message,
            sessionId: props.sessionId,
            interaction: transcriptInteraction,
        });
    }, [message, props.sessionId, transcriptInteraction]);

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
            {structuredResult}
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
