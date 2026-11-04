import {
    DaemonComputerActionExecuteRequestV1Schema,
    DaemonComputerActionExecuteResponseV1Schema,
} from '@happier-dev/protocol/computer/v1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';

import type { ComputerMachineRpc } from './runtimeActionExecutor';

/** Shared Use controls and streaming reach the same personal desktop owner. */
export function resolveComputerOwnDesktopOnly(input: Readonly<{ machineId: string; serverId?: string | null }>): boolean {
    const state = readRegisteredStorageState();
    const machine = state ? resolveServerScopedMachine(state, input.serverId, input.machineId) : null;
    return machine?.isShared === true && machine.access?.role === 'use';
}

function refuse(code: string) {
    return { ok: false, errorCode: code, error: code } as const;
}

/**
 * UI→daemon transport for the person's computer controls through the daemon's Computer owner.
 * Shared Use requests name its personal-desktop entry point. The result is the Action's payload or the
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
            method: input.ownDesktopOnly
                ? RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE
                : RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
            payload: payload.data,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    } catch (error) {
        if (input.signal?.aborted) throw error;
        return refuse(readRpcErrorCode(error)
            ?? (isMachineRpcTimeoutError(error) ? MACHINE_RPC_TIMEOUT_ERROR_CODE : 'action_failed'));
    }
    if (isRpcMethodNotFoundResult(raw)) return refuse('computer_unavailable');
    const parsed = DaemonComputerActionExecuteResponseV1Schema.safeParse(raw);
    return parsed.success ? parsed.data.result : refuse('invalid_action_output');
};
