import type { AttachmentDraft } from './attachmentDraftModel';

type AttachmentDraftMemoryStoreEntry = Readonly<{
    drafts: readonly AttachmentDraft[];
    updatedAt: number;
}>;

const ATTACHMENT_DRAFT_MEMORY_STORE_MAX_KEYS = 100;

const attachmentDraftMemoryStore = new Map<string, AttachmentDraftMemoryStoreEntry>();
const attachmentDraftMemoryStoreListeners = new Set<() => void>();
let attachmentDraftMemoryStoreRevision = 0;

function emitAttachmentDraftMemoryStoreChange(): void {
    attachmentDraftMemoryStoreRevision += 1;
    for (const listener of attachmentDraftMemoryStoreListeners) listener();
}

export function subscribeAttachmentDraftMemoryStore(listener: () => void): () => void {
    attachmentDraftMemoryStoreListeners.add(listener);
    return () => attachmentDraftMemoryStoreListeners.delete(listener);
}

export function getAttachmentDraftMemoryStoreRevision(): number {
    return attachmentDraftMemoryStoreRevision;
}

function normalizeDraftMemoryKey(key: string | null | undefined): string | null {
    if (typeof key !== 'string') return null;
    const trimmed = key.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function cloneDrafts(drafts: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    return drafts.map((draft) => ({
        ...draft,
        source: { ...draft.source },
        uploadProgress: draft.uploadProgress ? { ...draft.uploadProgress } : undefined,
    }));
}

function enforceMemorySafetyCap(): void {
    if (attachmentDraftMemoryStore.size <= ATTACHMENT_DRAFT_MEMORY_STORE_MAX_KEYS) return;

    const entriesByAge = [...attachmentDraftMemoryStore.entries()]
        .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
    const removeCount = attachmentDraftMemoryStore.size - ATTACHMENT_DRAFT_MEMORY_STORE_MAX_KEYS;
    for (const [key] of entriesByAge.slice(0, removeCount)) {
        attachmentDraftMemoryStore.delete(key);
    }
}

export function readAttachmentDraftsFromMemory(key: string | null | undefined): readonly AttachmentDraft[] {
    const normalizedKey = normalizeDraftMemoryKey(key);
    if (!normalizedKey) return [];

    const entry = attachmentDraftMemoryStore.get(normalizedKey);
    return entry ? cloneDrafts(entry.drafts) : [];
}

export function writeAttachmentDraftsToMemory(
    key: string | null | undefined,
    drafts: readonly AttachmentDraft[],
): void {
    const normalizedKey = normalizeDraftMemoryKey(key);
    if (!normalizedKey) return;

    if (drafts.length === 0) {
        if (attachmentDraftMemoryStore.delete(normalizedKey)) emitAttachmentDraftMemoryStoreChange();
        return;
    }

    attachmentDraftMemoryStore.set(normalizedKey, {
        drafts: cloneDrafts(drafts),
        updatedAt: Date.now(),
    });
    enforceMemorySafetyCap();
    emitAttachmentDraftMemoryStoreChange();
}

export function clearAttachmentDraftsFromMemory(key: string | null | undefined): void {
    const normalizedKey = normalizeDraftMemoryKey(key);
    if (!normalizedKey) return;
    if (attachmentDraftMemoryStore.delete(normalizedKey)) emitAttachmentDraftMemoryStoreChange();
}

export function clearAttachmentDraftsFromMemoryByPrefix(prefix: string | null | undefined): void {
    const normalizedPrefix = normalizeDraftMemoryKey(prefix);
    if (!normalizedPrefix) return;

    let changed = false;
    for (const key of attachmentDraftMemoryStore.keys()) {
        if (key.startsWith(normalizedPrefix)) {
            attachmentDraftMemoryStore.delete(key);
            changed = true;
        }
    }
    if (changed) emitAttachmentDraftMemoryStoreChange();
}

export function clearAllAttachmentDraftsFromMemory(): void {
    if (attachmentDraftMemoryStore.size === 0) return;
    attachmentDraftMemoryStore.clear();
    emitAttachmentDraftMemoryStoreChange();
}
