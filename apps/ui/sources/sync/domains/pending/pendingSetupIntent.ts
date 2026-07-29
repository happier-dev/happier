import { MMKV } from 'react-native-mmkv';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { emitPendingSetupIntentChanged, fromRecord, fromSerializedRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';
import { getActivePendingServerUrl, isPendingServerUrlActive, normalizePendingServerUrl, pendingServerScopedKey } from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-setup-intent', scope) });
const KEY_RECORD = 'record';
const KEY_RECORD_PREFIX = 'record:v2';
const KEY_SERVER_RECORD_PREFIX = 'record:server:v1';
const knownServerScopedKeys = new Set<string>();

function resolveIntentServerUrl(value: PendingSetupIntent): string | null {
    return normalizePendingServerUrl(value.relayUrl) ?? getActivePendingServerUrl();
}

function resolveActiveServerScopedKey(): string | null {
    const activeServerUrl = getActivePendingServerUrl();
    return activeServerUrl ? pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, activeServerUrl) : null;
}

function readRecord(key: string): PendingSetupIntent | null {
    const raw = storage.getString(key);
    if (!raw) return null;
    const record = fromSerializedRecord(raw);
    if (!record) {
        storage.delete(key);
        return null;
    }
    return record;
}

function dropMismatchedServerScopedIntent(activeServerScopedKey: string | null): void {
    const storageKeys = typeof (storage as unknown as { getAllKeys?: unknown }).getAllKeys === 'function'
        ? (storage as unknown as { getAllKeys: () => string[] }).getAllKeys()
        : [];
    const keys = new Set([...storageKeys, ...knownServerScopedKeys]);
    for (const key of keys) {
        if (!key.startsWith(`${KEY_SERVER_RECORD_PREFIX}:`)) continue;
        if (activeServerScopedKey && key === activeServerScopedKey) continue;
        const record = readRecord(key);
        if (!record) continue;
        storage.delete(key);
        knownServerScopedKeys.delete(key);
        console.debug('[pendingSetupIntent] dropped server-scoped setup intent after relay URL mismatch');
    }
}

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const activeScope = getActiveServerAccountScope();
    const serverUrl = resolveIntentServerUrl(value);
    if (!serverUrl || !isPendingServerUrlActive(serverUrl)) return;
    const record = toRecord({ ...value, relayUrl: normalizePendingServerUrl(value.relayUrl) ?? serverUrl });
    if (!record) return;
    if (activeScope) {
        storage.set(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope), JSON.stringify(record));
        const serverScopedKey = resolveActiveServerScopedKey();
        if (serverScopedKey) {
            storage.delete(serverScopedKey);
            knownServerScopedKeys.delete(serverScopedKey);
        }
        emitPendingSetupIntentChanged();
        return;
    }
    const serverScopedKey = pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, serverUrl);
    storage.set(serverScopedKey, JSON.stringify(record));
    knownServerScopedKeys.add(serverScopedKey);
    emitPendingSetupIntentChanged();
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        const record = readRecord(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
        if (record) return record;
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    const record = serverScopedKey ? readRecord(serverScopedKey) : null;
    if (record) return record;
    if (activeScope) {
        dropMismatchedServerScopedIntent(serverScopedKey);
    }
    return null;
}

export function clearPendingSetupIntent(): void {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        storage.delete(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    if (serverScopedKey) {
        storage.delete(serverScopedKey);
        knownServerScopedKeys.delete(serverScopedKey);
    }
    const legacy = storage.getString(KEY_RECORD);
    if (!legacy) {
        emitPendingSetupIntentChanged();
        return;
    }
    try {
        const record = fromRecord(JSON.parse(legacy) as unknown);
        if (!record || !record.relayUrl || isPendingServerUrlActive(record.relayUrl)) {
            storage.delete(KEY_RECORD);
        }
    } catch {
        storage.delete(KEY_RECORD);
    }
    emitPendingSetupIntentChanged();
}

export function migratePendingSetupIntentScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const canonicalKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, scope);
    let hasCanonicalRecord = readRecord(canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, legacyScope);
        const legacyRecord = readRecord(legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            const record = toRecord(legacyRecord);
            if (record) {
                storage.set(canonicalKey, JSON.stringify(record));
                hasCanonicalRecord = true;
                emitPendingSetupIntentChanged();
            }
        }
        storage.delete(legacyKey);
    }
}
