import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/storageScope';
import { getServerUrl } from '@/sync/serverConfig';
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

async function getServerHashScope(): Promise<string> {
    const url = getServerUrl().trim().replace(/\/+$/, '');
    const hash = await digest('SHA-256', textToUtf8Bytes(url));
    return encodeBase64(hash, 'base64url');
}

async function getServerHashScopeForServerUrl(serverUrl: string): Promise<string> {
    const normalized = String(serverUrl ?? '').trim().replace(/\/+$/, '');
    if (!normalized) {
        // Fall back to current server scope to keep behavior safe.
        return await getServerHashScope();
    }
    const hash = await digest('SHA-256', textToUtf8Bytes(normalized));
    return encodeBase64(hash, 'base64url');
}

async function getServerScopedKey(baseKey: string, serverUrlOverride?: string): Promise<string> {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    const serverHash = serverUrlOverride
        ? await getServerHashScopeForServerUrl(serverUrlOverride)
        : await getServerHashScope();
    return scopedStorageId(`${baseKey}__srv_${serverHash}`, scope);
}

async function getAuthKey(): Promise<string> {
    return await getServerScopedKey(AUTH_KEY);
}

async function getPendingExternalAuthKey(): Promise<string> {
    return await getServerScopedKey(PENDING_EXTERNAL_AUTH_KEY);
}

async function getPendingExternalConnectKey(): Promise<string> {
    return await getServerScopedKey(PENDING_EXTERNAL_CONNECT_KEY);
}

async function getAuthAutoRedirectSuppressedUntilKey(): Promise<string> {
    return await getServerScopedKey(AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_KEY);
}

async function getRecoveryKeyReminderDismissedKey(): Promise<string> {
    return await getServerScopedKey(RECOVERY_KEY_REMINDER_DISMISSED_KEY);
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
        const key = await getAuthKey();
        if (Platform.OS === 'web') {
            try {
                const raw = localStorage.getItem(key);
                if (!raw) return null;
                return JSON.parse(raw) as AuthCredentials;
            } catch (error) {
                console.error('Error getting credentials:', error);
                return null;
            }
        }
        const cached = credentialsCacheByKey.get(key);
        if (cached) {
            try {
                return JSON.parse(cached) as AuthCredentials;
            } catch {
                // Ignore cache parse errors, fall through to secure store read.
            }
        }
        try {
            const stored = await SecureStore.getItemAsync(key);
            if (!stored) return null;
            credentialsCacheByKey.set(key, stored);
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async getCredentialsForServerUrl(serverUrl: string): Promise<AuthCredentials | null> {
        const key = await getServerScopedKey(AUTH_KEY, serverUrl);
        if (Platform.OS === 'web') {
            try {
                const raw = localStorage.getItem(key);
                if (!raw) return null;
                return JSON.parse(raw) as AuthCredentials;
            } catch (error) {
                console.error('Error getting credentials:', error);
                return null;
            }
        }

        const cached = credentialsCacheByKey.get(key);
        if (cached) {
            try {
                return JSON.parse(cached) as AuthCredentials;
            } catch {
                // Ignore cache parse errors, fall through to secure store read.
            }
        }
        try {
            const stored = await SecureStore.getItemAsync(key);
            if (!stored) return null;
            credentialsCacheByKey.set(key, stored);
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const key = await getAuthKey();
        if (Platform.OS === 'web') {
            try {
                localStorage.setItem(key, JSON.stringify(credentials));
                return true;
            } catch (error) {
                console.error('Error setting credentials:', error);
                return false;
            }
        }
        try {
            const json = JSON.stringify(credentials);
            await SecureStore.setItemAsync(key, json);
            credentialsCacheByKey.set(key, json);
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        const key = await getAuthKey();
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
    },

    async removeCredentialsForServerUrl(serverUrl: string): Promise<boolean> {
        const key = await getServerScopedKey(AUTH_KEY, serverUrl);
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
