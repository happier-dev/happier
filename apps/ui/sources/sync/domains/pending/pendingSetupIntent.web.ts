import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';
import { getActivePendingServerUrl, isPendingServerUrlActive, normalizePendingServerUrl, pendingServerScopedKey } from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const STORAGE_KEY = scopedStorageId('pending-setup-intent-record', scope);
const STORAGE_KEY_PREFIX = scopedStorageId('pending-setup-intent-record:v2', scope);

// Backwards-compat: older web builds (and some e2e fixtures) persisted the MMKV-style key that
// mirrors the native MMKV instance id + record key.
const LEGACY_MMKV_STORAGE_KEY = `mmkv.${scopedStorageId('pending-setup-intent', scope)}\\record`;

function resolveIntentServerUrl(value: PendingSetupIntent): string | null {
    return normalizePendingServerUrl(value.relayUrl) ?? getActivePendingServerUrl();
}

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

function readPendingSetupIntent(storage: Storage, key: string): PendingSetupIntent | null {
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

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const storage = getStorage();
    if (!storage) return;
    const serverUrl = resolveIntentServerUrl(value);
    if (!serverUrl) return;
    const record = toRecord({ ...value, relayUrl: normalizePendingServerUrl(value.relayUrl) ?? serverUrl });
    if (!record) return;
    try {
        const payload = JSON.stringify(record);
        storage.setItem(pendingServerScopedKey(STORAGE_KEY_PREFIX, serverUrl), payload);
    } catch {
        // ignore storage failures
    }
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const storage = getStorage();
    if (!storage) return null;
    const activeServerUrl = getActivePendingServerUrl();
    if (!activeServerUrl) return null;
    const key = pendingServerScopedKey(STORAGE_KEY_PREFIX, activeServerUrl);
    const record = readPendingSetupIntent(storage, key);
    if (record) return record;

    const legacy = readPendingSetupIntent(storage, STORAGE_KEY) ?? readPendingSetupIntent(storage, LEGACY_MMKV_STORAGE_KEY);
    if (!legacy) return null;
    if (legacy.relayUrl && !isPendingServerUrlActive(legacy.relayUrl)) return null;

    // Migrate forward so future reads can be single-key.
    const next = toRecord(legacy);
    if (next) {
        try {
            storage.setItem(key, JSON.stringify(next));
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
        const activeServerUrl = getActivePendingServerUrl();
        if (activeServerUrl) {
            storage.removeItem(pendingServerScopedKey(STORAGE_KEY_PREFIX, activeServerUrl));
        }
        const legacy = readPendingSetupIntent(storage, STORAGE_KEY) ?? readPendingSetupIntent(storage, LEGACY_MMKV_STORAGE_KEY);
        if (!legacy || !legacy.relayUrl || isPendingServerUrlActive(legacy.relayUrl)) {
            storage.removeItem(STORAGE_KEY);
            storage.removeItem(LEGACY_MMKV_STORAGE_KEY);
        }
    } catch {
        // ignore storage failures
    }
}
