import { MMKV } from 'react-native-mmkv';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';
import { getActivePendingServerUrl, isPendingServerUrlActive, normalizePendingServerUrl, pendingServerScopedKey } from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-setup-intent', scope) });
const KEY_RECORD = 'record';
const KEY_RECORD_PREFIX = 'record:v2';

function resolveIntentServerUrl(value: PendingSetupIntent): string | null {
    return normalizePendingServerUrl(value.relayUrl) ?? getActivePendingServerUrl();
}

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const serverUrl = resolveIntentServerUrl(value);
    if (!serverUrl) return;
    const record = toRecord({ ...value, relayUrl: normalizePendingServerUrl(value.relayUrl) ?? serverUrl });
    if (!record) return;
    storage.set(pendingServerScopedKey(KEY_RECORD_PREFIX, serverUrl), JSON.stringify(record));
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const activeServerUrl = getActivePendingServerUrl();
    if (!activeServerUrl) return null;
    const key = pendingServerScopedKey(KEY_RECORD_PREFIX, activeServerUrl);
    const raw = storage.getString(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        const record = fromRecord(parsed);
        if (!record) {
            storage.delete(key);
            return null;
        }
        return record;
    } catch {
        storage.delete(key);
        return null;
    }
}

export function clearPendingSetupIntent(): void {
    const activeServerUrl = getActivePendingServerUrl();
    if (activeServerUrl) {
        storage.delete(pendingServerScopedKey(KEY_RECORD_PREFIX, activeServerUrl));
    }
    const legacy = storage.getString(KEY_RECORD);
    if (!legacy) return;
    try {
        const record = fromRecord(JSON.parse(legacy) as unknown);
        if (!record || !record.relayUrl || isPendingServerUrlActive(record.relayUrl)) {
            storage.delete(KEY_RECORD);
        }
    } catch {
        storage.delete(KEY_RECORD);
    }
}
