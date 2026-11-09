import {
    DaemonLocalServiceActionExecuteRequestV1Schema,
    DaemonLocalServiceActionExecuteResponseV1Schema,
} from '@happier-dev/protocol/local/services/actions/v1';
import { isRpcError, isRpcMethodNotFoundError, isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    isLocalServiceActionResultForRequest,
    type LocalServiceActionExecuteClientInput,
    type LocalServiceActionExecuteClientResult,
} from './api';

export async function executeLocalServiceActionViaMachineRpc(
    input: LocalServiceActionExecuteClientInput,
): Promise<LocalServiceActionExecuteClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    const payload = DaemonLocalServiceActionExecuteRequestV1Schema.safeParse(input.request);
    if (!payload.success) {
        return { ok: false, reason: 'invalid_response' };
    }
    try {
        const raw = await machineRpcWithServerScope<unknown, typeof payload.data>({
            machineId: payload.data.target.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            payload: payload.data,
            signal: input.signal,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const failure = readActionFailureEnvelope(raw, { treatReturnedErrorEnvelopeAsFailure: true });
        if (failure) return { ok: false, reason: 'refused', failure };
        const parsed = DaemonLocalServiceActionExecuteResponseV1Schema.safeParse(raw);
        return parsed.success && isLocalServiceActionResultForRequest(parsed.data.result, payload.data)
            ? { ok: true, result: parsed.data.result }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error)) return { ok: false, reason: 'unavailable' };
        if (isRpcError(error)) {
            const failure = readActionFailureEnvelope({ ...error, ok: false, errorCode: error.rpcErrorCode, error: error.message });
            if (failure) return { ok: false, reason: 'refused', failure };
        }
        return { ok: false, reason: 'request_failed' };
    }
}
