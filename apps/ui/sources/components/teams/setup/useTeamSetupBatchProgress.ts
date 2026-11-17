import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';

import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';

import type { TeamSetupBatch } from './useTeamSetupPlan';
import type { TeamSetupOwnerResult } from './teamSetupPlan';
import { useTeamSetupRepositoryProgress, type TeamSetupRepositoryProgress } from './useTeamSetupRepositoryProgress';

export type TeamSetupRepositoryPhase = 'queued' | 'opening' | 'prepared' | 'ready' | 'approval' | 'failed' | 'stopped' | 'unavailable';

export type TeamSetupBatchRepositoryProgress = Readonly<{
    team: TeamSetupBatch['selection']['team'];
    target: TeamSetupBatch['selection']['target'];
    source: TeamSetupBatch['selection']['repositories'][number]['source'];
    requestId: string;
    queued: boolean;
    dispatched: boolean;
    running: boolean;
    settlement: TeamSetupBatch['settlement'];
    progress: TeamSetupRepositoryProgress;
    ready: boolean;
    phase: TeamSetupRepositoryPhase;
}>;

function readPhase(batch: TeamSetupBatch, dispatched: boolean,
    progress: TeamSetupRepositoryProgress, ownerResult: TeamSetupOwnerResult<OpenProjectResultV1> | null,
    ready: boolean): TeamSetupRepositoryPhase {
    if (!dispatched) {
        if (batch.running) return 'queued';
        const machine = batch.settlement?.machine;
        if (machine && !machine.ok || batch.settlement?.machineSettlement) return 'failed';
        if (machine?.ok && ActionApprovalRequestCreatedResultSchema.safeParse(machine.result).success) return 'approval';
        return 'stopped';
    }
    if (ready) return 'ready';
    const operation = progress.setupOperation ?? progress.openOperation;
    if (operation) {
        const status = resolveActionOperationStatus(operation.snapshot, operation.observation);
        if (status.label.kind === 'host') {
            switch (status.label.value) {
                case 'failed': return 'failed';
                case 'cancelled': return 'stopped';
                case 'needs_review': return 'approval';
                case 'unavailable': case 'reconnecting': case 'outcome_uncertain': return 'unavailable';
            }
        }
    }
    if (ownerResult && !ownerResult.ok) return 'failed';
    if (ownerResult?.ok && ActionApprovalRequestCreatedResultSchema.safeParse(ownerResult.result).success) return 'approval';
    const result = progress.result ?? (ownerResult?.ok && 'kind' in ownerResult.result ? ownerResult.result : null);
    if (result?.kind === 'refused') return 'failed';
    if (result?.kind === 'outcomeUnknown') return 'unavailable';
    if (result?.kind === 'ambiguous') return 'stopped';
    if (!progress.setupOperation && result?.kind === 'opened') {
        if (result.setup === 'approvalRequired') return 'approval';
        if (result.setup === 'failed') return 'failed';
        if (result.setup === 'prepared') return 'prepared';
    }
    return operation || batch.running ? 'opening' : 'unavailable';
}

/** Mount beside the retained controller. Initial or recovered completion never replays the live ready moment. */
export function useTeamSetupBatchProgress(
    batch: TeamSetupBatch | null,
    sourceId: string,
    onReady?: (repository: TeamSetupBatchRepositoryProgress) => void,
): TeamSetupBatchRepositoryProgress | null {
    const row = batch?.selection.repositories.find(repository => repository.source.id === sourceId);
    const dispatched = !!(batch && row && batch.dispatched.has(row.repositoryId));
    const progress = useTeamSetupRepositoryProgress({
        serverId: batch?.selection.target.serverId ?? null,
        accountId: batch?.selection.lifetime.scope.accountId ?? null,
        machineId: dispatched ? batch?.selection.target.machineId ?? null : null,
        sourceId: row?.source.id ?? null,
        requestId: row?.requestId,
    }, batch?.selection.lifetime ?? null);
    const ownerResult = batch?.settlement?.repositories.find(repository => repository.id === row?.repositoryId)?.result ?? null;
    const returnedOpen = ownerResult?.ok && ownerResult.result.kind === 'opened' ? ownerResult.result : null;
    const opened = progress.result?.kind === 'opened' ? progress.result : returnedOpen;
    const openSucceeded = progress.openOperation?.snapshot.state === 'succeeded' || (!progress.openOperation && !!returnedOpen);
    const ready = openSucceeded && !!opened
        && (opened.setup === 'notRequired' || progress.setupOperation?.snapshot.state === 'succeeded');
    const observation = (progress.setupOperation ?? progress.openOperation)?.observation;
    const value = React.useMemo<TeamSetupBatchRepositoryProgress | null>(() => batch && row ? {
        team: batch.selection.team, target: batch.selection.target, source: row.source, requestId: row.requestId,
        queued: batch.running && !dispatched, dispatched, running: batch.running, settlement: batch.settlement, progress, ready,
        phase: readPhase(batch, dispatched, progress, ownerResult, ready),
    } : null, [batch?.selection, batch?.running, batch?.settlement, row, dispatched, progress, ownerResult, ready]);
    const active = (progress.setupOperation ?? progress.openOperation)?.snapshot;
    const previous = React.useRef<Readonly<{ requestId: string; ready: boolean; sawActive: boolean; dispatched: boolean }> | null | undefined>(undefined);
    React.useEffect(() => {
        const before = previous.current;
        const sameRequest = before?.requestId === value?.requestId;
        const locallyDispatched = before !== undefined && dispatched && (!sameRequest || !before?.dispatched);
        const connected = observation !== 'reconnecting' && observation !== 'unavailable';
        const sawActive = connected && (locallyDispatched || !!(sameRequest && before?.sawActive)
            || !!(observation === 'available' && active && !isActionOperationTerminal(active.state)));
        previous.current = value ? { requestId: value.requestId, ready, sawActive: !ready && sawActive, dispatched } : null;
        if (value && ready && sawActive && (!sameRequest || !before?.ready)
            && (observation === 'available' || !active && returnedOpen)) onReady?.(value);
    }, [value, ready, observation, active, dispatched, returnedOpen, onReady]);
    return value;
}
