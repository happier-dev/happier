import * as React from 'react';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm/diffSummary';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useScmDiffSummaryBinding';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useExecutionRunsBackendsForMachine } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import type { ScmWalkthroughRestoration, ScmWalkthroughSelection } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';

/** Exact Machine/checkout adapter. No Session is needed or manufactured. */
export function useWorkspaceScmDiffSummaryBinding(params: Readonly<{
    machineId: string; rootPath: string; serverId: string;
    paneScopeId?: string;
    comparison: SessionScmReviewComparison | null; output: ScmDiffSummaryOutputKind;
    restoration?: ScmWalkthroughRestoration;
    restoreSelections?: readonly ScmWalkthroughSelection[];
}>): ReturnType<typeof useScmDiffSummaryBinding> {
    const owner = useMachinePresenceSummary(params.serverId, params.machineId);
    const machineReachable = owner.reachability === 'reachable';
    const enabled = useFeatureEnabled('execution.runs', { scopeKind: 'spawn', serverId: params.serverId }) === true;
    const backends = useExecutionRunsBackendsForMachine({ machineId: params.machineId, serverId: params.serverId, enabled });
    // The workspace already supplies its exact target. Presence controls writes/launching, not whether
    // a saved-result reader can retain its checkout and attempt an authenticated read.
    const machine = React.useMemo(() => ({ machineId: params.machineId, basePath: params.rootPath }),
        [params.machineId, params.rootPath]);
    const launch = React.useMemo(() => ({ canLaunchExecutionRuns: enabled && machineReachable
        && resolveExecutionRunAvailableBackends(backends, 'scm_diff_summary').length > 0,
        launchUnavailableReason: enabled ? null : 'notEnabled' as const }), [enabled, machineReachable, backends]);
    const comparison = params.comparison?.kind === 'session' || params.comparison?.kind === 'turnCheckpoint' ? null : params.comparison;
    return useScmDiffSummaryBinding({ host: { machineId: params.machineId }, serverId: params.serverId, machine,
        machineReachable, canControl: machineReachable, canSend: machineReachable, launch, comparison, output: params.output,
        restoration: params.restoration, restoreSelections: params.restoreSelections, paneScopeId: params.paneScopeId });
}
