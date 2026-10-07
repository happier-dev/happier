import { SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND } from '@happier-dev/protocol/sessions/userMessageRpc';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';

import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { RpcError } from '@/sync/runtime/rpcErrors';
import { randomUUID } from '@/platform/randomUUID';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import type { SessionAttachmentsUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';

import type { AttachmentDraft } from './attachmentDraftModel';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export type AttachmentUploadedDraftCheckpoint = Readonly<{
    id: string;
    uploadedPath: string;
    uploadedSizeBytes: number;
    uploadedMimeType?: string;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
}>;

type StructuredInputImageInput = Readonly<{
    type: 'localImage';
    kind: 'image';
    localPath: string;
    path: string;
    provenance?: Readonly<{ kind: string }>;
    name: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
}>;

export type UploadedAttachment = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
    structuredInput?: StructuredInputImageInput;
}>;
type UploadedAttachmentBase = Omit<UploadedAttachment, 'structuredInput'>;

function isImageMimeType(mimeType: string | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}

function buildStructuredInputForUploadedAttachment(args: UploadedAttachmentBase): StructuredInputImageInput | undefined {
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

/**
 * Canonical projection from an admitted Session attachment to Message metadata.
 * Runner handoff verifies different source bytes, but must publish the same
 * attachment/message shape as every other Session upload.
 */
export function buildUploadedAttachment(args: UploadedAttachmentBase): UploadedAttachment {
    const structuredInput = buildStructuredInputForUploadedAttachment(args);
    return {
        ...args,
        ...(structuredInput ? { structuredInput } : {}),
    };
}

function toAttachmentPayload(attachment: UploadedAttachment): Record<string, unknown> {
    return {
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        ...(attachment.attachmentHandle ? { attachmentHandle: attachment.attachmentHandle } : {}),
    };
}

function markUploadedAttachmentInput(input: StructuredInputImageInput): StructuredInputImageInput {
    return input.type === 'localImage'
        ? {
            ...input,
            provenance: { kind: SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND },
        }
        : input;
}

export function buildAttachmentMessageMeta(uploaded: readonly UploadedAttachment[]): Record<string, unknown> {
    const structuredAttachments = uploaded
        .map((attachment) => attachment.structuredInput)
        .filter((input): input is StructuredInputImageInput => Boolean(input))
        .map(markUploadedAttachmentInput);

    return {
        happier: {
            kind: 'attachments.v1',
            payload: {
                attachments: uploaded.map(toAttachmentPayload),
            },
        },
        ...(structuredAttachments.length > 0
            ? {
                happierStructuredInputV1: {
                    v: 1,
                    imageInputs: structuredAttachments,
                },
            }
            : {}),
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
    /** Exact qualified Session target when the created Session is outside the active Account. */
    sessionTarget?: ExactSessionMachineTargetIdentity;
    drafts: readonly AttachmentDraft[];
    config: AttachmentsUploadConfig;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => void;
    /**
     * Optional owner-level durability checkpoint. It is awaited before the next
     * file starts so a partial batch retry can reuse the verified remote path.
     */
    onUploadedDraftCheckpoint?: (draft: AttachmentUploadedDraftCheckpoint) => Promise<void> | void;
    messageLocalId?: string;
    /** Genuine transfer boundary override for owner-level tests. */
    uploadFile?: typeof sessionAttachmentsUploadFile;
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
                ...(stillPresent.attachmentHandle ? { attachmentHandle: stillPresent.attachmentHandle } : {}),
            };
            uploaded.push(buildUploadedAttachment(uploadedAttachment));
            continue;
        }

        const initialProgress =
            typeof described.sizeBytes === 'number' && Number.isFinite(described.sizeBytes) && described.sizeBytes >= 0
                ? { uploadedBytes: 0, totalBytes: described.sizeBytes }
                : undefined;
        args.applyDraftPatch(stillPresent.id, { status: 'uploading', error: undefined, uploadProgress: initialProgress });
        let uploadRes = await (args.uploadFile ?? sessionAttachmentsUploadFile)({
            sessionId: args.sessionId,
            ...(args.sessionTarget ? { sessionTarget: args.sessionTarget } : {}),
            file: stillPresent.source,
            messageLocalId,
            config: args.config,
            onProgress: (progress) => {
                args.applyDraftPatch(stillPresent.id, { uploadProgress: progress });
            },
        });
        if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(uploadRes)) {
            const recoveryResult = await runTransferFinalizeRecovery({
                recovery: uploadRes.recovery,
                title: t('transferRecovery.title'),
                message: t('transferRecovery.message'),
            });
            if (recoveryResult?.status === 'finalized') {
                uploadRes = recoveryResult.response;
            } else {
                uploadRes = {
                    success: false,
                    error: recoveryResult?.status === 'unavailable'
                        ? t('transferRecovery.unavailable')
                        : recoveryResult?.status === 'discarded'
                            ? t('transferRecovery.discarded')
                            : uploadRes.error,
                };
            }
        }
        if (!uploadRes.success) {
            args.applyDraftPatch(stillPresent.id, { status: 'error', error: uploadRes.error });
            throw createAttachmentUploadFailureError(uploadRes);
        }

        const uploadedPatch = {
            status: 'uploaded',
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            uploadedMimeType: described.mimeType,
            sha256: uploadRes.sha256,
            attachmentHandle: uploadRes.attachmentHandle,
            error: undefined,
            uploadProgress: { uploadedBytes: uploadRes.sizeBytes, totalBytes: uploadRes.sizeBytes },
        } satisfies Partial<Omit<AttachmentDraft, 'id' | 'source'>>;
        args.applyDraftPatch(stillPresent.id, uploadedPatch);
        await args.onUploadedDraftCheckpoint?.({
            id: stillPresent.id,
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { uploadedMimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
            ...(uploadRes.attachmentHandle ? { attachmentHandle: uploadRes.attachmentHandle } : {}),
        });

        const uploadedAttachment: UploadedAttachmentBase = {
            name: described.name,
            path: uploadRes.path,
            sizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { mimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
            ...(uploadRes.attachmentHandle ? { attachmentHandle: uploadRes.attachmentHandle } : {}),
        };
        uploaded.push(buildUploadedAttachment(uploadedAttachment));
    }

    return { messageLocalId, uploaded };
}

export function formatAttachmentsBlock(uploaded: readonly UploadedAttachment[]): string {
    if (uploaded.length === 0) return '';
    const lines: string[] = [
        'Attachments: open and analyze these files before answering.',
        '[attachments]',
    ];
    for (const a of uploaded) {
        const typeLabel = a.mimeType ? a.mimeType : 'unknown';
        lines.push(`- ${a.path} (${a.name}, ${typeLabel}, ${a.sizeBytes} bytes)`);
    }
    lines.push('[/attachments]');
    return lines.join('\n');
}
