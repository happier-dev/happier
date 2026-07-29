import { MMKV } from 'react-native-mmkv';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import {
    getActivePendingServerUrl,
    isPendingServerUrlActive,
    normalizePendingServerUrl,
    pendingServerScopedKey,
} from './pendingServerScopedKeys';

export type PendingNotificationAction = Readonly<{
    serverUrl: string;
    sessionId: string;
    requestId: string;
    action: 'allow' | 'deny';
}>;

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const scope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-notification-action', scope) });

const KEY_RECORD_PREFIX = 'record:v2';
const KEY_SERVER_RECORD_PREFIX = 'record:server:v1';
const KEY_SERVER_URL = 'serverUrl';
const KEY_SESSION_ID = 'sessionId';
const KEY_REQUEST_ID = 'requestId';
const KEY_ACTION = 'action';

function normalizeUrl(raw: string): string {
    return normalizePendingServerUrl(raw) ?? '';
}

function readLegacyPendingNotificationAction(): PendingNotificationAction | null {
    const serverUrl = storage.getString(KEY_SERVER_URL);
    const sessionId = storage.getString(KEY_SESSION_ID);
    const requestId = storage.getString(KEY_REQUEST_ID);
    const actionRaw = storage.getString(KEY_ACTION);
    const action = actionRaw === 'allow' ? 'allow' : actionRaw === 'deny' ? 'deny' : null;
    if (!serverUrl || !sessionId || !requestId || !action) return null;
    return { serverUrl, sessionId, requestId, action };
}

function clearLegacyPendingNotificationAction(): void {
    storage.delete(KEY_SERVER_URL);
    storage.delete(KEY_SESSION_ID);
    storage.delete(KEY_REQUEST_ID);
    storage.delete(KEY_ACTION);
}

function readScopedPendingNotificationAction(key: string): PendingNotificationAction | null {
    const raw = storage.getString(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<PendingNotificationAction>;
        const serverUrl = normalizeUrl(parsed.serverUrl ?? '');
        const sessionId = String(parsed.sessionId ?? '').trim();
        const requestId = String(parsed.requestId ?? '').trim();
        const action = parsed.action === 'allow' ? 'allow' : parsed.action === 'deny' ? 'deny' : null;
        if (serverUrl && sessionId && requestId && action) {
            return { serverUrl, sessionId, requestId, action };
        }
    } catch {
        // ignore corrupt scoped payload
    }
    storage.delete(key);
    return null;
}

function resolveActiveServerScopedKey(): string | null {
    const activeServerUrl = getActivePendingServerUrl();
    return activeServerUrl ? pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, activeServerUrl) : null;
}

export function setPendingNotificationAction(value: PendingNotificationAction): void {
    const serverUrl = normalizeUrl(value?.serverUrl ?? '');
    const sessionId = String(value?.sessionId ?? '').trim();
    const requestId = String(value?.requestId ?? '').trim();
    const action = value?.action === 'allow' ? 'allow' : value?.action === 'deny' ? 'deny' : '';
    const activeScope = getActiveServerAccountScope();
    if (!serverUrl || !sessionId || !requestId || !action) return;
    const record = JSON.stringify({ serverUrl, sessionId, requestId, action } satisfies PendingNotificationAction);
    if (activeScope && isPendingServerUrlActive(serverUrl)) {
        storage.set(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope), record);
        const serverScopedKey = resolveActiveServerScopedKey();
        if (serverScopedKey) storage.delete(serverScopedKey);
        return;
    }
    storage.set(pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, serverUrl), record);
}

export function getPendingNotificationAction(): PendingNotificationAction | null {
    const activeScope = getActiveServerAccountScope();
    const serverScopedKey = resolveActiveServerScopedKey();
    if (activeScope) {
        const scopedKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope);
        const scoped = readScopedPendingNotificationAction(scopedKey);
        if (scoped) return scoped;
    } else if (serverScopedKey) {
        const serverScoped = readScopedPendingNotificationAction(serverScopedKey);
        if (serverScoped) return serverScoped;
    }

    const legacy = readLegacyPendingNotificationAction();
    if (!legacy) return null;
    if (!isPendingServerUrlActive(legacy.serverUrl)) return null;
    setPendingNotificationAction(legacy);
    clearLegacyPendingNotificationAction();
    return getPendingNotificationAction();
}

export function clearPendingNotificationAction(): void {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        storage.delete(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    if (serverScopedKey) {
        storage.delete(serverScopedKey);
    }
    const legacy = readLegacyPendingNotificationAction();
    if (!legacy || isPendingServerUrlActive(legacy.serverUrl)) {
        clearLegacyPendingNotificationAction();
    }
}

export function migratePendingNotificationActionScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const canonicalKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, scope);
    let hasCanonicalRecord = readScopedPendingNotificationAction(canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, legacyScope);
        const legacyRecord = readScopedPendingNotificationAction(legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            storage.set(canonicalKey, JSON.stringify(legacyRecord));
            hasCanonicalRecord = true;
        }
        storage.delete(legacyKey);
    }
}
