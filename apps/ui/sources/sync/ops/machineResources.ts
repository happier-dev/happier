import { DaemonResourcesGetResponseSchema, type MachineResourcesSnapshot } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type MachineResourcesGetResult =
    | { ok: true; snapshot: MachineResourcesSnapshot }
    | { ok: false; error: string; errorCode?: string };

export async function machineResourcesGet(
    machineId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<MachineResourcesGetResult> {
    try {
        const response = await machineRpcWithServerScope<unknown, {}>({
            machineId,
            serverId: opts?.serverId,
            method: RPC_METHODS.DAEMON_RESOURCES_GET,
            payload: {},
        });
        const parsed = DaemonResourcesGetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { ok: false, error: 'Unsupported response from machine RPC' };
        }
        if (!parsed.data.ok) {
            return { ok: false, error: parsed.data.error, errorCode: parsed.data.errorCode };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
