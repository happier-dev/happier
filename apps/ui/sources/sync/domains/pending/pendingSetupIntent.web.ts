import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { emitPendingSetupIntentChanged, fromRecord, fromSerializedRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';
import { getActivePendingServerUrl, isPendingServerUrlActive, normalizePendingServerUrl, pendingServerScopedKey } from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const STORAGE_KEY = scopedStorageId('pending-setup-intent-record', scope);
const STORAGE_KEY_PREFIX = scopedStorageId('pending-setup-intent-record:v2', scope);
const STORAGE_KEY_SERVER_PREFIX = scopedStorageId('pending-setup-intent-record:server:v1', scope);

// Backwards-compat: older web builds (and some e2e fixtures) persisted the MMKV-style key that
// mirrors the native MMKV instance id + record key.
const LEGACY_MMKV_STORAGE_KEY = `mmkv.${scopedStorageId('pending-setup-intent', scope)}\\record`;

function resolveIntentServerUrl(value: PendingSetupIntent): string | null {
    return normalizePendingServerUrl(value.relayUrl) ?? getActivePendingServerUrl();
}

function resolveActiveServerScopedKey(): string | null {
    const activeServerUrl = getActivePendingServerUrl();
    return activeServerUrl ? pendingServerScopedKey(STORAGE_KEY_SERVER_PREFIX, activeServerUrl) : null;
}

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

function readRecord(storage: Storage, key: string): PendingSetupIntent | null {
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const record = fromSerializedRecord(raw);
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

function listStorageKeys(storage: Storage): string[] {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key === 'string') keys.push(key);
    }
    return keys;
}

function dropMismatchedServerScopedIntent(storage: Storage, activeServerScopedKey: string | null): void {
    for (const key of listStorageKeys(storage)) {
        if (!key.startsWith(`${STORAGE_KEY_SERVER_PREFIX}:`)) continue;
        if (activeServerScopedKey && key === activeServerScopedKey) continue;
        const record = readRecord(storage, key);
        if (!record) continue;
        try {
            storage.removeItem(key);
            console.debug('[pendingSetupIntent] dropped server-scoped setup intent after relay URL mismatch');
        } catch {
            // ignore storage failures
        }
    }
}

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const storage = getStorage();
    if (!storage) return;
    const activeScope = getActiveServerAccountScope();
    const serverUrl = resolveIntentServerUrl(value);
    if (!serverUrl || !isPendingServerUrlActive(serverUrl)) return;
    const record = toRecord({ ...value, relayUrl: normalizePendingServerUrl(value.relayUrl) ?? serverUrl });
    if (!record) return;
    try {
        const payload = JSON.stringify(record);
        if (activeScope) {
            storage.setItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope), payload);
            const serverScopedKey = resolveActiveServerScopedKey();
            if (serverScopedKey) storage.removeItem(serverScopedKey);
            emitPendingSetupIntentChanged();
            return;
        }
        storage.setItem(pendingServerScopedKey(STORAGE_KEY_SERVER_PREFIX, serverUrl), payload);
        emitPendingSetupIntentChanged();
    } catch {
        // ignore storage failures
    }
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const storage = getStorage();
    if (!storage) return null;
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        const scoped = readRecord(storage, serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope));
        if (scoped) return scoped;
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    const record = serverScopedKey ? readRecord(storage, serverScopedKey) : null;
    if (record) return record;
    if (activeScope) {
        dropMismatchedServerScopedIntent(storage, serverScopedKey);
    }

    const legacy = readRecord(storage, STORAGE_KEY) ?? readRecord(storage, LEGACY_MMKV_STORAGE_KEY);
    if (!legacy) return null;
    if (legacy.relayUrl && !isPendingServerUrlActive(legacy.relayUrl)) return null;

    // Migrate forward so future reads can be single-key.
    const next = toRecord(legacy);
    if (next) {
        try {
            if (activeScope) {
                storage.setItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope), JSON.stringify(next));
            } else if (serverScopedKey) {
                storage.setItem(serverScopedKey, JSON.stringify(next));
            }
            storage.removeItem(STORAGE_KEY);
            storage.removeItem(LEGACY_MMKV_STORAGE_KEY);
        } catch {
            // ignore storage failures
        }
    }
    return legacy;
}

export function clearPendingSetupIntent(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        const activeScope = getActiveServerAccountScope();
        if (activeScope) {
            storage.removeItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope));
        }
        const serverScopedKey = resolveActiveServerScopedKey();
        if (serverScopedKey) {
            storage.removeItem(serverScopedKey);
        }
        const legacy = readRecord(storage, STORAGE_KEY) ?? readRecord(storage, LEGACY_MMKV_STORAGE_KEY);
        if (!legacy || !legacy.relayUrl || isPendingServerUrlActive(legacy.relayUrl)) {
            storage.removeItem(STORAGE_KEY);
            storage.removeItem(LEGACY_MMKV_STORAGE_KEY);
        }
        emitPendingSetupIntentChanged();
    } catch {
        // ignore storage failures
    }
}

export function migratePendingSetupIntentScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const storage = getStorage();
    if (!storage) return;
    const canonicalKey = serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope);
    let hasCanonicalRecord = readRecord(storage, canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, legacyScope);
        const legacyRecord = readRecord(storage, legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            const record = toRecord(legacyRecord);
            if (record) {
                try {
                    storage.setItem(canonicalKey, JSON.stringify(record));
                    hasCanonicalRecord = true;
                    emitPendingSetupIntentChanged();
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
