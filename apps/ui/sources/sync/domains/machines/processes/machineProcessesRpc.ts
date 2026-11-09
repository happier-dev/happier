import { MachineProcessesAnswerV1Schema, MachineProcessesListInputV1Schema, MachineProcessesWatchInputV1Schema,
    MachineProcessesWatchResultV1Schema, type MachineProcessesAnswerV1, type MachineProcessesWatchResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { projectMachineDaemonRpcFailure, type MachineDaemonRpcFailure } from '../machineDaemonRpcErrors';

export type MachineProcessesKey = Readonly<{ serverId?: string | null; machineId: string; scope: 'happier' | 'all'; view: 'tree' | 'owners'; detailToken?: string;
    /** Captured credential/cache scope; never caller authority or an RPC payload field. */
    accountId?: string }>;
export type MachineProcessesReadInput = MachineProcessesKey & Readonly<{ signal?: AbortSignal }>;
export type MachineProcessesWatchInput = MachineProcessesReadInput & Readonly<{ since?: number; historySince?: number }>;
export type MachineProcessesRpcResult<T> = Readonly<{ ok: true; value: T }> | MachineDaemonRpcFailure;

let actionExecute: FrontDoorActionExecute | undefined;
async function read<T>(input: MachineProcessesReadInput, request: () => Promise<unknown>,
    parse: (raw: unknown) => { success: true; data: T } | { success: false }): Promise<MachineProcessesRpcResult<T>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const raw = await request();
        if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (isRpcMethodNotFoundResult(raw)) return { ok: false, reason: 'older_happier' };
        const parsed = parse(raw);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return projectMachineDaemonRpcFailure(error);
    }
}
export function fetchMachineProcessesViaMachineRpc(input: MachineProcessesReadInput): Promise<MachineProcessesRpcResult<MachineProcessesAnswerV1>> {
    // Detail demand is part of the watch; a plain read never samples or invents history.
    const payload = MachineProcessesListInputV1Schema.parse({ machineId: input.machineId, scope: input.scope, view: input.view });
    return read(input, async () => {
        if (!actionExecute) actionExecute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
        const outcome = await actionExecute('machines.processes.list', { ...payload, ...(input.serverId ? { serverId: input.serverId } : {}) }, {
            surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}),
            ...(input.accountId ? { expectedAccountId: input.accountId } : {}), ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!outcome.ok) throw createRpcCallError({ error: outcome.error, errorCode: outcome.errorCode, failureCause: outcome.failureCause });
        return outcome.result;
    }, raw => MachineProcessesAnswerV1Schema.safeParse(raw));
}
export function watchMachineProcessesViaMachineRpc(input: MachineProcessesWatchInput): Promise<MachineProcessesRpcResult<MachineProcessesWatchResultV1>> {
    const payload = MachineProcessesWatchInputV1Schema.parse({ machineId: input.machineId, scope: input.scope, view: input.view,
        ...(input.since === undefined ? {} : { since: input.since }), ...(input.historySince === undefined ? {} : { historySince: input.historySince }), ...(input.detailToken ? { detailToken: input.detailToken } : {}) });
    return read(input, () => machineRpcWithServerScope({ machineId: input.machineId, serverId: input.serverId,
        accountId: input.accountId, method: RPC_METHODS.DAEMON_PROCESSES_WATCH, payload,
        ...(input.signal ? { signal: input.signal } : {}) }),
    raw => MachineProcessesWatchResultV1Schema.safeParse(raw));
}
