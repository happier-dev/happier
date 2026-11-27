/** Device-local large records. A successful write means the IndexedDB transaction committed. */
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

const STORE = 'records';

type BrowserRecordStore = 'records' | 'pictures' | 'sounds';
const connections = new Map<BrowserRecordStore, Promise<IDBDatabase>>();
const memoryRecords = new Map<string, string>();

export class BrowserRecordDatabaseOpenError extends Error {
    readonly code = 'indexeddb_open_failed';

    constructor(cause: unknown) {
        super('Could not open the local records database.', { cause });
        this.name = 'BrowserRecordDatabaseOpenError';
    }
}

/** Hard embed retirement never opens or clears full-app IndexedDB storage. */
export function clearEmbedBrowserRecords(): void {
    if (isEmbedWindowContext()) memoryRecords.clear();
}

/** One connection owner, with picture bytes isolated from 0.2's version-one records database. */
export function openBrowserRecordDatabase(store: BrowserRecordStore = 'records'): Promise<IDBDatabase> {
    if (isEmbedWindowContext()) return Promise.reject(new Error('Device media storage is unavailable in an embed.'));
    let connection = connections.get(store);
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('Browser storage is unavailable; local changes cannot be saved.'));
            return;
        }
        // Do not upgrade the records database: 0.2's same-origin opener explicitly requests version 1.
        const databaseName = store === 'records' ? 'happier-local-records'
            : store === 'pictures' ? 'happier-atmosphere-pictures' : 'happier-notification-sounds';
        const request = indexedDB.open(databaseName, store === 'pictures' ? 2 : undefined);
        request.onupgradeneeded = () => {
            const records = request.result.objectStoreNames.contains(store)
                ? request.transaction!.objectStore(store) : request.result.createObjectStore(store);
            if (store !== 'records') records.createIndex('kind', 'kind');
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Browser storage upgrade is blocked by another tab.'));
        request.onsuccess = () => {
            const database = request.result;
            const openedConnection = connections.get(store);
            const invalidateConnection = () => {
                if (connections.get(store) === openedConnection) connections.delete(store);
            };
            database.onclose = () => {
                invalidateConnection();
                console.warn('Browser record storage connection closed unexpectedly; the next operation will reopen it.');
            };
            database.onversionchange = () => {
                database.close();
                invalidateConnection();
            };
            resolve(database);
        };
    }).catch((error: unknown) => {
        connections.delete(store);
        // The browser owns the on-disk path. Let the next open use a new
        // connection, and preserve the failure rather than treating storage as empty.
        throw new BrowserRecordDatabaseOpenError(error);
    });
    connections.set(store, connection);
    return connection;
}

export async function readBrowserRecord(key: string): Promise<string | undefined> {
    if (isEmbedWindowContext()) return memoryRecords.get(key);
    const database = await openBrowserRecordDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(key);
        transaction.oncomplete = () => {
            if (request.result !== undefined && typeof request.result !== 'string') {
                reject(new Error('Invalid browser record; stored data was preserved.'));
            } else {
                resolve(request.result);
            }
        };
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record read aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

/** Reads `keys` in one read-only transaction; absent keys are omitted. */
export async function readBrowserRecords(keys: readonly string[]): Promise<Map<string, string>> {
    const uniqueKeys = [...new Set(keys)];
    if (isEmbedWindowContext()) {
        return new Map(uniqueKeys.flatMap((key) => {
            const value = memoryRecords.get(key);
            return value === undefined ? [] : [[key, value] as const];
        }));
    }
    const database = await openBrowserRecordDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const store = transaction.objectStore(STORE);
        const records = new Map<string, string>();
        for (const key of uniqueKeys) {
            const request = store.get(key);
            request.onsuccess = () => {
                if (request.result === undefined) return;
                if (typeof request.result !== 'string') {
                    transaction.abort();
                    reject(new Error('Invalid browser record; stored data was preserved.'));
                    return;
                }
                records.set(key, request.result);
            };
        }
        transaction.oncomplete = () => resolve(records);
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record read aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

/** The synchronous callback runs within one transaction, including concurrent tabs. */
export async function updateBrowserRecord<T>(
    key: string,
    update: (current: string | undefined) => { value: string | undefined; result: T },
): Promise<T> {
    return updateBrowserRecords([key], (current) => {
        const next = update(current.get(key));
        return { values: new Map([[key, next.value]]), result: next.result };
    });
}

/**
 * Reads `keys` and writes the returned records (undefined deletes) in one transaction, so a
 * multi-record change commits or aborts as a whole, including against concurrent tabs.
 */
export async function updateBrowserRecords<T>(
    keys: readonly string[],
    update: (current: ReadonlyMap<string, string | undefined>) => {
        values: ReadonlyMap<string, string | undefined>;
        result: T;
    },
): Promise<T> {
    const uniqueKeys = [...new Set(keys)];
    if (isEmbedWindowContext()) {
        // The synchronous update preserves the transaction owner's read/modify/write semantics
        // in the frame's one JavaScript realm, without cross-tab storage or coordination.
        const next = update(new Map(uniqueKeys.map((key) => [key, memoryRecords.get(key)])));
        for (const [key, value] of next.values) {
            if (value === undefined) memoryRecords.delete(key);
            else memoryRecords.set(key, value);
        }
        return next.result;
    }
    const database = await openBrowserRecordDatabase();
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        const store = transaction.objectStore(STORE);
        const current = new Map<string, string | undefined>();
        let pending = uniqueKeys.length;
        let result: T;
        const apply = () => {
            try {
                const next = update(current);
                result = next.result;
                for (const [key, value] of next.values) {
                    if (value === undefined) store.delete(key);
                    else store.put(value, key);
                }
            } catch (error) {
                transaction.abort();
                reject(error);
            }
        };
        for (const key of uniqueKeys) {
            const request = store.get(key);
            request.onsuccess = () => {
                if (request.result !== undefined && typeof request.result !== 'string') {
                    transaction.abort();
                    reject(new Error('Invalid browser record; stored data was preserved.'));
                    return;
                }
                current.set(key, request.result);
                if (--pending === 0) apply();
            };
        }
        if (pending === 0) apply();
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record write aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

export function writeBrowserRecord(key: string, value: string): Promise<void> {
    return updateBrowserRecord(key, () => ({ value, result: undefined }));
}

export function deleteBrowserRecord(key: string): Promise<void> {
    return updateBrowserRecord(key, () => ({ value: undefined, result: undefined }));
}

export async function clearBrowserRecords(): Promise<void> {
    if (isEmbedWindowContext()) { memoryRecords.clear(); return; }
    const database = await openBrowserRecordDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        transaction.objectStore(STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record clear aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

function browserRecordPrefixRange(prefix: string): IDBKeyRange {
    // IndexedDB orders strings by UTF-16 code units. Advance the last unit
    // that has a successor, then drop the suffix to exclude the next prefix.
    for (let index = prefix.length - 1; index >= 0; index--) {
        const unit = prefix.charCodeAt(index);
        if (unit < 0xffff) {
            const next = prefix.slice(0, index) + String.fromCharCode(unit + 1);
            return IDBKeyRange.bound(prefix, next, false, true);
        }
    }
    // The first binary key sorts immediately after the string key space.
    return IDBKeyRange.bound(prefix, new ArrayBuffer(0), false, true);
}

export async function listBrowserRecords(prefix: string): Promise<Map<string, string>> {
    if (isEmbedWindowContext()) return new Map(Array.from(memoryRecords).filter(([key]) => key.startsWith(prefix)));
    const database = await openBrowserRecordDatabase();
    const range = browserRecordPrefixRange(prefix);
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const store = transaction.objectStore(STORE);
        // Both bulk reads share the same transaction and key order, so their results pair by index.
        const keys = store.getAllKeys(range);
        const values: IDBRequest<unknown[]> = store.getAll(range);
        transaction.oncomplete = () => {
            const records = new Map<string, string>();
            for (const [index, key] of keys.result.entries()) {
                const value = values.result[index];
                if (typeof key !== 'string' || typeof value !== 'string') {
                    reject(new Error('Invalid browser record; stored data was preserved.'));
                    return;
                }
                records.set(key, value);
            }
            resolve(records);
        };
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record listing aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}
