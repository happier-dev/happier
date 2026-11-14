import type { DaemonExecutionRunEntry } from '@happier-dev/protocol/daemon/executionRuns';
import type { MachineExecutionRunsListResult } from '@/sync/ops/machineExecutionRuns';
import { t } from '@/text';

/** Opaque Home-qualified machine identity. Never parse this key. */
export function executionRunMachineAddressKey(serverId: string, machineId: string): string {
    return JSON.stringify([serverId, machineId]);
}

export type RunListUnavailableMachine = Readonly<{
    serverId: string;
    machineId: string;
    reason: 'read_failed' | 'not_read' | 'not_offered';
    error: string | null;
    errorCode: string | null;
}>;

/** Present the producer's typed refusal consistently in a row and the page error. */
export function machineRunReadFailureDetail(errorCode: string | null | undefined, fallback = t('detailPages.runs.machineReadFailed')): string {
    return errorCode === 'RPC_FORBIDDEN' ? t('detailPages.runs.machineNotShared') : fallback;
}

export type MachineRunReadAggregate =
    | Readonly<{ status: 'loaded'; runsByMachineAddressKey: Readonly<Record<string, readonly DaemonExecutionRunEntry[]>>;
        unavailableMachines: readonly RunListUnavailableMachine[] }>
    | Readonly<{ status: 'error'; error: string; unavailableMachines: readonly RunListUnavailableMachine[] }>;

/** A partial registry read replaces only those Machines' coverage, retaining other observed rows and failures. */
export function aggregateMachineRunReads(reads: readonly Readonly<{
    serverId: string;
    machineId: string;
    result: MachineExecutionRunsListResult | undefined;
}>[], previous?: MachineRunReadAggregate): MachineRunReadAggregate {
    const runsByMachineAddressKey: Record<string, readonly DaemonExecutionRunEntry[]> = {
        ...(previous?.status === 'loaded' ? previous.runsByMachineAddressKey : {}),
    };
    const changedKeys = new Set(reads.map(({ serverId, machineId }) => executionRunMachineAddressKey(serverId, machineId)));
    for (const key of changedKeys) delete runsByMachineAddressKey[key];
    const unavailableMachines = (previous?.unavailableMachines ?? []).filter(machine =>
        !changedKeys.has(executionRunMachineAddressKey(machine.serverId, machine.machineId)));
    for (const { serverId, machineId, result } of reads) {
        if (result?.ok) {
            runsByMachineAddressKey[executionRunMachineAddressKey(serverId, machineId)] = result.runs;
        } else {
            unavailableMachines.push({ serverId, machineId,
                reason: result && 'notOffered' in result && result.notOffered ? 'not_offered' : result ? 'read_failed' : 'not_read',
                error: result?.error ?? null, errorCode: result?.errorCode ?? null });
        }
    }
    const firstFailure = unavailableMachines.find(machine => machine.reason === 'read_failed');
    return firstFailure && Object.keys(runsByMachineAddressKey).length === 0
        ? { status: 'error', error: machineRunReadFailureDetail(firstFailure.errorCode, firstFailure.error ?? t('runs.failedToLoad')), unavailableMachines }
        : { status: 'loaded', runsByMachineAddressKey, unavailableMachines };
}

/** Filters one Machine's observed rows without changing the execution-run owner. */
export function selectMachineRunsForPresentation(input: Readonly<{
    runs: readonly DaemonExecutionRunEntry[] | undefined;
    showFinished: boolean;
    requestedRunId: string | null;
}>): readonly DaemonExecutionRunEntry[] | null {
    if (input.runs === undefined) return null;
    const rawRuns = input.runs;
    const visibleByStatus = input.showFinished ? rawRuns : rawRuns.filter(run => run.status === 'running');
    return input.requestedRunId === null
        ? visibleByStatus
        : visibleByStatus.filter(run => run.runId === input.requestedRunId);
}

export type RunListPresentationSummary = Readonly<{
    emptyState: 'empty' | 'unknown' | null;
    unknownMachineCount: number;
}>;

/** One page-level state; a missing Machine read never confirms an empty list. */
export function summarizeRunListPresentation(
    machineRuns: readonly (readonly DaemonExecutionRunEntry[] | null)[],
): RunListPresentationSummary {
    let unknownMachineCount = 0;
    let hasVisibleRuns = false;
    for (const runs of machineRuns) {
        if (runs === null) unknownMachineCount += 1;
        else if (runs.length > 0) hasVisibleRuns = true;
    }
    return {
        emptyState: machineRuns.length === 0 || hasVisibleRuns ? null : unknownMachineCount > 0 ? 'unknown' : 'empty',
        unknownMachineCount,
    };
}

/** A daemon Run's process facts as its row states them: pid, then CPU and memory when the daemon measured them. */
export function formatDaemonRunProcessFacts(run: DaemonExecutionRunEntry): string {
    const parts: string[] = [t('runs.detail.pid', { pid: run.pid })];
    const process = run.process;
    if (typeof process?.cpu === 'number' && Number.isFinite(process.cpu)) {
        parts.push(t('runs.detail.cpu', { percent: process.cpu.toFixed(1) }));
    }
    if (typeof process?.memory === 'number' && Number.isFinite(process.memory)) {
        parts.push(t('runs.detail.memory', { megabytes: Math.round(process.memory / (1024 * 1024)) }));
    }
    return parts.join(' · ');
}
