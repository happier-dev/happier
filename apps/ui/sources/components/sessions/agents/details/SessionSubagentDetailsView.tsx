import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionSubagentOverviewCard } from '@/components/sessions/agents/details/SessionSubagentOverviewCard';
import { SessionSubagentTranscriptBody } from '@/components/sessions/agents/details/SessionSubagentTranscriptBody';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { SessionExecutionRunDetailsView } from '@/components/sessions/runs/details/SessionExecutionRunDetailsView';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { useMessage, useResolvedSessionMessageRouteId, useSessionTranscriptLoaded } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        gap: 12,
    },
}));

export const SessionSubagentDetailsView = React.memo((props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    scopeId: string;
    subagentId: string;
}>) => {
    const styles = stylesheet;
    const session = useSessionViewShellSession(props.sessionId, props.serverId);
    const { subagents, entries } = useSessionAgentActivityRoster({
        sessionId: props.sessionId,
        serverId: props.serverId ?? session?.serverId,
        session,
    });
    const messagesLoaded = useSessionTranscriptLoaded(props.sessionId);

    const subagent = React.useMemo(() => {
        return subagents.find((candidate) => candidate.id === props.subagentId) ?? null;
    }, [props.subagentId, subagents]);

    const entry = React.useMemo(
        () => entries.find((candidate) => candidate.subagentId === props.subagentId) ?? null,
        [entries, props.subagentId],
    );

    const routeMessageId = subagent?.transcript.toolMessageRouteId ?? '';
    const resolvedMessageId = useResolvedSessionMessageRouteId(props.sessionId, routeMessageId);
    const message = useMessage(props.sessionId, resolvedMessageId ?? routeMessageId);
    const transcriptInteraction = React.useMemo(() => {
        if (!session) return { canSendMessages: false } as const;
        return deriveTranscriptInteractionFromSession({
            access: session.access,
            active: session.active,
            presence: session.presence,
        });
    }, [session]);

    if (!session || !subagent || !entry) {
        return (
            session && !messagesLoaded ? (
                <SurfaceStateCard testID="session-subagent-details-loading" kind="loading" title={t('common.loading')} />
            ) : (
                <SurfaceStateCard
                    testID="session-subagent-details-unavailable"
                    kind="unavailable"
                    title={t('session.subagents.details.unavailable')}
                />
            )
        );
    }

    // An execution-run participant has one canonical Details surface, and that
    // surface already owns the run's header, transcript, exact-target pending rows,
    // stop control and — when the run's own interaction projection permits it — the
    // standard Agent composer. Wrapping it in a second overview + composer shell put
    // two independent composers on one run.
    if (subagent.kind === 'execution_run' && subagent.runRef?.runId) {
        return (
            <View style={styles.container}>
                <SessionExecutionRunDetailsView
                    sessionId={props.sessionId}
                    serverId={props.serverId ?? session.serverId}
                    runId={subagent.runRef.runId}
                    presentation="panel"
                    openingTitle={entry.title}
                />
            </View>
        );
    }

    // Every remaining participant is an Agent-team member or tool participant, whose
    // delivery is the parent Session's own. Run delivery selection belongs to the Run
    // Details surface reached above, not to a chip duplicated here.
    const canShowComposer = subagent.capabilities.canSend && subagent.recipient !== null && subagent.status === 'running';

    return (
        <View style={styles.container}>
            <SessionSubagentOverviewCard subagent={subagent} entry={entry} />
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
                    serverId={props.serverId ?? session.serverId}
                    canSendMessages={transcriptInteraction.canSendMessages}
                    recipient={subagent.recipient}
                />
            ) : null}
        </View>
    );
});
