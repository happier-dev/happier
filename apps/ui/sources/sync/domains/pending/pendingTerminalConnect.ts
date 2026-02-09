import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-terminal-connect', scope) });
const KEY_RECORD = 'record';

export function setPendingTerminalConnect(value: PendingTerminalConnect): void {
    const record = toRecord(value);
    if (!record) return;
    storage.set(KEY_RECORD, JSON.stringify(record));
}

export function getPendingTerminalConnect(): PendingTerminalConnect | null {
    const raw = storage.getString(KEY_RECORD);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        const record = fromRecord(parsed);
        if (!record) {
            storage.delete(KEY_RECORD);
            return null;
        }
        return record;
    } catch {
        storage.delete(KEY_RECORD);
        return null;
    }
}

export function clearPendingTerminalConnect(): void {
    storage.delete(KEY_RECORD);
}
