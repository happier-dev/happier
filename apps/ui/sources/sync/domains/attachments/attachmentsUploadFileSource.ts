/** Device-only recovery reference; never part of the synchronized draft document. */
export type SavedAttachmentFile = Readonly<{ kind: 'capture'; captureRef: string; content: 'prepared' | 'source' }>
    | Readonly<{ kind: 'native'; uri: string }>;

export type AttachmentsUploadFileSource =
    | Readonly<{ kind: 'web'; file: File }>
    | Readonly<{
        kind: 'memory';
        bytes: Uint8Array;
        name: string;
        mimeType?: string | null;
        previewUri?: string | null;
        savedFile?: SavedAttachmentFile;
    }>
    | Readonly<{
        kind: 'native';
        uri: string;
        name: string;
        sizeBytes?: number | null;
        mimeType?: string | null;
    }>;

export type AttachmentFolderEntry = AttachmentFolderSourceEntryV1<AttachmentsUploadFileSource>;

/** Enumerated folder entries share one intake and upload path on every platform. */
export type AttachmentUploadSource = AttachmentSourceV1<AttachmentsUploadFileSource>;

export type AddWebAttachmentsOptions = Readonly<{ sources?: readonly AttachmentUploadSource[] }>;

/** Environment adapter only; durable file/folder payloads belong to Protocol. */
export function describeAttachmentUploadFileSource(source: AttachmentsUploadFileSource): Readonly<{
    name: string;
    sizeBytes: number | null;
    mimeType?: string;
}> {
    if (source.kind === 'web') return { name: source.file.name, sizeBytes: source.file.size, mimeType: source.file.type || undefined };
    return { name: source.name,
        sizeBytes: source.kind === 'memory' ? source.bytes.byteLength
            : typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : null,
        mimeType: source.mimeType ? String(source.mimeType) : undefined };
}

import type { AttachmentFolderSourceEntryV1, AttachmentSourceV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';

