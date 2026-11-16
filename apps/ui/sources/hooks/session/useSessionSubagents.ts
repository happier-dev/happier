import { readSessionRuntimeLostSinceMs, resolveNextSessionRuntimePresentationFreshnessAtMs } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';
import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { deriveSessionSubagentSidechainIds } from '@/sync/domains/session/subagents/sidechains/deriveSessionSubagentSidechainIds';
import type {
    SessionSubagent,
    SessionSubagentActiveExecutionRunState,
} from '@/sync/domains/session/subagents/types';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { useSessionDirectSessionRuntime } from '@/components/sessions/model/useSessionDirectSessionRuntime';
import { useReconciledStableRows } from './reconcileStableRows';
import { useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';

import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';

function buildExecutionRunStateSignature(runs: readonly SessionSubagentActiveExecutionRunState[]): string {
    if (runs.length === 0) return '';
    return runs.map((run) => `${run.runId}\u0000${run.status ?? ''}\u0000${run.runClass ?? ''}\u0000${run.turnInFlight ?? ''}`).join('\u0001');
}

function readSubagentKey(subagent: SessionSubagent): string {
    return subagent.id;
}

function readParticipantTargetKey(target: SessionParticipantTarget): string {
    return target.key;
}

export function useSessionSubagents(params: Readonly<{
    sessionId: string;
    session: Session | null;
    messages: readonly Message[];
    directSessionRuntime?: UseDirectSessionRuntimeResult;
}>): Readonly<{
    subagents: readonly SessionSubagent[];
    runtimeLostSinceMs: number | null;
    participantTargets: ReturnType<typeof deriveSessionSubagentRecipients>;
    sidechainIds: readonly string[];
}> {
    const runtimeNowMs = useSessionListRuntimeNowMs();
    const runtimeLostSinceMs = params.session ? readSessionRuntimeLostSinceMs(params.session, Math.max(runtimeNowMs, Date.now())) : null;
    useSessionListRuntimeWake(params.session ? resolveNextSessionRuntimePresentationFreshnessAtMs(params.session, Math.max(runtimeNowMs, Date.now())) : null);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const sessionFlavor = typeof (params.session as any)?.metadata?.flavor === 'string'
        ? String((params.session as any).metadata.flavor)
        : null;
    // All callers consume the stable projection owned by useSessionSubagentSourceMessages.
    const subagentMessages = params.messages;

    const executionRunPollingEnabled = React.useMemo(() => {
        return shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: executionRunsEnabled,
            messages: subagentMessages,
        });
    }, [executionRunsEnabled, subagentMessages]);

    const executionRunPollingRefreshKey = React.useMemo(() => {
        return deriveExecutionRunPollingRefreshKey(subagentMessages);
    }, [subagentMessages]);

    const runningExecutionRuns = useSessionRunningExecutionRuns({
        sessionId: params.sessionId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const runningExecutionRunsSignature = React.useMemo(
        () => buildExecutionRunStateSignature(runningExecutionRuns),
        [runningExecutionRuns],
    );
    const stableRunningExecutionRuns = useStableValueBySignature(runningExecutionRuns, runningExecutionRunsSignature);
    const internalDirectSessionRuntime = useSessionDirectSessionRuntime({
        sessionId: params.sessionId,
        metadata: params.session?.metadata,
        enabled: params.directSessionRuntime == null,
    });
    const directSessionRuntime = params.directSessionRuntime ?? internalDirectSessionRuntime;

    const derivedSubagents = React.useMemo(() => {
        if (!params.session) return [] as const;
        const derivedSubagents = deriveSessionSubagents({
            session: {
                metadata: sessionFlavor ? { flavor: sessionFlavor } : {},
            },
            messages: subagentMessages,
            runtimeLostSinceMs,
            activeExecutionRuns: stableRunningExecutionRuns,
        });
        return applyExecutionRunControlCapabilities(derivedSubagents, {
            canControlExecutionRuns:
                directSessionRuntime.directSessionLink === null
                || directSessionRuntime.status?.runnerActive === true,
        });
    }, [
        directSessionRuntime.directSessionLink,
        directSessionRuntime.status?.runnerActive,
        params.session != null,
        stableRunningExecutionRuns,
        subagentMessages,
        sessionFlavor,
        runtimeLostSinceMs,
    ]);
    const subagents = useReconciledStableRows(derivedSubagents, readSubagentKey);

    const derivedParticipantTargets = React.useMemo(() => {
        return deriveSessionSubagentRecipients(subagents);
    }, [subagents]);
    const participantTargets = useReconciledStableRows(derivedParticipantTargets, readParticipantTargetKey);

    const derivedSidechainIds = React.useMemo(() => {
        return deriveSessionSubagentSidechainIds(subagents);
    }, [subagents]);
    const sidechainIdsSignature = derivedSidechainIds.join('\0');
    const sidechainIds = useStableValueBySignature(derivedSidechainIds, sidechainIdsSignature);

    return { subagents, runtimeLostSinceMs, participantTargets, sidechainIds };
}
