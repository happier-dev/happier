import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type AttachmentDraftStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AttachmentDraft = Readonly<{
    id: string;
    source: AttachmentsUploadFileSource;
    status: AttachmentDraftStatus;
    error?: string;
    uploadProgress?: Readonly<{ uploadedBytes: number; totalBytes: number }>;
    uploadedPath?: string;
    uploadedSizeBytes?: number;
    uploadedMimeType?: string;
    sha256?: string;
}>;
