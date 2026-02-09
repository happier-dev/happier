import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';

const STORAGE_KEY = scopedStorageId('pending-terminal-connect-record', readStorageScopeFromEnv());

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

export function setPendingTerminalConnect(value: PendingTerminalConnect): void {
    const storage = getStorage();
    if (!storage) return;
    const record = toRecord(value);
    if (!record) return;
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
        // ignore storage failures
    }
}

export function getPendingTerminalConnect(): PendingTerminalConnect | null {
    const storage = getStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        const record = fromRecord(parsed);
        if (!record) {
            storage.removeItem(STORAGE_KEY);
            return null;
        }
        return record;
    } catch {
        storage.removeItem(STORAGE_KEY);
        return null;
    }
}

export function clearPendingTerminalConnect(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        storage.removeItem(STORAGE_KEY);
    } catch {
        // ignore storage failures
    }
}
