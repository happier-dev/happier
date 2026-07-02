import { Platform } from 'react-native';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerId,
    getActiveServerUrl,
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { digest } from '@/platform/digest';
import { encodeBase64 } from '@/encryption/base64';
import {
    readNativeSecureStoreString,
    removeNativeSecureStoreString,
    writeNativeSecureStoreString,
} from './nativeSecureStoreWithDevFallback';

const AUTH_KEY = 'auth_credentials';
const PENDING_EXTERNAL_AUTH_KEY = 'pending_external_auth';
const PENDING_EXTERNAL_AUTH_GLOBAL_KEY = 'pending_external_auth__global';
const PENDING_EXTERNAL_CONNECT_KEY = 'pending_external_connect';
const PENDING_EXTERNAL_CONNECT_GLOBAL_KEY = 'pending_external_connect__global';
const AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_KEY = 'auth_auto_redirect_suppressed_until';
const AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_GLOBAL_KEY = 'auth_auto_redirect_suppressed_until_global';
const RECOVERY_KEY_REMINDER_DISMISSED_KEY = 'recovery_key_reminder_dismissed';

function textToUtf8Bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

type ScopedStorageKeys = Readonly<{
    primary: string;
    legacy: readonly string[];
}>;

type ServerCredentialLookupOptions = Readonly<{
    serverId?: string | null;
}>;

type PendingExternalServerContext = Readonly<{
    serverId?: string;
    serverUrl?: string;
}>;

function normalizeUrlLegacy(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function normalizeUrl(raw: string): string {
    const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';

    try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        if (
            hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname === '[::1]'
            || hostname === 'localhost'
            || hostname.endsWith('.localhost')
        ) {
            parsed.hostname = 'localhost';
        } else {
            parsed.hostname = hostname;
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

function normalizeServerId(raw: string | null | undefined): string | null {
    const serverId = String(raw ?? '').trim();
    return serverId.length > 0 ? serverId : null;
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const normalized = String(value ?? '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
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
    const scope = readStorageScopeFromEnv();
    return scopedStorageId(`${baseKey}__srv_${scopeToken}`, scope);
}

function resolveServerIdForUrl(serverUrl: string, preferredServerId?: string | null): string | null {
    const normalized = normalizeUrl(serverUrl);
    if (!normalized) return null;
    const profiles = listServerProfiles();
    const preferredId = normalizeServerId(preferredServerId);
    if (preferredId) {
        const preferredProfile = profiles.find((profile) =>
            normalizeServerId(profile.id) === preferredId
            || normalizeServerId(profile.serverIdentityId ?? null) === preferredId
            || (profile.legacyServerIds ?? []).some((legacyId) => normalizeServerId(legacyId) === preferredId),
        ) ?? null;
        if (!preferredProfile) return null;
        return normalizeUrl(preferredProfile.serverUrl) === normalized
            ? normalizeServerId(preferredProfile.serverIdentityId ?? null) ?? preferredProfile.id
            : null;
    }
    const match = profiles.find((profile) => normalizeUrl(profile.serverUrl) === normalized);
    return match ? (normalizeServerId(match.serverIdentityId ?? null) ?? match.id) : null;
}

function findServerProfileForIdentifier(serverId: string | null | undefined) {
    const normalized = normalizeServerId(serverId);
    if (!normalized) return null;
    return listServerProfiles().find((profile) =>
        normalizeServerId(profile.id) === normalized
        || normalizeServerId(profile.serverIdentityId ?? null) === normalized
        || (profile.legacyServerIds ?? []).some((legacyId) => normalizeServerId(legacyId) === normalized),
    ) ?? null;
}

function listServerProfileCredentialScopeIds(serverId: string): string[] {
    const profile = findServerProfileForIdentifier(serverId);
    if (!profile) return [serverId];
    return uniqueStrings([
        profile.serverIdentityId ?? null,
        profile.id,
        ...(profile.legacyServerIds ?? []),
    ]);
}

async function getServerScopedKeys(
    baseKey: string,
    serverUrlOverride?: string,
    options: ServerCredentialLookupOptions = {},
): Promise<ScopedStorageKeys> {
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
    const activeServerId = serverUrlOverride ? null : getActiveServerId();
    const preferredServerId = normalizeServerId(options.serverId) ?? normalizeServerId(activeServerId);
    const resolvedServerId = resolveServerIdForUrl(normalizedUrl, preferredServerId);
    const activeServerProfile = activeServerId ? findServerProfileForIdentifier(activeServerId) : null;
    const activeServerUrl = activeServerProfile
        ? normalizeUrl(activeServerProfile.serverUrl)
        : '';

    // If the active server URL is coming from env/same-origin fallback but the persisted active server id
    // still points at a different profile, do NOT use the id scope. Fall back to a URL hash scope so
    // credentials are never read from the wrong server.
    const serverId = resolvedServerId ?? (activeServerUrl && activeServerUrl === normalizedUrl ? activeServerId : null);

    if (!serverId) {
        const hashScope = await getServerHashScopeForNormalizedUrl(normalizedUrl);
        const legacyHashScope =
            legacyNormalizedUrlForHash
                ? await getServerHashScopeForNormalizedUrl(legacyNormalizedUrlForHash)
                : null;
        return {
            primary: makeScopedKey(baseKey, hashScope),
            legacy: legacyHashScope && legacyHashScope !== hashScope ? [makeScopedKey(baseKey, legacyHashScope)] : [],
        };
    }

    const idScope = sanitizeScopeToken(serverId);
    const profileIdScopes = listServerProfileCredentialScopeIds(serverId)
        .map((id) => sanitizeScopeToken(id))
        .filter((scope) => scope !== idScope);
    const legacyUrlScope =
        legacyNormalizedUrlForHash
            ? await getServerHashScopeForNormalizedUrl(legacyNormalizedUrlForHash)
            : await getServerHashScopeForNormalizedUrl(normalizedUrl);
    return {
        primary: makeScopedKey(baseKey, idScope),
        legacy: uniqueStrings([
            ...profileIdScopes.map((scope) => makeScopedKey(baseKey, scope)),
            legacyUrlScope === idScope ? null : makeScopedKey(baseKey, legacyUrlScope),
        ]),
    };
}

async function getAuthKeys(
    serverUrlOverride?: string,
    options: ServerCredentialLookupOptions = {},
): Promise<ScopedStorageKeys> {
    return await getServerScopedKeys(AUTH_KEY, serverUrlOverride, options);
}

async function getPendingExternalAuthKey(): Promise<string> {
    return (await getServerScopedKeys(PENDING_EXTERNAL_AUTH_KEY)).primary;
}

function getPendingExternalAuthGlobalKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(PENDING_EXTERNAL_AUTH_GLOBAL_KEY, scope);
}

async function getPendingExternalConnectKey(): Promise<string> {
    return (await getServerScopedKeys(PENDING_EXTERNAL_CONNECT_KEY)).primary;
}

async function resolvePendingExternalScopedKeysForClear(
    baseKey: string,
    globalKey: string,
    validator: (value: unknown) => value is PendingExternalServerContext,
): Promise<ReadonlyArray<string>> {
    const scopedKeys = new Set<string>();
    const activeKeys = await getServerScopedKeys(baseKey);
    scopedKeys.add(activeKeys.primary);
    for (const legacyKey of activeKeys.legacy) {
        scopedKeys.add(legacyKey);
    }

    const globalValue = await readStoredJson(globalKey, baseKey, validator);
    if (!globalValue) {
        return [...scopedKeys];
    }

    const originalKeys = await getServerScopedKeys(baseKey, globalValue.serverUrl, {
        serverId: globalValue.serverId,
    });
    scopedKeys.add(originalKeys.primary);
    for (const legacyKey of originalKeys.legacy) {
        scopedKeys.add(legacyKey);
    }

    return [...scopedKeys];
}

function getPendingExternalConnectGlobalKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(PENDING_EXTERNAL_CONNECT_GLOBAL_KEY, scope);
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

function getRecoveryKeyReminderDismissedKeySync(): string | null {
    const normalizedUrl = normalizeUrl(getActiveServerUrl());
    if (!normalizedUrl) return null;

    const activeServerId = normalizeServerId(getActiveServerId());
    const resolvedServerId = resolveServerIdForUrl(normalizedUrl, activeServerId);
    const profiles = listServerProfiles();
    const activeServerUrl = activeServerId
        ? normalizeUrl(profiles.find((profile) => areServerProfileIdentifiersEquivalent(profile.id, activeServerId))?.serverUrl ?? '')
        : '';
    const serverId = resolvedServerId ?? (activeServerUrl && activeServerUrl === normalizedUrl ? activeServerId : null);
    if (!serverId) return null;

    return makeScopedKey(RECOVERY_KEY_REMINDER_DISMISSED_KEY, sanitizeScopeToken(serverId));
}

// Cache for synchronous access
const credentialsCacheByKey = new Map<string, string>();
const recoveryKeyReminderDismissedCacheByKey = new Map<string, string>();

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
    proof?: string;
    secret?: string;
    intent?: 'signup' | 'reset';
    serverId?: string;
    serverUrl?: string;
    returnTo?: string;
}

export interface PendingExternalConnect {
    provider: string;
    returnTo: string;
    serverId?: string;
    serverUrl?: string;
}

export type PendingExternalReadState<T> = Readonly<{
    value: T | null;
    serverMismatch: boolean;
}>;

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isInternalReturnTo(value: unknown): value is string {
    if (!isNonEmptyString(value)) return false;
    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) return false;
    // Prevent protocol-relative URLs.
    if (trimmed.startsWith('//')) return false;
    return true;
}

function isPendingExternalAuthRecord(value: unknown): value is PendingExternalAuth {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    if (!isNonEmptyString(maybe.provider)) return false;
    const secret = maybe.secret;
    const proof = maybe.proof;
    const mode = maybe.mode;
    const hasSecret = isNonEmptyString(secret);
    const hasProof = isNonEmptyString(proof);
    // New flow requires proof for binding. Accept legacy secret-only records for backward compatibility.
    if (!hasProof && !hasSecret) return false;
    if (mode !== undefined && mode !== 'keyed' && mode !== 'keyless') return false;
    if (maybe.serverId !== undefined && !isNonEmptyString(maybe.serverId)) return false;
    if (maybe.serverUrl !== undefined && !isNonEmptyString(maybe.serverUrl)) return false;
    if (maybe.returnTo !== undefined && !isInternalReturnTo(maybe.returnTo)) return false;
    if (maybe.intent === undefined) return true;
    return maybe.intent === 'signup' || maybe.intent === 'reset';
}

function isPendingExternalConnectRecord(value: unknown): value is PendingExternalConnect {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    if (!isNonEmptyString(maybe.provider) || !isNonEmptyString(maybe.returnTo)) return false;
    if (maybe.serverId !== undefined && !isNonEmptyString(maybe.serverId)) return false;
    if (maybe.serverUrl !== undefined && !isNonEmptyString(maybe.serverUrl)) return false;
    return true;
}

function resolveExactActiveServerIdForPendingServerUrl(serverUrl: string): string | null {
    const normalizedServerUrl = normalizeUrl(serverUrl);
    if (!normalizedServerUrl) return null;
    return resolveServerIdForUrl(normalizedServerUrl, getActiveServerId());
}

function doesPendingExternalStateMatchActiveServer(
    value: PendingExternalServerContext,
    options: Readonly<{ requireExplicitServerContext: boolean }>,
): boolean {
    const pendingServerId = normalizeServerId(typeof value.serverId === 'string' ? value.serverId : null);
    if (pendingServerId) {
        const activeServerId = normalizeServerId(getActiveServerId());
        return areServerProfileIdentifiersEquivalent(activeServerId, pendingServerId);
    }

    const pendingServerUrl = normalizeUrl(typeof value.serverUrl === 'string' ? value.serverUrl : '');
    if (!pendingServerUrl) {
        if (!options.requireExplicitServerContext) {
            return true;
        }
        const activeServerId = normalizeServerId(getActiveServerId());
        const activeServerUrl = normalizeUrl(getActiveServerUrl());
        return !activeServerId && !activeServerUrl;
    }

    const activeServerUrl = normalizeUrl(getActiveServerUrl());
    if (!activeServerUrl) {
        return false;
    }

    return pendingServerUrl === activeServerUrl;
}

function enrichPendingExternalServerContext<T extends PendingExternalServerContext>(
    value: T,
    options: Readonly<{ populateMissingServerUrl: boolean }>,
): T {
    const pendingServerId = normalizeServerId(typeof value.serverId === 'string' ? value.serverId : null);
    const pendingServerUrl = normalizeUrl(typeof value.serverUrl === 'string' ? value.serverUrl : '');
    const activeServerUrl = normalizeUrl(getActiveServerUrl());
    const enriched: Record<string, unknown> = { ...value };
    const exactActiveServerId =
        pendingServerUrl
            ? resolveExactActiveServerIdForPendingServerUrl(pendingServerUrl)
            : (options.populateMissingServerUrl ? resolveExactActiveServerIdForPendingServerUrl(activeServerUrl) : null);

    if (pendingServerId) {
        enriched.serverId = pendingServerId;
    } else if (exactActiveServerId && (!pendingServerUrl || pendingServerUrl === activeServerUrl)) {
        enriched.serverId = exactActiveServerId;
    }

    if (pendingServerUrl) {
        enriched.serverUrl = pendingServerUrl;
    } else if (options.populateMissingServerUrl && activeServerUrl) {
        enriched.serverUrl = activeServerUrl;
    }

    return enriched as T;
}

function safeParseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function resolveWebStorageBackend(): Storage | null {
    const windowStorage = (globalThis as any).window?.localStorage;
    if (windowStorage && typeof windowStorage.getItem === 'function') return windowStorage as Storage;

    const localStorage = (globalThis as any).localStorage;
    if (localStorage && typeof localStorage.getItem === 'function') return localStorage as Storage;

    return null;
}

async function readStoredJson<T>(
    key: string,
    label: string,
    validator: (value: unknown) => value is T,
): Promise<T | null> {
    if (Platform.OS === 'web') {
        const storage = resolveWebStorageBackend();
        if (!storage) return null;
        try {
            const raw = storage.getItem(key);
            if (!raw) return null;
            const parsed = safeParseJson(raw);
            return validator(parsed) ? parsed : null;
        } catch (error) {
            console.error(`Error getting ${label}:`, error);
            return null;
        }
    }

    try {
        const stored = await readNativeSecureStoreString(key);
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
        const storage = resolveWebStorageBackend();
        if (!storage) return false;
        try {
            storage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error(`Error setting ${label}:`, error);
            return false;
        }
    }

    try {
        await writeNativeSecureStoreString(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.error(`Error setting ${label}:`, error);
        return false;
    }
}

async function removeStoredValue(key: string, label: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        const storage = resolveWebStorageBackend();
        if (!storage) return false;
        try {
            storage.removeItem(key);
            return true;
        } catch (error) {
            console.error(`Error removing ${label}:`, error);
            return false;
        }
    }
    try {
        await removeNativeSecureStoreString(key);
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

function parseRecoveryKeyReminderDismissedRaw(raw: string | null): boolean {
    if (!raw) return false;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

async function readCredentialRawByKey(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
        const storage = resolveWebStorageBackend();
        if (!storage) return null;
        try {
            return storage.getItem(key);
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    }

    const cached = credentialsCacheByKey.get(key);
    if (cached) return cached;

    try {
        const stored = await readNativeSecureStoreString(key);
        if (stored) credentialsCacheByKey.set(key, stored);
        return stored;
    } catch (error) {
        console.error('Error getting credentials:', error);
        return null;
    }
}

async function writeCredentialRawByKey(key: string, raw: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        const storage = resolveWebStorageBackend();
        if (!storage) return false;
        try {
            storage.setItem(key, raw);
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    }

    try {
        await writeNativeSecureStoreString(key, raw);
        credentialsCacheByKey.set(key, raw);
        return true;
    } catch (error) {
        console.error('Error setting credentials:', error);
        return false;
    }
}

async function removeCredentialByKey(key: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        const storage = resolveWebStorageBackend();
        if (!storage) return false;
        try {
            storage.removeItem(key);
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    }

    try {
        await removeNativeSecureStoreString(key);
        credentialsCacheByKey.delete(key);
        return true;
    } catch (error) {
        console.error('Error removing credentials:', error);
        return false;
    }
}

type CredentialCleanupTarget = Readonly<{
    serverUrl: string;
    serverId?: string | null;
}>;

function listKnownServerCleanupTargets(): CredentialCleanupTarget[] {
    const seen = new Set<string>();
    const targets: CredentialCleanupTarget[] = [];

    const append = (serverUrlRaw: unknown, serverIdRaw?: unknown): void => {
        const serverUrl = normalizeUrl(String(serverUrlRaw ?? ''));
        if (!serverUrl) return;
        const serverId = normalizeServerId(typeof serverIdRaw === 'string' ? serverIdRaw : null);
        const key = serverId ?? `url:${serverUrl}`;
        if (seen.has(key)) return;
        seen.add(key);
        targets.push(serverId ? { serverUrl, serverId } : { serverUrl });
    };

    append(getActiveServerUrl(), getActiveServerId());
    for (const profile of listServerProfiles()) {
        append(profile.serverUrl, profile.id);
        append(profile.serverUrl, profile.serverIdentityId);
        for (const legacyServerId of profile.legacyServerIds ?? []) {
            append(profile.serverUrl, legacyServerId);
        }
    }

    return targets;
}

function listWebScopedCredentialKeysForCleanup(): string[] {
    if (Platform.OS !== 'web') return [];
    const storage = resolveWebStorageBackend();
    if (!storage) return [];
    const keys: string[] = [];
    try {
        for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i);
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
            const storage = resolveWebStorageBackend();
            if (!storage) return 0;
            try {
                const scopedSuppressedUntil = parse(storage.getItem(key));
                const globalSuppressedUntil = parse(storage.getItem(globalKey));
                return Math.max(scopedSuppressedUntil, globalSuppressedUntil);
            } catch {
                return 0;
            }
        }

        try {
            const [scopedStored, globalStored] = await Promise.all([
                readNativeSecureStoreString(key),
                readNativeSecureStoreString(globalKey),
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
            const storage = resolveWebStorageBackend();
            if (!storage) return false;
            try {
                storage.setItem(key, raw);
                storage.setItem(globalKey, raw);
                return true;
            } catch {
                return false;
            }
        }

        try {
            await Promise.all([
                writeNativeSecureStoreString(key, raw),
                writeNativeSecureStoreString(globalKey, raw),
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

        if (Platform.OS === 'web') {
            const storage = resolveWebStorageBackend();
            if (!storage) return false;
            try {
                const raw = storage.getItem(key);
                return parseRecoveryKeyReminderDismissedRaw(raw);
            } catch {
                return false;
            }
        }

        try {
            const stored = await readNativeSecureStoreString(key);
            recoveryKeyReminderDismissedCacheByKey.set(key, stored ?? '0');
            return parseRecoveryKeyReminderDismissedRaw(stored);
        } catch {
            return false;
        }
    },

    getCachedRecoveryKeyReminderDismissed(): boolean | null {
        const key = getRecoveryKeyReminderDismissedKeySync();
        if (!key) return null;

        if (Platform.OS === 'web') {
            const storage = resolveWebStorageBackend();
            if (!storage) return null;
            try {
                return parseRecoveryKeyReminderDismissedRaw(storage.getItem(key));
            } catch {
                return null;
            }
        }

        if (!recoveryKeyReminderDismissedCacheByKey.has(key)) return null;
        return parseRecoveryKeyReminderDismissedRaw(recoveryKeyReminderDismissedCacheByKey.get(key) ?? null);
    },

    async setRecoveryKeyReminderDismissed(value: boolean): Promise<boolean> {
        const key = await getRecoveryKeyReminderDismissedKey();
        const raw = value ? '1' : '0';

        if (Platform.OS === 'web') {
            const storage = resolveWebStorageBackend();
            if (!storage) return false;
            try {
                storage.setItem(key, raw);
                recoveryKeyReminderDismissedCacheByKey.set(key, raw);
                return true;
            } catch {
                return false;
            }
        }

        try {
            await writeNativeSecureStoreString(key, raw);
            recoveryKeyReminderDismissedCacheByKey.set(key, raw);
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

        for (const legacyKey of keys.legacy) {
            const legacyRaw = await readCredentialRawByKey(legacyKey);
            const legacyParsed = parseCredentialsRaw(legacyRaw);
            if (!legacyParsed || !legacyRaw) continue;

            const migrated = await writeCredentialRawByKey(keys.primary, legacyRaw);
            if (migrated) {
                await removeCredentialByKey(legacyKey);
            }
            return legacyParsed;
        }
        return null;
    },

    async getCredentialsForServerUrl(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<AuthCredentials | null> {
        const keys = await getServerScopedKeys(AUTH_KEY, serverUrl, options);
        const primaryRaw = await readCredentialRawByKey(keys.primary);
        const primaryParsed = parseCredentialsRaw(primaryRaw);
        if (primaryParsed) return primaryParsed;

        for (const legacyKey of keys.legacy) {
            const legacyRaw = await readCredentialRawByKey(legacyKey);
            const legacyParsed = parseCredentialsRaw(legacyRaw);
            if (!legacyParsed || !legacyRaw) continue;

            const migrated = await writeCredentialRawByKey(keys.primary, legacyRaw);
            if (migrated) {
                await removeCredentialByKey(legacyKey);
            }
            return legacyParsed;
        }
        return null;
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const keys = await getAuthKeys();
        const json = JSON.stringify(credentials);
        const written = await writeCredentialRawByKey(keys.primary, json);
        if (!written) return false;
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
        for (const legacyKey of keys.legacy) {
            await removeCredentialByKey(legacyKey);
        }
        return true;
    },

    async removeCredentials(): Promise<boolean> {
        // Clearing credentials should not implicitly suppress auth redirects forever.
        // Reset any suppression so subsequent auth flows can run normally.
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
        let allRemoved = true;
        const knownServerTargets = listKnownServerCleanupTargets();
        for (const target of knownServerTargets) {
            const keys = await getAuthKeys(
                target.serverUrl,
                target.serverId ? { serverId: target.serverId } : {},
            );
            const primaryRemoved = await removeCredentialByKey(keys.primary);
            allRemoved = allRemoved && primaryRemoved;
            for (const legacyKey of keys.legacy) {
                const legacyRemoved = await removeCredentialByKey(legacyKey);
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

    async removeCredentialsForServerUrl(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<boolean> {
        const keys = await getAuthKeys(serverUrl, options);
        const primaryRemoved = await removeCredentialByKey(keys.primary);
        for (const legacyKey of keys.legacy) {
            await removeCredentialByKey(legacyKey);
        }
        return primaryRemoved;
    },

    async invalidateCredentialsTokenForServerUrl(
        serverUrl: string,
        token: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<boolean> {
        const keys = await getAuthKeys(serverUrl, options);
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
        for (const legacyKey of keys.legacy) {
            const legacyRemoved = await removeIfMatches(legacyKey);
            if (legacyRemoved) return true;
        }
        return false;
    },

    async readPendingExternalAuthState(): Promise<PendingExternalReadState<PendingExternalAuth>> {
        const key = await getPendingExternalAuthKey();
        const scoped = await readStoredJson(key, 'pending external auth', isPendingExternalAuthRecord);
        if (scoped) {
            const serverMismatch = !doesPendingExternalStateMatchActiveServer(scoped, { requireExplicitServerContext: true });
            return {
                value: scoped,
                serverMismatch,
            };
        }
        const globalKey = getPendingExternalAuthGlobalKey();
        const global = await readStoredJson(globalKey, 'pending external auth', isPendingExternalAuthRecord);
        if (!global) {
            return {
                value: null,
                serverMismatch: false,
            };
        }
        return {
            value: global,
            serverMismatch: !doesPendingExternalStateMatchActiveServer(global, { requireExplicitServerContext: true }),
        };
    },

    async getPendingExternalAuth(): Promise<PendingExternalAuth | null> {
        const state = await this.readPendingExternalAuthState();
        if (!state.value || state.serverMismatch) {
            return null;
        }
        return state.value;
    },

    async setPendingExternalAuth(value: PendingExternalAuth): Promise<boolean> {
        const key = await getPendingExternalAuthKey();
        const storedValue = enrichPendingExternalServerContext(value, { populateMissingServerUrl: false });
        const ok = await writeStoredJson(key, 'pending external auth', storedValue);
        if (ok) {
            const globalKey = getPendingExternalAuthGlobalKey();
            await writeStoredJson(globalKey, 'pending external auth', storedValue).catch(() => false);
        }
        return ok;
    },

    async clearPendingExternalAuth(): Promise<boolean> {
        const globalKey = getPendingExternalAuthGlobalKey();
        const scopedKeys = await resolvePendingExternalScopedKeysForClear(
            PENDING_EXTERNAL_AUTH_KEY,
            globalKey,
            isPendingExternalAuthRecord,
        );
        let ok = false;
        for (const key of scopedKeys) {
            const removed = await removeStoredValue(key, 'pending external auth');
            ok = removed || ok;
        }
        await removeStoredValue(globalKey, 'pending external auth').catch(() => false);
        return ok;
    },

    async getPendingExternalConnect(): Promise<PendingExternalConnect | null> {
        const key = await getPendingExternalConnectKey();
        const scoped = await readStoredJson(key, 'pending external connect', isPendingExternalConnectRecord);
        if (scoped) {
            return doesPendingExternalStateMatchActiveServer(scoped, { requireExplicitServerContext: false }) ? scoped : null;
        }
        const globalKey = getPendingExternalConnectGlobalKey();
        const global = await readStoredJson(globalKey, 'pending external connect', isPendingExternalConnectRecord);
        if (!global) return null;
        return doesPendingExternalStateMatchActiveServer(global, { requireExplicitServerContext: true }) ? global : null;
    },

    async setPendingExternalConnect(value: PendingExternalConnect): Promise<boolean> {
        const key = await getPendingExternalConnectKey();
        const storedValue = enrichPendingExternalServerContext(value, { populateMissingServerUrl: true });
        const ok = await writeStoredJson(key, 'pending external connect', storedValue);
        if (ok) {
            const globalKey = getPendingExternalConnectGlobalKey();
            await writeStoredJson(globalKey, 'pending external connect', storedValue).catch(() => false);
        }
        return ok;
    },

    async clearPendingExternalConnect(): Promise<boolean> {
        const globalKey = getPendingExternalConnectGlobalKey();
        const scopedKeys = await resolvePendingExternalScopedKeysForClear(
            PENDING_EXTERNAL_CONNECT_KEY,
            globalKey,
            isPendingExternalConnectRecord,
        );
        let ok = false;
        for (const key of scopedKeys) {
            const removed = await removeStoredValue(key, 'pending external connect');
            ok = removed || ok;
        }
        await removeStoredValue(globalKey, 'pending external connect').catch(() => false);
        return ok;
    },
};
