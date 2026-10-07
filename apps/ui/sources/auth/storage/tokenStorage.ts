import { Platform } from 'react-native';
import { z } from 'zod';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';
import {
    AccountEncryptionMigrateRequestBindingDigestV1Schema,
    AuthEntryProviderPresentationV1Schema,
    TeamInvitationPostAuthContinuationV1Schema,
} from '@happier-dev/protocol';
import type { AuthEntryProviderPresentationV1, TeamInvitationPostAuthContinuationV1 } from '@happier-dev/protocol';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerId,
    getActiveServerUrl,
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { retireIrohHomeTransportDiagnostics } from '@/sync/runtime/irohHomeTransportDiagnostics';
import { withHomeMutationAuthority, type HomeMutationAuthority } from '@/sync/domains/server/homeMutationLock';
import { digest } from '@/platform/digest';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
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
const ACCOUNT_SERVICE_RECOVERY_KEY_REMINDER_DISMISSED_KEY = 'account_service_recovery_key_reminder_dismissed';
const PENDING_PERSONAL_HOME_BOOTSTRAP_SEED_KEY = 'pending_personal_home_bootstrap_seed';

/**
 * Account Service credentials are deliberately kept outside the Home credential
 * scope.  These names are persisted contracts: do not fold them into
 * `auth_credentials` or `pending_external_auth`, since older Home readers may
 * consume that data.
 */
export const ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY =
    'account_directory_auth_credentials';
export const PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY =
    'pending_account_directory_auth';
export const ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS =
    10 * 60 * 1000;
const ACCOUNT_DIRECTORY_STORAGE_MUTATION_LOCK_PREFIX =
    'happier:account-directory-storage-mutation';

function textToUtf8Bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

type ScopedStorageKeys = Readonly<{
    primary: string;
    legacy: readonly string[];
}>;

type PendingPersonalHomeBootstrapSeedRecord = Readonly<{
    v: 1;
    seedBase64Url: string;
}>;

export type ServerCredentialLookupOptions = Readonly<{
    serverId?: string | null;
    /** Only write when the currently stored credential still owns this scope. */
    expectedCredentials?: AuthCredentials;
}>;

/**
 * How a credential read reports a device secure-storage read failure.
 * `absent` (default) keeps the tolerant contract boot, request and migration
 * paths rely on: an unreadable store reads as no credential. `surface` rethrows
 * the storage error so a caller that can present "unavailable" never turns a
 * transient keychain/storage failure into a sign-out claim.
 */
export type ServerCredentialReadOptions = ServerCredentialLookupOptions & Readonly<{
    storageReadFailure?: 'absent' | 'surface';
}>;

/**
 * Exact-scope rollback handle returned by
 * `TokenStorage.setCredentialsForServerUrlWithRollback`. Composition owners
 * that write Home credentials before a final profile adoption must call
 * `rollback()` when that adoption fails. `serverId` is the canonical identity
 * the write was keyed by (null for a legacy URL-scope write).
 */
export type HomeCredentialWriteRollback = Readonly<{
    serverUrl: string;
    serverId: string | null;
    rollback(): Promise<boolean>;
}>;

export type HomeCredentialMutationEvent = Readonly<{
    kind: 'credentials_set' | 'credentials_removed';
    serverId: string;
    serverUrl: string;
    credentials?: AuthCredentials;
}>;

type HomeCredentialMutationListener = (event: HomeCredentialMutationEvent) => void;

const homeCredentialMutationListeners = new Set<HomeCredentialMutationListener>();

export function subscribeHomeCredentialMutations(
    listener: HomeCredentialMutationListener,
): () => void {
    homeCredentialMutationListeners.add(listener);
    return () => {
        homeCredentialMutationListeners.delete(listener);
    };
}

const accountDirectoryCredentialMutationListeners = new Set<() => void>();

/**
 * Observe writes to the stored Account Service sign-ins (sign-in, sign-out, replacement), so
 * surfaces that state "signed in" re-read instead of keeping a stale answer.
 */
export function subscribeAccountDirectoryCredentialMutations(listener: () => void): () => void {
    accountDirectoryCredentialMutationListeners.add(listener);
    return () => {
        accountDirectoryCredentialMutationListeners.delete(listener);
    };
}

function emitAccountDirectoryCredentialMutation(): void {
    for (const listener of [...accountDirectoryCredentialMutationListeners]) {
        try {
            listener();
        } catch {
            // Persistence success is authoritative; an observer cannot fail the write.
        }
    }
}

/** Explicit Account Service endpoint/identity key. */
export type AccountDirectoryCredentialTarget = Readonly<{
    endpoint: string;
    /** Account Service/server identity returned by the OAuth audience. */
    serverIdentityId: string;
}>;

export type AccountDirectoryOAuthReturnCustody = Readonly<{
    endpoint: string;
    serverIdentityId: string;
    canonicalServerUrl: string;
    entryIntent: AccountContinuationIntent;
    returnTo: string;
    accountEntryReturnTo?: string;
    /** Non-secret binding to the exact restricted credential committed for this return. */
    credentialTokenDigest: string;
    keyAuthSecret?: Uint8Array;
    authenticatedHome?: Readonly<{ homeServerIdentityId: string; credentials: AuthCredentials }>;
    homeAuthenticationFailure?: Readonly<{ homeServerIdentityId: string; code: 'restore_required' }>;
}>;

export type AccountHomeAuthenticationContinuation = Readonly<Pick<AccountDirectoryOAuthReturnCustody,
    'endpoint' | 'serverIdentityId' | 'canonicalServerUrl' | 'entryIntent' | 'returnTo' | 'accountEntryReturnTo'
    | 'credentialTokenDigest'
> & { homeServerIdentityId: string }>;

const ContinuationIdentitySchema = z.string().trim().min(1);
const AccountContinuationIntentSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('refresh') }).strict(),
    z.object({ kind: z.literal('link'), homeServerIdentityId: ContinuationIdentitySchema }).strict(),
    z.object({ kind: z.literal('enroll'), homeServerIdentityId: ContinuationIdentitySchema }).strict(),
    z.object({ kind: z.literal('enter'), target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('automatic') }).strict(),
        z.object({ kind: z.literal('explicit'), homeServerIdentityId: ContinuationIdentitySchema }).strict(),
    ]) }).strict(),
]);
const ContinuationEndpointSchema = z.string().transform((value, context) => {
    const endpoint = normalizeAccountDirectoryEndpoint(value);
    if (endpoint) return endpoint;
    context.addIssue({ code: 'custom', message: 'Invalid Account-service endpoint' });
    return z.NEVER;
});
const ContinuationReturnPathSchema = z.string().transform((value, context) => {
    const path = normalizeInternalReturnPath(value);
    if (path) return path;
    context.addIssue({ code: 'custom', message: 'Invalid internal return path' });
    return z.NEVER;
});
const AccountHomeAuthenticationContinuationSchema = z.object({
    endpoint: ContinuationEndpointSchema,
    canonicalServerUrl: ContinuationEndpointSchema,
    serverIdentityId: ContinuationIdentitySchema,
    homeServerIdentityId: ContinuationIdentitySchema,
    entryIntent: AccountContinuationIntentSchema,
    returnTo: ContinuationReturnPathSchema,
    accountEntryReturnTo: ContinuationReturnPathSchema.optional(),
    credentialTokenDigest: z.string().refine(isAccountDirectoryCredentialTokenDigest),
}).strict().superRefine((row, context) => {
    const intentTarget = row.entryIntent.kind === 'enter'
        ? row.entryIntent.target.kind === 'explicit' ? row.entryIntent.target.homeServerIdentityId : null
        : row.entryIntent.kind === 'refresh' ? null : row.entryIntent.homeServerIdentityId;
    if (intentTarget && intentTarget !== row.homeServerIdentityId) {
        context.addIssue({ code: 'custom', path: ['entryIntent'], message: 'Home continuation target mismatch' });
    }
});

export function parseAccountHomeAuthenticationContinuation(value: unknown): AccountHomeAuthenticationContinuation | null {
    const parsed = AccountHomeAuthenticationContinuationSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

let accountDirectoryOAuthReturnCustody: AccountDirectoryOAuthReturnCustody | null = null;

function clearAccountDirectoryOAuthReturnCustody(): void {
    accountDirectoryOAuthReturnCustody?.keyAuthSecret?.fill(0);
    accountDirectoryOAuthReturnCustody = null;
}

export type AccountDirectoryStorageReadResult<T> =
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'valid'; value: T }>
    | Readonly<{ kind: 'corrupt' }>
    | Readonly<{ kind: 'unavailable' }>;

export class AccountDirectoryStorageReadError extends Error {
    constructor(readonly reason: 'corrupt' | 'unavailable') {
        super(`Account Directory secure storage is ${reason}`);
        this.name = 'AccountDirectoryStorageReadError';
    }
}

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

function isAccountDirectoryCredentialTokenDigest(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export async function digestAccountDirectoryCredentialToken(
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

async function getPendingPersonalHomeBootstrapSeedStorageKey(
    serverUrl: string,
    options: ServerCredentialLookupOptions,
): Promise<string | null> {
    const normalizedServerUrl = normalizeUrl(serverUrl);
    if (!normalizedServerUrl) return null;
    const serverId = normalizeServerId(options.serverId);
    const scopeHash = await getServerHashScopeForNormalizedUrl(
        `${normalizedServerUrl}\u0000${serverId ?? ''}`,
    );
    return makeScopedKey(PENDING_PERSONAL_HOME_BOOTSTRAP_SEED_KEY, scopeHash);
}

function parsePendingPersonalHomeBootstrapSeedRecord(
    value: unknown,
): PendingPersonalHomeBootstrapSeedRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== 'seedBase64Url' || keys[1] !== 'v') return null;
    if (record.v !== 1 || typeof record.seedBase64Url !== 'string') return null;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(record.seedBase64Url)) return null;
    try {
        const seed = decodeBase64(record.seedBase64Url, 'base64url');
        if (seed.length !== 32 || encodeBase64(seed, 'base64url') !== record.seedBase64Url) return null;
    } catch {
        return null;
    }
    return { v: 1, seedBase64Url: record.seedBase64Url };
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
    // More than one Home can reach the same URL (a moved Home retaining its old
    // alias, or a legacy/manual duplicate). Picking one by registry order would
    // attribute that URL's credentials to an arbitrary identity, so ambiguity
    // resolves to no identity and callers fall back to the anonymous URL scope.
    const matches = profiles.filter((profile) => normalizeUrl(profile.serverUrl) === normalized);
    const match = matches.length === 1 ? matches[0]! : null;
    return match ? (normalizeServerId(match.serverIdentityId ?? null) ?? match.id) : null;
}

/**
 * Profiles that can currently derive the anonymous URL-hash scope for this URL,
 * through either their canonical routing URL or a retained legacy/manual alias.
 */
function listProfilesClaimingUrl(normalizedUrl: string) {
    if (!normalizedUrl) return [];
    return listServerProfiles().filter((profile) => (
        normalizeUrl(profile.serverUrl) === normalizedUrl
        || normalizeUrl(profile.canonicalServerUrl ?? '') === normalizedUrl
    ));
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

type HomeCredentialIdentityResolution = Readonly<{
    /** Canonical stable identity that owns the credential scope; null when none resolves. */
    serverId: string | null;
    /** Explicit identity without a profile yet: a strict pre-adoption scope. */
    preProfile: boolean;
    /**
     * The explicitly supplied identity belongs to a profile at a different URL.
     * Callers must fail closed instead of deriving a URL-hash scope.
     */
    conflict: boolean;
}>;

/**
 * Single canonical resolution of the stable Home identity behind an explicit
 * credential target. Storage key derivation and mutation-event targeting must
 * both consume this helper so the announced target can never diverge from the
 * scope that actually receives the write.
 *
 * - Explicit identity without a profile: enrollment/adoption may persist
 *   credentials before the profile exists only while no other profile owns the
 *   URL, so the validated stable identity is the primary scope directly.
 *   URL-hash scopes are excluded from this strict pre-adoption scope: anonymous
 *   URL data belongs to no identity and must never be migrated into one (or
 *   read as one). Profile-backed reads remain the only URL-hash migration input.
 * - Explicit identity with a profile at the same URL: the profile's canonical
 *   identity wins.
 * - Explicit identity whose profile lives at a different URL: conflict; fail
 *   closed rather than attributing credentials to the wrong identity.
 * - No explicit identity: legacy/manual URL-only resolution is preserved.
 */
function resolveHomeCredentialIdentity(
    normalizedServerUrl: string,
    requestedServerId: string | null,
): HomeCredentialIdentityResolution {
    if (!requestedServerId) {
        return { serverId: resolveServerIdForUrl(normalizedServerUrl), preProfile: false, conflict: false };
    }
    const requestedProfile = findServerProfileForIdentifier(requestedServerId);
    if (!requestedProfile) {
        const profileAtUrl = listServerProfiles().find(
            (profile) => normalizeUrl(profile.serverUrl) === normalizedServerUrl,
        );
        if (profileAtUrl) {
            return { serverId: null, preProfile: false, conflict: true };
        }
        return { serverId: requestedServerId, preProfile: true, conflict: false };
    }
    if (normalizeUrl(requestedProfile.serverUrl) === normalizedServerUrl) {
        return {
            serverId: normalizeServerId(requestedProfile.serverIdentityId) ?? requestedProfile.id,
            preProfile: false,
            conflict: false,
        };
    }
    return { serverId: null, preProfile: false, conflict: true };
}

function resolveHomeCredentialMutationTarget(
    serverUrl: string,
    options: ServerCredentialLookupOptions,
): Readonly<{ serverId: string; serverUrl: string }> | null {
    const normalizedServerUrl = normalizeUrl(serverUrl);
    if (!normalizedServerUrl) return null;

    const resolution = resolveHomeCredentialIdentity(normalizedServerUrl, normalizeServerId(options.serverId));
    if (resolution.conflict || !resolution.serverId) return null;
    return { serverId: resolution.serverId, serverUrl: normalizedServerUrl };
}

function emitHomeCredentialMutation(
    kind: HomeCredentialMutationEvent['kind'],
    serverUrl: string,
    options: ServerCredentialLookupOptions,
    credentials?: AuthCredentials,
): void {
    const target = resolveHomeCredentialMutationTarget(serverUrl, options);
    if (!target) return;
    const event = { kind, ...target } as HomeCredentialMutationEvent;
    // Keep the existing observable event shape stable for subscribers that
    // compare the routing tuple, while allowing the captured Account-settings
    // owner to identify its own conditional adoption write.
    if (credentials) {
        Object.defineProperty(event, 'credentials', {
            value: credentials,
            enumerable: false,
        });
    }
    for (const listener of [...homeCredentialMutationListeners]) {
        try {
            listener(event);
        } catch {
            // Persistence success is authoritative; one observer cannot turn it
            // into a failed credential operation or prevent other observers.
        }
    }
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

/**
 * Resolves the storage scope layout for a server target. Returns null only when
 * an explicitly supplied identity conflicts with the profile registry; such
 * callers must fail closed instead of deriving a URL-hash scope.
 */
async function getServerScopedKeys(
    baseKey: string,
    serverUrlOverride?: string,
    options: ServerCredentialLookupOptions = {},
): Promise<ScopedStorageKeys | null> {
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
    const requestedServerId = normalizeServerId(options.serverId);
    let serverId: string | null;
    let preAdoptionIdentityScope = false;
    if (requestedServerId) {
        // Explicit identity targets resolve through the canonical identity owner:
        // the validated stable identity is the primary scope even before the
        // profile exists, and a conflict with an existing profile fails closed.
        const resolution = resolveHomeCredentialIdentity(normalizedUrl, requestedServerId);
        if (resolution.conflict) return null;
        serverId = resolution.serverId;
        preAdoptionIdentityScope = resolution.preProfile;
    } else {
        const preferredServerId = normalizeServerId(activeServerId);
        const resolvedServerId = resolveServerIdForUrl(normalizedUrl, preferredServerId);
        const activeServerProfile = activeServerId ? findServerProfileForIdentifier(activeServerId) : null;
        const activeServerUrl = activeServerProfile
            ? normalizeUrl(activeServerProfile.serverUrl)
            : '';

        // If the active server URL is coming from env/same-origin fallback but the persisted active server id
        // still points at a different profile, do NOT use the id scope. Fall back to a URL hash scope so
        // credentials are never read from the wrong server.
        serverId = resolvedServerId ?? (activeServerUrl && activeServerUrl === normalizedUrl ? activeServerId : null);
    }

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
    // URL-hash data belongs to no identity, so it is a migration input only while
    // exactly this Home can reach that URL. When another profile also claims it,
    // reading or migrating it here would hand one Home another Home's credential.
    const resolvedProfileId = findServerProfileForIdentifier(serverId)?.id ?? null;
    const urlHashScopeIsShared = [normalizedUrl, legacyNormalizedUrlForHash]
        .filter((candidate) => Boolean(candidate))
        .some((candidate) => listProfilesClaimingUrl(candidate)
            .some((profile) => profile.id !== resolvedProfileId));
    // A strict pre-adoption identity scope is identity-keyed only. URL-hash data
    // belongs to no identity; it must never migrate into (or be readable as) one.
    const [canonicalUrlScope, legacyUrlScope] = preAdoptionIdentityScope || urlHashScopeIsShared
        ? [null, null] as const
        : await Promise.all([
            getServerHashScopeForNormalizedUrl(normalizedUrl),
            legacyNormalizedUrlForHash
                ? getServerHashScopeForNormalizedUrl(legacyNormalizedUrlForHash)
                : Promise.resolve(null),
        ]);
    return {
        primary: makeScopedKey(baseKey, idScope),
        legacy: preAdoptionIdentityScope
            ? []
            : uniqueStrings([
                ...profileIdScopes.map((scope) => makeScopedKey(baseKey, scope)),
                !canonicalUrlScope || canonicalUrlScope === idScope
                    ? null
                    : makeScopedKey(baseKey, canonicalUrlScope),
                !legacyUrlScope || legacyUrlScope === idScope || legacyUrlScope === canonicalUrlScope
                    ? null
                    : makeScopedKey(baseKey, legacyUrlScope),
            ]),
    };
}

async function getAuthKeys(
    serverUrlOverride?: string,
    options: ServerCredentialLookupOptions = {},
): Promise<ScopedStorageKeys | null> {
    return await getServerScopedKeys(AUTH_KEY, serverUrlOverride, options);
}

/**
 * Active-server derivation never carries an explicit identity option, so it
 * cannot produce an identity/URL conflict; the fallback only satisfies types
 * for that structurally unreachable branch.
 */
async function getActiveServerScopedKeys(baseKey: string): Promise<ScopedStorageKeys> {
    return (await getServerScopedKeys(baseKey)) ?? { primary: makeScopedKey(baseKey, 'default'), legacy: [] };
}

async function getPendingExternalAuthKeys(): Promise<ScopedStorageKeys> {
    return await getActiveServerScopedKeys(PENDING_EXTERNAL_AUTH_KEY);
}

function getPendingExternalAuthGlobalKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(PENDING_EXTERNAL_AUTH_GLOBAL_KEY, scope);
}

async function getPendingExternalConnectKey(): Promise<string> {
    return (await getActiveServerScopedKeys(PENDING_EXTERNAL_CONNECT_KEY)).primary;
}

async function resolvePendingExternalScopedKeysForClear(
    baseKey: string,
    globalKey: string,
    validator: (value: unknown) => value is PendingExternalServerContext,
): Promise<ReadonlyArray<string>> {
    const scopedKeys = new Set<string>();
    const activeKeys = await getActiveServerScopedKeys(baseKey);
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
    if (originalKeys) {
        scopedKeys.add(originalKeys.primary);
        for (const legacyKey of originalKeys.legacy) {
            scopedKeys.add(legacyKey);
        }
    }

    return [...scopedKeys];
}

function getPendingExternalConnectGlobalKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(PENDING_EXTERNAL_CONNECT_GLOBAL_KEY, scope);
}

async function getAuthAutoRedirectSuppressedUntilKey(): Promise<string> {
    return (await getActiveServerScopedKeys(AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_KEY)).primary;
}

function getAuthAutoRedirectSuppressedUntilGlobalKey(): string {
    const scope = Platform.OS === 'web' ? null : readStorageScopeFromEnv();
    return scopedStorageId(AUTH_AUTO_REDIRECT_SUPPRESSED_UNTIL_GLOBAL_KEY, scope);
}

/**
 * Whose recovery key a reminder is about: a Home Account (by the Home it lives on) or an Account
 * on an account service (by the service's identity). The two never share a key, so a dual-role
 * server's account-service reminder cannot overwrite, or duplicate, that server's Home reminder.
 */
export type RecoveryKeyReminderTarget =
    | Readonly<{ kind?: 'home'; serverUrl: string; serverId?: string }>
    | Readonly<{ kind: 'account_service'; serverIdentityId: string }>;

async function getRecoveryKeyReminderDismissedKey(
    target?: RecoveryKeyReminderTarget,
): Promise<string | null> {
    if (target?.kind === 'account_service') {
        const identity = target.serverIdentityId.trim();
        if (!identity) return null;
        return scopedStorageId(
            `${ACCOUNT_SERVICE_RECOVERY_KEY_REMINDER_DISMISSED_KEY}__svc_${sanitizeScopeToken(identity)}`,
            readStorageScopeFromEnv(),
        );
    }
    const keys = target
        ? await getServerScopedKeys(
            RECOVERY_KEY_REMINDER_DISMISSED_KEY,
            target.serverUrl,
            target.serverId ? { serverId: target.serverId } : {},
        )
        : await getActiveServerScopedKeys(RECOVERY_KEY_REMINDER_DISMISSED_KEY);
    return keys?.primary ?? null;
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

const CredentialStringSchema = z.string().min(1).refine((value) => value.trim() === value);
const AuthCredentialsSchema = z.object({
    token: CredentialStringSchema,
    secret: CredentialStringSchema.optional(),
    encryption: z.object({ publicKey: CredentialStringSchema, machineKey: CredentialStringSchema }).strict().optional(),
}).strict().superRefine((record, context) => {
    // Known material fields select the credential shape; dropping additive
    // fields must never reinterpret E2EE or conflicting material as keyless.
    if ((Object.hasOwn(record, 'secret') && record.secret === undefined)
        || (Object.hasOwn(record, 'encryption') && record.encryption === undefined)
        || (Object.hasOwn(record, 'secret') && Object.hasOwn(record, 'encryption'))) {
        context.addIssue({ code: 'custom', message: 'Invalid credential material shape' });
    }
}).transform((record): AuthCredentials => record.secret !== undefined
    ? { token: record.token, secret: record.secret }
    : record.encryption !== undefined ? { token: record.token, encryption: record.encryption }
        : { token: record.token });
const StoredAuthCredentialsSchema = createStoredReadSchema(AuthCredentialsSchema);

/** Strict credential admission; stored reads derive their projection from this same schema. */
export function parseAuthCredentials(value: unknown): AuthCredentials | null {
    const parsed = AuthCredentialsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/**
 * Short-lived Account Service OAuth continuation.  This type intentionally
 * lives beside the dedicated storage owner rather than extending
 * `PendingExternalAuth`; keeping the namespaces disjoint is part of the
 * persistence compatibility contract.
 */
export type PendingAccountDirectoryAuth = Readonly<{
    /** Normalized endpoint; always present on values returned by storage. */
    endpoint: string;
    serverIdentityId: string;
    /** Canonical callback spelling retained for the plan/API boundary. */
    credentialTarget: 'account_directory';
    entryIntent: AccountContinuationIntent;
    canonicalServerUrl: string;
    provider: string;
    purpose: 'account_directory';
    /** Server-generated post-provider handle; absent before the provider redirect completes. */
    pending?: string;
    createdAt: number;
    expiresAt: number;
    mode?: 'keyed' | 'keyless';
    proof?: string;
    secret?: string;
    returnTo?: string;
    accountEntryReturnTo?: string;
    /**
     * Optional stable identity of the Home that was authenticated when this login started.
     * Identity intent only — never Home credentials or a descriptor. Records without it are
     * accepted and behave like fresh-device discovery.
     */
    linkHomeServerIdentityId?: string;
    explicitHomeServerIdentityId?: string;
    /** Provider/state metadata is opaque to storage but retained for callback dispatch. */
    state?: string;
    nonce?: string;
}>;

export type PendingAccountDirectoryAuthInput = Readonly<{
    endpoint: string;
    serverIdentityId: string;
    credentialTarget: 'account_directory';
    entryIntent: AccountContinuationIntent;
    canonicalServerUrl: string;
    provider: string;
    purpose: 'account_directory';
    pending?: string;
    createdAt: number;
    expiresAt: number;
    mode?: 'keyed' | 'keyless';
    proof?: string;
    secret?: string;
    returnTo?: string;
    accountEntryReturnTo?: string;
    linkHomeServerIdentityId?: string;
    explicitHomeServerIdentityId?: string;
    state?: string;
    nonce?: string;
}>;

type NormalizedPendingAccountDirectoryAuth = Readonly<{
    endpoint: string;
    serverIdentityId: string;
    credentialTarget: 'account_directory';
    entryIntent: AccountContinuationIntent;
    canonicalServerUrl: string;
    provider: string;
    purpose: 'account_directory';
    pending?: string;
    createdAt: number;
    expiresAt: number;
    mode?: 'keyed' | 'keyless';
    proof?: string;
    secret?: string;
    returnTo?: string;
    accountEntryReturnTo?: string;
    linkHomeServerIdentityId?: string;
    explicitHomeServerIdentityId?: string;
    state?: string;
    nonce?: string;
}>;

export type PendingAccountDirectoryAuthTarget = Readonly<{
    endpoint: string;
    serverIdentityId: string;
}>;

export type PendingAccountDirectoryAuthCustodyResolution =
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'matched'; pending: PendingAccountDirectoryAuth }>
    | Readonly<{ kind: 'ambiguous' }>
    | Readonly<{ kind: 'corrupt' }>
    | Readonly<{ kind: 'unavailable' }>;

export type AccountDirectoryOAuthCredentialCommitResult =
    | Readonly<{ kind: 'committed' }>
    | Readonly<{ kind: 'custody_lost' }>
    | Readonly<{
        kind: 'storage_failed';
        /** True only when replacement succeeded and restoration of the prior credential failed. */
        accountCredentialCommitted: boolean;
    }>;

export function parseAccountContinuationIntent(value: unknown): AccountContinuationIntent | null {
    const parsed = AccountContinuationIntentSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function isLegacyAuthCredentials(credentials: AuthCredentials): credentials is LegacyAuthCredentials {
    return 'secret' in credentials
        && typeof credentials.secret === 'string'
        && credentials.secret.trim().length > 0;
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
    /**
     * The Home's projected presentation of `provider` at start (teams-lane-03/01
     * §10.2), so the return route names a dynamic provider as its Home does.
     * Optional: continuations written before it existed still read.
     */
    presentation?: AuthEntryProviderPresentationV1;
    proof?: string;
    secret?: string;
    intent?: 'signup' | 'reset';
    serverId?: string;
    serverUrl?: string;
    returnTo?: string;
    accountContinuation?: AccountHomeAuthenticationContinuation;
    teamContinuation?: Readonly<{
        v: 1;
        purpose: 'team_admission';
        admissionReference: string;
        teamId: string;
        homeServerIdentityId: string;
        destination: Readonly<{ kind: 'team_sign_in'; teamId: string }>;
    }>;
    /** Server-held invitation authority returned after authentication; never a raw bearer copy. */
    postAuthInvitation?: TeamInvitationPostAuthContinuationV1;
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
    /** Remove only this exact pending ceremony; a newer flow must survive stale callbacks. */
    removeExact?: PendingExternalAuth;
    serverUrl?: string;
    serverId?: string;
}>;

function matchesPendingExternalAuthExact(current: PendingExternalAuth, expected: PendingExternalAuth): boolean {
    return current.provider === expected.provider && current.proof === expected.proof
        && current.secret === expected.secret && current.intent === expected.intent
        && current.serverId === expected.serverId && current.serverUrl === expected.serverUrl
        && current.returnTo === expected.returnTo
        && JSON.stringify(current.teamContinuation) === JSON.stringify(expected.teamContinuation)
        && JSON.stringify(current.postAuthInvitation) === JSON.stringify(expected.postAuthInvitation)
        && JSON.stringify(current.accountContinuation) === JSON.stringify(expected.accountContinuation);
}

export interface PendingExternalConnect {
    provider: string;
    /** As on `PendingExternalAuth`: the start-time Home presentation, when one was projected. */
    presentation?: AuthEntryProviderPresentationV1;
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
    return normalizeInternalReturnPath(value) !== null;
}

export { normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';

function normalizeAccountDirectoryIdentity(value: unknown): string | null {
    const identity = String(value ?? '').trim();
    return identity.length > 0 ? identity : null;
}

function normalizeAccountDirectoryTarget(
    target: AccountDirectoryCredentialTarget,
): Readonly<{ endpoint: string; serverIdentityId: string }> | null {
    const endpoint = normalizeAccountDirectoryEndpoint(target.endpoint);
    const serverIdentityId = normalizeAccountDirectoryIdentity(target.serverIdentityId);
    if (!endpoint || !serverIdentityId) return null;
    return {
        endpoint,
        serverIdentityId,
    };
}

type StoredAccountDirectoryCredentialRecord = Readonly<{
    endpoint: string;
    serverIdentityId: string;
    credentials: TokenOnlyAuthCredentials;
    updatedAt: number;
}>;

function isStoredAccountDirectoryCredentialRecord(
    value: unknown,
): value is StoredAccountDirectoryCredentialRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const endpoint = typeof row.endpoint === 'string'
        ? normalizeAccountDirectoryEndpoint(row.endpoint)
        : null;
    const identity = row.serverIdentityId;
    const credentials = row.credentials;
    const updatedAt = row.updatedAt;
    if (!endpoint || !isNonEmptyString((credentials as Record<string, unknown> | null)?.token)) {
        return false;
    }
    if (!isNonEmptyString(identity)) return false;
    if (
        typeof updatedAt !== 'number'
        || !Number.isFinite(updatedAt)
        || !Number.isSafeInteger(updatedAt)
    ) return false;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return false;
    // Unknown stored fields are projected away below. Home material is a known
    // conflicting credential shape, not an additive Account-service field.
    return !Object.hasOwn(credentials, 'secret') && !Object.hasOwn(credentials, 'encryption');
}

function parseStoredAccountDirectoryCredentialRecords(value: unknown): StoredAccountDirectoryCredentialRecord[] | null {
    if (!Array.isArray(value)) return null;
    const records: StoredAccountDirectoryCredentialRecord[] = [];
    for (const candidate of value) {
        if (!isStoredAccountDirectoryCredentialRecord(candidate)) return null;
        const row = candidate as Record<string, unknown>;
        const endpoint = normalizeAccountDirectoryEndpoint(String(row.endpoint));
        const identity = normalizeAccountDirectoryIdentity(row.serverIdentityId);
        const credentials = row.credentials as Record<string, unknown>;
        if (!endpoint || !identity || !isNonEmptyString(credentials.token)) return null;
        records.push({
            endpoint,
            serverIdentityId: identity,
            credentials: { token: credentials.token },
            updatedAt: Number(row.updatedAt),
        });
    }
    return records;
}

function accountDirectoryCredentialRecordMatchesTarget(
    record: StoredAccountDirectoryCredentialRecord,
    target: Readonly<{ endpoint: string; serverIdentityId: string }>,
): boolean {
    return record.endpoint === target.endpoint
        && record.serverIdentityId === target.serverIdentityId;
}

type PendingAccountDirectoryAuthStoredRecord = NormalizedPendingAccountDirectoryAuth;

function isPendingAccountDirectoryAuthFieldsValid(
    value: unknown,
): value is PendingAccountDirectoryAuthStoredRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const endpointRaw = row.endpoint;
    const endpoint = typeof endpointRaw === 'string'
        ? normalizeAccountDirectoryEndpoint(endpointRaw)
        : null;
    const identity = row.serverIdentityId;
    const intent = parseAccountContinuationIntent(row.entryIntent);
    if (
        !endpoint
        || !isNonEmptyString(row.provider)
        || !normalizeAccountDirectoryEndpoint(typeof row.canonicalServerUrl === 'string' ? row.canonicalServerUrl : '')
        || row.purpose !== 'account_directory'
        || row.credentialTarget !== 'account_directory'
        || !intent
        || (row.pending !== undefined && !isNonEmptyString(row.pending))
        || !Number.isSafeInteger(row.createdAt)
        || !Number.isSafeInteger(row.expiresAt)
        || Number(row.createdAt) < 0
        || Number(row.expiresAt) <= Number(row.createdAt)
        || (row.mode !== undefined && row.mode !== 'keyed' && row.mode !== 'keyless')
        || !isNonEmptyString(row.serverIdentityId)
        || (row.proof !== undefined && !isNonEmptyString(row.proof))
        || (row.secret !== undefined && !isNonEmptyString(row.secret))
        || (row.mode === 'keyless' && row.secret !== undefined)
        || (row.returnTo !== undefined && !isInternalReturnTo(row.returnTo))
        || (row.accountEntryReturnTo !== undefined && !isInternalReturnTo(row.accountEntryReturnTo))
        || (row.linkHomeServerIdentityId !== undefined && (intent?.kind !== 'link' || row.linkHomeServerIdentityId !== intent.homeServerIdentityId))
        || (row.explicitHomeServerIdentityId !== undefined && (intent?.kind !== 'enter' || intent.target.kind !== 'explicit'
            || row.explicitHomeServerIdentityId !== intent.target.homeServerIdentityId))
        || (row.state !== undefined && !isNonEmptyString(row.state))
        || (row.nonce !== undefined && !isNonEmptyString(row.nonce))
    ) {
        return false;
    }

    // New pre-redirect records have no server pending handle yet. They must
    // carry the explicit Directory target marker and endpoint identity, plus
    // exactly one supported mode-dependent local binding: keyless uses the
    // proof, while keyed binds the local signing secret and carries no proof.
    if (
        row.pending === undefined
        && (
            !isNonEmptyString(identity)
            || (
                row.mode === 'keyless'
                    ? !isNonEmptyString(row.proof)
                    : row.mode === 'keyed'
                        ? !isNonEmptyString(row.secret) || row.proof !== undefined
                        : true
            )
        )
    ) {
        return false;
    }

    return isNonEmptyString(identity);
}

const PendingAccountDirectoryAuthSchema = z.object({
    endpoint: z.string(), serverIdentityId: z.string(), canonicalServerUrl: z.string(),
    credentialTarget: z.literal('account_directory'), purpose: z.literal('account_directory'),
    entryIntent: AccountContinuationIntentSchema, provider: z.string(), pending: z.string().optional(),
    createdAt: z.number(), expiresAt: z.number(), mode: z.enum(['keyed', 'keyless']).optional(),
    proof: z.string().optional(), secret: z.string().optional(), returnTo: z.string().optional(),
    accountEntryReturnTo: z.string().optional(), linkHomeServerIdentityId: z.string().optional(),
    explicitHomeServerIdentityId: z.string().optional(), state: z.string().optional(), nonce: z.string().optional(),
}).strict().refine(isPendingAccountDirectoryAuthFieldsValid);
const StoredPendingAccountDirectoryAuthSchema = createStoredReadSchema(PendingAccountDirectoryAuthSchema);

function normalizePendingAccountDirectoryAuth(
    value: PendingAccountDirectoryAuthInput | PendingAccountDirectoryAuth,
    options: Readonly<{ includeExpired?: boolean }> = {},
): NormalizedPendingAccountDirectoryAuth | null {
    const parsed = PendingAccountDirectoryAuthSchema.safeParse(value);
    if (!parsed.success) return null;
    value = parsed.data;
    const raw = value as Record<string, unknown>;
    const endpoint = normalizeAccountDirectoryEndpoint(String(raw.endpoint ?? ''));
    const identity = normalizeAccountDirectoryIdentity(raw.serverIdentityId);
    if (
        !endpoint
        || !identity
        || (options.includeExpired !== true && Date.now() >= value.expiresAt)
    ) return null;
    const canonicalServerUrl = normalizeAccountDirectoryEndpoint(String(raw.canonicalServerUrl ?? ''));
    if (!canonicalServerUrl) return null;
    return {
        endpoint,
        serverIdentityId: identity,
        credentialTarget: 'account_directory',
        entryIntent: parseAccountContinuationIntent(value.entryIntent)!,
        canonicalServerUrl,
        provider: value.provider.trim(),
        purpose: 'account_directory',
        ...(value.pending ? { pending: value.pending.trim() } : {}),
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        ...(value.mode ? { mode: value.mode } : {}),
        ...(value.proof ? { proof: value.proof.trim() } : {}),
        ...(value.secret ? { secret: value.secret.trim() } : {}),
        ...(value.returnTo ? { returnTo: normalizeInternalReturnPath(value.returnTo)! } : {}),
        ...(value.accountEntryReturnTo ? { accountEntryReturnTo: normalizeInternalReturnPath(value.accountEntryReturnTo)! } : {}),
        ...(value.linkHomeServerIdentityId ? { linkHomeServerIdentityId: value.linkHomeServerIdentityId.trim() } : {}),
        ...(value.explicitHomeServerIdentityId ? { explicitHomeServerIdentityId: value.explicitHomeServerIdentityId.trim() } : {}),
        ...(value.state ? { state: value.state.trim() } : {}),
        ...(value.nonce ? { nonce: value.nonce.trim() } : {}),
    };
}

function pendingAccountDirectoryAuthMatchesTarget(
    value: NormalizedPendingAccountDirectoryAuth,
    target: Readonly<{ endpoint: string; serverIdentityId: string | null }>,
): boolean {
    return normalizeAccountDirectoryEndpoint(value.endpoint) === target.endpoint
        && (normalizeAccountDirectoryIdentity(value.serverIdentityId) ?? null)
            === target.serverIdentityId;
}

function pendingAccountDirectoryAuthMatchesExact(
    current: NormalizedPendingAccountDirectoryAuth,
    expected: NormalizedPendingAccountDirectoryAuth,
): boolean {
    return current.endpoint === expected.endpoint
        && current.serverIdentityId === expected.serverIdentityId
        && current.credentialTarget === expected.credentialTarget
        && JSON.stringify(current.entryIntent) === JSON.stringify(expected.entryIntent)
        && current.canonicalServerUrl === expected.canonicalServerUrl
        && current.provider === expected.provider
        && current.purpose === expected.purpose
        && current.pending === expected.pending
        && current.createdAt === expected.createdAt
        && current.expiresAt === expected.expiresAt
        && current.mode === expected.mode
        && current.proof === expected.proof
        && current.secret === expected.secret
        && current.returnTo === expected.returnTo
        && current.accountEntryReturnTo === expected.accountEntryReturnTo
        && current.linkHomeServerIdentityId === expected.linkHomeServerIdentityId
        && current.explicitHomeServerIdentityId === expected.explicitHomeServerIdentityId
        && current.state === expected.state
        && current.nonce === expected.nonce;
}

function isOptionalPendingProviderPresentation(value: unknown): boolean {
    return value === undefined || AuthEntryProviderPresentationV1Schema.safeParse(value).success;
}

function isPendingExternalAuthFieldsValid(value: unknown): value is PendingExternalAuth {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    if (maybe.accountPasswordEnrollment !== undefined) return false;
    if (!isNonEmptyString(maybe.provider)) return false;
    const secret = maybe.secret;
    const proof = maybe.proof;
    const mode = maybe.mode;
    const hasSecret = isNonEmptyString(secret);
    const hasProof = isNonEmptyString(proof);
    // New flow requires proof for binding. Accept legacy secret-only records for backward compatibility.
    const isNativeMtlsContinuation = maybe.provider === 'mtls'
        && maybe.accountEncryptionFirstKey === undefined
        && !hasProof
        && !hasSecret;
    if (!hasProof && !hasSecret && !isNativeMtlsContinuation) return false;
    if (mode !== undefined && mode !== 'keyed' && mode !== 'keyless') return false;
    if (!isOptionalPendingProviderPresentation(maybe.presentation)) return false;
    if (maybe.serverId !== undefined && !isNonEmptyString(maybe.serverId)) return false;
    if (maybe.serverUrl !== undefined && !isNonEmptyString(maybe.serverUrl)) return false;
    if (maybe.returnTo !== undefined && !isInternalReturnTo(maybe.returnTo)) return false;
    // Kept from the validated record so the invitation check below reads the
    // same Team the continuation names rather than re-narrowing the raw value.
    let continuationTeamId: unknown;
    if (maybe.teamContinuation !== undefined) {
        if (!maybe.teamContinuation || typeof maybe.teamContinuation !== 'object' || Array.isArray(maybe.teamContinuation)) return false;
        const team = maybe.teamContinuation as Record<string, unknown>;
        const destination = team.destination;
        const teamKeys = Object.keys(team).sort();
        const destinationKeys = destination && typeof destination === 'object' && !Array.isArray(destination)
            ? Object.keys(destination).sort()
            : [];
        if (
            JSON.stringify(teamKeys) !== JSON.stringify([
                'admissionReference',
                'destination',
                'homeServerIdentityId',
                'purpose',
                'teamId',
                'v',
            ])
            || team.v !== 1
            || team.purpose !== 'team_admission'
            || !isNonEmptyString(team.admissionReference)
            || !isNonEmptyString(team.teamId)
            || !isNonEmptyString(team.homeServerIdentityId)
            || team.homeServerIdentityId !== maybe.serverId
            || maybe.returnTo !== undefined
            || maybe.accountContinuation !== undefined
            || !destination
            || typeof destination !== 'object'
            || Array.isArray(destination)
            || JSON.stringify(destinationKeys) !== JSON.stringify(['kind', 'teamId'])
            || (destination as Record<string, unknown>).kind !== 'team_sign_in'
            || (destination as Record<string, unknown>).teamId !== team.teamId
        ) return false;
        continuationTeamId = team.teamId;
    }
    if (maybe.postAuthInvitation !== undefined) {
        const parsed = TeamInvitationPostAuthContinuationV1Schema.safeParse(maybe.postAuthInvitation);
        if (!parsed.success || continuationTeamId !== parsed.data.teamId) return false;
    }
    if (maybe.accountContinuation !== undefined) {
        const continuation = parseAccountHomeAuthenticationContinuation(maybe.accountContinuation);
        if (!continuation || maybe.serverId !== continuation.homeServerIdentityId || maybe.returnTo !== continuation.returnTo
            || !isNonEmptyString(maybe.serverUrl) || maybe.accountEncryptionFirstKey !== undefined) return false;
    }
    if (isNativeMtlsContinuation) {
        if (!isNonEmptyString(maybe.serverId) || !isNonEmptyString(maybe.serverUrl)) return false;
        if (maybe.teamContinuation === undefined
            && maybe.accountContinuation === undefined
            && !isInternalReturnTo(maybe.returnTo)) return false;
    }
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

const PendingExternalAuthSchema = z.object({
    provider: z.string(),
    presentation: AuthEntryProviderPresentationV1Schema.optional(),
    proof: z.string().optional(),
    secret: z.string().optional(),
    mode: z.enum(['keyed', 'keyless']).optional(),
    intent: z.enum(['signup', 'reset']).optional(),
    serverId: z.string().optional(),
    serverUrl: z.string().optional(),
    returnTo: z.string().optional(),
    accountContinuation: AccountHomeAuthenticationContinuationSchema.optional(),
    teamContinuation: z.object({
        v: z.literal(1), purpose: z.literal('team_admission'),
        admissionReference: z.string(), teamId: z.string(), homeServerIdentityId: z.string(),
        destination: z.object({ kind: z.literal('team_sign_in'), teamId: z.string() }).strict(),
    }).strict().optional(),
    postAuthInvitation: TeamInvitationPostAuthContinuationV1Schema.optional(),
    accountEncryptionFirstKey: z.object({
        accountId: z.string(), requestDigest: z.string(), requestJson: z.string(),
        createdAt: z.number(), expiresAt: z.number(), pending: z.string().optional(),
        migrationSubmissionAttempted: z.literal(true).optional(), rejectedCredentialTokenDigest: z.string().optional(),
    }).strict().optional(),
    // This recognized custody is intentionally never persisted; it cannot
    // become an ignorable future field in the stored projection.
    accountPasswordEnrollment: z.never().optional(),
}).strict().refine(isPendingExternalAuthFieldsValid);
const StoredPendingExternalAuthSchema = createStoredReadSchema(PendingExternalAuthSchema);

function isPendingExternalAuthRecord(value: unknown): value is PendingExternalAuth {
    return PendingExternalAuthSchema.safeParse(value).success;
}

function parseStoredJsonValue<T>(value: unknown, validator: (value: unknown) => value is T): T | null {
    // The pending Home return consumes the same canonical fields and domain
    // checks as admission. Only persisted unknown-field policy differs.
    if (validator === isPendingExternalAuthRecord) {
        const parsed = StoredPendingExternalAuthSchema.safeParse(value);
        return parsed.success && validator(parsed.data) ? parsed.data : null;
    }
    return validator(value) ? value : null;
}

function isPendingPurposeBoundExternalAuthExpired(
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
    if (!isOptionalPendingProviderPresentation(maybe.presentation)) return false;
    if (maybe.serverId !== undefined && !isNonEmptyString(maybe.serverId)) return false;
    if (maybe.serverUrl !== undefined && !isNonEmptyString(maybe.serverUrl)) return false;
    return true;
}

function hasExactPendingExternalServerTarget(
    value: PendingExternalServerContext,
): value is PendingExternalServerContext & Readonly<{ serverId: string; serverUrl: string }> {
    return Boolean(
        normalizeServerId(typeof value.serverId === 'string' ? value.serverId : null)
        && normalizeUrl(typeof value.serverUrl === 'string' ? value.serverUrl : ''),
    );
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
    storageReadFailure: 'absent' | 'surface' = 'absent',
): Promise<T | null> {
    if (Platform.OS === 'web') {
        const storage = resolveWebStorageBackend();
        if (!storage) {
            if (storageReadFailure === 'surface') throw new Error('Secure storage unavailable');
            return null;
        }
        try {
            const raw = storage.getItem(key);
            if (!raw) return null;
            const parsed = safeParseJson(raw);
            return parseStoredJsonValue(parsed, validator);
        } catch (error) {
            if (storageReadFailure === 'surface') throw error;
            console.error(`Error getting ${label}:`, error);
            return null;
        }
    }

    try {
        const stored = await readNativeSecureStoreString(key);
        if (!stored) return null;
        const parsed = safeParseJson(stored);
        return parseStoredJsonValue(parsed, validator);
    } catch (error) {
        if (storageReadFailure === 'surface') throw error;
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

function getAccountDirectoryStorageKey(baseKey: string): string {
    return scopedStorageId(baseKey, readStorageScopeFromEnv());
}

async function readAccountDirectoryCredentialRecords(): Promise<
    AccountDirectoryStorageReadResult<readonly StoredAccountDirectoryCredentialRecord[]>
> {
    try {
        const raw = await readDeviceLocalStorageString(
            getAccountDirectoryStorageKey(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY),
        );
        if (raw === null) return { kind: 'absent' };
        const parsed = parseStoredAccountDirectoryCredentialRecords(safeParseJson(raw));
        return parsed ? { kind: 'valid', value: parsed } : { kind: 'corrupt' };
    } catch {
        return { kind: 'unavailable' };
    }
}

async function writeAccountDirectoryCredentialRecords(
    records: readonly StoredAccountDirectoryCredentialRecord[],
): Promise<boolean> {
    try {
        const previous = await readAccountDirectoryCredentialRecords();
        if (previous.kind === 'corrupt' || previous.kind === 'unavailable') return false;
        if (records.length === 0) {
            await removeDeviceLocalStorageString(
                getAccountDirectoryStorageKey(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY),
            );
        } else {
            await writeDeviceLocalStorageString(
                getAccountDirectoryStorageKey(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY),
                JSON.stringify(records),
            );
        }
        const scope = getAccountDirectoryStorageKey(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY);
        for (const custody of accountDirectoryCredentialCustodies.values()) {
            if (custody.scope !== scope) continue;
            const before = previous.kind === 'valid'
                ? previous.value.find((record) => accountDirectoryCredentialRecordMatchesTarget(record, custody.target))?.credentials.token
                : undefined;
            const after = records.find((record) => accountDirectoryCredentialRecordMatchesTarget(record, custody.target))?.credentials.token;
            if (before !== after) custody.revision += 1;
        }
        emitAccountDirectoryCredentialMutation();
        return true;
    } catch {
        return false;
    }
}

async function readPendingAccountDirectoryAuthRecords(): Promise<
    AccountDirectoryStorageReadResult<readonly NormalizedPendingAccountDirectoryAuth[]>
> {
    try {
        const raw = await readDeviceLocalStorageString(
            getAccountDirectoryStorageKey(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY),
        );
        if (raw === null) return { kind: 'absent' };
        const parsed = safeParseJson(raw);
        if (!Array.isArray(parsed)) return { kind: 'corrupt' };
        const records: NormalizedPendingAccountDirectoryAuth[] = [];
        for (const candidate of parsed) {
            const read = StoredPendingAccountDirectoryAuthSchema.safeParse(candidate);
            if (!read.success) return { kind: 'corrupt' };
            const normalized = normalizePendingAccountDirectoryAuth(read.data, {
                includeExpired: true,
            });
            if (!normalized) return { kind: 'corrupt' };
            records.push(normalized);
        }
        return { kind: 'valid', value: records };
    } catch {
        return { kind: 'unavailable' };
    }
}

async function writePendingAccountDirectoryAuthRecords(
    records: readonly NormalizedPendingAccountDirectoryAuth[],
): Promise<boolean> {
    try {
        if (records.length === 0) {
            await removeDeviceLocalStorageString(
                getAccountDirectoryStorageKey(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY),
            );
        } else {
            await writeDeviceLocalStorageString(
                getAccountDirectoryStorageKey(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY),
                JSON.stringify(records),
            );
        }
        return true;
    } catch {
        return false;
    }
}

function parseCredentialsRaw(raw: string | null): AuthCredentials | null {
    if (!raw) return null;
    try {
        const parsed = StoredAuthCredentialsSchema.safeParse(safeParseJson(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function areCredentialsEqual(left: AuthCredentials | null, right: AuthCredentials): boolean {
    if (!left || left.token !== right.token) return false;
    if (isLegacyAuthCredentials(left) || isLegacyAuthCredentials(right)) {
        return isLegacyAuthCredentials(left)
            && isLegacyAuthCredentials(right)
            && left.secret === right.secret;
    }
    if (isDataKeyAuthCredentials(left) || isDataKeyAuthCredentials(right)) {
        return isDataKeyAuthCredentials(left)
            && isDataKeyAuthCredentials(right)
            && left.encryption.publicKey === right.encryption.publicKey
            && left.encryption.machineKey === right.encryption.machineKey;
    }
    return true;
}

function parseRecoveryKeyReminderDismissedRaw(raw: string | null): boolean {
    if (!raw) return false;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

async function readCredentialRawByKey(
    key: string,
    storageReadFailure: 'absent' | 'surface' = 'absent',
): Promise<string | null> {
    if (Platform.OS !== 'web') {
        const cached = credentialsCacheByKey.get(key);
        if (cached) return cached;
    }

    try {
        const stored = await readDeviceLocalStorageString(key);
        if (stored && Platform.OS !== 'web') credentialsCacheByKey.set(key, stored);
        return stored;
    } catch (error) {
        if (storageReadFailure === 'surface') throw error;
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

const credentialScopeOperationTails = new Map<string, Promise<void>>();

async function serializeCredentialScopeOperation<T>(primaryKey: string, run: () => Promise<T>): Promise<T> {
    const previous = credentialScopeOperationTails.get(primaryKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    credentialScopeOperationTails.set(primaryKey, current);
    await previous;
    try {
        return await run();
    } finally {
        release();
        if (credentialScopeOperationTails.get(primaryKey) === current) {
            credentialScopeOperationTails.delete(primaryKey);
        }
    }
}

async function serializeCredentialScopeOperations<T>(
    keys: readonly string[],
    run: () => Promise<T>,
    authority?: HomeMutationAuthority,
): Promise<T> {
    return await withHomeMutationAuthority(authority, async () => {
        const orderedKeys = uniqueStrings(keys).sort();
        const acquire = async (index: number): Promise<T> => {
            const key = orderedKeys[index];
            if (!key) return await run();
            return await serializeCredentialScopeOperation(
                key,
                async () => await acquire(index + 1),
            );
        };
        return await acquire(0);
    });
}

/**
 * Single owner for "read the credentials stored under this scope layout".
 *
 * The cold-boot gate awaits this, and on native each scope is a keychain round trip. The primary
 * scope still answers the common case on its own; the legacy scopes only exist for the migration
 * path, so they are probed together instead of one round trip at a time. The declared scope order
 * still decides the winner, so precedence and the legacy -> primary migration are unchanged.
 */
async function readCredentialsForScopedKeys(
    keys: ScopedStorageKeys,
    authority?: HomeMutationAuthority,
    storageReadFailure: 'absent' | 'surface' = 'absent',
): Promise<AuthCredentials | null> {
    return await serializeCredentialScopeOperations([keys.primary, ...keys.legacy], async () => {
    // Only the presence probes may surface a storage failure; the migration
    // re-reads below stay tolerant so a failed probe never half-migrates.
    const primaryRaw = await readCredentialRawByKey(keys.primary, storageReadFailure);
    const primaryParsed = parseCredentialsRaw(primaryRaw);
    if (primaryParsed) return primaryParsed;

    if (keys.legacy.length === 0) return null;
    // One unreadable legacy scope must not hide a credential a sibling scope
    // still holds; the failure surfaces only when no probe produced one.
    const legacyProbes = await Promise.allSettled(
        keys.legacy.map((legacyKey) => readCredentialRawByKey(legacyKey, storageReadFailure)),
    );
    const legacyRaws = legacyProbes.map((probe) => (probe.status === 'fulfilled' ? probe.value : null));
    const legacyReadFailure = legacyProbes.find(
        (probe): probe is PromiseRejectedResult => probe.status === 'rejected',
    );

    for (let index = 0; index < keys.legacy.length; index += 1) {
        const legacyKey = keys.legacy[index]!;
        const legacyRaw = legacyRaws[index] ?? null;
        const legacyParsed = parseCredentialsRaw(legacyRaw);
        if (!legacyParsed || !legacyRaw) continue;

        // A different writer may claim primary custody while legacy probes are
        // in flight. Re-read before migration; the concurrent primary wins and
        // the legacy scope remains available for its actual owner/recovery.
        const concurrentPrimaryRaw = await readCredentialRawByKey(keys.primary);
        const concurrentPrimary = parseCredentialsRaw(concurrentPrimaryRaw);
        if (concurrentPrimary) return concurrentPrimary;
        const migrated = await writeCredentialRawByKey(keys.primary, legacyRaw);
        if (migrated) {
            const verifiedPrimaryRaw = await readCredentialRawByKey(keys.primary);
            if (verifiedPrimaryRaw === legacyRaw) {
                await removeCredentialByKey(legacyKey);
            } else {
                return parseCredentialsRaw(verifiedPrimaryRaw) ?? legacyParsed;
            }
        }
        return legacyParsed;
    }
        if (legacyReadFailure) throw legacyReadFailure.reason;
        return null;
    }, authority);
}

async function removeCredentialKeysAtomically(targetKeys: readonly string[]): Promise<boolean> {
    const keys = uniqueStrings(targetKeys);
    const previousRawByKey = new Map<string, string | null>();
    for (const key of keys) {
        const previousRaw = await readCredentialRawByKey(key);
        previousRawByKey.set(key, previousRaw);
    }

    for (const key of keys) {
        const previousRaw = previousRawByKey.get(key);
        if (previousRaw === undefined) continue;
        if (await readCredentialRawByKey(key) !== previousRaw) continue;
        const removed = await removeCredentialByKey(key);
        if (removed) continue;

        for (const [previousKey, previousRaw] of previousRawByKey) {
            if (previousRaw === null) continue;
            if (await readCredentialRawByKey(previousKey) === null) {
                await writeCredentialRawByKey(previousKey, previousRaw);
            }
        }
        return false;
    }
    return true;
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
        const key = serverId ? `id:${serverId}` : `url:${serverUrl}`;
        if (seen.has(key)) return;
        seen.add(key);
        targets.push(serverId ? { serverUrl, serverId } : { serverUrl });
    };

    for (const profile of listServerProfiles()) {
        append(profile.serverUrl, profile.serverIdentityId ?? profile.id);
    }

    const activeServerId = getActiveServerId();
    const activeProfile = findServerProfileForIdentifier(activeServerId);
    if (activeProfile) {
        append(
            activeProfile.serverUrl,
            activeProfile.serverIdentityId ?? activeProfile.id,
        );
    } else {
        append(getActiveServerUrl(), activeServerId);
    }

    return targets;
}

type WebScopedCredentialSnapshot = Readonly<{
    key: string;
    raw: string;
}>;

function listWebScopedCredentialKeysForCleanup(): WebScopedCredentialSnapshot[] {
    if (Platform.OS !== 'web') return [];
    const storage = resolveWebStorageBackend();
    if (!storage) return [];
    const snapshots: WebScopedCredentialSnapshot[] = [];
    try {
        for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i);
            if (!key) continue;
            if (key === AUTH_KEY || key.startsWith(`${AUTH_KEY}__srv_`)) {
                const raw = storage.getItem(key);
                if (raw !== null) snapshots.push({ key, raw });
            }
        }
    } catch {
        return [];
    }
    return snapshots;
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

let accountDirectoryStorageMutationTail: Promise<void> = Promise.resolve();

function accountDirectoryStorageMutationLockName(): string {
    return `${ACCOUNT_DIRECTORY_STORAGE_MUTATION_LOCK_PREFIX}:${getAccountDirectoryStorageKey('account-directory')}`;
}

/**
 * Serializes the complete latest-read/mutate/write transaction for both Account
 * Service custody arrays. Browser tabs share the Web Lock; non-web runtimes
 * retain one process-local tail around their async store.
 */
async function serializeAccountDirectoryStorageMutation<T>(
    mutation: () => Promise<T>,
): Promise<T> {
    if (Platform.OS === 'web') {
        const lockManager = typeof navigator === 'undefined'
            ? null
            : navigator.locks ?? null;
        if (!lockManager) {
            throw new Error('Browser Account Service storage locking is unavailable');
        }
        return await lockManager.request(
            accountDirectoryStorageMutationLockName(),
            mutation,
        );
    }

    const result = accountDirectoryStorageMutationTail.then(mutation, mutation);
    accountDirectoryStorageMutationTail = result.then(
        () => undefined,
        () => undefined,
    );
    return await result;
}

function parseDirectoryTokenCredentials(value: unknown): TokenOnlyAuthCredentials | null {
    const parsed = parseAuthCredentials(value);
    return parsed && isTokenOnlyAuthCredentials(parsed) ? parsed : null;
}

async function getAccountDirectoryCredentialsForTarget(
    target: AccountDirectoryCredentialTarget,
): Promise<AccountDirectoryStorageReadResult<TokenOnlyAuthCredentials>> {
    const normalized = normalizeAccountDirectoryTarget(target);
    if (!normalized) return { kind: 'absent' };
    const read = await readAccountDirectoryCredentialRecords();
    if (read.kind !== 'valid') return read.kind === 'absent' ? read : { kind: read.kind };
    const matches = read.value
        .filter((record) => accountDirectoryCredentialRecordMatchesTarget(record, normalized))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    const record = matches[0];
    return record
        ? { kind: 'valid', value: { token: record.credentials.token } }
        : { kind: 'absent' };
}

async function commitAccountDirectoryOAuthCredentialValue(input: Readonly<{
    expectedPending: PendingAccountDirectoryAuth;
    credentials: TokenOnlyAuthCredentials;
}>): Promise<AccountDirectoryOAuthCredentialCommitResult> {
    const expectedPending = normalizePendingAccountDirectoryAuth(
        input.expectedPending,
        { includeExpired: true },
    );
    const credentials = parseDirectoryTokenCredentials(input.credentials);
    if (!expectedPending) return { kind: 'custody_lost' };
    if (!credentials) return { kind: 'storage_failed', accountCredentialCommitted: false };

    return await serializeAccountDirectoryStorageMutation(async () => {
        const [credentialRead, pendingRead] = await Promise.all([
            readAccountDirectoryCredentialRecords(),
            readPendingAccountDirectoryAuthRecords(),
        ]);
        if (
            credentialRead.kind === 'corrupt'
            || credentialRead.kind === 'unavailable'
            || pendingRead.kind === 'corrupt'
            || pendingRead.kind === 'unavailable'
        ) return { kind: 'storage_failed', accountCredentialCommitted: false };

        const pendingRecords = pendingRead.kind === 'valid' ? pendingRead.value : [];
        if (!pendingRecords.some((record) => pendingAccountDirectoryAuthMatchesExact(record, expectedPending))) {
            return { kind: 'custody_lost' };
        }

        const target = {
            endpoint: expectedPending.endpoint,
            serverIdentityId: expectedPending.serverIdentityId,
        };
        const previousCredentials = credentialRead.kind === 'valid' ? credentialRead.value : [];
        const nextCredentials = previousCredentials.filter(
            (record) => !accountDirectoryCredentialRecordMatchesTarget(record, target),
        );
        nextCredentials.push({
            ...target,
            credentials,
            updatedAt: Date.now(),
        });
        nextCredentials.sort((left, right) => right.updatedAt - left.updatedAt);
        const nextPending = pendingRecords.filter(
            (record) => !pendingAccountDirectoryAuthMatchesExact(record, expectedPending),
        );

        if (!await writeAccountDirectoryCredentialRecords(nextCredentials)) {
            return { kind: 'storage_failed', accountCredentialCommitted: false };
        }
        if (await writePendingAccountDirectoryAuthRecords(nextPending)) {
            if (
                accountDirectoryOAuthReturnCustody?.endpoint === target.endpoint
                && accountDirectoryOAuthReturnCustody.serverIdentityId === target.serverIdentityId
            ) clearAccountDirectoryOAuthReturnCustody();
            return { kind: 'committed' };
        }

        const restored = await writeAccountDirectoryCredentialRecords(previousCredentials);
        return { kind: 'storage_failed', accountCredentialCommitted: !restored };
    });
}

async function setAccountDirectoryCredentialsForTarget(
    target: AccountDirectoryCredentialTarget,
    credentials: TokenOnlyAuthCredentials,
): Promise<boolean> {
    const normalized = normalizeAccountDirectoryTarget(target);
    const parsedCredentials = parseDirectoryTokenCredentials(credentials);
    if (!normalized || !parsedCredentials) return false;

    return await serializeAccountDirectoryStorageMutation(async () => {
        const read = await readAccountDirectoryCredentialRecords();
        if (read.kind === 'corrupt' || read.kind === 'unavailable') return false;
        const records = read.kind === 'valid' ? read.value : [];
        const next = records.filter(
            (record) => !accountDirectoryCredentialRecordMatchesTarget(record, normalized),
        );
        next.push({
            endpoint: normalized.endpoint,
            serverIdentityId: normalized.serverIdentityId,
            credentials: parsedCredentials,
            updatedAt: Date.now(),
        });
        next.sort((left, right) => right.updatedAt - left.updatedAt);
        const written = await writeAccountDirectoryCredentialRecords(next);
        if (written && accountDirectoryOAuthReturnCustody?.endpoint === normalized.endpoint
            && accountDirectoryOAuthReturnCustody.serverIdentityId === normalized.serverIdentityId) clearAccountDirectoryOAuthReturnCustody();
        return written;
    });
}

async function removeAccountDirectoryCredentialsForTarget(
    target: AccountDirectoryCredentialTarget,
): Promise<boolean> {
    const normalized = normalizeAccountDirectoryTarget(target);
    if (!normalized) return false;
    return await serializeAccountDirectoryStorageMutation(async () => {
        const read = await readAccountDirectoryCredentialRecords();
        if (read.kind === 'corrupt' || read.kind === 'unavailable') return false;
        const records = read.kind === 'valid' ? read.value : [];
        const next = records.filter((record) => !accountDirectoryCredentialRecordMatchesTarget(record, normalized));
        if (next.length === records.length) return true;
        const written = await writeAccountDirectoryCredentialRecords(next);
        if (written && accountDirectoryOAuthReturnCustody?.endpoint === normalized.endpoint
            && accountDirectoryOAuthReturnCustody.serverIdentityId === normalized.serverIdentityId) clearAccountDirectoryOAuthReturnCustody();
        return written;
    });
}

async function clearAccountDirectoryCredentials(): Promise<boolean> {
    return await serializeAccountDirectoryStorageMutation(async () => {
        const [credentialRead, pendingRead] = await Promise.all([
            readAccountDirectoryCredentialRecords(),
            readPendingAccountDirectoryAuthRecords(),
        ]);
        if (
            credentialRead.kind === 'corrupt'
            || credentialRead.kind === 'unavailable'
            || pendingRead.kind === 'corrupt'
            || pendingRead.kind === 'unavailable'
        ) return false;
        const previousCredentials = credentialRead.kind === 'valid' ? credentialRead.value : [];
        if (!await writeAccountDirectoryCredentialRecords([])) return false;
        if (await writePendingAccountDirectoryAuthRecords([])) {
            clearAccountDirectoryOAuthReturnCustody();
            return true;
        }
        await writeAccountDirectoryCredentialRecords(previousCredentials);
        return false;
    });
}

async function setPendingAccountDirectoryAuthValue(
    value: PendingAccountDirectoryAuthInput,
): Promise<boolean> {
    const normalized = normalizePendingAccountDirectoryAuth(value);
    if (!normalized) return false;

    return await serializeAccountDirectoryStorageMutation(async () => {
        const read = await readPendingAccountDirectoryAuthRecords();
        if (read.kind === 'corrupt' || read.kind === 'unavailable') return false;
        const records = read.kind === 'valid' ? read.value : [];
        const next = records.filter((record) => !pendingAccountDirectoryAuthMatchesTarget(record, {
            endpoint: normalized.endpoint,
            serverIdentityId: normalizeAccountDirectoryIdentity(normalized.serverIdentityId),
        }));
        next.push(normalized);
        const written = await writePendingAccountDirectoryAuthRecords(next);
        if (written) clearAccountDirectoryOAuthReturnCustody();
        return written;
    });
}

async function getPendingAccountDirectoryAuthValue(
    target: PendingAccountDirectoryAuthTarget,
    options: Readonly<{ includeExpired?: boolean }> = {},
): Promise<PendingAccountDirectoryAuth | null> {
    const normalized = normalizeAccountDirectoryTarget(target);
    if (!normalized) return null;
    const read = await readPendingAccountDirectoryAuthRecords();
    if (read.kind === 'corrupt' || read.kind === 'unavailable') {
        throw new AccountDirectoryStorageReadError(read.kind);
    }
    const records = read.kind === 'valid' ? read.value : [];
    const matches = records
        .filter((record) => pendingAccountDirectoryAuthMatchesTarget(record, normalized))
        .filter((record) => options.includeExpired === true || Date.now() < record.expiresAt)
        .sort((left, right) => right.createdAt - left.createdAt);
    return matches[0] ?? null;
}

async function resolvePendingAccountDirectoryAuthCustodyValue(
    provider: string,
): Promise<PendingAccountDirectoryAuthCustodyResolution> {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider) return { kind: 'absent' };
    const read = await readPendingAccountDirectoryAuthRecords();
    if (read.kind === 'corrupt' || read.kind === 'unavailable') return read;
    const matches = (read.kind === 'valid' ? read.value : [])
        .filter((record) => record.provider === normalizedProvider)
        .sort((left, right) => right.createdAt - left.createdAt);
    if (matches.length === 0) return { kind: 'absent' };
    if (matches.length > 1) return { kind: 'ambiguous' };
    return { kind: 'matched', pending: matches[0]! };
}

async function clearPendingAccountDirectoryAuthValue(
    target?: PendingAccountDirectoryAuthTarget,
    options: Readonly<{ expected?: PendingAccountDirectoryAuth }> = {},
): Promise<boolean> {
    if (target === undefined) {
        return await serializeAccountDirectoryStorageMutation(async () => {
            const read = await readPendingAccountDirectoryAuthRecords();
            if (read.kind === 'corrupt' || read.kind === 'unavailable') return false;
            return await writePendingAccountDirectoryAuthRecords([]);
        });
    }
    const normalized = normalizeAccountDirectoryTarget(target);
    const expected = options.expected
        ? normalizePendingAccountDirectoryAuth(options.expected, { includeExpired: true })
        : null;
    if (
        !normalized
        || (options.expected !== undefined && !expected)
        || (expected && !pendingAccountDirectoryAuthMatchesTarget(expected, normalized))
    ) return false;
    return await serializeAccountDirectoryStorageMutation(async () => {
        const read = await readPendingAccountDirectoryAuthRecords();
        if (read.kind === 'corrupt' || read.kind === 'unavailable') return false;
        const records = read.kind === 'valid' ? read.value : [];
        const next = records.filter((record) => expected
            ? !pendingAccountDirectoryAuthMatchesExact(record, expected)
            : !pendingAccountDirectoryAuthMatchesTarget(record, normalized));
        if (next.length === records.length) return true;
        return await writePendingAccountDirectoryAuthRecords(next);
    });
}

async function logoutAccountDirectoryTarget(
    target: AccountDirectoryCredentialTarget,
    isCurrent?: () => boolean,
    expectedToken?: string | null,
): Promise<boolean> {
    const normalized = normalizeAccountDirectoryTarget(target);
    if (!normalized) return false;
    return await serializeAccountDirectoryStorageMutation(async () => {
        if (isCurrent && !isCurrent()) return false;
        const [credentialRead, pendingRead] = await Promise.all([
            readAccountDirectoryCredentialRecords(),
            readPendingAccountDirectoryAuthRecords(),
        ]);
        if (
            credentialRead.kind === 'corrupt'
            || credentialRead.kind === 'unavailable'
            || pendingRead.kind === 'corrupt'
            || pendingRead.kind === 'unavailable'
        ) return false;
        const credentials = credentialRead.kind === 'valid' ? credentialRead.value : [];
        if (expectedToken !== undefined) {
            const currentToken = credentials.find(
                (record) => accountDirectoryCredentialRecordMatchesTarget(record, normalized),
            )?.credentials.token ?? null;
            if (currentToken !== expectedToken) return false;
        }
        const pending = pendingRead.kind === 'valid' ? pendingRead.value : [];
        const nextCredentials = credentials.filter(
            (record) => !accountDirectoryCredentialRecordMatchesTarget(record, normalized),
        );
        const nextPending = pending.filter(
            (record) => !pendingAccountDirectoryAuthMatchesTarget(record, normalized),
        );
        if (!await writeAccountDirectoryCredentialRecords(nextCredentials)) return false;
        if (await writePendingAccountDirectoryAuthRecords(nextPending)) {
            if (accountDirectoryOAuthReturnCustody?.endpoint === normalized.endpoint
                && accountDirectoryOAuthReturnCustody.serverIdentityId === normalized.serverIdentityId) clearAccountDirectoryOAuthReturnCustody();
            return true;
        }
        await writeAccountDirectoryCredentialRecords(credentials);
        return false;
    });
}

// The local revision makes same-runtime invalidation immediate; the persisted-token
// comparison below extends the same custody contract across browser tabs. This is not
// an Account identity source: removing or changing the captured bearer invalidates old work.
const accountDirectoryCredentialCustodies = new Map<string, {
    scope: string;
    target: AccountDirectoryCredentialTarget;
    revision: number;
}>();

export type AccountDirectoryCredentialCustody = Readonly<{
    isCurrent: () => boolean;
    read: () => Promise<TokenOnlyAuthCredentials | null>;
    issue: <T>(request: () => Promise<T>) => Promise<T>;
    logout: () => Promise<boolean>;
}>;

function createAccountDirectoryCredentialCustody(
    normalized: AccountDirectoryCredentialTarget,
    credentialRead: Promise<AccountDirectoryStorageReadResult<TokenOnlyAuthCredentials>>,
): AccountDirectoryCredentialCustody {
    const scope = getAccountDirectoryStorageKey(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY);
    const key = JSON.stringify([scope, normalized.endpoint, normalized.serverIdentityId]);
    let custody = accountDirectoryCredentialCustodies.get(key);
    if (!custody) {
        custody = { scope, target: normalized, revision: 0 };
        accountDirectoryCredentialCustodies.set(key, custody);
    }
    const captured = custody;
    const revision = captured.revision;
    const isCurrent = () => captured.revision === revision
        && scope === getAccountDirectoryStorageKey(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY);
    const readCapturedCredentials = async (): Promise<TokenOnlyAuthCredentials | null> => {
        const result = await credentialRead;
        if (result.kind === 'valid') return result.value;
        if (result.kind === 'absent') return null;
        throw new AccountDirectoryStorageReadError(result.kind);
    };
    return {
        isCurrent,
        async read() {
            if (!isCurrent()) throw new Error('Account Service credential custody superseded');
            const credentials = await readCapturedCredentials();
            if (!isCurrent()) throw new Error('Account Service credential custody superseded');
            return credentials;
        },
        async issue<T>(request: () => Promise<T>): Promise<T> {
            const capturedCredentials = await readCapturedCredentials();
            const admission = await serializeAccountDirectoryStorageMutation(async () => {
                if (!isCurrent()) throw new Error('Account Service credential custody superseded');
                const current = await getAccountDirectoryCredentialsForTarget(normalized);
                if (current.kind === 'corrupt' || current.kind === 'unavailable') {
                    throw new AccountDirectoryStorageReadError(current.kind);
                }
                const currentToken = current.kind === 'valid' ? current.value.token : null;
                if (currentToken !== (capturedCredentials?.token ?? null)) {
                    throw new Error('Account Service credential custody superseded');
                }
                // Start the transport while the storage lock is still held, but
                // release the lock before awaiting the network response.
                return { issued: request() };
            });
            return await admission.issued;
        },
        logout: async () => await logoutAccountDirectoryTarget(
            normalized,
            isCurrent,
            (await readCapturedCredentials())?.token ?? null,
        ),
    };
}

export function captureAccountDirectoryCredentialCustody(
    target: AccountDirectoryCredentialTarget,
): AccountDirectoryCredentialCustody {
    const normalized = normalizeAccountDirectoryTarget(target);
    if (!normalized) throw new Error('Invalid Account Service credential target');
    // Capture under the credential writer's ordering once. Requests never reread
    // ambient credentials and therefore cannot borrow a replacement Account bearer.
    return createAccountDirectoryCredentialCustody(
        normalized,
        serializeAccountDirectoryStorageMutation(
            async () => await getAccountDirectoryCredentialsForTarget(normalized),
        ),
    );
}

export type AccountDirectoryOAuthReturnInput = Omit<
    AccountDirectoryOAuthReturnCustody,
    'credentialTokenDigest'
>;

export type AccountDirectoryOAuthReturnExpected = Readonly<{
    endpoint: string;
    serverIdentityId: string;
    intent: AccountContinuationIntent;
    invokingSurface: string;
    accountEntryReturnTo?: string;
}>;

export type AccountDirectoryOAuthReturnClaim = Readonly<{
    returnCustody: AccountDirectoryOAuthReturnCustody;
    credentialCustody: AccountDirectoryCredentialCustody;
}>;

export type AccountDirectoryOAuthReturnCredentialExpectation =
    | Readonly<{ expectedCredentialToken: string; expectedCredentialTokenDigest?: never }>
    | Readonly<{ expectedCredentialTokenDigest: string; expectedCredentialToken?: never }>;

function accountDirectoryOAuthReturnMatches(
    custody: AccountDirectoryOAuthReturnCustody,
    expected: AccountDirectoryOAuthReturnExpected,
): boolean {
    return custody.endpoint === normalizeAccountDirectoryEndpoint(expected.endpoint)
        && custody.serverIdentityId === expected.serverIdentityId.trim()
        && custody.returnTo === normalizeInternalReturnPath(expected.invokingSurface)
        && custody.accountEntryReturnTo === expected.accountEntryReturnTo
        && JSON.stringify(custody.entryIntent) === JSON.stringify(expected.intent);
}

async function recordAccountDirectoryOAuthReturnValue(
    value: AccountDirectoryOAuthReturnInput,
    expectation: AccountDirectoryOAuthReturnCredentialExpectation,
): Promise<boolean> {
    const entryIntent = parseAccountContinuationIntent(value.entryIntent);
    const target = normalizeAccountDirectoryTarget(value);
    if (!entryIntent || !target) return false;
    return await serializeAccountDirectoryStorageMutation(async () => {
        const [credentialRead, pendingRead] = await Promise.all([
            getAccountDirectoryCredentialsForTarget(target),
            readPendingAccountDirectoryAuthRecords(),
        ]);
        if (credentialRead.kind !== 'valid'
            || pendingRead.kind === 'corrupt'
            || pendingRead.kind === 'unavailable') return false;
        const credentialTokenDigest = await digestAccountDirectoryCredentialToken(credentialRead.value.token);
        if ('expectedCredentialToken' in expectation
            ? credentialRead.value.token !== expectation.expectedCredentialToken
            : !isAccountDirectoryCredentialTokenDigest(expectation.expectedCredentialTokenDigest)
                || credentialTokenDigest !== expectation.expectedCredentialTokenDigest) return false;
        const pending = pendingRead.kind === 'valid' ? pendingRead.value : [];
        if (pending.some((record) => pendingAccountDirectoryAuthMatchesTarget(record, target))) return false;
        clearAccountDirectoryOAuthReturnCustody();
        accountDirectoryOAuthReturnCustody = {
            ...value,
            entryIntent,
            credentialTokenDigest,
            ...(value.keyAuthSecret ? { keyAuthSecret: value.keyAuthSecret.slice() } : {}),
        };
        return true;
    });
}

async function claimAccountDirectoryOAuthReturnValue(
    expected: AccountDirectoryOAuthReturnExpected,
): Promise<AccountDirectoryOAuthReturnClaim | null> {
    return await serializeAccountDirectoryStorageMutation(async () => {
        const returnCustody = accountDirectoryOAuthReturnCustody;
        if (!returnCustody || !accountDirectoryOAuthReturnMatches(returnCustody, expected)) return null;
        const target = normalizeAccountDirectoryTarget(returnCustody);
        if (!target) {
            clearAccountDirectoryOAuthReturnCustody();
            return null;
        }
        const [credentialRead, pendingRead] = await Promise.all([
            getAccountDirectoryCredentialsForTarget(target),
            readPendingAccountDirectoryAuthRecords(),
        ]);
        const pending = pendingRead.kind === 'valid' ? pendingRead.value : [];
        const valid = credentialRead.kind === 'valid'
            && pendingRead.kind !== 'corrupt'
            && pendingRead.kind !== 'unavailable'
            && !pending.some((record) => pendingAccountDirectoryAuthMatchesTarget(record, target))
            && await digestAccountDirectoryCredentialToken(credentialRead.value.token) === returnCustody.credentialTokenDigest;
        if (!valid || credentialRead.kind !== 'valid') {
            clearAccountDirectoryOAuthReturnCustody();
            return null;
        }
        const credentialCustody = createAccountDirectoryCredentialCustody(
            target,
            Promise.resolve(credentialRead),
        );
        accountDirectoryOAuthReturnCustody = null;
        return { returnCustody, credentialCustody };
    });
}

export interface AccountDirectoryAuthCredentialsFacade {
    read(target: AccountDirectoryCredentialTarget): Promise<AccountDirectoryStorageReadResult<TokenOnlyAuthCredentials>>;
    get(target: AccountDirectoryCredentialTarget): Promise<TokenOnlyAuthCredentials | null>;
    set(target: AccountDirectoryCredentialTarget, credentials: TokenOnlyAuthCredentials): Promise<boolean>;
    remove(target: AccountDirectoryCredentialTarget): Promise<boolean>;
    clear(): Promise<boolean>;
    logout(target: AccountDirectoryCredentialTarget): Promise<boolean>;
}

export const accountDirectoryAuthCredentials: AccountDirectoryAuthCredentialsFacade = {
    async read(
        target: AccountDirectoryCredentialTarget,
    ): Promise<AccountDirectoryStorageReadResult<TokenOnlyAuthCredentials>> {
        return await getAccountDirectoryCredentialsForTarget(target);
    },

    async get(
        target: AccountDirectoryCredentialTarget,
    ): Promise<TokenOnlyAuthCredentials | null> {
        const result = await getAccountDirectoryCredentialsForTarget(target);
        if (result.kind === 'valid') return result.value;
        if (result.kind === 'absent') return null;
        throw new AccountDirectoryStorageReadError(result.kind);
    },

    async set(
        target: AccountDirectoryCredentialTarget,
        credentials: TokenOnlyAuthCredentials,
    ): Promise<boolean> {
        return await setAccountDirectoryCredentialsForTarget(
            target,
            credentials,
        );
    },

    async remove(
        target: AccountDirectoryCredentialTarget,
    ): Promise<boolean> {
        return await removeAccountDirectoryCredentialsForTarget(target);
    },

    async clear(): Promise<boolean> {
        return await clearAccountDirectoryCredentials();
    },

    async logout(
        target: AccountDirectoryCredentialTarget,
    ): Promise<boolean> {
        return await logoutAccountDirectoryTarget(target);
    },
};

type HomeCredentialWriteOutcome = Readonly<{
    stored: boolean;
    serverId: string | null;
    /** Exact-scope rollback for the attempted write; null when nothing was written. */
    rollback: (() => Promise<boolean>) | null;
}>;

/**
 * Single canonical writer for explicit Home credential scopes. The write keys
 * the primary scope by the canonical stable identity (which may precede profile
 * adoption), keeps URL-hash scopes as reader-only migration inputs, and
 * captures the exact pre-write snapshot so a failed final adoption can undo
 * precisely this write without touching a concurrent winner's credentials.
 */
async function writeHomeCredentialsForServerScope(
    serverUrl: string,
    options: ServerCredentialLookupOptions,
    credentials: AuthCredentials,
    authority?: HomeMutationAuthority,
): Promise<HomeCredentialWriteOutcome> {
    if (!isNonEmptyString((credentials as Record<string, unknown>).token)) {
        return { stored: false, serverId: null, rollback: null };
    }
    const normalizedServerUrl = normalizeUrl(serverUrl);
    const identity = resolveHomeCredentialIdentity(
        normalizedServerUrl,
        normalizeServerId(options.serverId),
    );
    if (identity.conflict) {
        return { stored: false, serverId: null, rollback: null };
    }
    const keys = await getAuthKeys(serverUrl, options);
    // Identity/URL mismatch fails closed: never write credentials under a URL
    // scope that an existing profile's identity does not own.
    if (!keys) return { stored: false, serverId: null, rollback: null };

    return await serializeCredentialScopeOperations([keys.primary, ...keys.legacy], async () => {
    const json = JSON.stringify(credentials);
    const previousPrimaryRaw = await readCredentialRawByKey(keys.primary);
    const previousLegacyRaws = await Promise.all(keys.legacy.map((legacyKey) => readCredentialRawByKey(legacyKey)));
    if (options.expectedCredentials) {
        const currentCredentials = parseCredentialsRaw(previousPrimaryRaw)
            ?? previousLegacyRaws.map(parseCredentialsRaw).find((value): value is AuthCredentials => value !== null)
            ?? null;
        if (!areCredentialsEqual(currentCredentials, options.expectedCredentials)) {
            return { stored: false, serverId: identity.serverId, rollback: null };
        }
    }

    const written = await writeCredentialRawByKey(keys.primary, json);
    if (!written) return { stored: false, serverId: identity.serverId, rollback: null };
    for (const legacyKey of keys.legacy) {
        await removeCredentialByKey(legacyKey);
    }
    emitHomeCredentialMutation('credentials_set', serverUrl, options, credentials);

    const rollback = async (): Promise<boolean> => {
        return await serializeCredentialScopeOperations([keys.primary, ...keys.legacy], async () => {
        let restored = true;
        let mutated = false;
        // Remove what this write created only while its content is still ours;
        // a key rewritten concurrently belongs to its new writer.
        const currentPrimaryRaw = await readCredentialRawByKey(keys.primary);
        const ownsPrimary = currentPrimaryRaw === json;
        if (ownsPrimary) {
            restored = previousPrimaryRaw !== null
                ? await writeCredentialRawByKey(keys.primary, previousPrimaryRaw)
                : await removeCredentialByKey(keys.primary);
            mutated = restored;
        }
        const currentLegacyRaws = await Promise.all(
            keys.legacy.map((legacyKey) => readCredentialRawByKey(legacyKey)),
        );
        // Alias restoration is one ownership decision. If any alias no longer
        // has the exact empty state left by this write, a newer layout writer
        // owns the complete alias set (including aliases it deliberately
        // emptied), so restoring any older alias would resurrect stale bytes.
        if (ownsPrimary && currentLegacyRaws.every((raw) => raw === null)) {
            for (let index = 0; index < keys.legacy.length; index += 1) {
                const previousRaw = previousLegacyRaws[index] ?? null;
                if (previousRaw === null) continue;
                const legacyRestored = await writeCredentialRawByKey(keys.legacy[index]!, previousRaw);
                restored = legacyRestored && restored;
                mutated = legacyRestored || mutated;
            }
        }
        if (restored && mutated) {
            emitHomeCredentialMutation('credentials_removed', serverUrl, options);
        }
        return restored;
        }, authority);
    };
    return { stored: true, serverId: identity.serverId, rollback };
    }, authority);
}

/** Internal composition seam for profile adoption while it owns the Home lock. */
export async function getHomeCredentialsUnderMutationAuthority(
    authority: HomeMutationAuthority,
    serverUrl: string,
    options: ServerCredentialReadOptions = {},
): Promise<AuthCredentials | null> {
    const { storageReadFailure, ...lookup } = options;
    const keys = await getAuthKeys(serverUrl, lookup);
    return keys ? await readCredentialsForScopedKeys(keys, authority, storageReadFailure) : null;
}

/** Internal composition seam for profile adoption while it owns the Home lock. */
export async function setHomeCredentialsWithRollbackUnderMutationAuthority(
    authority: HomeMutationAuthority,
    serverUrl: string,
    options: ServerCredentialLookupOptions,
    credentials: AuthCredentials,
): Promise<HomeCredentialWriteRollback | null> {
    const outcome = await writeHomeCredentialsForServerScope(
        serverUrl,
        options,
        credentials,
        authority,
    );
    if (!outcome.stored || !outcome.rollback) return null;
    return {
        serverUrl: normalizeUrl(serverUrl),
        serverId: outcome.serverId,
        rollback: outcome.rollback,
    };
}

/** Internal composition seam for profile adoption while it owns the Home lock. */
export async function removeHomeCredentialsUnderMutationAuthority(
    authority: HomeMutationAuthority,
    serverUrl: string,
    options: ServerCredentialLookupOptions = {},
): Promise<boolean> {
    const keys = await getAuthKeys(serverUrl, options);
    if (!keys) return false;
    const targetKeys = uniqueStrings([keys.primary, ...keys.legacy]);
    const removed = await serializeCredentialScopeOperations(
        targetKeys,
        async () => await removeCredentialKeysAtomically(targetKeys),
        authority,
    );
    if (!removed) return false;
    emitHomeCredentialMutation('credentials_removed', serverUrl, options);
    retireIrohHomeTransportDiagnostics(resolveHomeCredentialMutationTarget(serverUrl, options)?.serverId ?? '');
    return true;
}

export const TokenStorage = {
    /** Dedicated Account Service credential namespace (never the active Home). */
    accountDirectoryAuthCredentials,

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

    async getRecoveryKeyReminderDismissed(target?: RecoveryKeyReminderTarget): Promise<boolean> {
        const key = await getRecoveryKeyReminderDismissedKey(target);
        if (!key) return false;

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

    /**
     * Whether a reminder was recorded and not yet dismissed. Unlike a Home Account, whose reminder
     * applies whenever its key is held here, an account-service reminder exists only once its
     * creation recorded one.
     */
    async getRecoveryKeyReminderPending(target: RecoveryKeyReminderTarget): Promise<boolean> {
        const key = await getRecoveryKeyReminderDismissedKey(target);
        if (!key) return false;
        try {
            const raw = Platform.OS === 'web'
                ? resolveWebStorageBackend()?.getItem(key) ?? null
                : await readNativeSecureStoreString(key);
            return raw === '0';
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

    async setRecoveryKeyReminderDismissed(value: boolean, target?: RecoveryKeyReminderTarget): Promise<boolean> {
        const key = await getRecoveryKeyReminderDismissedKey(target);
        if (!key) return false;
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
        return await withHomeMutationAuthority(undefined, async (authority) => {
            const keys = await getAuthKeys();
            return keys ? await readCredentialsForScopedKeys(keys, authority) : null;
        });
    },

    async getCredentialsForServerUrl(
        serverUrl: string,
        options: ServerCredentialReadOptions = {},
    ): Promise<AuthCredentials | null> {
        return await withHomeMutationAuthority(
            undefined,
            async (authority) => await getHomeCredentialsUnderMutationAuthority(authority, serverUrl, options),
        );
    },

    /**
     * Pending account-creation custody for one exact Personal Home endpoint and optional
     * stable identity. This is device-local signing material, not a Home credential.
     */
    async getPendingPersonalHomeBootstrapSeed(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<Uint8Array | null> {
        const key = await getPendingPersonalHomeBootstrapSeedStorageKey(serverUrl, options);
        if (!key) return null;
        let raw: string | null;
        try {
            raw = await readDeviceLocalStorageString(key);
        } catch {
            return null;
        }
        const parsed = parsePendingPersonalHomeBootstrapSeedRecord(safeParseJson(raw ?? ''));
        if (!parsed) return null;
        try {
            const seed = decodeBase64(parsed.seedBase64Url, 'base64url');
            return seed.length === 32 ? seed : null;
        } catch {
            return null;
        }
    },

    async setPendingPersonalHomeBootstrapSeed(
        serverUrl: string,
        options: ServerCredentialLookupOptions,
        seed: Uint8Array,
    ): Promise<boolean> {
        if (!(seed instanceof Uint8Array) || seed.length !== 32) return false;
        const key = await getPendingPersonalHomeBootstrapSeedStorageKey(serverUrl, options);
        if (!key) return false;
        const seedBase64Url = encodeBase64(seed, 'base64url');
        try {
            // Never replace an existing unreadable or different seed. It may already identify
            // a server-committed Account whose token response was lost.
            const existingRaw = await readDeviceLocalStorageString(key);
            if (existingRaw !== null) {
                const existing = parsePendingPersonalHomeBootstrapSeedRecord(safeParseJson(existingRaw));
                return existing?.seedBase64Url === seedBase64Url;
            }
            const record = JSON.stringify({
                v: 1,
                seedBase64Url,
            } satisfies PendingPersonalHomeBootstrapSeedRecord);
            await writeDeviceLocalStorageString(key, record);
            return await readDeviceLocalStorageString(key) === record;
        } catch {
            return false;
        }
    },

    async clearPendingPersonalHomeBootstrapSeed(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<boolean> {
        const key = await getPendingPersonalHomeBootstrapSeedStorageKey(serverUrl, options);
        if (!key) return false;
        try {
            await removeDeviceLocalStorageString(key);
            return true;
        } catch {
            return false;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        return await withHomeMutationAuthority(undefined, async (authority) => {
        const keys = await getAuthKeys();
        if (!keys) return false;
        return await serializeCredentialScopeOperations([keys.primary, ...keys.legacy], async () => {
        const json = JSON.stringify(credentials);
        const written = await writeCredentialRawByKey(keys.primary, json);
        if (!written) return false;
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
        for (const legacyKey of keys.legacy) {
            await removeCredentialByKey(legacyKey);
        }
        emitHomeCredentialMutation('credentials_set', getActiveServerUrl(), {
            serverId: getActiveServerId(),
        }, credentials);
        return true;
        }, authority);
        });
    },

    /** Persist credentials for an explicit Home without changing focused-server state. */
    async setCredentialsForServerUrl(
        serverUrl: string,
        options: ServerCredentialLookupOptions,
        credentials: AuthCredentials,
    ): Promise<boolean> {
        return await withHomeMutationAuthority(undefined, async (authority) => (
            await writeHomeCredentialsForServerScope(serverUrl, options, credentials, authority)
        ).stored);
    },

    /**
     * Persist credentials for an explicit Home and return the exact-scope
     * rollback for the attempted write. Composition owners that revalidate and
     * commit a profile after the write (adoption) must call `rollback()` when
     * that final adoption fails, so a losing adoption race never leaves its
     * credentials readable by the winning identity or a URL-only lookup. The
     * rollback removes/restores only the keys this write created or emptied;
     * it never touches a concurrent winner's credentials and is idempotent.
     * Returns null when the write was rejected or failed (nothing to undo).
     */
    async setCredentialsForServerUrlWithRollback(
        serverUrl: string,
        options: ServerCredentialLookupOptions,
        credentials: AuthCredentials,
    ): Promise<HomeCredentialWriteRollback | null> {
        return await withHomeMutationAuthority(
            undefined,
            async (authority) => await setHomeCredentialsWithRollbackUnderMutationAuthority(
                authority,
                serverUrl,
                options,
                credentials,
            ),
        );
    },

    async removeCredentials(): Promise<boolean> {
        return await withHomeMutationAuthority(undefined, async (authority) => {
        // Clearing credentials should not implicitly suppress auth redirects forever.
        // Reset any suppression so subsequent auth flows can run normally.
        await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
        let allRemoved = true;
        const emittedMutationTargets = new Set<string>();
        const knownTargetKeys = new Set<string>();
        const knownServerTargets = listKnownServerCleanupTargets();
        for (const target of knownServerTargets) {
            const options = target.serverId ? { serverId: target.serverId } : {};
            const keys = await getAuthKeys(
                target.serverUrl,
                options,
            );
            // A profile registry change between listing and scope resolution must
            // not sweep credentials for a target that no longer resolves.
            if (!keys) continue;
            const targetKeys = uniqueStrings([keys.primary, ...keys.legacy]);
            for (const key of targetKeys) {
                knownTargetKeys.add(key);
            }
            const targetRemoved = await serializeCredentialScopeOperations(
                targetKeys,
                async () => await removeCredentialKeysAtomically(targetKeys),
                authority,
            );
            allRemoved = allRemoved && targetRemoved;

            if (targetRemoved) {
                const mutationTarget = resolveHomeCredentialMutationTarget(target.serverUrl, options);
                if (mutationTarget) {
                    const mutationKey = `${mutationTarget.serverId}\u0000${mutationTarget.serverUrl}`;
                    if (!emittedMutationTargets.has(mutationKey)) {
                        emittedMutationTargets.add(mutationKey);
                        emitHomeCredentialMutation('credentials_removed', target.serverUrl, options);
                        retireIrohHomeTransportDiagnostics(mutationTarget.serverId);
                    }
                }
            }
        }

        if (Platform.OS === 'web') {
            const webScopedKeys = listWebScopedCredentialKeysForCleanup();
            const storage = resolveWebStorageBackend();
            for (const { key, raw } of webScopedKeys) {
                if (knownTargetKeys.has(key)) continue;
                const removed = await serializeCredentialScopeOperations([key], async () => {
                    // Enumeration is only a snapshot. A later writer owns changed
                    // bytes, so the orphan sweep must recheck before mutation.
                    if (storage?.getItem(key) !== raw) return true;
                    return await removeCredentialByKey(key);
                }, authority);
                allRemoved = allRemoved && removed;
            }
        }

        return allRemoved;
        });
    },

    async removeCredentialsForServerUrl(
        serverUrl: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<boolean> {
        return await withHomeMutationAuthority(
            undefined,
            async (authority) => await removeHomeCredentialsUnderMutationAuthority(authority, serverUrl, options),
        );
    },

    async invalidateCredentialsTokenForServerUrl(
        serverUrl: string,
        token: string,
        options: ServerCredentialLookupOptions = {},
    ): Promise<boolean> {
        return await withHomeMutationAuthority(undefined, async (authority) => {
        const keys = await getAuthKeys(serverUrl, options);
        if (!keys) return false;
        const removeIfMatches = async (key: string): Promise<boolean> => {
            const raw = await readCredentialRawByKey(key);
            const parsed = parseCredentialsRaw(raw);
            if (!parsed || parsed.token !== token) return false;
            const removed = await removeCredentialByKey(key);
            credentialsCacheByKey.delete(key);
            return removed;
        };

        return await serializeCredentialScopeOperations([keys.primary, ...keys.legacy], async () => {
            const primaryRemoved = await removeIfMatches(keys.primary);
            if (primaryRemoved) {
                emitHomeCredentialMutation('credentials_removed', serverUrl, options);
                retireIrohHomeTransportDiagnostics(resolveHomeCredentialMutationTarget(serverUrl, options)?.serverId ?? '');
                return true;
            }
            for (const legacyKey of keys.legacy) {
                const legacyRemoved = await removeIfMatches(legacyKey);
                if (legacyRemoved) {
                    emitHomeCredentialMutation('credentials_removed', serverUrl, options);
                    retireIrohHomeTransportDiagnostics(resolveHomeCredentialMutationTarget(serverUrl, options)?.serverId ?? '');
                    return true;
                }
            }
            return false;
        }, authority);
        });
    },

    /**
     * Store a short-lived Account Service OAuth continuation.  This is kept
     * separate from Home pending auth so a legacy Home reader can never
     * consume a Directory callback.
     */
    async setPendingAccountDirectoryAuth(
        value: PendingAccountDirectoryAuthInput,
    ): Promise<boolean> {
        return await setPendingAccountDirectoryAuthValue(value);
    },

    async commitAccountDirectoryOAuthCredential(input: Readonly<{
        expectedPending: PendingAccountDirectoryAuth;
        credentials: TokenOnlyAuthCredentials;
    }>): Promise<AccountDirectoryOAuthCredentialCommitResult> {
        return await commitAccountDirectoryOAuthCredentialValue(input);
    },

    async recordAccountDirectoryOAuthReturn(
        value: AccountDirectoryOAuthReturnInput,
        expectation: AccountDirectoryOAuthReturnCredentialExpectation,
    ): Promise<boolean> {
        return await recordAccountDirectoryOAuthReturnValue(value, expectation);
    },

    readAccountDirectoryOAuthReturn(expected: Readonly<{
        endpoint: string; serverIdentityId: string; intent: AccountContinuationIntent; invokingSurface: string;
        accountEntryReturnTo?: string;
    }>): AccountDirectoryOAuthReturnCustody | null {
        const custody = accountDirectoryOAuthReturnCustody;
        if (!custody || !accountDirectoryOAuthReturnMatches(custody, expected)) return null;
        return custody;
    },

    async claimAccountDirectoryOAuthReturn(expected: Readonly<{
        endpoint: string; serverIdentityId: string; intent: AccountContinuationIntent; invokingSurface: string;
        accountEntryReturnTo?: string;
    }>): Promise<AccountDirectoryOAuthReturnClaim | null> {
        return await claimAccountDirectoryOAuthReturnValue(expected);
    },

    async getPendingAccountDirectoryAuth(
        target: PendingAccountDirectoryAuthTarget,
        // The OAuth callback may inspect an expired record only to classify
        // the terminal UX. Admission still occurs in the callback finalizer,
        // which rejects it before any request or credential write.
        options: Readonly<{ includeExpired?: boolean }> = {},
    ): Promise<PendingAccountDirectoryAuth | null> {
        return await getPendingAccountDirectoryAuthValue(target, options);
    },

    /** Resolve OAuth callback family from persisted custody before consulting advisory URL markers. */
    async resolvePendingAccountDirectoryAuthCustody(
        provider: string,
    ): Promise<PendingAccountDirectoryAuthCustodyResolution> {
        return await resolvePendingAccountDirectoryAuthCustodyValue(provider);
    },

    async clearPendingAccountDirectoryAuth(
        target?: PendingAccountDirectoryAuthTarget,
        options: Readonly<{ expected?: PendingAccountDirectoryAuth }> = {},
    ): Promise<boolean> {
        return await clearPendingAccountDirectoryAuthValue(target, options);
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
            if (isPendingPurposeBoundExternalAuthExpired(scoped)) {
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
        if (isPendingPurposeBoundExternalAuthExpired(global)) {
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

    /** Read provider-return custody without retargeting it to the Home now focused. */
    async readPendingExternalAuthContinuationState(): Promise<PendingExternalReadState<PendingExternalAuth>> {
        const global = await readStoredJson(
            getPendingExternalAuthGlobalKey(),
            'pending external auth',
            isPendingExternalAuthRecord,
        );
        if (!global) return await this.readPendingExternalAuthState();
        if (isPendingPurposeBoundExternalAuthExpired(global)) {
            await this.clearPendingExternalAuth(
                hasAttemptedFirstKeyMigration(global)
                    ? { removeFirstKeyMigrationAttempted: global }
                    : undefined,
            );
            return { value: null, serverMismatch: false };
        }
        return {
            value: global,
            serverMismatch: hasExactPendingExternalServerTarget(global)
                ? false
                : !doesPendingExternalStateMatchActiveServer(
                    global,
                    { requireExplicitServerContext: true },
                ),
        };
    },

    async isPendingExternalAuthContinuationCurrent(expected: PendingExternalAuth): Promise<boolean> {
        const state = await this.readPendingExternalAuthContinuationState();
        const current = state.value;
        return !state.serverMismatch && current !== null
            && matchesPendingExternalAuthExact(current, expected);
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
        options: ServerCredentialReadOptions = {},
    ): Promise<PendingExternalReadState<PendingExternalAuth>> {
        const keys = await getServerScopedKeys(
            PENDING_EXTERNAL_AUTH_KEY,
            serverUrl,
            options,
        );
        if (!keys) {
            return { value: null, serverMismatch: true };
        }
        for (const key of [keys.primary, ...keys.legacy]) {
            const value = await readStoredJson(
                key,
                'pending external auth',
                isPendingExternalAuthRecord,
                options.storageReadFailure,
            );
            if (!value) continue;
            return {
                value: isPendingPurposeBoundExternalAuthExpired(
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
            options.storageReadFailure,
        );
        if (
            !global
            || isPendingPurposeBoundExternalAuthExpired(global)
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
            await digestAccountDirectoryCredentialToken(params.token);
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
                if (!keys) {
                    return {
                        kind: 'not_current',
                    };
                }
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
                    await digestAccountDirectoryCredentialToken(
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

    async setPendingExternalAuth(
        value: PendingExternalAuth,
        target?: Readonly<{ serverUrl: string; serverId?: string }>,
    ): Promise<boolean> {
        if (
            'accountPasswordEnrollment'
            in (value as PendingExternalAuth & Record<string, unknown>)
        ) return false;
        if (
            (value.provider === 'mtls' || value.accountContinuation !== undefined
                || value.teamContinuation !== undefined || value.postAuthInvitation !== undefined)
            && !isPendingExternalAuthRecord(value)
        ) return false;
        return await serializePendingExternalAuthMutation(
            async () => {
                const keys = target
                    ? await getServerScopedKeys(
                        PENDING_EXTERNAL_AUTH_KEY,
                        target.serverUrl,
                        target.serverId ? { serverId: target.serverId } : {},
                    )
                    : await getPendingExternalAuthKeys();
                if (!keys) return false;
                const key = keys.primary;
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
                        if (!originalKeys) {
                            return ok;
                        }
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

    async recordTeamInvitationPostAuthContinuation(
        expected: PendingExternalAuth,
        continuation: TeamInvitationPostAuthContinuationV1,
        target: Readonly<{ serverUrl: string; serverId?: string }>,
    ): Promise<PendingExternalAuth | null> {
        return await serializePendingExternalAuthMutation(async () => {
            const keys = await getServerScopedKeys(
                PENDING_EXTERNAL_AUTH_KEY,
                target.serverUrl,
                target.serverId ? { serverId: target.serverId } : {},
            );
            if (!keys) return null;
            const globalKey = getPendingExternalAuthGlobalKey();
            const [scoped, global] = await Promise.all([
                readStoredJson(keys.primary, 'pending external auth', isPendingExternalAuthRecord),
                readStoredJson(globalKey, 'pending external auth', isPendingExternalAuthRecord),
            ]);
            if (!scoped || !global
                || !matchesPendingExternalAuthExact(scoped, expected)
                || !matchesPendingExternalAuthExact(global, expected)) return null;
            const updated = { ...expected, postAuthInvitation: continuation };
            if (!await writeStoredJson(keys.primary, 'pending external auth', updated)) return null;
            if (!await writeStoredJson(globalKey, 'pending external auth', updated)) {
                await writeStoredJson(keys.primary, 'pending external auth', expected).catch(() => false);
                return null;
            }
            return updated;
        });
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
                            ).then((keys) => keys ? [keys.primary, ...keys.legacy] : [])
                        : resolvePendingExternalScopedKeysForClear(
                            PENDING_EXTERNAL_AUTH_KEY,
                            globalKey,
                            isPendingExternalAuthRecord,
                        )
                );
                const expected =
                    options.removeFirstKeyMigrationAttempted;
                const exact = options.removeExact;
                if (expected || exact) {
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
                            && (expected
                                ? matchesAttemptedFirstKeyMigration(entry.value, expected)
                                : matchesPendingExternalAuthExact(entry.value, exact!)),
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
                                    expected ?? exact!,
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

    /**
     * The pending connect continuation. A record carrying its exact Home
     * (`serverId` + `serverUrl`) belongs to the Home whose credential started it
     * and is returned whichever Home is focused now; the return consumer then
     * finalizes against that exact Home (teams-lane-03/02 TA-R14/TA-R16). Only a
     * record without an exact target falls back to active-server matching.
     */
    async getPendingExternalConnect(): Promise<PendingExternalConnect | null> {
        const key = await getPendingExternalConnectKey();
        const scoped = await readStoredJson(key, 'pending external connect', isPendingExternalConnectRecord);
        if (scoped) {
            return hasExactPendingExternalServerTarget(scoped)
                || doesPendingExternalStateMatchActiveServer(scoped, { requireExplicitServerContext: false })
                ? scoped
                : null;
        }
        const globalKey = getPendingExternalConnectGlobalKey();
        const global = await readStoredJson(globalKey, 'pending external connect', isPendingExternalConnectRecord);
        if (!global) return null;
        return hasExactPendingExternalServerTarget(global)
            || doesPendingExternalStateMatchActiveServer(global, { requireExplicitServerContext: true })
            ? global
            : null;
    },

    async setPendingExternalConnect(value: PendingExternalConnect): Promise<boolean> {
        // An explicitly targeted continuation is stored under that exact Home's
        // scope, never under whichever Home happens to be focused.
        const explicitTarget = hasExactPendingExternalServerTarget(value)
            ? await getServerScopedKeys(PENDING_EXTERNAL_CONNECT_KEY, value.serverUrl, { serverId: value.serverId })
            : null;
        const key = explicitTarget?.primary ?? await getPendingExternalConnectKey();
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
