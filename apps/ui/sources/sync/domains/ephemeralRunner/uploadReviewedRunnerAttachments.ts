import type { RunnerReviewedFileV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';

import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import {
    buildUploadedAttachment,
    uploadAttachmentDraftsToSession,
    type IssuedUploadedAttachment,
} from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export type ReviewedRunnerAttachmentUpload = IssuedUploadedAttachment & Readonly<{
    id: string;
}>;

/**
 * A previously verified ordinary-upload result for one reviewed file, retained
 * by the activation custody owner. Reusing it is what keeps a partial-batch
 * retry from uploading the same reviewed bytes to a second randomized path.
 */
export type ResumedRunnerAttachmentUpload = Readonly<{
    id: string;
    name: string;
    mimeType?: string;
    path: string;
    sizeBytes: number;
    sha256: string;
    attachmentHandle?: IssuedUploadedAttachment['attachmentHandle'];
}>;

export type RunnerAttachmentAdmissionErrorCode =
    | 'runner_attachment_manifest_mismatch'
    | 'runner_attachment_upload_failed'
    | 'runner_attachment_size_mismatch'
    | 'runner_attachment_digest_mismatch';

export class RunnerAttachmentAdmissionError extends Error {
    readonly code: RunnerAttachmentAdmissionErrorCode;

    constructor(code: RunnerAttachmentAdmissionErrorCode) {
        super(code);
        this.name = 'RunnerAttachmentAdmissionError';
        this.code = code;
    }
}

/**
 * Uploads creator-staged bytes through the ordinary Session attachment owner.
 * Initial prompt admission is deliberately inside this operation: every returned
 * size and digest must match the reviewed immutable manifest before the prompt can
 * enter the Session runtime.
 */
export async function uploadReviewedRunnerAttachments(input: Readonly<{
    sessionId: string;
    sessionTarget?: ExactSessionMachineTargetIdentity;
    messageLocalId: string;
    reviewedFiles: readonly RunnerReviewedFileV1[];
    stagedFiles: readonly Readonly<{ id: string; source: AttachmentsUploadFileSource }>[];
    /** Verified per-file results retained by the activation custody owner. */
    resumedUploads?: readonly ResumedRunnerAttachmentUpload[];
    /** Called once per newly verified file so custody can checkpoint it. */
    onVerifiedUpload?: (upload: ResumedRunnerAttachmentUpload) => Promise<void> | void;
    destination: Omit<AttachmentsUploadConfig, 'maxFileBytes'>;
    maxFileBytes: number;
    admitInitialPrompt: (uploaded: readonly ReviewedRunnerAttachmentUpload[]) => Promise<void> | void;
    /** Genuine network/storage boundary consumed by the ordinary uploader. */
    uploadFile?: Parameters<typeof uploadAttachmentDraftsToSession>[0]['uploadFile'];
}>): Promise<readonly ReviewedRunnerAttachmentUpload[]> {
    const stagedById = new Map<string, AttachmentsUploadFileSource>();
    for (const staged of input.stagedFiles) {
        if (stagedById.has(staged.id)) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
        }
        stagedById.set(staged.id, staged.source);
    }
    if (stagedById.size !== input.reviewedFiles.length) {
        throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
    }

    const resumedById = new Map<string, ResumedRunnerAttachmentUpload>();
    for (const resumed of input.resumedUploads ?? []) {
        if (resumedById.has(resumed.id)) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
        }
        resumedById.set(resumed.id, resumed);
    }

    const reviewedById = new Map(input.reviewedFiles.map((reviewed) => [reviewed.id, reviewed]));
    let drafts: AttachmentDraft[] = [];
    for (const reviewed of input.reviewedFiles) {
        const source = stagedById.get(reviewed.id);
        if (!source) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
        }
        stagedById.delete(reviewed.id);
        const resumed = resumedById.get(reviewed.id);
        if (!resumed) {
            drafts.push({ id: reviewed.id, source, status: 'pending' });
            continue;
        }
        resumedById.delete(reviewed.id);
        // A retained checkpoint is reused only when it still describes the exact
        // reviewed file. Anything else is a corrupt record, not a faster path.
        if (resumed.path.length === 0 || resumed.name !== reviewed.name
            || (resumed.mimeType ?? null) !== (reviewed.mimeType ?? null)
            || resumed.sizeBytes !== reviewed.sizeBytes
            || resumed.sha256.toLowerCase() !== reviewed.sha256) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
        }
        drafts.push({
            id: reviewed.id,
            source,
            status: 'uploaded',
            uploadedPath: resumed.path,
            uploadedSizeBytes: resumed.sizeBytes,
            ...(resumed.mimeType ? { uploadedMimeType: resumed.mimeType } : {}),
            sha256: resumed.sha256.toLowerCase(),
            ...(resumed.attachmentHandle ? { attachmentHandle: resumed.attachmentHandle } : {}),
        });
    }
    if (resumedById.size !== 0) {
        throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
    }

    let ordinaryResult: Awaited<ReturnType<typeof uploadAttachmentDraftsToSession>>;
    try {
        ordinaryResult = await uploadAttachmentDraftsToSession({
            sessionId: input.sessionId,
            ...(input.sessionTarget ? { sessionTarget: input.sessionTarget } : {}),
            drafts,
            messageLocalId: input.messageLocalId,
            config: { ...input.destination, maxFileBytes: input.maxFileBytes },
            applyDraftPatch: (id, patch) => {
                drafts = drafts.map((draft) => draft.id === id ? { ...draft, ...patch } : draft);
            },
            ...(input.onVerifiedUpload ? { onUploadedDraftCheckpoint: async (draft) => {
                const reviewed = reviewedById.get(draft.id);
                const sha256 = draft.sha256?.toLowerCase();
                if (!reviewed || typeof draft.uploadedPath !== 'string'
                    || draft.uploadedSizeBytes !== reviewed.sizeBytes
                    || !sha256 || sha256 !== reviewed.sha256) {
                    throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
                }
                await input.onVerifiedUpload?.({
                    id: reviewed.id,
                    name: reviewed.name,
                    ...(reviewed.mimeType ? { mimeType: reviewed.mimeType } : {}),
                    path: draft.uploadedPath,
                    sizeBytes: reviewed.sizeBytes,
                    sha256,
                    attachmentHandle: draft.attachmentHandle,
                });
            } } : {}),
            ...(input.uploadFile ? { uploadFile: input.uploadFile } : {}),
        });
    } catch (error) {
        if (error instanceof RunnerAttachmentAdmissionError) throw error;
        throw new RunnerAttachmentAdmissionError('runner_attachment_upload_failed');
    }
    if (ordinaryResult.messageLocalId !== input.messageLocalId
        || ordinaryResult.uploaded.length !== input.reviewedFiles.length) {
        throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
    }

    const uploaded = ordinaryResult.uploaded.map((ordinaryUploaded, index): ReviewedRunnerAttachmentUpload => {
        const reviewed = input.reviewedFiles[index];
        if (!reviewed) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_manifest_mismatch');
        }
        if (ordinaryUploaded.sizeBytes !== reviewed.sizeBytes) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_size_mismatch');
        }
        const sha256 = ordinaryUploaded.sha256?.toLowerCase();
        if (!sha256 || sha256 !== reviewed.sha256) {
            throw new RunnerAttachmentAdmissionError('runner_attachment_digest_mismatch');
        }
        return {
            ...buildUploadedAttachment({
                id: reviewed.id,
                name: reviewed.name,
                path: ordinaryUploaded.path,
                ...(reviewed.mimeType ? { mimeType: reviewed.mimeType } : {}),
                sizeBytes: ordinaryUploaded.sizeBytes,
                sha256,
                attachmentHandle: ordinaryUploaded.attachmentHandle,
            }),
            id: reviewed.id,
            attachmentHandle: ordinaryUploaded.attachmentHandle,
        };
    });

    await input.admitInitialPrompt(uploaded);
    return uploaded;
}
