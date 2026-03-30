import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';

const STORAGE_KEY = scopedStorageId('pending-setup-intent-record', readStorageScopeFromEnv());

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

export function setPendingSetupIntent(value: PendingSetupIntent): void {
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

export function getPendingSetupIntent(): PendingSetupIntent | null {
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

export function clearPendingSetupIntent(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        storage.removeItem(STORAGE_KEY);
    } catch {
        // ignore storage failures
    }
}
