import type { RunnerReviewedFileV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import { admitRunnerAttachmentSource } from './runnerAttachmentSourceAdmission';
import {
    createRunnerArtifactAcquisitionSink,
    openRunnerArtifactAcquisitionCustody,
    removeRunnerArtifactAcquisitionCustody,
    type RunnerArtifactAcquisitionCustodyHandle,
} from './package/runnerArtifactAcquisitionSink';

export class RunnerAttachmentStagingError extends Error {
    readonly code: 'runner_attachment_unavailable' | 'runner_attachment_too_large';
    constructor(code: RunnerAttachmentStagingError['code'], readonly reason?: 'folder') {
        super(code);
        this.name = 'RunnerAttachmentStagingError';
        this.code = code;
    }
}

function describeSource(source: AttachmentsUploadFileSource): Readonly<{ name: string; mimeType: string | null }> {
    if (source.kind === 'web') return { name: source.file.name, mimeType: source.file.type || null };
    return { name: source.name, mimeType: source.mimeType ? String(source.mimeType) : null };
}

export type StagedRunnerAttachments = Readonly<{
    reviewedFiles: readonly RunnerReviewedFileV1[];
    stagedFiles: readonly Readonly<{ id: string; source: AttachmentsUploadFileSource }>[];
    custodyFiles: readonly StagedRunnerAttachmentCustodyFile[];
    cleanup: () => Promise<void>;
}>;

export type StagedRunnerAttachmentCustodyFile = Readonly<{
    id: string;
    name: string;
    mimeType: string | null;
    sizeBytes: number;
    custody: RunnerArtifactAcquisitionCustodyHandle;
}>;

export async function reopenStagedRunnerAttachment(
    file: StagedRunnerAttachmentCustodyFile,
): Promise<Readonly<{ id: string; source: AttachmentsUploadFileSource }>> {
    const localSource = await openRunnerArtifactAcquisitionCustody(file.custody);
    const source: AttachmentsUploadFileSource = localSource.kind === 'web'
        ? { kind: 'web', file: new File([localSource.file], file.name, { type: file.mimeType ?? '' }) }
        : { kind: 'native', uri: localSource.uri, name: file.name, sizeBytes: file.sizeBytes, mimeType: file.mimeType };
    return { id: file.id, source };
}

export async function removeStagedRunnerAttachmentCustody(
    files: readonly StagedRunnerAttachmentCustodyFile[],
): Promise<void> {
    await Promise.all(files.map(async (file) => await removeRunnerArtifactAcquisitionCustody(file.custody)));
}

/**
 * Freezes the exact creator-reviewed bytes before an activation can be created.
 * Staging is the longest step of preparation, so it observes the same
 * preparation signal the launch owner aborts on Cancel and stops at the next
 * chunk boundary, leaving the user's original source untouched.
 */
export async function stageRunnerAttachments(
    drafts: readonly AttachmentDraft[],
    limits: Readonly<{
        maxFileBytes: number;
        onCustodyAcquired?: (custodyFile: StagedRunnerAttachmentCustodyFile) => Promise<void>;
        onStagedAttachment?: (input: Readonly<{
            reviewedFile: RunnerReviewedFileV1;
            custodyFile: StagedRunnerAttachmentCustodyFile;
        }>) => Promise<void>;
    }>,
    signal?: AbortSignal,
): Promise<StagedRunnerAttachments> {
    const reviewedFiles: RunnerReviewedFileV1[] = [];
    const stagedFiles: Array<Readonly<{ id: string; source: AttachmentsUploadFileSource }>> = [];
    const custodyFiles: StagedRunnerAttachmentCustodyFile[] = [];
    const cleanups: Array<{ remove: () => Promise<void>; persisted: boolean }> = [];
    try {
        for (const draft of drafts) {
            signal?.throwIfAborted();
            const admitted = admitRunnerAttachmentSource(draft.source);
            if (!admitted.ok) throw new RunnerAttachmentStagingError(admitted.code, admitted.reason);
            const reader = await openLocalUploadSourceReader(admitted.source);
            try {
                const sizeBytes = reader.sizeBytes;
                if (sizeBytes === null) throw new RunnerAttachmentStagingError('runner_attachment_unavailable');
                if (sizeBytes > limits.maxFileBytes) throw new RunnerAttachmentStagingError('runner_attachment_too_large');
                const described = describeSource(admitted.source);
                const sink = await createRunnerArtifactAcquisitionSink({
                    artifactName: described.name,
                    sizeBytes,
                });
                const cleanup = { remove: sink.cleanup, persisted: false };
                cleanups.push(cleanup);
                const custodyFile = {
                    id: draft.id,
                    name: described.name,
                    mimeType: described.mimeType,
                    sizeBytes,
                    custody: sink.custody,
                } satisfies StagedRunnerAttachmentCustodyFile;
                await limits.onCustodyAcquired?.(custodyFile);
                cleanup.persisted = limits.onCustodyAcquired !== undefined;
                const hasher = createTransferManifestHasher();
                let offset = 0;
                while (offset < sizeBytes) {
                    signal?.throwIfAborted();
                    const chunk = await reader.readBytes(offset, Math.min(1024 * 1024, sizeBytes - offset));
                    if (chunk.byteLength === 0) throw new RunnerAttachmentStagingError('runner_attachment_unavailable');
                    hasher.update(chunk);
                    await sink.writeBytes(chunk);
                    offset += chunk.byteLength;
                }
                signal?.throwIfAborted();
                await sink.close();
                const localSource = await sink.source();
                const source: AttachmentsUploadFileSource = localSource.kind === 'web'
                    ? { kind: 'web', file: new File([localSource.file], described.name, { type: described.mimeType ?? '' }) }
                    : localSource.kind === 'native'
                        ? { kind: 'native', uri: localSource.uri, name: described.name, sizeBytes, mimeType: described.mimeType }
                        : (() => { throw new RunnerAttachmentStagingError('runner_attachment_unavailable'); })();
                const reviewedFile = {
                    id: draft.id,
                    name: described.name,
                    mimeType: described.mimeType,
                    sizeBytes,
                    sha256: hasher.digestManifestHash().slice('sha256:'.length),
                } satisfies RunnerReviewedFileV1;
                await limits.onStagedAttachment?.({ reviewedFile, custodyFile });
                reviewedFiles.push(reviewedFile);
                stagedFiles.push({ id: draft.id, source });
                custodyFiles.push(custodyFile);
            } finally {
                await reader.close();
            }
        }
        let cleanupComplete = false;
        let cleanupInFlight: Promise<void> | null = null;
        const cleanup = (): Promise<void> => {
            if (cleanupComplete) return Promise.resolve();
            if (cleanupInFlight) return cleanupInFlight;
            const pending = Promise.all(cleanups.map(async ({ remove }) => await remove())).then(() => {
                cleanupComplete = true;
            });
            cleanupInFlight = pending;
            void pending.finally(() => {
                if (cleanupInFlight === pending) cleanupInFlight = null;
            }).catch(() => undefined);
            return pending;
        };
        return {
            reviewedFiles: Object.freeze(reviewedFiles.slice()),
            stagedFiles: Object.freeze(stagedFiles.slice()),
            custodyFiles: Object.freeze(custodyFiles.slice()),
            cleanup,
        };
    } catch (error) {
        // Cleanup is best-effort on the failed preparation path. Its failure
        // must not replace the owning staging/cancellation result, especially
        // after Cancel has already established the attempt's terminal fact.
        await Promise.allSettled(cleanups.filter((cleanup) => !cleanup.persisted).map((cleanup) => cleanup.remove()));
        if (error instanceof RunnerAttachmentStagingError) throw error;
        // Cancellation is not an unavailable attachment: keep the exact abort
        // reason so the launch owner reports a canceled attempt, not a failure.
        if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error;
        throw new RunnerAttachmentStagingError('runner_attachment_unavailable');
    }
}
