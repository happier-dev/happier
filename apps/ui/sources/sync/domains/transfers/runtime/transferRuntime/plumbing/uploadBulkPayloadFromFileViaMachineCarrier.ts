import {
    type DirectTransferImportFinalizeResponse,
    type DirectTransferImportOpenRequest,
} from './directTransferImportClient';
import {
    uploadBulkPayloadFromFileViaDirectImport,
    type TransferFinalizeRecoveryFailure,
} from './directTransferImportUpload';
import type {
    BulkTransferFailureResponse,
    BulkTransferFileReader,
} from './uploadBulkPayloadFromFile';
import { resolveMachineCarrierRoute } from './machineCarrierHttpLease';
import { captureFilesystemTransferAccountScope } from './filesystemTransferAccountScope';
import { isTransferFinalizeRecoveryFailure } from './directTransferFinalizeRecovery';

function toDirectFailure(error: unknown): BulkTransferFailureResponse {
    return {
        success: false,
        error: error instanceof Error ? error.message : 'Direct import upload unavailable',
        ...(error && typeof error === 'object' && typeof (error as { errorCode?: unknown }).errorCode === 'string'
            ? { errorCode: (error as { errorCode: string }).errorCode }
            : {}),
    };
}

/** Uploads one prepared finite transfer through the mandatory machine/1 carrier. */
export async function uploadBulkPayloadFromFileViaMachineCarrier<
    TResponse,
>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    fileReader: BulkTransferFileReader;
    directImportRequest: DirectTransferImportOpenRequest;
    parseDirectFinalizeResponse?: ((response: Extract<DirectTransferImportFinalizeResponse, { success: true }>) => TResponse | null) | null;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<TResponse | BulkTransferFailureResponse | TransferFinalizeRecoveryFailure<TResponse>> {
    let account: Awaited<ReturnType<typeof captureFilesystemTransferAccountScope>> | undefined;
    let recoveryOwnsAccount = false;
    try {
        if (params.signal?.aborted) {
            return { success: false, error: 'Upload canceled' };
        }

        if (params.directImportRequest.t === 'session_file_upload_v1') {
            try {
                account = await captureFilesystemTransferAccountScope(params.serverId, params.signal);
                account.assertCurrent();
            } catch (error) { return toDirectFailure(error); }
        }
        // Selection precedes preparation. An unavailable mandatory carrier must
        // not allocate a transfer that a legacy RPC/relay path could consume.
        const machineRoute = await resolveMachineCarrierRoute(params.machineId, account?.serverId ?? params.serverId);
        if (machineRoute.kind === 'unavailable') {
            return {
                success: false,
                error: machineRoute.error,
                errorCode: machineRoute.errorCode,
            };
        }

        try {
            const capturedAccount = account;
            const result = await uploadBulkPayloadFromFileViaDirectImport<TResponse>({
                machineId: params.machineId,
                serverId: machineRoute.serverId,
                accountId: capturedAccount?.accountId,
                accountLifetime: capturedAccount?.accountLifetime,
                onRecoverySettled: capturedAccount?.dispose,
                fileReader: params.fileReader,
                request: params.directImportRequest,
                parseFinalizeResponse: params.parseDirectFinalizeResponse ?? null,
                timeoutMs: params.timeoutMs ?? null,
                signal: capturedAccount?.signal ?? params.signal ?? null,
                onProgress: params.onProgress ?? null,
                // Acquisition stays pinned to the route selected above, while
                // its cancellation scope belongs to the caller that invokes it:
                // the live upload passes this operation's signal, and the
                // deferred finalize recovery runs after this operation ended.
                acquirePreparedCarrier: async prepared => {
                    if (capturedAccount && !capturedAccount.accountLifetime.isCurrent()) throw new Error('action_account_scope_changed');
                    return await machineRoute.acquire({ ...prepared, accountLifetime: capturedAccount?.accountLifetime });
                },
            });
            recoveryOwnsAccount = isTransferFinalizeRecoveryFailure(result);
            return result;
        } catch (error) {
            return toDirectFailure(error);
        }
    } finally {
        if (!recoveryOwnsAccount) account?.dispose();
        await params.fileReader.close();
    }
}
