import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { describeAttachmentUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { randomUUID } from '@/platform/randomUUID';
import type { AttachmentDraft } from './attachmentDraftModel';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export type AttachmentDraftEagerUploadTarget = Readonly<{
    sessionId: string;
    sessionTarget?: ExactSessionMachineTargetIdentity;
    config: AttachmentsUploadConfig;
    transferContext?: SessionAttachmentTransferContext;
}>;

function sourceSizeBytes(source: AttachmentUploadSource): number | null {
    return source.kind === 'folder'
        ? source.entries.reduce((total, entry) => total + (sourceSizeBytes(entry.source) ?? 0), 0)
        : describeAttachmentUploadFileSource(source).sizeBytes;
}

/** Shared intake for picked/pasted sources and sources appended from another surface. */
export function admitAttachmentDraftSources(input: Readonly<{
    sources: readonly AttachmentUploadSource[];
    maxFileBytes: number;
}>): Readonly<{ drafts: readonly AttachmentDraft[]; skippedOversizeCount: number }> {
    const drafts: AttachmentDraft[] = [];
    let skippedOversizeCount = 0;
    for (const source of input.sources) {
        const files = source.kind === 'folder' ? source.entries.map(entry => entry.source) : [source];
        if (files.some(file => (sourceSizeBytes(file) ?? 0) > input.maxFileBytes)) {
            skippedOversizeCount += 1;
            continue;
        }
        drafts.push({ id: randomUUID(), source, status: 'pending' });
    }
    return { drafts, skippedOversizeCount };
}

/** Only folders upload at intake; ordinary files and pictures stay local until Send. */
export function startEagerAttachmentDraftUploads(input: Readonly<{
    drafts: readonly AttachmentDraft[];
    target?: AttachmentDraftEagerUploadTarget;
    activeUploads: Map<string, AbortController>;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, source: AttachmentUploadSource) => void;
}>): void {
    const target = input.target;
    if (!target) return;
    for (const draft of input.drafts) {
        if (draft.source.kind !== 'folder' || draft.status !== 'pending' || draft.uploadedPath || input.activeUploads.has(draft.id)) continue;
        const controller = new AbortController();
        input.activeUploads.set(draft.id, controller);
        void import('./uploadAttachmentDraftsToSession').then(({ uploadAttachmentDraftsToSession }) => uploadAttachmentDraftsToSession({
            ...target, drafts: [draft], signal: controller.signal,
            applyDraftPatch: (id, patch) => input.applyDraftPatch(id, patch, draft.source),
        })).catch(() => {
            // The upload owner has already projected the failure onto this draft.
        }).finally(() => {
            if (input.activeUploads.get(draft.id) === controller) input.activeUploads.delete(draft.id);
        });
    }
}
