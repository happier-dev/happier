import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';

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
import { getStorage, useSettingsSelector } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/**
 * Why the launcher is hidden, in the same order the launcher decision checks it. Surfaces say this
 * instead of silently hiding the way to start an agent (agents lab ST "Can't start here").
 */
export type SessionExecutionRunLaunchUnavailableReason =
    | 'notEnabled'
    | 'machineOffline'
    | 'sessionInactive'
    | 'externalRunnerInactive';

export type UseSessionExecutionRunLaunchabilityResult = Readonly<{
    canLaunchExecutionRuns: boolean;
    canShowExecutionRunLauncher: boolean;
    /** `null` exactly when `canShowExecutionRunLauncher` is true. */
    launchUnavailableReason: SessionExecutionRunLaunchUnavailableReason | null;
    executionRunsBackends: ExecutionRunBackendCapabilityMap;
    executionRunsSupported: boolean;
    sessionServerId: string | null;
}>;

export function useSessionExecutionRunLaunchability(
    sessionId: string,
    session: Session | null | undefined,
    explicitServerId?: string | null,
): UseSessionExecutionRunLaunchabilityResult {
    const normalizedExplicitServerId = typeof explicitServerId === 'string' && explicitServerId.trim().length > 0
        ? explicitServerId.trim()
        : null;
    const preferredServerId = usePreferredServerIdForSession({
        serverId: normalizedExplicitServerId ?? session?.serverId,
        sessionId,
    });
    const sessionTargetServerId = preferredServerId;
    const scopedSession = normalizedExplicitServerId && session?.serverId
        && !areServerProfileIdentifiersEquivalent(session.serverId, sessionTargetServerId)
        ? null
        : session;
    // Settings affect resume admission only for inactive Sessions. Active
    // launchers must not subscribe to unrelated Account preference changes.
    const resumeSettings = useSettingsSelector(React.useCallback(
        (settings) => scopedSession?.active === false ? settings : null,
        [scopedSession?.active],
    ));
    const executionRunsEnabled = useFeatureEnabled(
        'execution.runs',
        sessionTargetServerId ? { scopeKind: 'spawn', serverId: sessionTargetServerId } : undefined,
    );
    const executionRunsSupported = useSessionExecutionRunsSupported(sessionId, sessionTargetServerId);
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId, sessionTargetServerId);
    const { machineReachable } = useSessionMachineReachability(sessionId, sessionTargetServerId);
    const machineTarget = useSessionMachineTarget(sessionId, sessionTargetServerId);
    const ownerMetadata = scopedSession ? readSessionOwnerMetadataView(scopedSession) : null;
    const externalSessionRuntime = useSessionExternalSessionRuntime({
        sessionId,
        metadata: ownerMetadata,
        serverId: sessionTargetServerId,
    });
    // A Session whose Agent identity cannot be read must not borrow the default
    // Agent's resume capabilities; the hook already treats a null id as "no
    // current declaration" and fails the launcher closed.
    const agentId = React.useMemo(
        () => resolveAgentIdFromSessionMetadata(ownerMetadata),
        [ownerMetadata],
    );
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: machineTarget?.machineId ?? resolveSessionMachineId(ownerMetadata),
        serverId: sessionTargetServerId,
        settings: resumeSettings ?? getStorage().getState().settings,
        enabled: scopedSession?.active === false,
    });
    const allowWhileInactive = React.useMemo(() => {
        if (scopedSession?.active !== false) return false;
        if (!machineReachable) return false;
        return canResumeSessionWithOptions(ownerMetadata, resumeCapabilityOptions);
    }, [machineReachable, ownerMetadata, resumeCapabilityOptions, scopedSession?.active]);

    const launchUnavailableReason = React.useMemo((): SessionExecutionRunLaunchUnavailableReason | null => {
        if (executionRunsEnabled !== true) {
            return 'notEnabled';
        }
        if (scopedSession?.active === false && allowWhileInactive !== true) {
            // An inactive Session starts agents by resuming, which needs its Machine.
            return machineReachable ? 'sessionInactive' : 'machineOffline';
        }
        if (externalSessionRuntime.externalSessionLink !== null && externalSessionRuntime.status?.runnerActive !== true) {
            return 'externalRunnerInactive';
        }
        return null;
    }, [
        allowWhileInactive,
        externalSessionRuntime.externalSessionLink,
        externalSessionRuntime.status?.runnerActive,
        executionRunsEnabled,
        machineReachable,
        scopedSession?.active,
    ]);
    const canShowExecutionRunLauncher = launchUnavailableReason === null;

    const canLaunchExecutionRuns = React.useMemo(() => canLaunchExecutionRunsForSession({
        session: scopedSession,
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
        scopedSession,
    ]);

    return {
        canLaunchExecutionRuns,
        canShowExecutionRunLauncher,
        launchUnavailableReason,
        executionRunsBackends,
        executionRunsSupported,
        sessionServerId: sessionTargetServerId,
    };
}
