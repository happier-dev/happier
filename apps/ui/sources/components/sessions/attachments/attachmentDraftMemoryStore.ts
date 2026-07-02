import type { AttachmentDraft } from './attachmentDraftModel';

const ATTACHMENT_DRAFT_STORE_MAX_ENTRIES = 50;

type AttachmentDraftStoreEntry = Readonly<{
    drafts: readonly AttachmentDraft[];
    updatedAt: number;
}>;

const attachmentDraftMemoryStore = new Map<string, AttachmentDraftStoreEntry>();

function copyAttachmentDrafts(drafts: readonly AttachmentDraft[]): AttachmentDraft[] {
    return drafts.map((draft) => ({
        ...draft,
        source: { ...draft.source },
        uploadProgress: draft.uploadProgress ? { ...draft.uploadProgress } : undefined,
    }));
}

function pruneAttachmentDraftStore(): void {
    if (attachmentDraftMemoryStore.size <= ATTACHMENT_DRAFT_STORE_MAX_ENTRIES) return;

    const keysByOldestUpdate = Array.from(attachmentDraftMemoryStore.entries())
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .map(([key]) => key);

    for (const key of keysByOldestUpdate.slice(0, attachmentDraftMemoryStore.size - ATTACHMENT_DRAFT_STORE_MAX_ENTRIES)) {
        attachmentDraftMemoryStore.delete(key);
    }
}

export function readAttachmentDraftsForKey(key: string): AttachmentDraft[] {
    const entry = attachmentDraftMemoryStore.get(key);
    return entry ? copyAttachmentDrafts(entry.drafts) : [];
}

export function writeAttachmentDraftsForKey(key: string, drafts: readonly AttachmentDraft[]): void {
    if (drafts.length === 0) {
        attachmentDraftMemoryStore.delete(key);
        return;
    }

    attachmentDraftMemoryStore.set(key, {
        drafts: copyAttachmentDrafts(drafts),
        updatedAt: Date.now(),
    });
    pruneAttachmentDraftStore();
}

export function clearAttachmentDraftsForKey(key: string): void {
    attachmentDraftMemoryStore.delete(key);
}

export function clearAttachmentDraftsForKeyPrefix(prefix: string): void {
    for (const key of attachmentDraftMemoryStore.keys()) {
        if (key.startsWith(prefix)) {
            attachmentDraftMemoryStore.delete(key);
        }
    }
}
