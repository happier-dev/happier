import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import type { AttachmentTargetUploadedDraftCheckpoint } from './uploadAttachmentDraftsToSession';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';

export type AttachmentDraftStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AttachmentDraft = Readonly<{
    id: string;
    source: AttachmentUploadSource;
    /** Editable marks are local to this attachment occurrence, until Send or reload. */
    edit?: Readonly<{ original: AttachmentUploadSource; document: ImageMarksDocumentV1 }>;
    /** Browser source facts follow this picked occurrence through edits and Revert. */
    browserAnnotation?: Readonly<{ annotationId: string; image: ImageMarksDocumentV1['image'] }>;
    status: AttachmentDraftStatus;
    error?: string;
    /** Content-free transfer refusal, retained independently of localized copy. */
    errorCode?: string;
    uploadProgress?: Readonly<{ uploadedBytes: number; totalBytes: number }>;
    uploadedPath?: string;
    uploadedSizeBytes?: number;
    uploadedMimeType?: string;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
    /** Exact cross-Session upload checkpoints; ordinary uploadedPath remains source-scoped. */
    targetUploadedCheckpoints?: readonly AttachmentTargetUploadedDraftCheckpoint[];
}>;

export function sendableAttachmentDrafts(drafts: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    return drafts.filter(draft => draft.source.kind !== 'folder' || draft.status !== 'error');
}

/** Recovery keeps missing occurrences visible, but no submission may turn them into empty files. */
export function assertAttachmentDraftSourcesAvailable(drafts: readonly AttachmentDraft[]): void {
    const missing = drafts.find(draft => draft.errorCode === 'attachment_source_missing');
    if (missing) throw Object.assign(new Error(missing.error ?? 'Re-attach the missing source file.'), {
        rpcErrorCode: 'attachment_source_missing',
    });
}

/** Acceptance owns only the exact immutable source occurrence captured for Send. */
export function removeSubmittedAttachmentDrafts(current: readonly AttachmentDraft[], submitted: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    const sourcesById = new Map(submitted.map(draft => [draft.id, draft.source]));
    const remaining = current.filter(draft => sourcesById.get(draft.id) !== draft.source);
    return remaining.length === current.length ? current : remaining;
}
