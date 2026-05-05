import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { getActivePendingServerUrl, isPendingServerUrlActive, normalizePendingServerUrl, pendingServerScopedKey } from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-terminal-connect', scope) });
const KEY_RECORD = 'record';
const KEY_RECORD_PREFIX = 'record:v2';

export function setPendingTerminalConnect(value: PendingTerminalConnect): void {
    const serverUrl = normalizePendingServerUrl(value.serverUrl);
    if (!serverUrl) return;
    const record = toRecord({ ...value, serverUrl });
    if (!record) return;
    storage.set(pendingServerScopedKey(KEY_RECORD_PREFIX, serverUrl), JSON.stringify(record));
}

export function getPendingTerminalConnect(): PendingTerminalConnect | null {
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

export function clearPendingTerminalConnect(): void {
    const activeServerUrl = getActivePendingServerUrl();
    if (activeServerUrl) {
        storage.delete(pendingServerScopedKey(KEY_RECORD_PREFIX, activeServerUrl));
    }
    const legacy = storage.getString(KEY_RECORD);
    if (!legacy) return;
    try {
        const record = fromRecord(JSON.parse(legacy) as unknown);
        if (!record || isPendingServerUrlActive(record.serverUrl)) {
            storage.delete(KEY_RECORD);
        }
    } catch {
        storage.delete(KEY_RECORD);
    }
}
