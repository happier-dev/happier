import { sessionAttachmentsUploadFile, type AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { SessionAttachmentsUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { AttachmentDraft } from './attachmentDraftModel';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { uploadAttachmentDraftsToSession, type AttachmentTargetUploadedDraftCheckpoint, type IssuedUploadedAttachment } from './uploadAttachmentDraftsToSession';

export function isAttachmentTargetUploadCheckpointFor(
    checkpoint: AttachmentTargetUploadedDraftCheckpoint,
    target: ExactSessionMachineTargetIdentity,
    messageLocalId: string,
    executionTarget: SessionExecutionTargetV1,
): boolean {
    return checkpoint.target.serverId === target.serverId && checkpoint.target.accountId === target.accountId
        && checkpoint.target.sessionId === target.sessionId && checkpoint.messageLocalId === messageLocalId
        && checkpoint.executionTarget?.serverId === executionTarget.serverId
        && checkpoint.executionTarget?.machineId === executionTarget.machineId;
}

export function recordAttachmentTargetUploadCheckpoint(
    previous: readonly AttachmentTargetUploadedDraftCheckpoint[] | undefined,
    checkpoint: AttachmentTargetUploadedDraftCheckpoint,
): readonly AttachmentTargetUploadedDraftCheckpoint[] {
    return [...(previous ?? []).filter(entry => entry.messageLocalId === checkpoint.messageLocalId
        && !isAttachmentTargetUploadCheckpointFor(entry,
            checkpoint.target, checkpoint.messageLocalId, checkpoint.executionTarget)), checkpoint];
}

/** Capture once at composer submission, before asynchronous target preparation or fanout. */
export function captureSessionMessageAttachmentDrafts(drafts: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    // Files are immutable browser blobs. Memory content needs its own invocation copy;
    // native URIs retain the ordinary uploader's source-file lifetime contract.
    const captureFile = (source: AttachmentsUploadFileSource): AttachmentsUploadFileSource => source.kind === 'memory'
        ? { ...source, bytes: new Uint8Array(source.bytes) } : { ...source };
    return drafts.map(({ id, source, targetUploadedCheckpoints, edit, browserAnnotation, errorCode, error }) => ({
        id,
        ...(edit ? { edit } : {}),
        ...(browserAnnotation ? { browserAnnotation } : {}),
        source: source.kind === 'folder' ? { ...source, entries: source.entries.map(entry => ({ ...entry, source: captureFile(entry.source) })),
            ...(source.directories ? { directories: [...source.directories] } : {}) } : captureFile(source),
        status: errorCode === 'attachment_source_missing' ? 'error' : 'pending',
        ...(errorCode === 'attachment_source_missing' ? { errorCode, error } : {}),
        ...(targetUploadedCheckpoints ? { targetUploadedCheckpoints: targetUploadedCheckpoints.map(checkpoint => ({
            ...checkpoint, target: { ...checkpoint.target },
            ...(checkpoint.executionTarget ? { executionTarget: { ...checkpoint.executionTarget } } : {}),
            ...(checkpoint.attachmentHandle ? { attachmentHandle: { ...checkpoint.attachmentHandle } } : {}),
        })) } : {}),
    }));
}

/** Upload original composer sources to one resolved leaf; source-session checkpoints have no authority here. */
export async function uploadSessionMessageAttachmentDrafts(args: Readonly<{
    target: ExactSessionMachineTargetIdentity;
    executionTarget: SessionExecutionTargetV1;
    drafts: readonly AttachmentDraft[];
    config: AttachmentsUploadConfig;
    messageLocalId: string;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    onUploadedDraftCheckpoint?: (checkpoint: AttachmentTargetUploadedDraftCheckpoint) => Promise<void> | void;
    uploadFile?: typeof sessionAttachmentsUploadFile;
}>): Promise<readonly IssuedUploadedAttachment[] | null> {
    const isCurrent = () => !args.signal?.aborted && args.isCurrent();
    if (!isCurrent()) return null;

    const drafts = captureSessionMessageAttachmentDrafts(args.drafts).map(draft => {
        const checkpoint = draft.targetUploadedCheckpoints?.find(entry => entry.id === draft.id
            && isAttachmentTargetUploadCheckpointFor(entry, args.target, args.messageLocalId, args.executionTarget));
        if (!checkpoint) return draft;
        const { target: _target, executionTarget: _executionTarget, messageLocalId: _messageLocalId, ...uploaded } = checkpoint;
        return { ...draft, ...uploaded };
    });
    const assertCurrent = () => {
        if (!isCurrent()) throw new Error('Session attachment preparation is no longer current');
    };
    try {
        const uploaded = await uploadAttachmentDraftsToSession({
            sessionId: args.target.sessionId,
            sessionTarget: args.target,
            drafts,
            config: args.config,
            messageLocalId: args.messageLocalId,
            signal: args.signal,
            // Ordinary source upload fields never acquire target-local path authority.
            applyDraftPatch: () => {},
            uploadFile: async (request) => {
                assertCurrent();
                const result = await (args.uploadFile ?? sessionAttachmentsUploadFile)({
                    ...request,
                    ...(args.signal ? { signal: args.signal } : {}),
                    isCurrent,
                });
                assertCurrent();
                if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(result)) {
                    return {
                        ...result,
                        recovery: {
                            ...result.recovery,
                            invoke: async (action, signal) => {
                                assertCurrent();
                                const recovered = await result.recovery.invoke(action, signal);
                                assertCurrent();
                                return recovered;
                            },
                        },
                    };
                }
                return result;
            },
            onUploadedDraftCheckpoint: async checkpoint => {
                assertCurrent();
                await args.onUploadedDraftCheckpoint?.({ ...checkpoint,
                    target: { ...args.target }, executionTarget: { ...args.executionTarget }, messageLocalId: args.messageLocalId });
                assertCurrent();
            },
        });
        assertCurrent();
        return uploaded.uploaded;
    } catch {
        // Preparation refusal keeps the original composer sources available for a fresh retry.
        return null;
    }
}
