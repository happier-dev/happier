import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { getActiveServerId, getActiveServerUrl, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { digest } from '@/platform/digest';
import { encodeBase64 } from '@/encryption/base64';

const AUTH_KEY = 'auth_credentials';
const PENDING_EXTERNAL_AUTH_KEY = 'pending_external_auth';
const PENDING_EXTERNAL_CONNECT_KEY = 'pending_external_connect';
const AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_KEY = 'auth_auto_redirect_suppressed_until';
const AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_GLOBAL_KEY = 'auth_auto_redirect_suppressed_until_global';
const RECOVERY_KEY_REMINDER_DISMISSED_KEY = 'recovery_key_reminder_dismissed';

function textToUtf8Bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

type ScopedStorageKeys = Readonly<{
    primary: string;
    legacy: string | null;
}>;

function normalizeUrlLegacy(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function normalizeUrl(raw: string): string {
    const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';

    try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost') {
            parsed.hostname = 'localhost';
        }

        const normalizedPath = parsed.pathname.replace(/\/+$/, '');
        const path = normalizedPath && normalizedPath !== '/' ? normalizedPath : '';
        const port = parsed.port ? `:${parsed.port}` : '';
        const auth = parsed.username
            ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
            : '';

        return `${parsed.protocol}//${auth}${parsed.hostname}${port}${path}${parsed.search}${parsed.hash}`.replace(/\/+$/, '');
    } catch {
        return trimmed;
    }
}

function sanitizeScopeToken(raw: string): string {
    const token = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    return token || 'default';
}

async function getServerHashScopeForNormalizedUrl(normalizedUrl: string): Promise<string> {
    const normalized = String(normalizedUrl ?? '').trim();
    if (!normalized) return 'default';
    const hash = await digest('SHA-256', textToUtf8Bytes(normalized));
    return encodeBase64(hash, 'base64url');
}

async function getServerHashScopeForServerUrl(serverUrl: string): Promise<string> {
    return await getServerHashScopeForNormalizedUrl(normalizeUrl(serverUrl));
}

function makeScopedKey(baseKey: string, scopeToken: string): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(`${baseKey}__srv_${scopeToken}`, scope);
}

function resolveServerIdForUrl(serverUrl: string): string | null {
    const normalized = normalizeUrl(serverUrl);
    if (!normalized) return null;
    const match = listServerProfiles().find((profile) => normalizeUrl(profile.serverUrl) === normalized);
    return match?.id ?? null;
}

async function getServerScopedKeys(baseKey: string, serverUrlOverride?: string): Promise<ScopedStorageKeys> {
    const rawUrl = serverUrlOverride ?? getActiveServerUrl();
    const normalizedUrl = normalizeUrl(rawUrl);
    const legacyCandidates = new Set<string>();
    const legacyNormalizedUrl = normalizeUrlLegacy(rawUrl);
    if (legacyNormalizedUrl) legacyCandidates.add(legacyNormalizedUrl);

    // Backwards-compat: older versions treated 127.0.0.1 and localhost as distinct scopes.
    // If we currently normalized to localhost, also consider the loopback IP scope as a legacy key.
    try {
        const parsed = new URL(normalizedUrl);
        if (parsed.hostname.toLowerCase() === 'localhost') {
            parsed.hostname = '127.0.0.1';
            legacyCandidates.add(normalizeUrlLegacy(parsed.toString()));
        }
    } catch {
        // ignore
    }

    const legacyNormalizedUrlForHash =
        [...legacyCandidates].find((candidate) => candidate && candidate !== normalizedUrl) ?? '';
    const resolvedServerId = resolveServerIdForUrl(normalizedUrl);
    const activeServerId = serverUrlOverride ? null : getActiveServerId();
    const activeServerUrl = activeServerId
        ? normalizeUrl(listServerProfiles().find((profile) => profile.id === activeServerId)?.serverUrl ?? '')
        : '';

    // If the active server URL is coming from env/same-origin fallback but the persisted active server id
    // still points at a different profile (commonly: cloud), do NOT use the id scope. Fall back to a URL hash
    // scope so credentials are never read from the wrong server.
    const serverId = resolvedServerId ?? (activeServerUrl && activeServerUrl === normalizedUrl ? activeServerId : null);

    if (!serverId) {
        const hashScope = await getServerHashScopeForNormalizedUrl(normalizedUrl);
        const legacyHashScope =
            legacyNormalizedUrlForHash
                ? await getServerHashScopeForNormalizedUrl(legacyNormalizedUrlForHash)
                : null;
        return {
            primary: makeScopedKey(baseKey, hashScope),
            legacy: legacyHashScope && legacyHashScope !== hashScope ? makeScopedKey(baseKey, legacyHashScope) : null,
        };
    }

    const idScope = sanitizeScopeToken(serverId);
    const legacyScope =
        legacyNormalizedUrlForHash
            ? await getServerHashScopeForNormalizedUrl(legacyNormalizedUrlForHash)
            : await getServerHashScopeForNormalizedUrl(normalizedUrl);
    return {
        primary: makeScopedKey(baseKey, idScope),
        legacy: legacyScope === idScope ? null : makeScopedKey(baseKey, legacyScope),
    };
}

async function getAuthKeys(serverUrlOverride?: string): Promise<ScopedStorageKeys> {
    return await getServerScopedKeys(AUTH_KEY, serverUrlOverride);
}

async function getPendingExternalAuthKey(): Promise<string> {
    return (await getServerScopedKeys(PENDING_EXTERNAL_AUTH_KEY)).primary;
}

async function getPendingExternalConnectKey(): Promise<string> {
    return (await getServerScopedKeys(PENDING_EXTERNAL_CONNECT_KEY)).primary;
}

async function getAuthAutoRedirectSuppressedUntilKey(): Promise<string> {
    return (await getServerScopedKeys(AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_KEY)).primary;
}

function getAuthAutoRedirectSuppressedUntilGlobalKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_GLOBAL_KEY, scope);
}

async function getRecoveryKeyReminderDismissedKey(): Promise<string> {
    return (await getServerScopedKeys(RECOVERY_KEY_REMINDER_DISMISSED_KEY)).primary;
}

// Cache for synchronous access
const credentialsCacheByKey = new Map<string, string>();

export type AuthCredentials =
    | Readonly<{
        token: string;
        secret: string;
    }>
    | Readonly<{
        token: string;
        encryption: Readonly<{
            publicKey: string;
            machineKey: string;
        }>;
    }>;

export function isLegacyAuthCredentials(credentials: AuthCredentials): credentials is Extract<AuthCredentials, { secret: string }> {
    return typeof (credentials as any)?.secret === 'string' && (credentials as any).secret.trim().length > 0;
}

export interface PendingExternalAuth {
    provider: string;
    secret: string;
    intent?: 'signup' | 'reset';
}

export interface PendingExternalConnect {
    provider: string;
    returnTo: string;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isPendingExternalAuthRecord(value: unknown): value is PendingExternalAuth {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    if (!isNonEmptyString(maybe.provider) || !isNonEmptyString(maybe.secret)) return false;
    if (maybe.intent === undefined) return true;
    return maybe.intent === 'signup' || maybe.intent === 'reset';
}

function isPendingExternalConnectRecord(value: unknown): value is PendingExternalConnect {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    return isNonEmptyString(maybe.provider) && isNonEmptyString(maybe.returnTo);
}

function safeParseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function readStoredJson<T>(
    key: string,
    label: string,
    validator: (value: unknown) => value is T,
): Promise<T | null> {
    if (Platform.OS === 'web') {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = safeParseJson(raw);
            return validator(parsed) ? parsed : null;
        } catch (error) {
            console.error(`Error getting ${label}:`, error);
            return null;
        }
    }

    try {
        const stored = await SecureStore.getItemAsync(key);
        if (!stored) return null;
        const parsed = safeParseJson(stored);
        return validator(parsed) ? parsed : null;
    } catch (error) {
        console.error(`Error getting ${label}:`, error);
        return null;
    }
}

async function writeStoredJson(
    key: string,
    label: string,
    value: unknown,
): Promise<boolean> {
    if (Platform.OS === 'web') {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error(`Error setting ${label}:`, error);
            return false;
        }
    }

    try {
        await SecureStore.setItemAsync(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.error(`Error setting ${label}:`, error);
        return false;
    }
}

async function removeStoredValue(key: string, label: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.error(`Error removing ${label}:`, error);
            return false;
        }
    }
    try {
        await SecureStore.deleteItemAsync(key);
        return true;
    } catch (error) {
        console.error(`Error removing ${label}:`, error);
        return false;
    }
}

function parseCredentialsRaw(raw: string | null): AuthCredentials | null {
    if (!raw) return null;
    try {
        const parsed = safeParseJson(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const maybe = parsed as Record<string, unknown>;
        if (!isNonEmptyString(maybe.token)) return null;

        // Credentials must include a restore mechanism:
        // - legacy secret (stack dev auth), OR
        // - encryption keypair (dataKey)
        const hasLegacySecret = isNonEmptyString(maybe.secret);
        const hasEncryption =
            !!maybe.encryption &&
            typeof maybe.encryption === 'object' &&
            isNonEmptyString((maybe.encryption as Record<string, unknown>).publicKey) &&
            isNonEmptyString((maybe.encryption as Record<string, unknown>).machineKey);

        if (!hasLegacySecret && !hasEncryption) return null;
        return parsed as AuthCredentials;
    } catch {
        return null;
    }
}

async function readCredentialRawByKey(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    }

    const cached = credentialsCacheByKey.get(key);
    if (cached) return cached;

    try {
        const stored = await SecureStore.getItemAsync(key);
        if (stored) credentialsCacheByKey.set(key, stored);
        return stored;
    } catch (error) {
        console.error('Error getting credentials:', error);
        return null;
    }
}

async function writeCredentialRawByKey(key: string, raw: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        try {
            localStorage.setItem(key, raw);
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    }

    try {
        await SecureStore.setItemAsync(key, raw);
        credentialsCacheByKey.set(key, raw);
        return true;
    } catch (error) {
        console.error('Error setting credentials:', error);
        return false;
    }
}

async function removeCredentialByKey(key: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    }

    try {
        await SecureStore.deleteItemAsync(key);
        credentialsCacheByKey.delete(key);
        return true;
    } catch (error) {
        console.error('Error removing credentials:', error);
        return false;
    }
}

function listKnownServerUrlsForCredentialCleanup(): string[] {
    const urls = [getActiveServerUrl(), ...listServerProfiles().map((profile) => profile.serverUrl)];
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const raw of urls) {
        const normalized = normalizeUrl(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
    }
    return unique;
}

function listWebScopedCredentialKeysForCleanup(): string[] {
    if (Platform.OS !== 'web') return [];
    const keys: string[] = [];
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key === AUTH_KEY || key.startsWith(`${AUTH_KEY}__srv_`)) {
                keys.push(key);
            }
        }
    } catch {
        return [];
    }
    return keys;
}

export const TokenStorage = {
    async getAuthAutoRedirectSuppressedUntil(): Promise<number> {
        const key = await getAuthAutoRedirectSuppressedUntilKey();
        const globalKey = getAuthAutoRedirectSuppressedUntilGlobalKey();
        const parse = (raw: string | null): number => {
            if (!raw) return 0;
            const n = Number.parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };

        if (Platform.OS === 'web') {
            try {
                const scopedSuppressedUntil = parse(localStorage.getItem(key));
                const globalSuppressedUntil = parse(localStorage.getItem(globalKey));
                return Math.max(scopedSuppressedUntil, globalSuppressedUntil);
            } catch {
                return 0;
            }
        }

        try {
            const [scopedStored, globalStored] = await Promise.all([
                SecureStore.getItemAsync(key),
                SecureStore.getItemAsync(globalKey),
            ]);
            return Math.max(parse(scopedStored), parse(globalStored));
        } catch {
            return 0;
        }
    },

    async setAuthAutoRedirectSuppressedUntil(value: number): Promise<boolean> {
        const key = await getAuthAutoRedirectSuppressedUntilKey();
        const globalKey = getAuthAutoRedirectSuppressedUntilGlobalKey();
        const raw = String(Math.max(0, Math.floor(value)));

        if (Platform.OS === 'web') {
            try {
                localStorage.setItem(key, raw);
                localStorage.setItem(globalKey, raw);
                return true;
            } catch {
                return false;
            }
        }

        try {
            await Promise.all([
                SecureStore.setItemAsync(key, raw),
                SecureStore.setItemAsync(globalKey, raw),
            ]);
            return true;
        } catch {
            return false;
        }
    },

    async suppressAuthAutoRedirectForMs(ms: number): Promise<void> {
        const durationMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(Date.now() + durationMs);
    },

    async getRecoveryKeyReminderDismissed(): Promise<boolean> {
        const key = await getRecoveryKeyReminderDismissedKey();
        const parse = (raw: string | null): boolean => {
            if (!raw) return false;
            const v = raw.trim().toLowerCase();
            return v === '1' || v === 'true' || v === 'yes' || v === 'on';
        };

        if (Platform.OS === 'web') {
            try {
                return parse(localStorage.getItem(key));
            } catch {
                return false;
            }
        }

        try {
            const stored = await SecureStore.getItemAsync(key);
            return parse(stored);
        } catch {
            return false;
        }
    },

    async setRecoveryKeyReminderDismissed(value: boolean): Promise<boolean> {
        const key = await getRecoveryKeyReminderDismissedKey();
        const raw = value ? '1' : '0';

        if (Platform.OS === 'web') {
            try {
                localStorage.setItem(key, raw);
                return true;
            } catch {
                return false;
            }
        }

        try {
            await SecureStore.setItemAsync(key, raw);
            return true;
        } catch {
            return false;
        }
    },

    async getCredentials(): Promise<AuthCredentials | null> {
        const keys = await getAuthKeys();
        const primaryRaw = await readCredentialRawByKey(keys.primary);
        const primaryParsed = parseCredentialsRaw(primaryRaw);
        if (primaryParsed) return primaryParsed;

        if (!keys.legacy) return null;

        const legacyRaw = await readCredentialRawByKey(keys.legacy);
        const legacyParsed = parseCredentialsRaw(legacyRaw);
        if (!legacyParsed || !legacyRaw) return null;

        const migrated = await writeCredentialRawByKey(keys.primary, legacyRaw);
        if (migrated) {
            await removeCredentialByKey(keys.legacy);
        }
        return legacyParsed;
    },

    async getCredentialsForServerUrl(serverUrl: string): Promise<AuthCredentials | null> {
        const keys = await getAuthKeys(serverUrl);
        const primaryRaw = await readCredentialRawByKey(keys.primary);
        const primaryParsed = parseCredentialsRaw(primaryRaw);
        if (primaryParsed) return primaryParsed;

        if (!keys.legacy) return null;

        const legacyRaw = await readCredentialRawByKey(keys.legacy);
        const legacyParsed = parseCredentialsRaw(legacyRaw);
        if (!legacyParsed || !legacyRaw) return null;

        const migrated = await writeCredentialRawByKey(keys.primary, legacyRaw);
        if (migrated) {
            await removeCredentialByKey(keys.legacy);
        }
        return legacyParsed;
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const keys = await getAuthKeys();
        const json = JSON.stringify(credentials);
        const written = await writeCredentialRawByKey(keys.primary, json);
        if (!written) return false;
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
        if (keys.legacy) {
            await removeCredentialByKey(keys.legacy);
        }
        return true;
    },

    async removeCredentials(): Promise<boolean> {
        // Clearing credentials should not implicitly suppress auth redirects forever.
        // Reset any suppression so subsequent auth flows can run normally.
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
        let allRemoved = true;
        const knownServerUrls = listKnownServerUrlsForCredentialCleanup();
        for (const serverUrl of knownServerUrls) {
            const keys = await getAuthKeys(serverUrl);
            const primaryRemoved = await removeCredentialByKey(keys.primary);
            allRemoved = allRemoved && primaryRemoved;
            if (keys.legacy) {
                const legacyRemoved = await removeCredentialByKey(keys.legacy);
                allRemoved = allRemoved && legacyRemoved;
            }
        }

        if (Platform.OS === 'web') {
            const webScopedKeys = listWebScopedCredentialKeysForCleanup();
            for (const key of webScopedKeys) {
                const removed = await removeCredentialByKey(key);
                allRemoved = allRemoved && removed;
            }
        }

        return allRemoved;
    },

    async removeCredentialsForServerUrl(serverUrl: string): Promise<boolean> {
        const keys = await getAuthKeys(serverUrl);
        const primaryRemoved = await removeCredentialByKey(keys.primary);
        if (keys.legacy) {
            await removeCredentialByKey(keys.legacy);
        }
        return primaryRemoved;
    },

    async invalidateCredentialsTokenForServerUrl(serverUrl: string, token: string): Promise<boolean> {
        const keys = await getAuthKeys(serverUrl);
        const removeIfMatches = async (key: string): Promise<boolean> => {
            const raw = await readCredentialRawByKey(key);
            const parsed = parseCredentialsRaw(raw);
            if (!parsed || parsed.token !== token) return false;
            const removed = await removeCredentialByKey(key);
            credentialsCacheByKey.delete(key);
            return removed;
        };

        const primaryRemoved = await removeIfMatches(keys.primary);
        if (primaryRemoved) return true;
        if (keys.legacy) {
            const legacyRemoved = await removeIfMatches(keys.legacy);
            if (legacyRemoved) return true;
        }
        return false;
    },

    async getPendingExternalAuth(): Promise<PendingExternalAuth | null> {
        const key = await getPendingExternalAuthKey();
        return await readStoredJson(key, 'pending external auth', isPendingExternalAuthRecord);
    },

    async setPendingExternalAuth(value: PendingExternalAuth): Promise<boolean> {
        const key = await getPendingExternalAuthKey();
        return await writeStoredJson(key, 'pending external auth', value);
    },

    async clearPendingExternalAuth(): Promise<boolean> {
        const key = await getPendingExternalAuthKey();
        return await removeStoredValue(key, 'pending external auth');
    },

    async getPendingExternalConnect(): Promise<PendingExternalConnect | null> {
        const key = await getPendingExternalConnectKey();
        return await readStoredJson(key, 'pending external connect', isPendingExternalConnectRecord);
    },

    async setPendingExternalConnect(value: PendingExternalConnect): Promise<boolean> {
        const key = await getPendingExternalConnectKey();
        return await writeStoredJson(key, 'pending external connect', value);
    },

    async clearPendingExternalConnect(): Promise<boolean> {
        const key = await getPendingExternalConnectKey();
        return await removeStoredValue(key, 'pending external connect');
    },
};
