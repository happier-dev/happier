import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';

type NewSessionAttachmentDraftStoreEntry = Readonly<{
    drafts: readonly AttachmentDraft[];
    updatedAt: number;
}>;

const NEW_SESSION_ATTACHMENT_DRAFT_MAX_AGE_MS = 10 * 60 * 1000;
const NEW_SESSION_ATTACHMENT_DRAFT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const newSessionAttachmentDraftStore = new Map<string, NewSessionAttachmentDraftStoreEntry>();

function normalizeFlowId(flowId: string | null | undefined): string | null {
    if (typeof flowId !== 'string') return null;
    const trimmed = flowId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function cloneDrafts(drafts: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    return drafts.map((draft) => ({ ...draft }));
}

function cleanupStaleEntries(now: number = Date.now()): void {
    for (const [flowId, entry] of newSessionAttachmentDraftStore.entries()) {
        if (now - entry.updatedAt <= NEW_SESSION_ATTACHMENT_DRAFT_MAX_AGE_MS) continue;
        newSessionAttachmentDraftStore.delete(flowId);
    }
}

setInterval(() => {
    cleanupStaleEntries();
}, NEW_SESSION_ATTACHMENT_DRAFT_CLEANUP_INTERVAL_MS);

export function readNewSessionAttachmentDrafts(flowId: string | null | undefined): readonly AttachmentDraft[] {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return [];

    cleanupStaleEntries();
    const entry = newSessionAttachmentDraftStore.get(normalizedFlowId);
    return entry ? cloneDrafts(entry.drafts) : [];
}

export function writeNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    drafts: readonly AttachmentDraft[],
): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;

    if (drafts.length === 0) {
        newSessionAttachmentDraftStore.delete(normalizedFlowId);
        return;
    }

    newSessionAttachmentDraftStore.set(normalizedFlowId, {
        drafts: cloneDrafts(drafts),
        updatedAt: Date.now(),
    });
}

export function clearNewSessionAttachmentDrafts(flowId: string | null | undefined): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;
    newSessionAttachmentDraftStore.delete(normalizedFlowId);
}

export function clearAllNewSessionAttachmentDrafts(): void {
    newSessionAttachmentDraftStore.clear();
}
