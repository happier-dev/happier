import type { DaemonExecutionRunEntry, DaemonExecutionRunListResponse } from '@happier-dev/protocol/daemon/executionRuns';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

let actionExecute: FrontDoorActionExecute | undefined;

export type MachineExecutionRunsListResult =
    | { ok: true; runs: readonly DaemonExecutionRunEntry[] }
    | { ok: false; error: string; errorCode?: string };

export async function machineExecutionRunsList(
    machineId: string,
    opts?: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>,
): Promise<MachineExecutionRunsListResult> {
    try {
        if (!actionExecute) actionExecute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
        const outcome = await actionExecute('machines.runs.list', {
            machineId, ...(opts?.serverId ? { serverId: opts.serverId } : {}),
        }, {
            surface: 'ui', ...(opts?.serverId ? { serverId: opts.serverId } : {}),
            ...(opts?.accountId ? { expectedAccountId: opts.accountId } : {}),
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        if (!outcome.ok) return { ok: false, error: outcome.error, errorCode: outcome.errorCode };
        // The Action executor has validated the published output schema.
        return { ok: true, runs: (outcome.result as DaemonExecutionRunListResponse).runs };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

