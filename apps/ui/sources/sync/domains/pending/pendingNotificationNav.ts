import { MMKV } from 'react-native-mmkv';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { isPendingServerUrlActive, normalizePendingServerUrl } from './pendingServerScopedKeys';

export type PendingNotificationNav = Readonly<{
    serverUrl: string;
    route: string;
}>;

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const scope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-notification-nav', scope) });

const KEY_RECORD_PREFIX = 'record:v2';
const KEY_SERVER_URL = 'serverUrl';
const KEY_ROUTE = 'route';

function normalizeUrl(raw: string): string {
    return normalizePendingServerUrl(raw) ?? '';
}

function readLegacyPendingNotificationNav(): PendingNotificationNav | null {
    const serverUrl = storage.getString(KEY_SERVER_URL);
    const route = storage.getString(KEY_ROUTE);
    if (!serverUrl || !route) return null;
    return { serverUrl, route };
}

function clearLegacyPendingNotificationNav(): void {
    storage.delete(KEY_SERVER_URL);
    storage.delete(KEY_ROUTE);
}

export function setPendingNotificationNav(value: PendingNotificationNav): void {
    const serverUrl = normalizeUrl(value?.serverUrl ?? '');
    const route = String(value?.route ?? '').trim();
    const activeScope = getActiveServerAccountScope();
    if (!serverUrl || !route || !activeScope || !isPendingServerUrlActive(serverUrl)) return;
    storage.set(
        serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope),
        JSON.stringify({ serverUrl, route } satisfies PendingNotificationNav),
    );
}

export function getPendingNotificationNav(): PendingNotificationNav | null {
    const activeScope = getActiveServerAccountScope();
    if (!activeScope) return null;
    const key = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope);
    const raw = storage.getString(key);
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Partial<PendingNotificationNav>;
            const serverUrl = normalizeUrl(parsed.serverUrl ?? '');
            const route = String(parsed.route ?? '').trim();
            if (serverUrl && route) {
                return { serverUrl, route };
            }
        } catch {
            // ignore corrupt scoped payload
        }
        storage.delete(key);
    }

    const legacy = readLegacyPendingNotificationNav();
    if (!legacy) return null;
    if (!isPendingServerUrlActive(legacy.serverUrl)) return null;
    setPendingNotificationNav(legacy);
    clearLegacyPendingNotificationNav();
    return getPendingNotificationNav();
}

export function clearPendingNotificationNav(): void {
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        storage.delete(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope));
    }
    const legacy = readLegacyPendingNotificationNav();
    if (!legacy || isPendingServerUrlActive(legacy.serverUrl)) {
        clearLegacyPendingNotificationNav();
    }
}
