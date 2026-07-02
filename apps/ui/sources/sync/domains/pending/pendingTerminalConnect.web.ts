import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { isPendingServerUrlActive, normalizePendingServerUrl } from './pendingServerScopedKeys';

const STORAGE_KEY = scopedStorageId('pending-terminal-connect-record', readStorageScopeFromEnv());
const STORAGE_KEY_PREFIX = scopedStorageId('pending-terminal-connect-record:v2', readStorageScopeFromEnv());

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

function readScopedRecord(storage: Storage, key: string): PendingTerminalConnect | null {
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

export function setPendingTerminalConnect(value: PendingTerminalConnect): void {
    const storage = getStorage();
    if (!storage) return;
    const activeScope = getActiveServerAccountScope();
    const serverUrl = normalizePendingServerUrl(value.serverUrl);
    if (!serverUrl || !activeScope || !isPendingServerUrlActive(serverUrl)) return;
    const record = toRecord({ ...value, serverUrl });
    if (!record) return;
    try {
        storage.setItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope), JSON.stringify(record));
    } catch {
        // ignore storage failures
    }
}

export function getPendingTerminalConnect(): PendingTerminalConnect | null {
    const storage = getStorage();
    if (!storage) return null;
    const activeScope = getActiveServerAccountScope();
    if (!activeScope) return null;
    return readScopedRecord(storage, serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope));
}

export function clearPendingTerminalConnect(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        const activeScope = getActiveServerAccountScope();
        if (activeScope) {
            storage.removeItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope));
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

export function migratePendingTerminalConnectScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const storage = getStorage();
    if (!storage) return;
    const canonicalKey = serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope);
    let hasCanonicalRecord = readScopedRecord(storage, canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, legacyScope);
        const legacyRecord = readScopedRecord(storage, legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            const record = toRecord(legacyRecord);
            if (record) {
                try {
                    storage.setItem(canonicalKey, JSON.stringify(record));
                    hasCanonicalRecord = true;
                } catch {
                    // ignore storage failures
                }
            }
        }
        try {
            storage.removeItem(legacyKey);
        } catch {
            // ignore storage failures
        }
    }
}
