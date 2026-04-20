import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';

const scope = readStorageScopeFromEnv();
const STORAGE_KEY = scopedStorageId('pending-setup-intent-record', scope);

// Backwards-compat: older web builds (and some e2e fixtures) persisted the MMKV-style key that
// mirrors the native MMKV instance id + record key.
const LEGACY_MMKV_STORAGE_KEY = `mmkv.${scopedStorageId('pending-setup-intent', scope)}\\record`;

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
    const record = toRecord(value);
    if (!record) return;
    try {
        const payload = JSON.stringify(record);
        storage.setItem(STORAGE_KEY, payload);
        // Best-effort compatibility write so fixture seeding stays stable across key migrations.
        storage.setItem(LEGACY_MMKV_STORAGE_KEY, payload);
    } catch {
        // ignore storage failures
    }
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const storage = getStorage();
    if (!storage) return null;
    const record = readPendingSetupIntent(storage, STORAGE_KEY);
    if (record) return record;

    const legacy = readPendingSetupIntent(storage, LEGACY_MMKV_STORAGE_KEY);
    if (!legacy) return null;

    // Migrate forward so future reads can be single-key.
    const next = toRecord(legacy);
    if (next) {
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(next));
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
        storage.removeItem(STORAGE_KEY);
        storage.removeItem(LEGACY_MMKV_STORAGE_KEY);
    } catch {
        // ignore storage failures
    }
}
