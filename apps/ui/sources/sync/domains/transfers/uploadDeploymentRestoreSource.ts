import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DeploymentBackupRestoreSourceV1Schema, DeploymentBackupRestoreUploadInitV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { openLocalUploadSourceReader, type LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { uploadBulkPayloadFromFile } from './runtime/transferRuntime/plumbing/uploadBulkPayloadFromFile';
import { createWorkspaceFileTransferRpcCaller } from './runtime/transferRuntime/families/workspaceFileTransferRpcCaller';
import type { ChunkUploadProgress } from './runtime/transferRuntime/plumbing/chunkTransferClient';

/** A local file enters the existing encrypted finite-transfer owner; restore only receives its opaque handle. */
export async function uploadDeploymentRestoreSource(input: Readonly<{
    serverId: string; accountId: string; machineId: string; environmentId: string; file: LocalUploadSource;
    signal: AbortSignal; onProgress?: (progress: ChunkUploadProgress) => void;
}>) {
    const reader = await openLocalUploadSourceReader(input.file);
    if (reader.sizeBytes === null) {
        await reader.close();
        throw new Error('restore_upload_source_unavailable');
    }
    const rpc = createWorkspaceFileTransferRpcCaller(input);
    type Init = Awaited<ReturnType<Parameters<typeof uploadBulkPayloadFromFile>[0]['init']>>;
    type Finalize = Readonly<{ success: boolean; transferId?: string; error?: string }>;
    const response = await uploadBulkPayloadFromFile<Finalize>({
        fileReader: { ...reader, sizeBytes: reader.sizeBytes }, signal: input.signal, onProgress: input.onProgress,
        init: signal => rpc.call<Init, unknown>({ machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            request: DeploymentBackupRestoreUploadInitV1Schema.parse({ t: 'deployment_restore_upload_v1',
                environmentId: input.environmentId, sizeBytes: reader.sizeBytes }), signal }),
        sendChunk: (request, signal) => rpc.call({ machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, request, signal }),
        finalize: (request, signal) => rpc.call<Finalize, typeof request>({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, request, signal }),
        abort: request => rpc.call({ machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, request }),
        retainUploadAfterFinalize: response => response.success === true,
    });
    if (!response.success) throw new Error(response.error ?? 'restore_upload_unavailable');
    return DeploymentBackupRestoreSourceV1Schema.parse({ kind: 'upload', transferId: 'transferId' in response ? response.transferId : undefined });
}
