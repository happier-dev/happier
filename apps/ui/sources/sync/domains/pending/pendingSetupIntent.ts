import { MMKV } from 'react-native-mmkv';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';
import {
    getActivePendingServerUrl,
    isPendingServerUrlActive,
    normalizePendingServerUrl,
    pendingServerScopedKey,
} from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-setup-intent', scope) });
const KEY_RECORD = 'record';
const KEY_RECORD_PREFIX = 'record:v2';
const KEY_SERVER_RECORD_PREFIX = 'record:server:v1';

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

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const activeScope = getActiveServerAccountScope();
    const serverUrl = resolveIntentServerUrl(value);
    if (!serverUrl || !isPendingServerUrlActive(serverUrl)) return;
    const record = toRecord({ ...value, relayUrl: normalizePendingServerUrl(value.relayUrl) ?? serverUrl });
    if (!record) return;
    if (activeScope) {
        storage.set(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope), JSON.stringify(record));
        const serverScopedKey = resolveActiveServerScopedKey();
        if (serverScopedKey) storage.delete(serverScopedKey);
        return;
    }
    storage.set(pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, serverUrl), JSON.stringify(record));
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        const record = readRecord(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
        if (record) return record;
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    return serverScopedKey ? readRecord(serverScopedKey) : null;
}

export function clearPendingSetupIntent(): void {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        storage.delete(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    if (serverScopedKey) {
        storage.delete(serverScopedKey);
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
