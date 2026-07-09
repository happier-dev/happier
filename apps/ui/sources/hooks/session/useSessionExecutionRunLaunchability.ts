import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { useSessionExternalSessionRuntime } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { canLaunchExecutionRunsForSession } from '@/sync/domains/executionRuns/canLaunchExecutionRunsForSession';
import type { ExecutionRunBackendCapabilityMap } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSettings } from '@/sync/domains/state/storage';

export type UseSessionExecutionRunLaunchabilityResult = Readonly<{
    canLaunchExecutionRuns: boolean;
    canShowExecutionRunLauncher: boolean;
    executionRunsBackends: ExecutionRunBackendCapabilityMap;
    executionRunsSupported: boolean;
    sessionServerId: string | null;
}>;

export function useSessionExecutionRunLaunchability(
    sessionId: string,
    session: Session | null | undefined,
): UseSessionExecutionRunLaunchabilityResult {
    const settings = useSettings();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const sessionTargetServerId = usePreferredServerIdForSession(sessionId, session?.serverId);
    const executionRunsSupported = useSessionExecutionRunsSupported(sessionId, sessionTargetServerId);
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId, sessionTargetServerId);
    const { machineReachable } = useSessionMachineReachability(sessionId);
    const machineTarget = useSessionMachineTarget(sessionId);
    const externalSessionRuntime = useSessionExternalSessionRuntime({
        sessionId,
        metadata: session?.metadata,
    });
    const agentId = React.useMemo(
        () => resolveAgentIdFromSessionMetadata(session?.metadata) ?? DEFAULT_AGENT_ID,
        [session?.metadata],
    );
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: machineTarget?.machineId ?? resolveSessionMachineId(session?.metadata),
        settings,
        enabled: session?.active === false,
    });
    const allowWhileInactive = React.useMemo(() => {
        if (session?.active !== false) return false;
        if (!machineReachable) return false;
        return canResumeSessionWithOptions(session?.metadata, resumeCapabilityOptions);
    }, [machineReachable, resumeCapabilityOptions, session?.active, session?.metadata]);

    const canShowExecutionRunLauncher = React.useMemo(() => {
        if (executionRunsEnabled !== true) {
            return false;
        }
        if (session?.active === false && allowWhileInactive !== true) {
            return false;
        }
        if (externalSessionRuntime.externalSessionLink !== null && externalSessionRuntime.status?.runnerActive !== true) {
            return false;
        }
        return true;
    }, [
        allowWhileInactive,
        externalSessionRuntime.externalSessionLink,
        externalSessionRuntime.status?.runnerActive,
        executionRunsEnabled,
        session?.active,
    ]);

    const canLaunchExecutionRuns = React.useMemo(() => canLaunchExecutionRunsForSession({
        session,
        executionRunsSupported,
        executionRunsBackends,
        allowWhileInactive,
        hasExternalSessionLink: externalSessionRuntime.externalSessionLink !== null,
        externalSessionRunnerActive: externalSessionRuntime.status?.runnerActive,
    }), [
        allowWhileInactive,
        externalSessionRuntime.externalSessionLink,
        externalSessionRuntime.status?.runnerActive,
        executionRunsBackends,
        executionRunsSupported,
        session,
    ]);

    return {
        canLaunchExecutionRuns,
        canShowExecutionRunLauncher,
        executionRunsBackends,
        executionRunsSupported,
        sessionServerId: sessionTargetServerId,
    };
}
