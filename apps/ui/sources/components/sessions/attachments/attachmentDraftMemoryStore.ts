import { removeSubmittedAttachmentDrafts, type AttachmentDraft } from './attachmentDraftModel';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const EMPTY_DRAFTS: readonly AttachmentDraft[] = Object.freeze([]);
type Entry = { drafts: readonly AttachmentDraft[]; scope?: ServerAccountScope; loaded: boolean;
    loading?: Promise<void>; saving?: Promise<void>; loadError?: unknown; cleared?: boolean };
const attachmentDraftMemoryStore = new Map<string, Entry>();
type DraftChange = 'changed' | 'cleared';
// Moved from New Session: all mounted attachment consumers follow this one memory owner.
const listeners = new Set<Readonly<{ key: string; changed: (event: DraftChange) => void }>>();

function notify(key: string, event: DraftChange): void {
    for (const listener of [...listeners]) if (listener.key === key) listener.changed(event);
}

function entryFor(key: string): Entry {
    let entry = attachmentDraftMemoryStore.get(key);
    if (!entry) { entry = { drafts: EMPTY_DRAFTS, loaded: true }; attachmentDraftMemoryStore.set(key, entry); }
    return entry;
}

/** The typed address owner supplies Account identity; opaque occurrence keys are never parsed. */
export function bindAttachmentDraftPersistence(key: string, scope: ServerAccountScope): void {
    const entry = entryFor(key);
    if (entry.scope) return;
    entry.scope = scope;
    entry.loaded = false;
}

function load(key: string, entry: Entry): Promise<void> {
    if (entry.loaded || !entry.scope) return Promise.resolve();
    if (entry.loading) return entry.loading;
    const scope = entry.scope;
    entry.loading = import('./attachmentDraftPersistence').then(({ readAttachmentDraftRecord }) => readAttachmentDraftRecord(key, scope)).then(saved => {
        // An append can arrive while storage is opening. Preserve both the saved
        // occurrences and synchronous new intake; only an explicit clear retires them.
        const newer = new Map(entry.drafts.map(draft => [draft.id, draft]));
        const restored = entry.cleared ? [] : saved.filter(draft => !newer.has(draft.id));
        entry.drafts = [...restored, ...entry.drafts];
        entry.loaded = true;
        notify(key, 'changed');
    }).catch(async (error: unknown) => {
        entry.loadError = error;
        const [{ Modal }, { t }] = await Promise.all([import('@/modal'), import('@/text')]);
        Modal.alert(t('common.error'), t('attachments.alerts.recoveryFailedBody'));
    });
    return entry.loading;
}

async function persist(key: string, entry: Entry): Promise<void> {
    if (!entry.scope) return;
    const scope = entry.scope;
    await load(key, entry);
    if (entry.loadError) throw entry.loadError;
    const { writeAttachmentDraftRecord } = await import('./attachmentDraftPersistence');
    await writeAttachmentDraftRecord(key, scope, entry.drafts);
}

function observeSaveFailure(key: string, entry: Entry): void {
    void entry.saving?.catch(() => {
        entry.drafts = entry.drafts.map(draft => draft.errorCode === 'attachment_source_missing' ? draft : {
            ...draft, status: 'error', errorCode: 'attachment_persistence_failed',
        });
        notify(key, 'changed');
    });
}

function save(key: string, entry: Entry): void {
    if (!entry.scope) return;
    const previous = entry.saving;
    entry.saving = (async () => {
        await previous?.catch(() => {});
        await persist(key, entry);
    })();
    observeSaveFailure(key, entry);
}

/** Delivery receipts wait for the same write that preserves ordinary paste/pick intake. */
export async function flushAttachmentDraftsForKey(key: string): Promise<void> {
    const entry = entryFor(key);
    await load(key, entry);
    if (entry.loadError) throw entry.loadError;
    await entry.saving;
}

/** Same-owner occurrence rollover preserves hydrated sources and newer destination intake. */
export function moveAttachmentDraftsForKey(fromKey: string, toKey: string): Promise<void> {
    if (fromKey === toKey) return flushAttachmentDraftsForKey(toKey);
    const sourceReady = flushAttachmentDraftsForKey(fromKey);
    const source = entryFor(fromKey);
    const destination = entryFor(toKey);
    const previousSave = destination.saving;
    const moving = (async () => {
        await Promise.all([sourceReady, load(toKey, destination), previousSave]);
        if (destination.loadError) throw destination.loadError;
        const carried = source.drafts;
        const destinationIds = new Set(destination.drafts.map(draft => draft.id));
        destination.drafts = [...carried.filter(draft => !destinationIds.has(draft.id)), ...destination.drafts];
        notify(toKey, 'changed');
        await persist(toKey, destination);
        // Retire only sources accepted by the destination. Its durable write
        // precedes this cleanup, which follows the source's existing save queue.
        settleAttachmentDraftsForKey(fromKey, carried);
    })();
    destination.saving = moving;
    observeSaveFailure(toKey, destination);
    return moving;
}

export function subscribeAttachmentDraftsForKey(key: string, changed: (event: DraftChange) => void): () => void {
    const listener = { key, changed };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Stable readonly snapshot for the mounted manager; public copy readers retain their API. */
export function getAttachmentDraftsSnapshotForKey(key: string): readonly AttachmentDraft[] {
    const entry = entryFor(key);
    void load(key, entry);
    return entry.drafts;
}

function copyAttachmentDrafts(drafts: readonly AttachmentDraft[]): AttachmentDraft[] {
    return drafts.map((draft) => ({
        ...draft,
        source: draft.source,
        uploadProgress: draft.uploadProgress ? { ...draft.uploadProgress } : undefined,
    }));
}

export function readAttachmentDraftsForKey(key: string): AttachmentDraft[] {
    const drafts = getAttachmentDraftsSnapshotForKey(key);
    return drafts ? copyAttachmentDrafts(drafts) : [];
}

export function writeAttachmentDraftsForKey(key: string, drafts: readonly AttachmentDraft[]): void {
    const previous = getAttachmentDraftsSnapshotForKey(key);
    if (previous.length === drafts.length && previous.every((draft, index) => draft === drafts[index])) return;
    const entry = entryFor(key);
    entry.drafts = [...drafts];
    if (drafts.length === 0) entry.cleared = true;
    if (previous.length !== drafts.length || drafts.some((draft, index) => draft.id !== previous[index]?.id || draft.source !== previous[index]?.source)) save(key, entry);
    notify(key, 'changed');
}

export function settleAttachmentDraftsForKey(key: string, submitted: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    const remaining = removeSubmittedAttachmentDrafts(getAttachmentDraftsSnapshotForKey(key), submitted);
    writeAttachmentDraftsForKey(key, remaining);
    return remaining;
}

export function patchAttachmentDraftForKey(key: string, id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, expectedSource?: AttachmentDraft['source']): void {
    const drafts = getAttachmentDraftsSnapshotForKey(key);
    if (!drafts.some(draft => draft.id === id && (!expectedSource || draft.source === expectedSource))) return;
    writeAttachmentDraftsForKey(key, drafts.map(draft => draft.id === id ? { ...draft, ...patch } : draft));
}

export function clearAttachmentDraftsForKey(key: string): void {
    const entry = entryFor(key);
    entry.drafts = EMPTY_DRAFTS;
    entry.cleared = true;
    save(key, entry);
    notify(key, 'cleared');
}

export function clearAttachmentDraftsForKeyPrefix(prefix: string): void {
    const keys = new Set([...attachmentDraftMemoryStore.keys(), ...[...listeners].map(listener => listener.key)]);
    for (const key of keys) {
        if (key.startsWith(prefix)) {
            clearAttachmentDraftsForKey(key);
        }
    }
}
