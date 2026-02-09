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
const RECOVERY_KEY_REMINDER_DISMISSED_KEY = 'recovery_key_reminder_dismissed';

function textToUtf8Bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

type ScopedStorageKeys = Readonly<{
    primary: string;
    legacy: string | null;
}>;

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function sanitizeScopeToken(raw: string): string {
    const token = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    return token || 'default';
}

async function getServerHashScopeForServerUrl(serverUrl: string): Promise<string> {
    const normalized = normalizeUrl(serverUrl);
    if (!normalized) return 'default';
    const hash = await digest('SHA-256', textToUtf8Bytes(normalized));
    return encodeBase64(hash, 'base64url');
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
    const normalizedUrl = normalizeUrl(serverUrlOverride ?? getActiveServerUrl());
    const serverId = serverUrlOverride ? resolveServerIdForUrl(normalizedUrl) : getActiveServerId();

    if (!serverId) {
        const hashScope = await getServerHashScopeForServerUrl(normalizedUrl);
        return {
            primary: makeScopedKey(baseKey, hashScope),
            legacy: null,
        };
    }

    const idScope = sanitizeScopeToken(serverId);
    const legacyScope = await getServerHashScopeForServerUrl(normalizedUrl);
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

async function getRecoveryKeyReminderDismissedKey(): Promise<string> {
    return (await getServerScopedKeys(RECOVERY_KEY_REMINDER_DISMISSED_KEY)).primary;
}

// Cache for synchronous access
const credentialsCacheByKey = new Map<string, string>();

export interface AuthCredentials {
    token: string;
    secret: string;
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
        return JSON.parse(raw) as AuthCredentials;
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

export const TokenStorage = {
    async getAuthAutoRedirectSuppressedUntil(): Promise<number> {
        const key = await getAuthAutoRedirectSuppressedUntilKey();
        const parse = (raw: string | null): number => {
            if (!raw) return 0;
            const n = Number.parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };

        if (Platform.OS === 'web') {
            try {
                return parse(localStorage.getItem(key));
            } catch {
                return 0;
            }
        }

        try {
            const stored = await SecureStore.getItemAsync(key);
            return parse(stored);
        } catch {
            return 0;
        }
    },

    async setAuthAutoRedirectSuppressedUntil(value: number): Promise<boolean> {
        const key = await getAuthAutoRedirectSuppressedUntilKey();
        const raw = String(Math.max(0, Math.floor(value)));

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
        if (keys.legacy) {
            await removeCredentialByKey(keys.legacy);
        }
        return true;
    },

    async removeCredentials(): Promise<boolean> {
        const keys = await getAuthKeys();
        const primaryRemoved = await removeCredentialByKey(keys.primary);
        if (keys.legacy) {
            await removeCredentialByKey(keys.legacy);
        }
        return primaryRemoved;
    },

    async removeCredentialsForServerUrl(serverUrl: string): Promise<boolean> {
        const keys = await getAuthKeys(serverUrl);
        const primaryRemoved = await removeCredentialByKey(keys.primary);
        if (keys.legacy) {
            await removeCredentialByKey(keys.legacy);
        }
        return primaryRemoved;
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
