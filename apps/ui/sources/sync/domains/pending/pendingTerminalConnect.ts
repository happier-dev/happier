import { MMKV } from 'react-native-mmkv';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { fromRecord, toRecord, type PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { isPendingServerUrlActive, normalizePendingServerUrl } from './pendingServerScopedKeys';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-terminal-connect', scope) });
const KEY_RECORD = 'record';
const KEY_RECORD_PREFIX = 'record:v2';

function readScopedRecord(key: string): PendingTerminalConnect | null {
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

export function setPendingTerminalConnect(value: PendingTerminalConnect): void {
    const activeScope = getActiveServerAccountScope();
    const serverUrl = normalizePendingServerUrl(value.serverUrl);
    if (!serverUrl || !activeScope || !isPendingServerUrlActive(serverUrl)) return;
    const record = toRecord({ ...value, serverUrl });
    if (!record) return;
    storage.set(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope), JSON.stringify(record));
}

export function getPendingTerminalConnect(): PendingTerminalConnect | null {
    const activeScope = getActiveServerAccountScope();
    if (!activeScope) return null;
    return readScopedRecord(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
}

export function clearPendingTerminalConnect(): void {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        storage.delete(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
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

export function migratePendingTerminalConnectScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const canonicalKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, scope);
    let hasCanonicalRecord = readScopedRecord(canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, legacyScope);
        const legacyRecord = readScopedRecord(legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            const record = toRecord(legacyRecord);
            if (record) {
                storage.set(canonicalKey, JSON.stringify(record));
                hasCanonicalRecord = true;
            }
        }
        storage.delete(legacyKey);
    }
}
