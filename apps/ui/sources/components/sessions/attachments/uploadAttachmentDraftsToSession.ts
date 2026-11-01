import { SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND } from '@happier-dev/protocol';

import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { RpcError } from '@/sync/runtime/rpcErrors';
import { randomUUID } from '@/platform/randomUUID';

import type { AttachmentDraft } from './attachmentDraftModel';
import type { StructuredInputImageInput } from '@/components/sessions/agentInput/structuredInputMentions';

export type UploadedAttachment = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
    structuredInput?: StructuredInputImageInput;
}>;
type UploadedAttachmentBase = Omit<UploadedAttachment, 'structuredInput'>;

function isImageMimeType(mimeType: string | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}

function buildStructuredInputForUploadedAttachment(args: Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
}>): StructuredInputImageInput | undefined {
    if (!isImageMimeType(args.mimeType)) return undefined;
    return {
        type: 'localImage',
        kind: 'image',
        localPath: args.path,
        path: args.path,
        provenance: { kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND },
        name: args.name,
        ...(args.mimeType ? { mimeType: args.mimeType } : {}),
        sizeBytes: args.sizeBytes,
        ...(args.sha256 ? { sha256: args.sha256 } : {}),
    };
}

function describeSource(source: AttachmentsUploadFileSource): Readonly<{
    name: string;
    mimeType?: string;
    sizeBytes?: number;
}> {
    if (source.kind === 'web') {
        return {
            name: source.file.name,
            mimeType: source.file.type || undefined,
            sizeBytes: source.file.size,
        };
    }
    if (source.kind === 'memory') {
        return {
            name: source.name,
            mimeType: source.mimeType ? String(source.mimeType) : undefined,
            sizeBytes: source.bytes.byteLength,
        };
    }
    return {
        name: source.name,
        mimeType: source.mimeType ? String(source.mimeType) : undefined,
        sizeBytes: typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : undefined,
    };
}

function createAttachmentUploadFailureError(input: Readonly<{
    error: string;
    errorCode?: string | null;
}>): Error {
    const normalizedCode = typeof input.errorCode === 'string' ? input.errorCode.trim() : '';
    return normalizedCode ? new RpcError(input.error, normalizedCode) : new Error(input.error);
}

export async function uploadAttachmentDraftsToSession(args: Readonly<{
    sessionId: string;
    drafts: readonly AttachmentDraft[];
    config: AttachmentsUploadConfig;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => void;
    messageLocalId?: string;
}>): Promise<Readonly<{
    messageLocalId: string;
    uploaded: readonly UploadedAttachment[];
}>> {
    const messageLocalId = args.messageLocalId ?? randomUUID();
    const uploaded: UploadedAttachment[] = [];

    for (const draft of args.drafts) {
        const stillPresent = args.drafts.find((d) => d.id === draft.id);
        if (!stillPresent) continue;

        const described = describeSource(stillPresent.source);
        if (stillPresent.uploadedPath) {
            const uploadedAttachment: UploadedAttachmentBase = {
                name: described.name,
                path: stillPresent.uploadedPath,
                sizeBytes: stillPresent.uploadedSizeBytes ?? described.sizeBytes ?? 0,
                ...((stillPresent.uploadedMimeType ?? described.mimeType)
                    ? { mimeType: (stillPresent.uploadedMimeType ?? described.mimeType)! }
                    : {}),
                ...(stillPresent.sha256 ? { sha256: stillPresent.sha256 } : {}),
            };
            const structuredInput = buildStructuredInputForUploadedAttachment(uploadedAttachment);
            uploaded.push({
                ...uploadedAttachment,
                ...(structuredInput ? { structuredInput } : {}),
            });
            continue;
        }

        const initialProgress =
            typeof described.sizeBytes === 'number' && Number.isFinite(described.sizeBytes) && described.sizeBytes >= 0
                ? { uploadedBytes: 0, totalBytes: described.sizeBytes }
                : undefined;
        args.applyDraftPatch(stillPresent.id, { status: 'uploading', error: undefined, uploadProgress: initialProgress });
        const uploadRes = await sessionAttachmentsUploadFile({
            sessionId: args.sessionId,
            file: stillPresent.source,
            messageLocalId,
            config: args.config,
            onProgress: (progress) => {
                args.applyDraftPatch(stillPresent.id, { uploadProgress: progress });
            },
        });
        if (!uploadRes.success) {
            args.applyDraftPatch(stillPresent.id, { status: 'error', error: uploadRes.error });
            throw createAttachmentUploadFailureError(uploadRes);
        }

        args.applyDraftPatch(stillPresent.id, {
            status: 'uploaded',
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            uploadedMimeType: described.mimeType,
            sha256: uploadRes.sha256,
            error: undefined,
            uploadProgress: { uploadedBytes: uploadRes.sizeBytes, totalBytes: uploadRes.sizeBytes },
        });

        const uploadedAttachment: UploadedAttachmentBase = {
            name: described.name,
            path: uploadRes.path,
            sizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { mimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
        };
        const structuredInput = buildStructuredInputForUploadedAttachment(uploadedAttachment);
        uploaded.push({
            ...uploadedAttachment,
            ...(structuredInput ? { structuredInput } : {}),
        });
    }

    return { messageLocalId, uploaded };
}

export function formatAttachmentsBlock(uploaded: readonly UploadedAttachment[]): string {
    const lines: string[] = [
        'Attachments: open and analyze these files before answering. Relative paths are relative to the session working directory, not your home directory.',
        '[attachments]',
    ];
    for (const a of uploaded) {
        const typeLabel = a.mimeType ? a.mimeType : 'unknown';
        lines.push(`- ${a.path} (${a.name}, ${typeLabel}, ${a.sizeBytes} bytes)`);
    }
    lines.push('[/attachments]');
    return lines.join('\n');
}
