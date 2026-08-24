import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import {
    clearAttachmentDraftsFromMemory,
    clearAttachmentDraftsFromMemoryByPrefix,
    getAttachmentDraftMemoryStoreRevision,
    readAttachmentDraftsFromMemory,
    subscribeAttachmentDraftMemoryStore,
    writeAttachmentDraftsToMemory,
} from '@/components/sessions/attachments/attachmentDraftMemoryStore';

function buildNewSessionAttachmentDraftKey(flowId: string | null | undefined): string | null {
    if (typeof flowId !== 'string') return null;
    const trimmed = flowId.trim();
    return trimmed.length > 0 ? `new-session:${trimmed}` : null;
}

export function readNewSessionAttachmentDrafts(flowId: string | null | undefined): readonly AttachmentDraft[] {
    return readAttachmentDraftsFromMemory(buildNewSessionAttachmentDraftKey(flowId));
}

export function writeNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    drafts: readonly AttachmentDraft[],
): void {
    writeAttachmentDraftsToMemory(buildNewSessionAttachmentDraftKey(flowId), drafts);
}

export function clearNewSessionAttachmentDrafts(flowId: string | null | undefined): void {
    clearAttachmentDraftsFromMemory(buildNewSessionAttachmentDraftKey(flowId));
}

export function clearAllNewSessionAttachmentDrafts(): void {
    clearAttachmentDraftsFromMemoryByPrefix('new-session:');
}

export const subscribeNewSessionAttachmentDrafts = subscribeAttachmentDraftMemoryStore;
export const getNewSessionAttachmentDraftsRevision = getAttachmentDraftMemoryStoreRevision;
