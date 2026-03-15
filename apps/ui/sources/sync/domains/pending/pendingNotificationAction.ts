import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

export type PendingNotificationAction = Readonly<{
    serverUrl: string;
    sessionId: string;
    requestId: string;
    action: 'allow' | 'deny';
}>;

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const scope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-notification-action', scope) });

const KEY_SERVER_URL = 'serverUrl';
const KEY_SESSION_ID = 'sessionId';
const KEY_REQUEST_ID = 'requestId';
const KEY_ACTION = 'action';

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

export function setPendingNotificationAction(value: PendingNotificationAction): void {
    const serverUrl = normalizeUrl(value?.serverUrl ?? '');
    const sessionId = String(value?.sessionId ?? '').trim();
    const requestId = String(value?.requestId ?? '').trim();
    const action = value?.action === 'allow' ? 'allow' : value?.action === 'deny' ? 'deny' : '';
    if (!serverUrl || !sessionId || !requestId || !action) return;
    storage.set(KEY_SERVER_URL, serverUrl);
    storage.set(KEY_SESSION_ID, sessionId);
    storage.set(KEY_REQUEST_ID, requestId);
    storage.set(KEY_ACTION, action);
}

export function getPendingNotificationAction(): PendingNotificationAction | null {
    const serverUrl = storage.getString(KEY_SERVER_URL);
    const sessionId = storage.getString(KEY_SESSION_ID);
    const requestId = storage.getString(KEY_REQUEST_ID);
    const actionRaw = storage.getString(KEY_ACTION);
    const action = actionRaw === 'allow' ? 'allow' : actionRaw === 'deny' ? 'deny' : null;
    if (!serverUrl || !sessionId || !requestId || !action) return null;
    return { serverUrl, sessionId, requestId, action };
}

export function clearPendingNotificationAction(): void {
    storage.delete(KEY_SERVER_URL);
    storage.delete(KEY_SESSION_ID);
    storage.delete(KEY_REQUEST_ID);
    storage.delete(KEY_ACTION);
}

