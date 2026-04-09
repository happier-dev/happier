import type {
    SessionAttachmentsUploadFinalizeResponse,
    TransferFileReader,
} from './sessionAttachmentTransfers';
import {
    type DirectTransferImportOpenRequest,
    uploadBulkPayloadFromFileViaDirectImport,
} from '../plumbing/directTransferImportUpload';

type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
type SessionAttachmentDirectImportRequest = Extract<
    DirectTransferImportOpenRequest,
    Readonly<{ t: 'session_attachment_upload_v1' }>
>;

export async function uploadSessionAttachmentFromReaderViaDirectImport(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    fileReader: TransferFileReader;
    request: SessionAttachmentDirectImportRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<SessionAttachmentsUploadFinalizeResponse | TransferFailureResponse> {
    return await uploadBulkPayloadFromFileViaDirectImport<SessionAttachmentsUploadFinalizeResponse>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        fileReader: params.fileReader,
        request: params.request,
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });
}
