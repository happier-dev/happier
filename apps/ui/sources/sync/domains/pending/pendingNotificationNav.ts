import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

export type PendingNotificationNav = Readonly<{
    serverUrl: string;
    route: string;
}>;

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const scope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-notification-nav', scope) });

const KEY_SERVER_URL = 'serverUrl';
const KEY_ROUTE = 'route';

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

export function setPendingNotificationNav(value: PendingNotificationNav): void {
    const serverUrl = normalizeUrl(value?.serverUrl ?? '');
    const route = String(value?.route ?? '').trim();
    if (!serverUrl || !route) return;
    storage.set(KEY_SERVER_URL, serverUrl);
    storage.set(KEY_ROUTE, route);
}

export function getPendingNotificationNav(): PendingNotificationNav | null {
    const serverUrl = storage.getString(KEY_SERVER_URL);
    const route = storage.getString(KEY_ROUTE);
    if (!serverUrl || !route) return null;
    return { serverUrl, route };
}

export function clearPendingNotificationNav(): void {
    storage.delete(KEY_SERVER_URL);
    storage.delete(KEY_ROUTE);
}

