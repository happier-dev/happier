import { MMKV } from 'react-native-mmkv';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { isPendingServerUrlActive, normalizePendingServerUrl } from './pendingServerScopedKeys';

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

export function setPendingNotificationAction(value: PendingNotificationAction): void {
    const serverUrl = normalizeUrl(value?.serverUrl ?? '');
    const sessionId = String(value?.sessionId ?? '').trim();
    const requestId = String(value?.requestId ?? '').trim();
    const action = value?.action === 'allow' ? 'allow' : value?.action === 'deny' ? 'deny' : '';
    const activeScope = getActiveServerAccountScope();
    if (!serverUrl || !sessionId || !requestId || !action || !activeScope || !isPendingServerUrlActive(serverUrl)) return;
    storage.set(
        serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope),
        JSON.stringify({ serverUrl, sessionId, requestId, action } satisfies PendingNotificationAction),
    );
}

export function getPendingNotificationAction(): PendingNotificationAction | null {
    const activeScope = getActiveServerAccountScope();
    if (!activeScope) return null;
    const key = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope);
    const raw = storage.getString(key);
    if (raw) {
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
    const legacy = readLegacyPendingNotificationAction();
    if (!legacy || isPendingServerUrlActive(legacy.serverUrl)) {
        clearLegacyPendingNotificationAction();
    }
}
