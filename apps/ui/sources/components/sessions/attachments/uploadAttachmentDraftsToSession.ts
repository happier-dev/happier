import type { AttachmentsUploadConfig } from '@/sync/ops/sessionAttachmentsUpload';
import { sessionAttachmentsUploadFile } from '@/sync/ops/sessionAttachmentsUpload';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { randomUUID } from '@/platform/randomUUID';

import type { AttachmentDraft } from './attachmentDraftModel';

export type UploadedAttachment = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
}>;

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
    return {
        name: source.name,
        mimeType: source.mimeType ? String(source.mimeType) : undefined,
        sizeBytes: typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : undefined,
    };
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
            uploaded.push({
                name: described.name,
                path: stillPresent.uploadedPath,
                mimeType: stillPresent.uploadedMimeType ?? described.mimeType,
                sizeBytes: stillPresent.uploadedSizeBytes ?? described.sizeBytes ?? 0,
                sha256: stillPresent.sha256,
            });
            continue;
        }

        args.applyDraftPatch(stillPresent.id, { status: 'uploading', error: undefined });
        const uploadRes = await sessionAttachmentsUploadFile({
            sessionId: args.sessionId,
            file: stillPresent.source,
            messageLocalId,
            config: args.config,
        });
        if (!uploadRes.success) {
            args.applyDraftPatch(stillPresent.id, { status: 'error', error: uploadRes.error });
            throw new Error(uploadRes.error);
        }

        args.applyDraftPatch(stillPresent.id, {
            status: 'uploaded',
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            uploadedMimeType: described.mimeType,
            sha256: uploadRes.sha256,
            error: undefined,
        });

        uploaded.push({
            name: described.name,
            path: uploadRes.path,
            mimeType: described.mimeType,
            sizeBytes: uploadRes.sizeBytes,
            sha256: uploadRes.sha256,
        });
    }

    return { messageLocalId, uploaded };
}

export function formatAttachmentsBlock(uploaded: readonly UploadedAttachment[]): string {
    const lines: string[] = [
        'Attachments: read each file path with the Read tool before answering.',
        '[attachments]',
    ];
    for (const a of uploaded) {
        const typeLabel = a.mimeType ? a.mimeType : 'unknown';
        lines.push(`- ${a.path} (${a.name}, ${typeLabel}, ${a.sizeBytes} bytes)`);
    }
    lines.push('[/attachments]');
    return lines.join('\n');
}

