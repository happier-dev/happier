import { MMKV } from 'react-native-mmkv';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-setup-intent', scope) });
const KEY_RECORD = 'record';

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const record = toRecord(value);
    if (!record) return;
    storage.set(KEY_RECORD, JSON.stringify(record));
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
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

export function clearPendingSetupIntent(): void {
    storage.delete(KEY_RECORD);
}
