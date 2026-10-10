import {
    DaemonComputerActionExecuteRequestV1Schema,
    DaemonComputerActionExecuteResponseV1Schema,
} from '@happier-dev/protocol/computer/v1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import type { ComputerMachineRpc } from './runtimeActionExecutor';

function refuse(code: string) {
    return { ok: false, errorCode: code, error: code } as const;
}

/**
 * UI→daemon transport for the person's computer controls: the owner-scoped machine RPC to the daemon's
 * one computer owner (`daemon.computer.actions.execute`). The result is the Action's own payload or the
 * owner's refusal envelope; the front door validates the payload against the Action's output schema.
 */
export const executeComputerActionViaMachineRpc: ComputerMachineRpc = async (input) => {
    const payload = DaemonComputerActionExecuteRequestV1Schema.safeParse({
        sessionId: input.sessionId,
        actionId: input.actionId,
        input: input.input,
    });
    if (!payload.success) return refuse('invalid_parameters');
    let raw: unknown;
    try {
        raw = await machineRpcWithServerScope<unknown, typeof payload.data>({
            machineId: input.machineId,
            ...(input.serverId ? { serverId: input.serverId } : {}),
            ...(input.accountId ? { accountId: input.accountId } : {}),
            method: RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
            payload: payload.data,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    } catch (error) {
        if (input.signal?.aborted) throw error;
        return refuse('machine_unreachable');
    }
    if (isRpcMethodNotFoundResult(raw)) return refuse('computer_unavailable');
    const parsed = DaemonComputerActionExecuteResponseV1Schema.safeParse(raw);
    return parsed.success ? parsed.data.result : refuse('invalid_action_output');
};
