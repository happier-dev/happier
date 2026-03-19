import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { shouldEnableExecutionRunPolling } from '@/sync/domains/session/participants/shouldEnableExecutionRunPolling';
import { deriveExecutionRunPollingRefreshKey } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { deriveSessionSubagentSidechainIds } from '@/sync/domains/session/subagents/sidechains/deriveSessionSubagentSidechainIds';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDirectSessionRuntime, type UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';

export function useSessionSubagents(params: Readonly<{
    sessionId: string;
    session: Session | null;
    messages: readonly Message[];
    directSessionRuntime?: UseDirectSessionRuntimeResult;
}>): Readonly<{
    subagents: readonly SessionSubagent[];
    participantTargets: ReturnType<typeof deriveSessionSubagentRecipients>;
    sidechainIds: readonly string[];
}> {
    const executionRunsEnabled = useFeatureEnabled('execution.runs');

    const executionRunPollingEnabled = React.useMemo(() => {
        return shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: executionRunsEnabled,
            messages: params.messages,
        });
    }, [executionRunsEnabled, params.messages]);

    const executionRunPollingRefreshKey = React.useMemo(() => {
        return deriveExecutionRunPollingRefreshKey(params.messages);
    }, [params.messages]);

    const runningExecutionRuns = useSessionRunningExecutionRuns({
        sessionId: params.sessionId,
        enabled: executionRunPollingEnabled,
        refreshKey: executionRunPollingRefreshKey,
    });
    const internalDirectSessionRuntime = useDirectSessionRuntime({
        sessionId: params.sessionId,
        metadata: params.session?.metadata,
    });
    const directSessionRuntime = params.directSessionRuntime ?? internalDirectSessionRuntime;

    const subagents = React.useMemo(() => {
        if (!params.session) return [] as const;
        const derivedSubagents = deriveSessionSubagents({
            session: params.session,
            messages: params.messages,
            activeExecutionRuns: runningExecutionRuns,
        });
        return applyExecutionRunControlCapabilities(derivedSubagents, {
            canControlExecutionRuns:
                directSessionRuntime.directSessionLink === null
                || directSessionRuntime.status?.runnerActive === true,
        });
    }, [
        directSessionRuntime.directSessionLink,
        directSessionRuntime.status?.runnerActive,
        params.messages,
        params.session,
        runningExecutionRuns,
    ]);

    const participantTargets = React.useMemo(() => {
        return deriveSessionSubagentRecipients(subagents);
    }, [subagents]);

    const sidechainIds = React.useMemo(() => {
        return deriveSessionSubagentSidechainIds(subagents);
    }, [subagents]);

    return { subagents, participantTargets, sidechainIds };
}
