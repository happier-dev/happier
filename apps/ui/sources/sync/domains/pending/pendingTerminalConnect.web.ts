import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { getActivePendingServerUrl, isPendingServerUrlActive, normalizePendingServerUrl, pendingServerScopedKey } from './pendingServerScopedKeys';

const STORAGE_KEY = scopedStorageId('pending-terminal-connect-record', readStorageScopeFromEnv());
const STORAGE_KEY_PREFIX = scopedStorageId('pending-terminal-connect-record:v2', readStorageScopeFromEnv());

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

export function setPendingTerminalConnect(value: PendingTerminalConnect): void {
    const storage = getStorage();
    if (!storage) return;
    const serverUrl = normalizePendingServerUrl(value.serverUrl);
    if (!serverUrl) return;
    const record = toRecord({ ...value, serverUrl });
    if (!record) return;
    try {
        storage.setItem(pendingServerScopedKey(STORAGE_KEY_PREFIX, serverUrl), JSON.stringify(record));
    } catch {
        // ignore storage failures
    }
}

export function getPendingTerminalConnect(): PendingTerminalConnect | null {
    const storage = getStorage();
    if (!storage) return null;
    const activeServerUrl = getActivePendingServerUrl();
    if (!activeServerUrl) return null;
    const key = pendingServerScopedKey(STORAGE_KEY_PREFIX, activeServerUrl);
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        const record = fromRecord(parsed);
        if (!record) {
            storage.removeItem(key);
            return null;
        }
        return record;
    } catch {
        storage.removeItem(key);
        return null;
    }
}

export function clearPendingTerminalConnect(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        const activeServerUrl = getActivePendingServerUrl();
        if (activeServerUrl) {
            storage.removeItem(pendingServerScopedKey(STORAGE_KEY_PREFIX, activeServerUrl));
        }
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return;
        const record = fromRecord(JSON.parse(raw) as unknown);
        if (!record || isPendingServerUrlActive(record.serverUrl)) {
            storage.removeItem(STORAGE_KEY);
        }
    } catch {
        // ignore storage failures
    }
}
