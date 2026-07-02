import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';

import { uploadSessionAttachmentFromReaderViaDirectImport } from './uploadSessionAttachmentFromReaderViaDirectImport';

type SessionRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;
type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
export type TransferFileReader = Readonly<{
    sizeBytes: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    close: () => Promise<void>;
}>;

export type SessionAttachmentsUploadInitRequest = Readonly<{
    messageLocalId: string;
    fileName: string;
    sizeBytes: number;
    uploadLocation: 'workspace' | 'os_temp';
    workspaceRootPath?: string;
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: 'git_info_exclude' | 'gitignore' | 'none';
    vcsIgnoreWritesEnabled: boolean;
}>;

export type SessionAttachmentsUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | SessionRpcFailure;

export async function uploadDaemonSessionAttachmentFromReader(params: Readonly<{
    sessionId: string;
    fileReader: TransferFileReader;
    request: SessionAttachmentsUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<SessionAttachmentsUploadFinalizeResponse | TransferFailureResponse> {
    const machineTarget = readMachineControlTargetForSession(params.sessionId);
    const preferredServerId = resolveSessionListPreferredServerIdFromState(
        storage.getState(),
        params.sessionId,
        getActiveServerSnapshot().serverId,
    );
    const serverId = preferredServerId ?? undefined;
    if (!machineTarget || !serverId) {
        return {
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return await uploadSessionAttachmentFromReaderViaDirectImport({
        machineId: machineTarget.machineId,
        serverId,
        fileReader: params.fileReader,
        request: {
            ...params.request,
            t: 'session_attachment_upload_v1',
            workingDirectory: machineTarget.basePath,
            workspaceRootPath: params.request.uploadLocation === 'workspace'
                ? machineTarget.basePath
                : params.request.workspaceRootPath,
        },
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });
}
