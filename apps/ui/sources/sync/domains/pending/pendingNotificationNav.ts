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

export type PendingNotificationNav = Readonly<{
    serverUrl: string;
    route: string;
}>;

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const scope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-notification-nav', scope) });

const KEY_RECORD_PREFIX = 'record:v2';
const KEY_SERVER_RECORD_PREFIX = 'record:server:v1';
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

function readScopedPendingNotificationNav(key: string): PendingNotificationNav | null {
    const raw = storage.getString(key);
    if (!raw) return null;
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
    return null;
}

function resolveActiveServerScopedKey(): string | null {
    const activeServerUrl = getActivePendingServerUrl();
    return activeServerUrl ? pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, activeServerUrl) : null;
}

export function setPendingNotificationNav(value: PendingNotificationNav): void {
    const serverUrl = normalizeUrl(value?.serverUrl ?? '');
    const route = String(value?.route ?? '').trim();
    const activeScope = getActiveServerAccountScope();
    if (!serverUrl || !route) return;
    const record = JSON.stringify({ serverUrl, route } satisfies PendingNotificationNav);
    if (activeScope && isPendingServerUrlActive(serverUrl)) {
        storage.set(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope), record);
        const serverScopedKey = resolveActiveServerScopedKey();
        if (serverScopedKey) storage.delete(serverScopedKey);
        return;
    }
    storage.set(pendingServerScopedKey(KEY_SERVER_RECORD_PREFIX, serverUrl), record);
}

export function getPendingNotificationNav(): PendingNotificationNav | null {
    const activeScope = getActiveServerAccountScope();
    const serverScopedKey = resolveActiveServerScopedKey();
    if (activeScope) {
        const scopedKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, activeScope);
        const scoped = readScopedPendingNotificationNav(scopedKey);
        if (scoped) return scoped;
    } else if (serverScopedKey) {
        const serverScoped = readScopedPendingNotificationNav(serverScopedKey);
        if (serverScoped) return serverScoped;
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
    const serverScopedKey = resolveActiveServerScopedKey();
    if (serverScopedKey) {
        storage.delete(serverScopedKey);
    }
    const legacy = readLegacyPendingNotificationNav();
    if (!legacy || isPendingServerUrlActive(legacy.serverUrl)) {
        clearLegacyPendingNotificationNav();
    }
}

export function migratePendingNotificationNavScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const canonicalKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, scope);
    let hasCanonicalRecord = readScopedPendingNotificationNav(canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(KEY_RECORD_PREFIX, legacyScope);
        const legacyRecord = readScopedPendingNotificationNav(legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            storage.set(canonicalKey, JSON.stringify(legacyRecord));
            hasCanonicalRecord = true;
        }
        storage.delete(legacyKey);
    }
}
