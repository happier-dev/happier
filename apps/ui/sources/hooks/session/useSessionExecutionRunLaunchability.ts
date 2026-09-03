import * as React from 'react';

import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { useSessionDirectSessionRuntime } from '@/components/sessions/model/useSessionDirectSessionRuntime';
import { canLaunchExecutionRunsForSession } from '@/sync/domains/executionRuns/canLaunchExecutionRunsForSession';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSettings } from '@/sync/domains/state/storage';

export type UseSessionExecutionRunLaunchabilityResult = Readonly<{
    canLaunchExecutionRuns: boolean;
    canShowExecutionRunLauncher: boolean;
    executionRunsBackends: Record<string, unknown> | null | undefined;
    executionRunsSupported: boolean;
}>;

export function useSessionExecutionRunLaunchability(
    sessionId: string,
    session: Session | null | undefined,
): UseSessionExecutionRunLaunchabilityResult {
    const settings = useSettings();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const executionRunsSupported = useSessionExecutionRunsSupported(sessionId);
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId);
    const { machineReachable } = useSessionMachineReachability(sessionId);
    const machineTarget = useSessionMachineTarget(sessionId);
    const directSessionRuntime = useSessionDirectSessionRuntime({
        sessionId,
        metadata: session?.metadata,
    });
    const agentId = React.useMemo(
        () => resolveAgentIdFromFlavor(session?.metadata?.flavor) ?? DEFAULT_AGENT_ID,
        [session?.metadata?.flavor],
    );
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: machineTarget?.machineId ?? resolveSessionMachineId(session?.metadata),
        settings,
        enabled: session?.active === false,
    });
    const allowWhileInactive = React.useMemo(() => {
        if (session?.active !== false) return false;
        if (session.resumingAt != null) return false;
        if (!machineReachable) return false;
        return canResumeSessionWithOptions(session?.metadata, resumeCapabilityOptions);
    }, [machineReachable, resumeCapabilityOptions, session?.active, session?.metadata, session?.resumingAt]);

    const canShowExecutionRunLauncher = React.useMemo(() => {
        if (executionRunsEnabled !== true) {
            return false;
        }
        if (session?.active === false && allowWhileInactive !== true) {
            return false;
        }
        if (directSessionRuntime.directSessionLink !== null && directSessionRuntime.status?.runnerActive !== true) {
            return false;
        }
        return true;
    }, [
        allowWhileInactive,
        directSessionRuntime.directSessionLink,
        directSessionRuntime.status?.runnerActive,
        executionRunsEnabled,
        session?.active,
    ]);

    const canLaunchExecutionRuns = React.useMemo(() => canLaunchExecutionRunsForSession({
        session,
        executionRunsSupported,
        executionRunsBackends,
        allowWhileInactive,
        hasDirectSessionLink: directSessionRuntime.directSessionLink !== null,
        directSessionRunnerActive: directSessionRuntime.status?.runnerActive,
    }), [
        allowWhileInactive,
        directSessionRuntime.directSessionLink,
        directSessionRuntime.status?.runnerActive,
        executionRunsBackends,
        executionRunsSupported,
        session,
    ]);

    return {
        canLaunchExecutionRuns,
        canShowExecutionRunLauncher,
        executionRunsBackends,
        executionRunsSupported,
    };
}
