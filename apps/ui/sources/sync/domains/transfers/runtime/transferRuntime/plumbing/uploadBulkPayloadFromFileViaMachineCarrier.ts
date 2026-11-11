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
import { userRequestLeaseOwner } from '@/sync/runtime/connectivity/userRequestLease';
import { readTransferFailureCode } from './transferFailureCode';

function toDirectFailure(error: unknown): BulkTransferFailureResponse {
    const errorCode = readTransferFailureCode(error);
    return {
        success: false,
        error: error instanceof Error ? error.message : 'Direct import upload unavailable',
        ...(errorCode ? { errorCode } : {}),
    };
}

/** Uploads one prepared finite transfer through the canonical Machine carrier. */
export async function uploadBulkPayloadFromFileViaMachineCarrier<
    TResponse,
>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    fileReader: BulkTransferFileReader;
    /** Private byte transport supplied by a containing admitted write/copy. */
    callAdmittedAction?: Parameters<typeof uploadBulkPayloadFromFileViaDirectImport>[0]['callAdmittedAction'];
    directImportRequest: DirectTransferImportOpenRequest;
    parseDirectFinalizeResponse?: ((response: Extract<DirectTransferImportFinalizeResponse, { success: true }>) => TResponse | null) | null;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<TResponse | BulkTransferFailureResponse | TransferFinalizeRecoveryFailure<TResponse>> {
    const releaseRequestLease = userRequestLeaseOwner.acquire();
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
        // Capture the carrier before allocating the prepared capability.
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
                callAdmittedAction: params.callAdmittedAction,
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
        try {
            if (!recoveryOwnsAccount) account?.dispose();
            await params.fileReader.close();
        } finally {
            // A returned recovery continuation retains Account custody, not live networking.
            releaseRequestLease();
        }
    }
}
