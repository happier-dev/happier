import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type MachineExecutionRunsListResult =
    | { ok: true; runs: readonly DaemonExecutionRunEntry[] }
    | { ok: false; error: string; errorCode?: string };

export async function machineExecutionRunsList(
    machineId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<MachineExecutionRunsListResult> {
    try {
        const response = await machineRpcWithServerScope<unknown, {}>({
            machineId,
            serverId: opts?.serverId,
            method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST,
            payload: {},
        });
        if (!response || typeof response !== 'object' || !Array.isArray((response as any).runs)) {
            return { ok: false, error: 'Unsupported response from machine RPC' };
        }
        return { ok: true, runs: (response as any).runs ?? [] };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

