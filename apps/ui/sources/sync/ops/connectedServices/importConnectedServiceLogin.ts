import {
    ConnectedServiceImportParamsSchema,
    CONNECTED_SERVICE_IMPORT_TIMEOUT_MS,
    ConnectedServiceImportResultSchema,
    RPC_ERROR_CODES,
    RPC_METHODS,
    readRpcErrorCode,
    isRpcMethodNotFoundResult,
    type ConnectedServiceImportParams,
    type ConnectedServiceImportResult,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/** Imports on the selected machine; only the stored profile outcome crosses the RPC. */
/** Imports from the chosen machine on the captured relay with a shared RPC/provider deadline and validated status-only result. */
export async function importConnectedServiceLogin(params: Readonly<{
    serverId: string;
    machineId: string;
    request: ConnectedServiceImportParams;
}>): Promise<ConnectedServiceImportResult> {
    const unsupported = { success: false, errorCode: 'unsupported', error: 'Machine update required' } as const;
    let issued = false;
    try {
        const raw = await machineRpcWithServerScope<unknown, ConnectedServiceImportParams>({
            serverId: params.serverId,
            machineId: params.machineId,
            method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_IMPORT,
            payload: ConnectedServiceImportParamsSchema.parse({ ...params.request, deadlineAtMs: Date.now() + CONNECTED_SERVICE_IMPORT_TIMEOUT_MS }),
            timeoutMs: CONNECTED_SERVICE_IMPORT_TIMEOUT_MS + 15_000,
            // Once emitted, an import must not be replayed through a fallback socket.
            onIssued: () => { issued = true; },
        });
        if (isRpcMethodNotFoundResult(raw)) return unsupported;
        const result = ConnectedServiceImportResultSchema.parse(raw);
        if (result.success && (result.serviceId !== params.request.serviceId || result.profileId !== params.request.profileId)) {
            throw new Error('Connected login import returned a different profile');
        }
        return result;
    } catch (error) {
        if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return unsupported;
        if (issued) return { success: false, errorCode: 'storage_result_unknown', error: 'The import result is unknown. Refresh the profile before retrying.' };
        throw error;
    }
}
