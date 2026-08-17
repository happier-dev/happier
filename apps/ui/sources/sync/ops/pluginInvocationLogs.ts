import {
    DaemonPluginInvocationLogReadRequestV1Schema,
    DaemonPluginInvocationLogReadResponseV1Schema,
    type DaemonPluginInvocationLogReadResponseV1,
    type PluginInvocationLogReadQueryV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/**
 * The selected machine's portable identity is checked by the daemon, while
 * `serverId` is resolved only at the UI routing boundary. Nothing here
 * selects, persists, filters, or retains plugin logs.
 */
export type PluginInvocationLogMachineReadTarget = Readonly<{
    serverId: string;
    serverIdentityId: string;
    machineId: string;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin invocation log read was cancelled');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw createAbortError();
}

function readerUnavailableResponse(): DaemonPluginInvocationLogReadResponseV1 {
    return DaemonPluginInvocationLogReadResponseV1Schema.parse({
        version: 1,
        kind: 'unavailable',
        code: 'plugin_log_reader_unavailable',
    });
}

/**
 * One bounded read through the canonical daemon logger RPC. The daemon owns
 * query semantics, cursor interpretation, identity filtering, and redaction;
 * this UI adapter only preserves the exact target and validates the wire.
 */
export async function readPluginInvocationLogsOnMachine(params: Readonly<{
    target: PluginInvocationLogMachineReadTarget;
    query: PluginInvocationLogReadQueryV1;
    signal?: AbortSignal;
}>): Promise<DaemonPluginInvocationLogReadResponseV1> {
    throwIfAborted(params.signal);
    const payload = DaemonPluginInvocationLogReadRequestV1Schema.parse({
        version: 1,
        target: {
            serverIdentityId: params.target.serverIdentityId,
            machineId: params.target.machineId,
        },
        query: params.query,
    });
    let raw: unknown;
    try {
        raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: params.target.machineId,
            serverId: params.target.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
            payload,
            ...(params.signal ? { signal: params.signal } : {}),
        });
    } catch (error) {
        throwIfAborted(params.signal);
        const rpcErrorCode = readRpcErrorCode(error);
        if (
            rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
        ) {
            return readerUnavailableResponse();
        }
        throw error;
    }
    throwIfAborted(params.signal);
    const response = DaemonPluginInvocationLogReadResponseV1Schema.safeParse(raw);
    if (!response.success) {
        throw new Error('Plugin invocation log response was invalid');
    }
    return response.data;
}
