import * as React from 'react';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useScmDiffSummaryBinding';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForMachine } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

/** Exact Machine/checkout adapter. No Session is needed or manufactured. */
export function useWorkspaceScmDiffSummaryBinding(params: Readonly<{
    machineId: string; rootPath: string; serverId: string;
    comparison: SessionScmReviewComparison | null; output: ScmDiffSummaryOutputKind;
}>) {
    const owner = useMachinePresenceSummary(params.serverId, params.machineId);
    const machineKnown = owner.reachability !== 'unknown';
    const machineReachable = owner.reachability === 'reachable';
    const enabled = useFeatureEnabled('execution.runs', { scopeKind: 'spawn', serverId: params.serverId }) === true;
    const backends = useExecutionRunsBackendsForMachine({ machineId: params.machineId, serverId: params.serverId, enabled });
    const machine = React.useMemo(() => machineKnown ? { machineId: params.machineId, basePath: params.rootPath } : null,
        [machineKnown, params.machineId, params.rootPath]);
    const launch = React.useMemo(() => ({ canLaunchExecutionRuns: enabled && machineReachable
        && resolveExecutionRunAvailableBackends(backends, 'scm_diff_summary').length > 0 }), [enabled, machineReachable, backends]);
    const comparison = params.comparison?.kind === 'session' || params.comparison?.kind === 'turnCheckpoint' ? null : params.comparison;
    return useScmDiffSummaryBinding({ host: { machineId: params.machineId }, serverId: params.serverId, machine,
        machineReachable, canControl: machineReachable, canSend: machineReachable, launch, comparison, output: params.output });
}
