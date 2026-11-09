import { Platform } from 'react-native';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { listBrowserRecords, readBrowserRecord, updateBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
import {
    isLegacySessionDraftScopeRecord,
    legacySessionDraftRowKeys,
    migrateLegacySessionDraftScope,
    parseSessionDraftScopeEnvelope,
    SESSION_DRAFT_RECORD_UNREAD,
    sessionDraftStoredRecordsEqual,
} from './sessionDraftSerializedScope';

const PREFIX = 'session-drafts-repository-v1:';

type RecordsUpdate = (current: ReadonlyMap<string, string | undefined>) => {
    values: ReadonlyMap<string, string | undefined>;
    result: void;
};
type Dependencies = {
    legacy: { getAllKeys(): string[]; getString(key: string): string | undefined; delete(key: string): void };
    records: {
        list(): Promise<Map<string, string>>;
        read(key: string): Promise<string | undefined>;
        /** One transaction over `keys`: every returned change commits, or none does. */
        updateMany(keys: readonly string[], update: RecordsUpdate): Promise<void>;
    };
};

/**
 * A future storage format refuses startup (an object carrying an unknown `v`, or non-JSON bytes).
 * Any other JSON value is a draft record; the repository marks an unreadable one as retained
 * custody of its own scope.
 */
function isRecognizedDraftRecord(raw: string): boolean {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('v' in parsed)) return true;
        return isLegacySessionDraftScopeRecord(raw) || parseSessionDraftScopeEnvelope(raw) !== null;
    } catch {
        return false;
    }
}

const CONFLICT_MESSAGE = 'This draft changed in another tab. Stored drafts and your unsaved edits were preserved.';

/**
 * Browser draft records, one per draft (see `sessionDraftRowKey`). Writes are keyed, so an
 * autosave commits only the records the repository changed, in one transaction.
 */
export function createSessionDraftPersistenceStorage({ legacy, records }: Dependencies) {
    const values = new Map<string, string>();
    const dirty = new Map<string, string | undefined>();
    // Per record, the last value this tab read or committed: the baseline that tells a stale
    // local edit apart from another tab's newer write of the same draft.
    const previousRequested = new Map<string, string>();
    let ready = false;
    let preparation: Promise<void> | undefined;
    let flushing: Promise<void> | undefined;

    function assertReady() {
        if (!ready) throw new Error('Draft storage has not finished loading. Your saved drafts have not been discarded.');
    }

    /**
     * Moves one whole-scope record into rows in one transaction. An IndexedDB source is re-read
     * inside the transaction (a sibling tab may have migrated or rewritten it); the migration sees
     * only records this transaction read, so a draft added after listing refuses rather than
     * overwriting. On refusal the scope keeps a whole-scope record (a Web Storage copy moves into
     * the empty IndexedDB scope record), and the repository reads that scope alone as unreadable
     * retained custody. Returns whether the source is now held in IndexedDB.
     */
    async function migrateScopeRecord(key: string, listedRaw: string, source: 'records' | 'legacy'): Promise<boolean> {
        let outcome: 'migrated' | 'retained' | 'refused' = 'migrated';
        await records.updateMany([key, ...legacySessionDraftRowKeys(key, listedRaw)], (current) => {
            const legacyRaw = source === 'records' ? current.get(key) : listedRaw;
            if (!isLegacySessionDraftScopeRecord(legacyRaw)) return { values: new Map(), result: undefined };
            const changes = migrateLegacySessionDraftScope(key, legacyRaw,
                (rowKey) => current.has(rowKey) ? current.get(rowKey) : SESSION_DRAFT_RECORD_UNREAD);
            if (changes) return { values: changes, result: undefined };
            if (source === 'legacy' && current.get(key) === undefined) {
                outcome = 'retained';
                return { values: new Map([[key, legacyRaw]]), result: undefined };
            }
            outcome = 'refused';
            return { values: new Map(), result: undefined };
        });
        if (outcome !== 'migrated') {
            console.warn('Session draft migration refused for one Account: a stored draft differs from the whole-scope copy; both were kept.');
        }
        return outcome !== 'refused' || source === 'records';
    }

    async function prepare(): Promise<void> {
        if (ready) return;
        if (preparation) return preparation;
        preparation = (async () => {
            let stored = await records.list();
            let migrated = false;
            for (const [key, value] of stored) {
                if (!isLegacySessionDraftScopeRecord(value)) continue;
                await migrateScopeRecord(key, value, 'records');
                migrated = true;
            }
            for (const key of legacy.getAllKeys().filter((key) => key.startsWith(PREFIX))) {
                const previous = legacy.getString(key);
                if (previous === undefined) continue;
                if (!isLegacySessionDraftScopeRecord(previous)) {
                    throw new Error('Unrecognized draft storage format. Stored drafts were preserved.');
                }
                migrated = true;
                // Delete the Web Storage copy only once IndexedDB holds it (migrated or retained).
                if (await migrateScopeRecord(key, previous, 'legacy') && legacy.getString(key) === previous) legacy.delete(key);
            }
            if (migrated) stored = await records.list();
            for (const value of stored.values()) {
                if (!isRecognizedDraftRecord(value)) {
                    throw new Error('Unrecognized draft storage format. Stored drafts were preserved.');
                }
            }
            values.clear();
            previousRequested.clear();
            for (const [key, value] of stored) {
                values.set(key, value);
                previousRequested.set(key, value);
            }
            ready = true;
        })().finally(() => { preparation = undefined; });
        return preparation;
    }

    async function flush(): Promise<void> {
        assertReady();
        if (flushing) {
            await flushing;
            if (dirty.size) await flush();
            return;
        }
        flushing = (async () => {
            while (dirty.size) {
                const batch = new Map(dirty);
                await records.updateMany([...batch.keys()], (current) => {
                    const changes = new Map<string, string | undefined>();
                    for (const [key, value] of batch) {
                        const stored = current.get(key);
                        if (stored === value) continue;
                        // Another tab may have written the same value, but never a different
                        // draft over the one this tab last saw.
                        if (!sessionDraftStoredRecordsEqual(stored, previousRequested.get(key))
                            && !sessionDraftStoredRecordsEqual(stored, value)) {
                            throw new Error(CONFLICT_MESSAGE);
                        }
                        changes.set(key, value);
                    }
                    return { values: changes, result: undefined };
                });
                for (const [key, value] of batch) {
                    if (value === undefined) previousRequested.delete(key);
                    else previousRequested.set(key, value);
                    if (dirty.get(key) === value) dirty.delete(key);
                }
            }
        })().finally(() => { flushing = undefined; });
        return flushing;
    }

    function change(key: string, value: string | undefined) {
        assertReady();
        if (value === undefined) values.delete(key);
        else values.set(key, value);
        dirty.set(key, value);
        // The repository owns autosave scheduling and publishes durability failures to subscribers.
    }

    return {
        getString: (key: string) => { assertReady(); return values.get(key); },
        getAllKeys: () => { assertReady(); return [...values.keys()]; },
        set: (key: string, value: string) => change(key, value),
        delete: (key: string) => change(key, undefined),
        prepare,
        flush,
        /** Adopts the committed value of one draft record; other records keep their local edits. */
        refresh: async (key: string) => {
            await prepare();
            await flush();
            // Reuse the existing local-storage operation lifetime so a sibling autosave
            // cannot commit its old target baseline while this read adopts the returning draft.
            while (flushing) await flushing;
            flushing = (async () => {
                const stored = await records.read(key);
                dirty.delete(key);
                if (stored === undefined) {
                    values.delete(key);
                    previousRequested.delete(key);
                } else {
                    values.set(key, stored);
                    previousRequested.set(key, stored);
                }
            })().finally(() => { flushing = undefined; });
            await flushing;
        },
        discardPendingWrites: async () => {
            // Explicit local-data clearing may discard failed writes, unlike normal autosave.
            await preparation?.catch(() => {});
            dirty.clear();
            await flushing?.catch(() => {});
            dirty.clear();
            values.clear();
            previousRequested.clear();
        },
    };
}

let browserStorage: ReturnType<typeof createSessionDraftPersistenceStorage> | undefined;

export function getSessionDraftPersistenceStorage() {
    if (isEmbedWindowContext() || Platform.OS !== 'web') return getPersistenceStorage();
    browserStorage ??= createSessionDraftPersistenceStorage({
        legacy: getPersistenceStorage(),
        records: {
            list: () => listBrowserRecords(PREFIX),
            read: readBrowserRecord,
            updateMany: updateBrowserRecords,
        },
    });
    return browserStorage;
}

export async function prepareSessionDraftPersistenceStorage(): Promise<void> {
    const storage = getSessionDraftPersistenceStorage();
    if ('prepare' in storage) await storage.prepare();
}

export async function discardSessionDraftPersistenceWrites(): Promise<void> {
    await browserStorage?.discardPendingWrites();
}
