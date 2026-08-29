import { Platform } from 'react-native';
import {
    AccountEncryptionMigrateRequestBindingDigestV1Schema,
} from '@happier-dev/protocol';
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
    readDeviceLocalStorageString,
    removeDeviceLocalStorageString,
    writeDeviceLocalStorageString,
} from './deviceLocalStorage';
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
export const ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS =
    10 * 60 * 1000;

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

async function digestCredentialToken(
    token: string,
): Promise<string> {
    const hash =
        await digest(
            'SHA-256',
            textToUtf8Bytes(token),
        );
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
        // Independent digests: the boot gate awaits this, so they run together rather than chained.
        const [hashScope, legacyHashScope] = await Promise.all([
            getServerHashScopeForNormalizedUrl(normalizedUrl),
            legacyNormalizedUrlForHash
                ? getServerHashScopeForNormalizedUrl(legacyNormalizedUrlForHash)
                : Promise.resolve(null),
        ]);
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

async function getPendingExternalAuthKeys(): Promise<ScopedStorageKeys> {
    return await getServerScopedKeys(PENDING_EXTERNAL_AUTH_KEY);
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

export type TokenOnlyAuthCredentials = Readonly<{
    token: string;
}>;

export type LegacyAuthCredentials = Readonly<{
    token: string;
    secret: string;
}>;

export type DataKeyAuthCredentials = Readonly<{
    token: string;
    encryption: Readonly<{
        publicKey: string;
        machineKey: string;
    }>;
}>;

export type AuthCredentials =
    | TokenOnlyAuthCredentials
    | LegacyAuthCredentials
    | DataKeyAuthCredentials;

export function isLegacyAuthCredentials(credentials: AuthCredentials): credentials is LegacyAuthCredentials {
    return typeof (credentials as any)?.secret === 'string' && (credentials as any).secret.trim().length > 0;
}

export function isDataKeyAuthCredentials(
    credentials: AuthCredentials,
): credentials is DataKeyAuthCredentials {
    const encryption = (credentials as { encryption?: unknown }).encryption;
    if (!encryption || typeof encryption !== 'object') return false;
    const record = encryption as Record<string, unknown>;
    return isNonEmptyString(record.publicKey) && isNonEmptyString(record.machineKey);
}

export function isTokenOnlyAuthCredentials(
    credentials: AuthCredentials,
): credentials is TokenOnlyAuthCredentials {
    return !isLegacyAuthCredentials(credentials) && !isDataKeyAuthCredentials(credentials);
}

export interface PendingExternalAuth {
    provider: string;
    proof?: string;
    secret?: string;
    intent?: 'signup' | 'reset';
    serverId?: string;
    serverUrl?: string;
    returnTo?: string;
    accountEncryptionFirstKey?: Readonly<{
        accountId: string;
        requestDigest: string;
        requestJson: string;
        createdAt: number;
        expiresAt: number;
        pending?: string;
        migrationSubmissionAttempted?: true;
        rejectedCredentialTokenDigest?: string;
    }>;
}

export type PendingExternalAuthFirstKeyRejectedCredentialMarkResult =
    | Readonly<{
        kind: 'recorded';
        pending: PendingExternalAuth;
    }>
    | Readonly<{ kind: 'not_current' }>
    | Readonly<{ kind: 'write_failed' }>;

export type PendingExternalAuthFirstKeyRejectedCredentialClassification =
    | Readonly<{
        kind: 'rejected';
        pending: PendingExternalAuth;
    }>
    | Readonly<{ kind: 'allowed' }>;

export type PendingExternalAuthClearOptions = Readonly<{
    removeFirstKeyMigrationAttempted?: PendingExternalAuth;
    serverUrl?: string;
    serverId?: string;
}>;

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
    if (maybe.accountEncryptionFirstKey !== undefined) {
        if (
            !maybe.accountEncryptionFirstKey
            || typeof maybe.accountEncryptionFirstKey !== 'object'
            || Array.isArray(maybe.accountEncryptionFirstKey)
        ) {
            return false;
        }
        const continuation =
            maybe.accountEncryptionFirstKey as Record<string, unknown>;
        if (
            !isNonEmptyString(continuation.accountId)
            || continuation.accountId.length > 256
            || !AccountEncryptionMigrateRequestBindingDigestV1Schema
                .safeParse(continuation.requestDigest).success
            || !isNonEmptyString(continuation.requestJson)
            || !Number.isSafeInteger(continuation.createdAt)
            || !Number.isSafeInteger(continuation.expiresAt)
            || Number(continuation.createdAt) < 0
            || Number(continuation.expiresAt)
                <= Number(continuation.createdAt)
            || Number(continuation.expiresAt)
                - Number(continuation.createdAt)
                > ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS
            || (
                continuation.pending !== undefined
                && !isNonEmptyString(continuation.pending)
            )
            || (
                continuation.migrationSubmissionAttempted !== undefined
                && continuation.migrationSubmissionAttempted !== true
            )
            || (
                continuation.migrationSubmissionAttempted === true
                && !isNonEmptyString(continuation.pending)
            )
            || (
                continuation.rejectedCredentialTokenDigest !== undefined
                && (
                    continuation.migrationSubmissionAttempted !== true
                    || typeof continuation.rejectedCredentialTokenDigest
                        !== 'string'
                    || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(
                        continuation.rejectedCredentialTokenDigest,
                    )
                )
            )
        ) {
            return false;
        }
        const keys = Object.keys(continuation);
        const allowedKeys = new Set([
            'accountId',
            'requestDigest',
            'requestJson',
            'createdAt',
            'expiresAt',
            'pending',
            'migrationSubmissionAttempted',
            'rejectedCredentialTokenDigest',
        ]);
        if (
            keys.length
                !== (
                    5
                    + (
                        continuation.pending === undefined
                            ? 0
                            : 1
                    )
                    + (
                        continuation.migrationSubmissionAttempted === undefined
                            ? 0
                            : 1
                    )
                    + (
                        continuation.rejectedCredentialTokenDigest === undefined
                            ? 0
                            : 1
                    )
                )
            || keys.some((key) => !allowedKeys.has(key))
        ) {
            return false;
        }
    }
    if (maybe.intent === undefined) return true;
    return maybe.intent === 'signup' || maybe.intent === 'reset';
}

function isPendingExternalAuthFirstKeyExpired(
    value: PendingExternalAuth,
): boolean {
    const continuation = value.accountEncryptionFirstKey;
    return Boolean(
        continuation
        && continuation.migrationSubmissionAttempted
            !== true
        && Date.now() >= continuation.expiresAt,
    );
}

function hasAttemptedFirstKeyMigration(
    value: PendingExternalAuth,
): boolean {
    return value.accountEncryptionFirstKey
        ?.migrationSubmissionAttempted === true;
}

function matchesAttemptedFirstKeyMigration(
    value: PendingExternalAuth,
    expected: PendingExternalAuth,
): boolean {
    const continuation = value.accountEncryptionFirstKey;
    const expectedContinuation =
        expected.accountEncryptionFirstKey;
    return Boolean(
        continuation?.migrationSubmissionAttempted === true
        && expectedContinuation
            ?.migrationSubmissionAttempted === true
        && value.provider.trim().toLowerCase()
            === expected.provider.trim().toLowerCase()
        && value.proof === expected.proof
        && value.secret === expected.secret
        && value.intent === expected.intent
        && value.returnTo === expected.returnTo
        && normalizeServerId(value.serverId)
            === normalizeServerId(expected.serverId)
        && normalizeUrl(value.serverUrl ?? '')
            === normalizeUrl(expected.serverUrl ?? '')
        && continuation.accountId
            === expectedContinuation.accountId
        && continuation.requestDigest
            === expectedContinuation.requestDigest
        && continuation.requestJson
            === expectedContinuation.requestJson
        && continuation.createdAt
            === expectedContinuation.createdAt
        && continuation.expiresAt
            === expectedContinuation.expiresAt
        && continuation.pending
            === expectedContinuation.pending
        && continuation.rejectedCredentialTokenDigest
            === expectedContinuation.rejectedCredentialTokenDigest,
    );
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

function doesPendingExternalStateMatchServer(
    value: PendingExternalServerContext,
    serverUrl: string,
    serverId?: string,
): boolean {
    const expectedServerId = normalizeServerId(serverId ?? null);
    const pendingServerId = normalizeServerId(
        typeof value.serverId === 'string'
            ? value.serverId
            : null,
    );
    if (expectedServerId && pendingServerId) {
        return areServerProfileIdentifiersEquivalent(
            expectedServerId,
            pendingServerId,
        );
    }
    return normalizeUrl(
        typeof value.serverUrl === 'string'
            ? value.serverUrl
            : '',
    ) === normalizeUrl(serverUrl);
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

        // Plain/keyless accounts intentionally persist only the bearer token. Account
        // E2EE material exists only for legacy or data-key credentials.
        const hasLegacySecret = isNonEmptyString(maybe.secret);
        const hasEncryption =
            !!maybe.encryption &&
            typeof maybe.encryption === 'object' &&
            isNonEmptyString((maybe.encryption as Record<string, unknown>).publicKey) &&
            isNonEmptyString((maybe.encryption as Record<string, unknown>).machineKey);

        if (hasLegacySecret || hasEncryption) return parsed as AuthCredentials;
        return { token: maybe.token };
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
    if (Platform.OS !== 'web') {
        const cached = credentialsCacheByKey.get(key);
        if (cached) return cached;
    }

    try {
        const stored = await readDeviceLocalStorageString(key);
        if (stored && Platform.OS !== 'web') credentialsCacheByKey.set(key, stored);
        return stored;
    } catch (error) {
        console.error('Error getting credentials:', error);
        return null;
    }
}

async function writeCredentialRawByKey(key: string, raw: string): Promise<boolean> {
    try {
        await writeDeviceLocalStorageString(key, raw);
        if (Platform.OS !== 'web') credentialsCacheByKey.set(key, raw);
        return true;
    } catch (error) {
        console.error('Error setting credentials:', error);
        return false;
    }
}

async function removeCredentialByKey(key: string): Promise<boolean> {
    try {
        await removeDeviceLocalStorageString(key);
        if (Platform.OS !== 'web') credentialsCacheByKey.delete(key);
        return true;
    } catch (error) {
        console.error('Error removing credentials:', error);
        return false;
    }
}

/**
 * Single owner for "read the credentials stored under this scope layout".
 *
 * The cold-boot gate awaits this, and on native each scope is a keychain round trip. The primary
 * scope still answers the common case on its own; the legacy scopes only exist for the migration
 * path, so they are probed together instead of one round trip at a time. The declared scope order
 * still decides the winner, so precedence and the legacy -> primary migration are unchanged.
 */
async function readCredentialsForScopedKeys(keys: ScopedStorageKeys): Promise<AuthCredentials | null> {
    const primaryRaw = await readCredentialRawByKey(keys.primary);
    const primaryParsed = parseCredentialsRaw(primaryRaw);
    if (primaryParsed) return primaryParsed;

    if (keys.legacy.length === 0) return null;
    const legacyRaws = await Promise.all(keys.legacy.map((legacyKey) => readCredentialRawByKey(legacyKey)));

    for (let index = 0; index < keys.legacy.length; index += 1) {
        const legacyKey = keys.legacy[index]!;
        const legacyRaw = legacyRaws[index] ?? null;
        const legacyParsed = parseCredentialsRaw(legacyRaw);
        if (!legacyParsed || !legacyRaw) continue;

        const migrated = await writeCredentialRawByKey(keys.primary, legacyRaw);
        if (migrated) {
            await removeCredentialByKey(legacyKey);
        }
        return legacyParsed;
    }
    return null;
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

let pendingExternalAuthMutationTail:
    Promise<void> = Promise.resolve();

async function serializePendingExternalAuthMutation<T>(
    mutation: () => Promise<T>,
): Promise<T> {
    const result =
        pendingExternalAuthMutationTail.then(
            mutation,
            mutation,
        );
    pendingExternalAuthMutationTail =
        result.then(
            () => undefined,
            () => undefined,
        );
    return await result;
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
        return await readCredentialsForScopedKeys(await getAuthKeys());
    },

    async getCredentialsForServerUrl(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<AuthCredentials | null> {
        return await readCredentialsForScopedKeys(await getAuthKeys(serverUrl, options));
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

    /** Persist credentials for an explicit Home without changing focused-server state. */
    async setCredentialsForServerUrl(
        serverUrl: string,
        credentials: AuthCredentials,
        options: ServerCredentialLookupOptions = {},
    ): Promise<boolean> {
        const keys = await getAuthKeys(serverUrl, options);
        const json = JSON.stringify(credentials);
        const written = await writeCredentialRawByKey(keys.primary, json);
        if (!written) return false;
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
        const targetKeys = uniqueStrings([
            keys.primary,
            ...keys.legacy,
        ]);
        const previousRawByKey = new Map<string, string>();
        for (const key of targetKeys) {
            const previousRaw = await readCredentialRawByKey(key);
            if (previousRaw !== null) {
                previousRawByKey.set(key, previousRaw);
            }
        }

        for (const key of targetKeys) {
            const removed = await removeCredentialByKey(key);
            if (removed) continue;

            for (const [
                previousKey,
                previousRaw,
            ] of previousRawByKey) {
                await writeCredentialRawByKey(
                    previousKey,
                    previousRaw,
                );
            }
            return false;
        }
        return true;
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
        const keys = await getPendingExternalAuthKeys();
        for (const key of [keys.primary, ...keys.legacy]) {
            const scoped =
                await readStoredJson(
                    key,
                    'pending external auth',
                    isPendingExternalAuthRecord,
                );
            if (!scoped) continue;
            if (isPendingExternalAuthFirstKeyExpired(scoped)) {
                await this.clearPendingExternalAuth(
                    hasAttemptedFirstKeyMigration(scoped)
                        ? {
                            removeFirstKeyMigrationAttempted:
                                scoped,
                        }
                        : undefined,
                );
                return {
                    value: null,
                    serverMismatch: false,
                };
            }
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
        if (isPendingExternalAuthFirstKeyExpired(global)) {
            await this.clearPendingExternalAuth(
                hasAttemptedFirstKeyMigration(global)
                    ? {
                        removeFirstKeyMigrationAttempted:
                            global,
                    }
                    : undefined,
            );
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

    async readPendingExternalAuthStateForServerUrl(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<PendingExternalReadState<PendingExternalAuth>> {
        const keys = await getServerScopedKeys(
            PENDING_EXTERNAL_AUTH_KEY,
            serverUrl,
            options,
        );
        for (const key of [keys.primary, ...keys.legacy]) {
            const value = await readStoredJson(
                key,
                'pending external auth',
                isPendingExternalAuthRecord,
            );
            if (!value) continue;
            return {
                value: isPendingExternalAuthFirstKeyExpired(
                    value,
                )
                    ? null
                    : value,
                serverMismatch: !doesPendingExternalStateMatchServer(
                    value,
                    serverUrl,
                    options.serverId ?? undefined,
                ),
            };
        }
        const global = await readStoredJson(
            getPendingExternalAuthGlobalKey(),
            'pending external auth',
            isPendingExternalAuthRecord,
        );
        if (
            !global
            || isPendingExternalAuthFirstKeyExpired(global)
        ) {
            return { value: null, serverMismatch: false };
        }
        return {
            value: global,
            serverMismatch: !doesPendingExternalStateMatchServer(
                global,
                serverUrl,
                options.serverId ?? undefined,
            ),
        };
    },

    async readExactPendingExternalAuthFirstKeyMigrationAttempt(
        params: Readonly<{
            expected: PendingExternalAuth;
            serverUrl: string;
            serverId?: string;
        }>,
    ): Promise<PendingExternalAuth | null> {
        const state =
            await this.readPendingExternalAuthStateForServerUrl(
                params.serverUrl,
                params.serverId
                    ? { serverId: params.serverId }
                    : {},
            );
        if (
            state.serverMismatch
            || !state.value
            || !matchesAttemptedFirstKeyMigration(
                state.value,
                params.expected,
            )
        ) {
            return null;
        }
        return state.value;
    },

    async classifyPendingExternalAuthFirstKeyRejectedCredential(
        params: Readonly<{
            serverUrl: string;
            serverId?: string;
            token: string;
        }>,
    ): Promise<PendingExternalAuthFirstKeyRejectedCredentialClassification> {
        const state =
            await this.readPendingExternalAuthStateForServerUrl(
                params.serverUrl,
                params.serverId
                    ? { serverId: params.serverId }
                    : {},
            );
        const rejectedDigest =
            state.value?.accountEncryptionFirstKey
                ?.rejectedCredentialTokenDigest;
        if (
            state.serverMismatch
            || !state.value
            || state.value.accountEncryptionFirstKey
                ?.migrationSubmissionAttempted !== true
            || !rejectedDigest
        ) {
            return { kind: 'allowed' };
        }
        const candidateDigest =
            await digestCredentialToken(params.token);
        return candidateDigest === rejectedDigest
            ? {
                kind: 'rejected',
                pending: state.value,
            }
            : { kind: 'allowed' };
    },

    async markPendingExternalAuthFirstKeyRejectedCredential(
        params: Readonly<{
            expected: PendingExternalAuth;
            serverUrl: string;
            serverId?: string;
            token: string;
        }>,
    ): Promise<PendingExternalAuthFirstKeyRejectedCredentialMarkResult> {
        return await serializePendingExternalAuthMutation(
            async () => {
                const currentCredentials =
                    await this.getCredentialsForServerUrl(
                        params.serverUrl,
                        params.serverId
                            ? {
                                serverId:
                                    params.serverId,
                            }
                            : {},
                    );
                if (
                    currentCredentials?.token
                    !== params.token
                ) {
                    return {
                        kind: 'not_current',
                    };
                }

                const keys =
                    await getServerScopedKeys(
                        PENDING_EXTERNAL_AUTH_KEY,
                        params.serverUrl,
                        params.serverId
                            ? {
                                serverId:
                                    params.serverId,
                            }
                            : {},
                    );
                let scoped:
                    | PendingExternalAuth
                    | null = null;
                const primary =
                    await readStoredJson(
                        keys.primary,
                        'pending external auth',
                        isPendingExternalAuthRecord,
                    );
                if (primary) {
                    if (
                        !matchesAttemptedFirstKeyMigration(
                            primary,
                            params.expected,
                        )
                    ) {
                        return {
                            kind: 'not_current',
                        };
                    }
                    scoped = primary;
                }
                for (const key of keys.legacy) {
                    if (scoped) break;
                    const candidate =
                        await readStoredJson(
                            key,
                            'pending external auth',
                            isPendingExternalAuthRecord,
                        );
                    if (!candidate) continue;
                    if (
                        !matchesAttemptedFirstKeyMigration(
                            candidate,
                            params.expected,
                        )
                    ) {
                        return {
                            kind: 'not_current',
                        };
                    }
                    scoped = candidate;
                }
                const globalKey =
                    getPendingExternalAuthGlobalKey();
                const global =
                    await readStoredJson(
                        globalKey,
                        'pending external auth',
                        isPendingExternalAuthRecord,
                    );
                const exactGlobal =
                    global
                    && doesPendingExternalStateMatchServer(
                        global,
                        params.serverUrl,
                        params.serverId,
                    )
                    && matchesAttemptedFirstKeyMigration(
                        global,
                        params.expected,
                    )
                        ? global
                        : null;
                if (
                    !scoped
                    && global
                    && !exactGlobal
                ) {
                    return {
                        kind: 'not_current',
                    };
                }
                const exact = scoped ?? exactGlobal;
                if (!exact) {
                    return {
                        kind: 'not_current',
                    };
                }

                const rejectedCredentialTokenDigest =
                    await digestCredentialToken(
                        params.token,
                    );
                const confirmedCredentials =
                    await this.getCredentialsForServerUrl(
                        params.serverUrl,
                        params.serverId
                            ? {
                                serverId:
                                    params.serverId,
                            }
                            : {},
                    );
                if (
                    confirmedCredentials?.token
                    !== params.token
                ) {
                    return {
                        kind: 'not_current',
                    };
                }
                const updated: PendingExternalAuth = {
                    ...exact,
                    accountEncryptionFirstKey: {
                        ...exact.accountEncryptionFirstKey!,
                        rejectedCredentialTokenDigest,
                    },
                };

                if (scoped) {
                    const written =
                        await writeStoredJson(
                            keys.primary,
                            'pending external auth',
                            updated,
                        );
                    if (!written) {
                        return {
                            kind: 'write_failed',
                        };
                    }
                    if (exactGlobal) {
                        await writeStoredJson(
                            globalKey,
                            'pending external auth',
                            updated,
                        ).catch(() => false);
                    }
                } else {
                    const written =
                        await writeStoredJson(
                            globalKey,
                            'pending external auth',
                            updated,
                        );
                    if (!written) {
                        return {
                            kind: 'write_failed',
                        };
                    }
                }
                return {
                    kind: 'recorded',
                    pending: updated,
                };
            },
        );
    },

    async setPendingExternalAuth(value: PendingExternalAuth): Promise<boolean> {
        return await serializePendingExternalAuthMutation(
            async () => {
                const key =
                    (await getPendingExternalAuthKeys())
                        .primary;
                const storedValue =
                    enrichPendingExternalServerContext(
                        value,
                        { populateMissingServerUrl: false },
                    );
                const globalKey =
                    getPendingExternalAuthGlobalKey();
                const [existingScoped, existingGlobal] =
                    await Promise.all([
                        readStoredJson(
                            key,
                            'pending external auth',
                            isPendingExternalAuthRecord,
                        ),
                        readStoredJson(
                            globalKey,
                            'pending external auth',
                            isPendingExternalAuthRecord,
                        ),
                    ]);
                if (
                    existingScoped
                    && hasAttemptedFirstKeyMigration(
                        existingScoped,
                    )
                    && !matchesAttemptedFirstKeyMigration(
                        existingScoped,
                        storedValue,
                    )
                ) {
                    return false;
                }
                if (
                    !existingScoped
                    && existingGlobal
                    && hasAttemptedFirstKeyMigration(
                        existingGlobal,
                    )
                    && doesPendingExternalStateMatchActiveServer(
                        existingGlobal,
                        { requireExplicitServerContext: true },
                    )
                    && !matchesAttemptedFirstKeyMigration(
                        existingGlobal,
                        storedValue,
                    )
                ) {
                    return false;
                }
                const ok =
                    await writeStoredJson(
                        key,
                        'pending external auth',
                        storedValue,
                    );
                if (ok) {
                    let canReplaceGlobal = true;
                    if (
                        existingGlobal
                        && hasAttemptedFirstKeyMigration(
                            existingGlobal,
                        )
                        && !matchesAttemptedFirstKeyMigration(
                            existingGlobal,
                            storedValue,
                        )
                    ) {
                        const originalKeys =
                            await getServerScopedKeys(
                                PENDING_EXTERNAL_AUTH_KEY,
                                existingGlobal.serverUrl,
                                {
                                    serverId:
                                        existingGlobal.serverId,
                                },
                            );
                        canReplaceGlobal = false;
                        for (
                            const originalKey of [
                                originalKeys.primary,
                                ...originalKeys.legacy,
                            ]
                        ) {
                            const original =
                                await readStoredJson(
                                    originalKey,
                                    'pending external auth',
                                    isPendingExternalAuthRecord,
                                );
                            if (
                                original
                                && matchesAttemptedFirstKeyMigration(
                                    original,
                                    existingGlobal,
                                )
                            ) {
                                canReplaceGlobal = true;
                                break;
                            }
                        }
                    }
                    if (canReplaceGlobal) {
                        await writeStoredJson(
                            globalKey,
                            'pending external auth',
                            storedValue,
                        ).catch(() => false);
                    }
                }
                return ok;
            },
        );
    },

    async clearPendingExternalAuth(
        options: PendingExternalAuthClearOptions = {},
    ): Promise<boolean> {
        return await serializePendingExternalAuthMutation(
            async () => {
                const globalKey =
                    getPendingExternalAuthGlobalKey();
                const scopedKeys = await (
                    options.serverUrl
                        ? getServerScopedKeys(
                                PENDING_EXTERNAL_AUTH_KEY,
                                options.serverUrl!,
                                options.serverId
                                    ? {
                                        serverId:
                                            options.serverId,
                                    }
                                    : {},
                            ).then((keys) => [
                                keys.primary,
                                ...keys.legacy,
                            ])
                        : resolvePendingExternalScopedKeysForClear(
                            PENDING_EXTERNAL_AUTH_KEY,
                            globalKey,
                            isPendingExternalAuthRecord,
                        )
                );
                const expected =
                    options.removeFirstKeyMigrationAttempted;
                if (expected) {
                    const keys = [...scopedKeys, globalKey];
                    const observed = await Promise.all(
                        keys.map(async (key) => ({
                            key,
                            value: await readStoredJson(
                                key,
                                'pending external auth',
                                isPendingExternalAuthRecord,
                            ),
                        })),
                    );
                    const matching = observed.filter(
                        (entry) =>
                            entry.value !== null
                            && matchesAttemptedFirstKeyMigration(
                                entry.value,
                                expected,
                            ),
                    );
                    if (matching.length === 0) {
                        return false;
                    }
                    const removedKeys: string[] = [];
                    for (const entry of matching) {
                        if (
                            !await removeStoredValue(
                                entry.key,
                                'pending external auth',
                            )
                        ) {
                            for (const removedKey of removedKeys) {
                                await writeStoredJson(
                                    removedKey,
                                    'pending external auth',
                                    expected,
                                ).catch(() => false);
                            }
                            return false;
                        }
                        removedKeys.push(entry.key);
                    }
                    return true;
                }
                const removeIfAuthorized = async (
                    key: string,
                ): Promise<boolean> => {
                    const value = await readStoredJson(
                        key,
                        'pending external auth',
                        isPendingExternalAuthRecord,
                    );
                    if (
                        value
                        && hasAttemptedFirstKeyMigration(
                            value,
                        )
                    ) {
                        return false;
                    }
                    return await removeStoredValue(
                        key,
                        'pending external auth',
                    );
                };
                let ok = false;
                for (const key of scopedKeys) {
                    const removed =
                        await removeIfAuthorized(key);
                    ok = removed || ok;
                }
                const globalRemoved =
                    await removeIfAuthorized(globalKey)
                        .catch(() => false);
                ok = globalRemoved || ok;
                return ok;
            },
        );
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
