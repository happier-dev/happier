import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { isAcceptedPendingSessionStop, readSessionStopActionResponse, resolveSessionStopFailureMessage } from '@/components/sessions/sessionStopArchiveFlow';
import { Modal } from '@/modal';
import { isExecutionRunMutationCancelled } from '@/sync/ops/sessionExecutionRuns';
import { t } from '@/text';

function resolveStopFailedTitle(intent: unknown): string {
    switch (intent) {
        case 'review': return t('runPage.stopFailed.title.review');
        case 'plan': return t('runPage.stopFailed.title.plan');
        case 'delegate': return t('runPage.stopFailed.title.delegate');
        default: return t('runPage.stopFailed.title.run');
    }
}

/**
 * A stop the Run's machine did not confirm (agents lab ST "stop didn't go through"). It keeps the
 * existing whole-session fallback, and says its consequence before it happens: stopping the session
 * also stops every other agent live in it. Mounted only while a stop has failed, so the session's
 * activity projection is read only then.
 */
export const ExecutionRunStopFailedState = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
    intent: unknown;
    machineId: string | null;
    machineName: string;
    /** The stop RPC's own failure, for the collapsed Details. */
    diagnostic: string | null;
    onRetry: () => void;
    onSessionStopped: () => void;
}>) => {
    const activity = useSessionAgentActivity({
        sessionId: props.sessionId,
        ...(props.serverId ? { serverId: props.serverId } : {}),
    });
    // `live` counts this Run too while it is still in flight.
    const otherLiveAgents = Math.max(0, activity.counts.live - 1);
    const reason = otherLiveAgents > 0
        ? t('runPage.stopFailed.reasonWithOthers', { machine: props.machineName, count: otherLiveAgents })
        : t('runPage.stopFailed.reasonAlone', { machine: props.machineName });
    const { machineId, sessionId, serverId, onSessionStopped } = props;
    const { execute, isCurrent } = useMountedActionExecution(serverId);

    const stopSession = React.useCallback(async () => {
        if (!machineId || !isCurrent()) return;
        const result = await execute('session.stop', { sessionId });
        if (!isCurrent() || isExecutionRunMutationCancelled(result)) return;
        const response = result.ok ? readSessionStopActionResponse(result.result) : null;
        if (!response || (!response.success && !isAcceptedPendingSessionStop(response))) {
            Modal.alert(t('common.error'), !result.ok ? result.error : response
                ? resolveSessionStopFailureMessage(response, t('runs.stop.failedToStopSession'))
                : t('runs.stop.failedToStopSession'));
            return;
        }
        onSessionStopped();
    }, [execute, isCurrent, machineId, onSessionStopped, sessionId]);

    return (
        <SurfaceStateCard
            testID="session-run-details-stop-failed"
            kind="error"
            iconName="stop"
            title={resolveStopFailedTitle(props.intent)}
            reason={reason}
            diagnosticCode={props.diagnostic}
            action={{ label: t('surfaceState.tryAgain'), onPress: props.onRetry }}
            secondaryAction={machineId ? { label: t('runPage.stopFailed.stopSession'), onPress: stopSession } : undefined}
        />
    );
});
