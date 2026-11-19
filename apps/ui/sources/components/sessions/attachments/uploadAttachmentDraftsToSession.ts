import { SessionAttachmentHandleV1Schema, type SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { RawIngressStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { buildUploadedAttachment, type UploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';

import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { readRpcErrorCode, RpcError } from '@/sync/runtime/rpcErrors';
import { randomUUID } from '@/platform/randomUUID';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { describeUploadFailure } from '@/components/transfers/describeUploadFailure';
import { classifyTransferFailure, readTransferFailureCode } from '@/sync/domains/transfers/runtime/transferRuntime';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { SessionAttachmentsUploadFinalizeResponse, SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';

import { assertAttachmentDraftSourcesAvailable, sendableAttachmentDrafts, type AttachmentDraft } from './attachmentDraftModel';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { BrowserAnnotationPicture } from '@/sync/domains/session/input/browserContext';

export { buildUploadedAttachment, type UploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';

export type IssuedUploadedAttachment = UploadedAttachment & Readonly<{
    attachmentHandle: SessionAttachmentHandleV1;
    browserAnnotation?: BrowserAnnotationPicture;
}>;

/** The draft owner withdrew this upload; callers settle it without failure UI. */
export class AttachmentUploadCancelled extends Error {
    constructor() {
        super('Attachment upload cancelled');
        this.name = 'AttachmentUploadCancelled';
    }
}

function throwIfAttachmentUploadCancelled(signal: AbortSignal | null | undefined): void {
    if (signal?.aborted) throw new AttachmentUploadCancelled();
}

function projectUploadedDraft(draft: AttachmentDraft, attachment: UploadedAttachmentBase): IssuedUploadedAttachment {
    const uploaded = { ...buildUploadedAttachment(attachment), attachmentHandle: attachment.attachmentHandle };
    if (!draft.browserAnnotation) return uploaded;
    const marks = draft.edit?.document ?? { v: 1 as const, image: draft.browserAnnotation.image, marks: [] };
    return { ...uploaded, browserAnnotation: { annotationId: draft.browserAnnotation.annotationId, marks,
        imageRef: { mediaId: attachment.attachmentHandle.id, mediaKind: 'image',
            width: marks.crop?.width ?? marks.image.width, height: marks.crop?.height ?? marks.image.height,
            sizeBytes: attachment.sizeBytes, file: { sessionId: attachment.attachmentHandle.sessionId, storage: 'session',
                path: attachment.path, ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}), mimeType: attachment.mimeType ?? 'image/png' } } } };
}

/** Authored ingress carries issued selections; the daemon owns their presentation projection. */
export function buildSessionAttachmentIngressMeta(
    uploaded: readonly Pick<IssuedUploadedAttachment, 'attachmentHandle'>[],
): Readonly<{ happierStructuredInputV1: RawIngressStructuredInputV1 }> {
    return { happierStructuredInputV1: { v: 1, sessionAttachments: uploaded.map(attachment => attachment.attachmentHandle) } };
}

export type AttachmentUploadedDraftCheckpoint = Readonly<{
    id: string;
    uploadedPath: string;
    uploadedSizeBytes: number;
    uploadedMimeType?: string;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
}>;

export type AttachmentTargetUploadedDraftCheckpoint = AttachmentUploadedDraftCheckpoint & Readonly<{
    target: ExactSessionMachineTargetIdentity;
    executionTarget: SessionExecutionTargetV1;
    messageLocalId: string;
}>;

type UploadedAttachmentBase = Omit<IssuedUploadedAttachment, 'structuredInput'>;

export function describeAttachmentUploadSource(source: AttachmentUploadSource): Readonly<{
    name: string;
    mimeType?: string;
    sizeBytes?: number;
}> {
    if (source.kind === 'folder') {
        return { name: source.name, mimeType: source.mimeType,
            sizeBytes: source.entries.reduce((total, entry) => total + (describeAttachmentUploadSource(entry.source).sizeBytes ?? 0), 0) };
    }
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
    errorCode?: string | null;
    thrown?: unknown;
}>): Error {
    const normalizedCode = typeof input.errorCode === 'string' ? input.errorCode.trim() : '';
    const message = describeUploadFailure(classifyTransferFailure({
        ...(normalizedCode ? { errorCode: normalizedCode } : {}), thrown: input.thrown,
    }), t('common.machine'));
    return normalizedCode ? new RpcError(message, normalizedCode) : new Error(message);
}

type DraftUploadArguments = Parameters<typeof uploadAttachmentDraftsToSession>[0];
type TransferUploadResult = Awaited<ReturnType<typeof sessionAttachmentsUploadFile>>;
type DraftUploadResult = Exclude<TransferUploadResult, { success: true }>
    | (Extract<TransferUploadResult, { success: true }> & Readonly<{ attachmentHandle: SessionAttachmentHandleV1 }>);
type RecoverAttachmentDrafts = (drafts: readonly AttachmentDraft[]) => readonly AttachmentDraft[];
// Eager upload and Send share one complete transfer, including finalize recovery.
// Successful results also serve snapshots captured before the draft checkpoint arrived.
const folderUploads = new WeakMap<AttachmentUploadSource, Map<string, Promise<DraftUploadResult> | Extract<DraftUploadResult, { success: true }>>>();

function sameIssuedHandle(current: SessionAttachmentHandleV1 | undefined, attempted: SessionAttachmentHandleV1): boolean {
    return current?.id === attempted.id && current.sessionId === attempted.sessionId;
}

export function recoverRejectedAttachmentDrafts(
    failure: unknown,
    submittedDrafts: readonly AttachmentDraft[],
    uploaded: readonly IssuedUploadedAttachment[],
): RecoverAttachmentDrafts | undefined {
    if (readActionErrorCodeV1(failure) !== 'session_attachment_upload_checkpoint_stale') return;
    const issuedByDraftId = new Map(uploaded.map(attachment => [attachment.id, attachment.attachmentHandle]));
    const sourceByDraftId = new Map(submittedDrafts.map(draft => [draft.id, draft.source]));

    for (const draft of submittedDrafts) {
        const attempted = issuedByDraftId.get(draft.id);
        const uploads = folderUploads.get(draft.source);
        if (!attempted || !uploads) continue;
        for (const [key, cached] of uploads) {
            if ('attachmentHandle' in cached && sameIssuedHandle(cached.attachmentHandle, attempted)) uploads.delete(key);
        }
    }

    return drafts => {
        let changed = false;
        const recovered = drafts.map(draft => {
            const attempted = issuedByDraftId.get(draft.id);
            if (!attempted || sourceByDraftId.get(draft.id) !== draft.source || !sameIssuedHandle(draft.attachmentHandle, attempted)) return draft;
            changed = true;
            return { ...draft, status: 'pending' as const, uploadedPath: undefined, uploadedSizeBytes: undefined,
                uploadedMimeType: undefined, sha256: undefined, attachmentHandle: undefined, uploadProgress: undefined };
        });
        return changed ? recovered : drafts;
    };
}

async function uploadAndRecoverDraft(args: DraftUploadArguments, draft: AttachmentDraft, messageLocalId: string): Promise<DraftUploadResult> {
    const upload = async (): Promise<DraftUploadResult> => {
        let result = await (args.uploadFile ?? sessionAttachmentsUploadFile)({ sessionId: args.sessionId,
            ...(args.sessionTarget ? { sessionTarget: args.sessionTarget } : {}),
            ...(args.transferContext ? { transferContext: args.transferContext } : {}),
            file: draft.source, attachmentId: draft.id, messageLocalId, config: args.config,
            signal: args.signal ?? undefined,
            onProgress: progress => args.applyDraftPatch(draft.id, { uploadProgress: progress }),
        });
        if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(result)) {
            const recovery = await runTransferFinalizeRecovery({ recovery: result.recovery, signal: args.signal,
                title: t('transferRecovery.title'), message: t('transferRecovery.message') });
            result = recovery?.status === 'finalized' ? recovery.response : { success: false,
                error: recovery?.status === 'unavailable' ? t('transferRecovery.unavailable')
                    : recovery?.status === 'discarded' ? t('transferRecovery.discarded') : result.error };
        }
        if (!result.success) return result;
        const issuedHandle = SessionAttachmentHandleV1Schema.safeParse(result.attachmentHandle);
        if (!issuedHandle.success || issuedHandle.data.sessionId !== args.sessionId) {
            throw new Error('Session attachment preparation requires an issued target Session handle');
        }
        return { ...result, attachmentHandle: issuedHandle.data };
    };
    if (draft.source.kind !== 'folder') return await upload();
    const key = JSON.stringify([draft.id, args.sessionId, args.sessionTarget?.serverId, args.sessionTarget?.accountId,
        args.config.uploadLocation, args.config.workspaceRelativeDir, args.config.vcsIgnoreStrategy,
        args.config.vcsIgnoreWritesEnabled, args.config.maxFileBytes]);
    let uploads = folderUploads.get(draft.source);
    if (!uploads) { uploads = new Map(); folderUploads.set(draft.source, uploads); }
    const existing = uploads.get(key);
    if (existing) return await existing;
    const pending = upload();
    uploads.set(key, pending);
    const capturedUploads = uploads;
    void pending.then(result => {
        if (result.success) capturedUploads.set(key, result);
        else capturedUploads.delete(key);
    }, () => capturedUploads.delete(key));
    return await pending;
}

export async function uploadAttachmentDraftsToSession(args: Readonly<{
    sessionId: string;
    /** Exact qualified Session target when the created Session is outside the active Account. */
    sessionTarget?: ExactSessionMachineTargetIdentity;
    transferContext?: SessionAttachmentTransferContext;
    drafts: readonly AttachmentDraft[];
    config: AttachmentsUploadConfig;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => void;
    /**
     * Optional owner-level durability checkpoint. It is awaited before the next
     * file starts so a partial batch retry can reuse the verified remote path.
     */
    onUploadedDraftCheckpoint?: (draft: AttachmentUploadedDraftCheckpoint) => Promise<void> | void;
    messageLocalId?: string;
    signal?: AbortSignal | null;
    /** Genuine transfer boundary override for owner-level tests. */
    uploadFile?: typeof sessionAttachmentsUploadFile;
}>): Promise<Readonly<{
    messageLocalId: string;
    uploaded: readonly IssuedUploadedAttachment[];
}>> {
    const messageLocalId = args.messageLocalId ?? randomUUID();
    const uploaded: IssuedUploadedAttachment[] = [];

    assertAttachmentDraftSourcesAvailable(args.drafts);

    for (const draft of sendableAttachmentDrafts(args.drafts)) {
        throwIfAttachmentUploadCancelled(args.signal);
        const stillPresent = args.drafts.find((d) => d.id === draft.id);
        if (!stillPresent) continue;

        const described = describeAttachmentUploadSource(stillPresent.source);
        const retainedHandle = SessionAttachmentHandleV1Schema.safeParse(stillPresent.attachmentHandle);
        if (stillPresent.uploadedPath && retainedHandle.success && retainedHandle.data.sessionId === args.sessionId) {
            const uploadedAttachment: UploadedAttachmentBase = {
                id: stillPresent.id,
                name: described.name,
                path: stillPresent.uploadedPath,
                sizeBytes: stillPresent.uploadedSizeBytes ?? described.sizeBytes ?? 0,
                ...((stillPresent.uploadedMimeType ?? described.mimeType)
                    ? { mimeType: (stillPresent.uploadedMimeType ?? described.mimeType)! }
                    : {}),
                ...(stillPresent.sha256 ? { sha256: stillPresent.sha256 } : {}),
                attachmentHandle: retainedHandle.data,
            };
            uploaded.push(projectUploadedDraft(stillPresent, uploadedAttachment));
            continue;
        }

        const initialProgress =
            typeof described.sizeBytes === 'number' && Number.isFinite(described.sizeBytes) && described.sizeBytes >= 0
                ? { uploadedBytes: 0, totalBytes: described.sizeBytes }
                : undefined;
        args.applyDraftPatch(stillPresent.id, { status: 'uploading', error: undefined, errorCode: undefined, uploadProgress: initialProgress });
        let uploadRes: DraftUploadResult;
        try {
            uploadRes = await uploadAndRecoverDraft(args, stillPresent, messageLocalId);
        } catch (error) {
            throwIfAttachmentUploadCancelled(args.signal);
            const failure = createAttachmentUploadFailureError({ errorCode: readRpcErrorCode(error) ?? readTransferFailureCode(error), thrown: error });
            args.applyDraftPatch(stillPresent.id, { status: 'error', error: failure.message, errorCode: readRpcErrorCode(failure) });
            throw failure;
        }
        throwIfAttachmentUploadCancelled(args.signal);
        if (!uploadRes.success) {
            const failure = createAttachmentUploadFailureError(uploadRes);
            args.applyDraftPatch(stillPresent.id, { status: 'error', error: failure.message, errorCode: readRpcErrorCode(failure) });
            throw failure;
        }

        const uploadedPatch = {
            status: 'uploaded',
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            uploadedMimeType: described.mimeType,
            sha256: uploadRes.sha256,
            attachmentHandle: uploadRes.attachmentHandle,
            error: undefined,
            errorCode: undefined,
            uploadProgress: { uploadedBytes: uploadRes.sizeBytes, totalBytes: uploadRes.sizeBytes },
        } satisfies Partial<Omit<AttachmentDraft, 'id' | 'source'>>;
        args.applyDraftPatch(stillPresent.id, uploadedPatch);
        await args.onUploadedDraftCheckpoint?.({
            id: stillPresent.id,
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { uploadedMimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
            attachmentHandle: uploadRes.attachmentHandle,
        });

        const uploadedAttachment: UploadedAttachmentBase = {
            id: stillPresent.id,
            name: described.name,
            path: uploadRes.path,
            sizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { mimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
            attachmentHandle: uploadRes.attachmentHandle,
        };
        uploaded.push(projectUploadedDraft(stillPresent, uploadedAttachment));
    }

    return { messageLocalId, uploaded };
}
