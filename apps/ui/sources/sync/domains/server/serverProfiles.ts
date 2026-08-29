import { MMKV } from 'react-native-mmkv';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { isStackContext } from './serverContext';
import { canonicalizeServerUrl, createServerUrlComparableKey } from './url/serverUrlCanonical';
import { sanitizeServerUrlForShareableLink } from './url/shareableServerUrl';
import { readConfiguredServerUrlEnv, readConfiguredServerUrlEnvRaw } from './readConfiguredServerUrlEnv';
import { resolveSetupSurfacePolicy } from './setup/setupSurfacePolicy';
import { normalizeStoredServerSelectionGroups } from './selection/serverSelectionMutations';
import type { ServerSelectionGroup } from './selection/serverSelectionTypes';

export type ServerProfileSource =
    | 'manual' | 'qr' | 'account-directory' | 'desktop-personal-home' | 'legacy'
    | 'url' | 'stack-env' | 'notification' | 'preconfigured';

export type AccountServiceEndpointV1 = Readonly<{
    url: string;
    serverIdentityId?: string;
    displayName?: string;
    source: 'default' | 'configured' | 'user';
}>;

export type HomeConnectionDescriptorV1 = Readonly<{
    v: 1;
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    revision: number;
    endpoints: ReadonlyArray<
        | Readonly<{ kind: 'https'; url: string }>
        | Readonly<{ kind: 'iroh'; endpointId: string; relayUrls?: readonly string[]; directAddresses?: readonly string[] }>
    >;
}>;

type LegacyManualHomeDescriptor = Readonly<{
    serverUrl: string;
    canonicalServerUrl?: string;
    publicServerUrl?: string | null;
    homeServerIdentityId?: string;
    displayName?: string;
}>;

export const HAPPIER_CLOUD_SERVER_URL = 'https://api.happier.dev' as const;

export type ServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    shareableServerUrl?: string | null;
    shareableServerUrlValidatedAgainstServerUrl?: string | null;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    source?: ServerProfileSource;
    /** Original unknown persisted source retained for lossless downgrade/round-trip. */
    legacySource?: string;
    canonicalServerUrl?: string;
    publicServerUrl?: string | null;
}>;

export type PortableServerIdentityProfileResolution =
    | Readonly<{
        kind: 'resolved';
        serverIdentityId: string;
        profile: ServerProfile;
    }>
    | Readonly<{
        kind: 'missing';
        serverIdentityId: string;
    }>
    | Readonly<{
        kind: 'ambiguous';
        serverIdentityId: string;
        profiles: readonly ServerProfile[];
    }>;

export type ActiveServerSnapshot = Readonly<{
    serverId: string;
    serverUrl: string;
    activeShareableServerUrl?: string | null;
    activeShareableServerUrlValidatedAgainstServerUrl?: string | null;
    activeLocalRelayUrl?: string | null;
    runtimeOrigin?: string;
    carrier?: 'https' | 'iroh';
    isSelectionExplicit?: boolean;
    generation: number;
}>;

type PersistedServerState = {
    activeServerIdIsExplicit?: boolean;
    activeServerId?: string;
    servers?: Record<string, ServerProfile>;
    accountServiceEndpoint?: AccountServiceEndpointV1 | null;
    homeViewState?: HomeViewStateV1 | null;
};

export type HomeViewStateV1 = Readonly<{
    version: 1;
    groups: readonly ServerSelectionGroup[];
    activeTargetKind: 'server' | 'group' | null;
    activeTargetId: string | null;
}>;

type PreconfiguredServer = Readonly<{
    name: string;
    source: ServerProfileSource;
    url: string;
    idSeed?: string;
}>;

const SESSION_STORAGE_ACTIVE_ID_KEY = 'activeServerId';
const STATE_KEY = 'server-state-v1';

let activeServerGeneration = 0;
const activeServerListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();
let activeServerSnapshotCache: ActiveServerSnapshot | null = null;
let activeRuntimeOrigin: string | undefined;
let activeCarrier: 'https' | 'iroh' | undefined;
const runtimeOriginListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();

let serverProfilesGeneration = 0;
const serverProfilesListeners = new Set<(generation: number) => void>();

function emitServerProfilesChanged(): void {
    serverProfilesGeneration += 1;
    for (const listener of serverProfilesListeners) listener(serverProfilesGeneration);
}

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

function normalizeServerId(raw: unknown): string | null {
    const id = String(raw ?? '').trim();
    return id || null;
}

function normalizeServerIdentityId(raw: unknown): string | null {
    return normalizeServerIdentityIdCapability(raw) ?? null;
}

function uniqueServerIds(ids: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of ids) {
        const id = normalizeServerId(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

export function resolveServerProfileScopeId(profile: Pick<ServerProfile, 'id' | 'serverIdentityId'>): string {
    return profile.serverIdentityId ?? profile.id;
}

function comparableUrlKey(rawUrl: string): string {
    return createServerUrlComparableKey(rawUrl);
}

function deriveServerIdFromUrl(serverUrl: string): string {
    const normalized = normalizeUrl(serverUrl);
    try {
        const url = new URL(normalized);
        const host = url.hostname.toLowerCase();
        const port = url.port ? `-${url.port}` : '';
        const base = `${host}${port}`;
        const sanitized = base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
        return sanitized || 'custom';
    } catch {
        const fallback = normalized.toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
        return fallback || 'custom';
    }
}

function defaultServerNameFromUrl(serverUrl: string): string {
    const normalized = normalizeUrl(serverUrl);
    try {
        const parsed = new URL(normalized);
        const host = parsed.hostname;
        if (!host) return normalized;
        return parsed.port ? `${host}:${parsed.port}` : host;
    } catch {
        return normalized;
    }
}

function nowMs(): number {
    return Date.now();
}

function storageId(): string {
    const scope = readStorageScopeFromEnv();
    return scopedStorageId('server-profiles', scope);
}

type PersistedStateStorage = Readonly<{
    getString: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
}>;

let persistedStateStorage: PersistedStateStorage | null = null;

function resolveWebStorageBackend(): Storage | null {
    const windowStorage = (globalThis as any).window?.localStorage;
    if (windowStorage && typeof windowStorage.getItem === 'function') return windowStorage as Storage;
    const localStorage = (globalThis as any).localStorage;
    if (localStorage && typeof localStorage.getItem === 'function') return localStorage as Storage;
    const sessionStorage = (globalThis as any).sessionStorage;
    if (sessionStorage && typeof sessionStorage.getItem === 'function') return sessionStorage as Storage;
    return null;
}

function createWebPersistedStateStorage(): PersistedStateStorage {
    const storage = resolveWebStorageBackend();
    const fallback = new Map<string, string>();
    const prefix = `${storageId()}:`;
    const resolveKey = (key: string) => `${prefix}${key}`;

    return {
        getString: (key: string) => {
            const resolvedKey = resolveKey(key);
            try {
                const value = storage?.getItem(resolvedKey) ?? null;
                return typeof value === 'string' ? value : fallback.get(resolvedKey);
            } catch {
                return fallback.get(resolvedKey);
            }
        },
        set: (key: string, value: string) => {
            const resolvedKey = resolveKey(key);
            try {
                storage?.setItem(resolvedKey, value);
            } catch {
                // ignore
            }
            fallback.set(resolvedKey, value);
        },
    };
}

function createNativePersistedStateStorage(): PersistedStateStorage {
    const storage = new MMKV({ id: storageId() });
    return {
        getString: (key: string) => storage.getString(key),
        set: (key: string, value: string) => storage.set(key, value),
    };
}

function getPersistedStateStorage(): PersistedStateStorage {
    if (persistedStateStorage) return persistedStateStorage;
    persistedStateStorage = isWebRuntime() ? createWebPersistedStateStorage() : createNativePersistedStateStorage();
    return persistedStateStorage;
}

// Demo-scoped persistence firewall. While demo mode is active the onboarding
// journey seeds a demo relay server into the active-server state; those writes
// must never reach durable storage, or a hard exit (tab close / crash / mid-seed
// navigation) would strand the real profile pointed at the dead demo server on the
// next boot. This mirrors the runtimeFetch demo firewall: on suspend we swap the
// live backend for an in-memory scratch seeded with the current durable value so
// reads stay coherent for the demo world while every write is redirected away from
// the real store; on resume we restore the untouched durable backend. Graceful
// teardown behavior is unchanged (the real store was already correct).
let demoPersistenceSuspendDepth = 0;
let durablePersistedStateStorageDuringDemo: PersistedStateStorage | null = null;

function createInMemoryPersistedStateStorage(seed: string | undefined): PersistedStateStorage {
    const values = new Map<string, string>();
    if (seed !== undefined) values.set(STATE_KEY, seed);
    return {
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => {
            values.set(key, value);
        },
    };
}

export function suspendServerProfilePersistenceForDemo(): void {
    demoPersistenceSuspendDepth += 1;
    if (demoPersistenceSuspendDepth !== 1) return;
    const durable = getPersistedStateStorage();
    durablePersistedStateStorageDuringDemo = durable;
    persistedStateStorage = createInMemoryPersistedStateStorage(durable.getString(STATE_KEY));
    persistedStateParseCache = null;
}

export function resumeServerProfilePersistenceForDemo(): void {
    if (demoPersistenceSuspendDepth === 0) return;
    demoPersistenceSuspendDepth -= 1;
    if (demoPersistenceSuspendDepth !== 0) return;
    persistedStateStorage = durablePersistedStateStorageDuringDemo;
    durablePersistedStateStorageDuringDemo = null;
    persistedStateParseCache = null;
}

export function isServerProfilePersistenceSuspendedForDemo(): boolean {
    return demoPersistenceSuspendDepth > 0;
}

export function resetServerProfilePersistenceSuspendForTests(): void {
    if (demoPersistenceSuspendDepth > 0 && durablePersistedStateStorageDuringDemo) {
        persistedStateStorage = durablePersistedStateStorageDuringDemo;
        persistedStateParseCache = null;
    }
    demoPersistenceSuspendDepth = 0;
    durablePersistedStateStorageDuringDemo = null;
}

function parsePreconfiguredServersFromEnv(): PreconfiguredServer[] {
    const entries: PreconfiguredServer[] = [];
    const seenUrlKeys = new Set<string>();
    const setupPolicy = resolveSetupSurfacePolicy();

    const append = (
        urlRaw: unknown,
        nameRaw: unknown,
        source: ServerProfileSource,
        opts: Readonly<{ idSeed?: string }> = {},
    ): void => {
        const url = normalizeUrl(String(urlRaw ?? ''));
        if (!url) return;
        const key = comparableUrlKey(url);
        if (seenUrlKeys.has(key)) return;
        seenUrlKeys.add(key);
        const name = String(nameRaw ?? '').trim();
        entries.push({ name, source, url, ...(opts.idSeed ? { idSeed: opts.idSeed } : {}) });
    };

    const rawPreconfigured = String(process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS ?? '').trim();
    if (rawPreconfigured) {
        try {
            const parsed = JSON.parse(rawPreconfigured);
            if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                    if (typeof entry === 'string') {
                        append(entry, '', 'preconfigured');
                        continue;
                    }
                    if (!entry || typeof entry !== 'object') continue;
                    const record = entry as Record<string, unknown>;
                    append(record.url ?? record.serverUrl ?? '', record.name ?? '', 'preconfigured');
                }
            }
        } catch {
            // ignore malformed preconfigured JSON
        }
    }

    const rawSingleUrl = normalizeUrl(readConfiguredServerUrlEnvRaw());
    const singleUrl = normalizeUrl(readConfiguredServerUrlEnv());
    if (singleUrl) {
        const inStack = isStackContext();
        const idSeed = rawSingleUrl && rawSingleUrl !== singleUrl ? deriveServerIdFromUrl(rawSingleUrl) : undefined;
        append(singleUrl, '', inStack ? 'stack-env' : 'url', inStack ? { idSeed } : {});
    }

    // On web with no explicitly configured server, fall back to same-origin so that
    // self-hosted deployments (e.g. https://happier.example.com) get a server profile
    // without needing EXPO_PUBLIC_HAPPIER_SERVER_URL set at build time.
    if (entries.length === 0) {
        const origin = getWebSameOriginServerUrl();
        if (origin) {
            append(origin, '', 'url');
        }
    }

    // In stack context, and on native builds, never start "serverless": seed Happier Cloud when no preconfigured server exists.
    if (entries.length === 0 && (isStackContext() || !isWebRuntime()) && setupPolicy.relay.allowHappierCloud) {
        append(HAPPIER_CLOUD_SERVER_URL, 'Happier Cloud', 'preconfigured');
    }

    return entries;
}

function findProfileByEquivalentUrl(servers: Record<string, ServerProfile>, serverUrl: string): ServerProfile | null {
    const targetKey = comparableUrlKey(serverUrl);
    for (const profile of Object.values(servers)) {
        if (comparableUrlKey(profile.canonicalServerUrl ?? profile.serverUrl) === targetKey) return profile;
    }
    return null;
}

function findProfileByServerIdentifier(
    servers: Record<string, ServerProfile>,
    idRaw: string | null | undefined,
): ServerProfile | null {
    const id = normalizeServerId(idRaw);
    if (!id) return null;
    const direct = servers[id];
    if (direct) return direct;
    for (const profile of Object.values(servers)) {
        if (profile.serverIdentityId === id) return profile;
        if ((profile.legacyServerIds ?? []).includes(id)) return profile;
    }
    return null;
}

function createUniqueServerId(
    servers: Record<string, ServerProfile>,
    baseIdRaw: string,
    serverUrl: string,
): string {
    const targetUrlKey = comparableUrlKey(serverUrl);
    const baseId = String(baseIdRaw ?? '').trim() || 'custom';
    let id = baseId;
    let suffix = 2;
    while (servers[id] && comparableUrlKey(servers[id]!.serverUrl) !== targetUrlKey) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
    }
    return id;
}

function applyRuntimeSeedPolicy(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    const next = { ...servers };
    for (const configured of parsePreconfiguredServersFromEnv()) {
        const existing = findProfileByEquivalentUrl(next, configured.url);
        if (existing) continue;

        const idSeed = String(configured.idSeed ?? '').trim();
        if (idSeed && idSeed in next) {
            const current = next[idSeed]!;
            if (
                current.source === 'stack-env'
                && configured.source === 'stack-env'
                && comparableUrlKey(current.serverUrl) !== comparableUrlKey(configured.url)
            ) {
                const now = nowMs();
                next[idSeed] = {
                    ...current,
                    serverUrl: configured.url,
                    updatedAt: now,
                };
                continue;
            }
        }

        const id = createUniqueServerId(next, idSeed || deriveServerIdFromUrl(configured.url), configured.url);
        const now = nowMs();
        next[id] = {
            id,
            name: configured.name || defaultServerNameFromUrl(configured.url) || id,
            serverUrl: configured.url,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: 0,
            source: configured.source,
        };
    }
    return next;
}

function getPrimaryPreconfiguredServerId(servers: Record<string, ServerProfile>): string | null {
    for (const configured of parsePreconfiguredServersFromEnv()) {
        const existing = findProfileByEquivalentUrl(servers, configured.url);
        if (existing) return existing.id;
    }
    return null;
}

function resolvePrimaryActiveServerId(servers: Record<string, ServerProfile>, desiredId: string | null): string {
    if (desiredId && desiredId in servers) return desiredId;
    const preconfiguredId = getPrimaryPreconfiguredServerId(servers);
    if (preconfiguredId) return preconfiguredId;
    const first = Object.keys(servers)[0];
    return first ?? '';
}

function parseProfile(id: string, value: unknown): ServerProfile | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const sid = String(record.id ?? id).trim();
    const name = String(record.name ?? '').trim();
    const serverUrl = normalizeUrl(String(record.serverUrl ?? ''));
    if (!sid || !name || !serverUrl) return null;

    const rawSource = String(record.source ?? '').trim().toLowerCase();
    const source: ServerProfileSource | undefined =
        rawSource === 'manual'
            || rawSource === 'url'
            || rawSource === 'stack-env'
            || rawSource === 'notification'
            || rawSource === 'preconfigured'
            || rawSource === 'qr'
            || rawSource === 'account-directory'
            || rawSource === 'desktop-personal-home'
            || rawSource === 'legacy'
            ? rawSource
            : rawSource ? 'legacy' : undefined;
    const legacySource = source === 'legacy' && rawSource ? rawSource : undefined;

    const canonicalServerUrl = typeof record.canonicalServerUrl === 'string'
        ? normalizeUrl(record.canonicalServerUrl) : '';
    const publicServerUrl = record.publicServerUrl === null
        ? null
        : typeof record.publicServerUrl === 'string' ? normalizeUrl(record.publicServerUrl) : undefined;

    return {
        id: sid,
        name,
        serverUrl,
        ...(canonicalServerUrl ? { canonicalServerUrl } : {}),
        ...(publicServerUrl !== undefined ? { publicServerUrl } : {}),
        ...(typeof record.shareableServerUrl === 'string'
            ? { shareableServerUrl: sanitizeServerUrlForShareableLink(record.shareableServerUrl) }
            : {}),
        ...(typeof record.shareableServerUrlValidatedAgainstServerUrl === 'string'
            ? { shareableServerUrlValidatedAgainstServerUrl: normalizeUrl(String(record.shareableServerUrlValidatedAgainstServerUrl)) }
            : {}),
        ...(normalizeServerIdentityId(record.serverIdentityId)
            ? { serverIdentityId: normalizeServerIdentityId(record.serverIdentityId) }
            : {}),
        ...(Array.isArray(record.legacyServerIds)
            ? { legacyServerIds: uniqueServerIds(record.legacyServerIds).filter((legacyId) => legacyId !== sid) }
            : {}),
        createdAt: Number(record.createdAt ?? 0) || 0,
        updatedAt: Number(record.updatedAt ?? 0) || 0,
        lastUsedAt: Number(record.lastUsedAt ?? 0) || 0,
        source,
        ...(legacySource ? { legacySource } : {}),
    };
}

function pickPreferredEquivalentProfile(
    profiles: readonly ServerProfile[],
    opts: Readonly<{ sameOriginServerUrl: string | null; preferredServerId: string | null }>,
): ServerProfile {
    if (profiles.length === 1) return profiles[0]!;

    const sameOrigin = opts.sameOriginServerUrl ? normalizeUrl(opts.sameOriginServerUrl) : '';
    if (sameOrigin) {
        const sameOriginMatch = profiles.find((p) => normalizeUrl(p.serverUrl) === sameOrigin);
        if (sameOriginMatch) return sameOriginMatch;
    }

    const preferredId = normalizeServerId(opts.preferredServerId);
    if (preferredId) {
        const preferredMatch = profiles.find((p) => normalizeServerId(p.id) === preferredId);
        if (preferredMatch) return preferredMatch;
    }

    const sourceRank: Record<ServerProfileSource, number> = {
        'stack-env': 0,
        preconfigured: 1,
        url: 2,
        notification: 3,
        manual: 4,
        qr: 2,
        'account-directory': 2,
        'desktop-personal-home': 1,
        legacy: 10,
    };

    return [...profiles].sort((a, b) => {
        const aRank = a.source ? (sourceRank[a.source] ?? 10) : 10;
        const bRank = b.source ? (sourceRank[b.source] ?? 10) : 10;
        if (aRank !== bRank) return aRank - bRank;

        const aUsed = Number(a.lastUsedAt ?? 0) || 0;
        const bUsed = Number(b.lastUsedAt ?? 0) || 0;
        if (aUsed !== bUsed) return bUsed - aUsed;

        const aUpdated = Number(a.updatedAt ?? 0) || 0;
        const bUpdated = Number(b.updatedAt ?? 0) || 0;
        if (aUpdated !== bUpdated) return bUpdated - aUpdated;

        const aCreated = Number(a.createdAt ?? 0) || 0;
        const bCreated = Number(b.createdAt ?? 0) || 0;
        return aCreated - bCreated;
    })[0]!;
}

function mergeProfileIdentityMetadata(
    profiles: readonly ServerProfile[],
    preferred: ServerProfile,
): Pick<ServerProfile, 'serverIdentityId' | 'legacyServerIds'> {
    const identity = preferred.serverIdentityId ?? profiles.find((profile) => profile.serverIdentityId)?.serverIdentityId ?? null;
    const legacyIds = uniqueServerIds([
        preferred.id,
        ...profiles.map((profile) => profile.id),
        ...profiles.map((profile) => profile.serverIdentityId),
        ...profiles.flatMap((profile) => profile.legacyServerIds ?? []),
    ]).filter((id) => id !== preferred.id && id !== identity);

    return {
        ...(identity ? { serverIdentityId: identity } : {}),
        ...(legacyIds.length > 0 ? { legacyServerIds: legacyIds } : {}),
    };
}

function dedupeEquivalentProfiles(params: Readonly<{
    servers: Record<string, ServerProfile>;
    sameOriginServerUrl: string | null;
    preferredServerId: string | null;
}>): Readonly<{
    servers: Record<string, ServerProfile>;
    idRewrite: Map<string, string>;
    changed: boolean;
}> {
    const groupsByKey = new Map<string, ServerProfile[]>();
    const profilesByUrl = new Map<string, ServerProfile[]>();
    for (const profile of Object.values(params.servers)) {
        const key = comparableUrlKey(profile.canonicalServerUrl ?? profile.serverUrl) || `id:${profile.id}`;
        const group = profilesByUrl.get(key);
        if (group) group.push(profile);
        else profilesByUrl.set(key, [profile]);
    }
    for (const [urlKey, profiles] of profilesByUrl) {
        const identities = new Set(profiles.map((profile) => profile.serverIdentityId).filter(Boolean));
        if (identities.size <= 1) {
            groupsByKey.set(urlKey, profiles);
            continue;
        }
        // Stable identities outrank URL equality. Keep conflicting Homes
        // separate; identity-less legacy entries may only join when there is
        // no ambiguity (handled by the <=1 branch above).
        for (const profile of profiles) {
            const identityKey = profile.serverIdentityId ?? `legacy:${profile.id}`;
            const key = `${urlKey}|identity:${identityKey}`;
            const group = groupsByKey.get(key);
            if (group) group.push(profile);
            else groupsByKey.set(key, [profile]);
        }
    }

    let changed = false;
    const idRewrite = new Map<string, string>();
    const next: Record<string, ServerProfile> = {};

    for (const group of groupsByKey.values()) {
        if (group.length === 1) {
            const only = group[0]!;
            next[only.id] = only;
            continue;
        }

        changed = true;
        const preferred = pickPreferredEquivalentProfile(group, {
            sameOriginServerUrl: params.sameOriginServerUrl,
            preferredServerId: params.preferredServerId,
        });
        const merged: ServerProfile = group.reduce<ServerProfile>((acc, current) => {
            if (current.id === acc.id) return acc;
            return {
                ...acc,
                createdAt: Math.min(acc.createdAt, current.createdAt),
                updatedAt: Math.max(acc.updatedAt, current.updatedAt),
                lastUsedAt: Math.max(acc.lastUsedAt, current.lastUsedAt),
                ...(acc.shareableServerUrl ?? current.shareableServerUrl
                    ? { shareableServerUrl: acc.shareableServerUrl ?? current.shareableServerUrl ?? null }
                    : {}),
                ...(acc.shareableServerUrlValidatedAgainstServerUrl ?? current.shareableServerUrlValidatedAgainstServerUrl
                    ? {
                        shareableServerUrlValidatedAgainstServerUrl:
                            acc.shareableServerUrlValidatedAgainstServerUrl
                            ?? current.shareableServerUrlValidatedAgainstServerUrl
                            ?? null,
                    }
                    : {}),
                ...(acc.canonicalServerUrl ?? current.canonicalServerUrl ? { canonicalServerUrl: acc.canonicalServerUrl ?? current.canonicalServerUrl } : {}),
                ...(acc.publicServerUrl !== undefined || current.publicServerUrl !== undefined
                    ? { publicServerUrl: acc.publicServerUrl ?? current.publicServerUrl ?? null } : {}),
            };
        }, preferred);

        const identityMetadata = mergeProfileIdentityMetadata(group, merged);

        next[merged.id] = { ...merged, ...identityMetadata };

        for (const current of group) {
            if (current.id === merged.id) continue;
            idRewrite.set(current.id, merged.id);
        }
    }

    return { servers: next, idRewrite, changed };
}

function dedupeIdentityProfiles(params: Readonly<{
    servers: Record<string, ServerProfile>;
    sameOriginServerUrl: string | null;
    preferredServerId: string | null;
}>): Readonly<{
    servers: Record<string, ServerProfile>;
    idRewrite: Map<string, string>;
    changed: boolean;
}> {
    const groupsByIdentity = new Map<string, ServerProfile[]>();
    for (const profile of Object.values(params.servers)) {
        const identity = profile.serverIdentityId;
        if (!identity) continue;
        const group = groupsByIdentity.get(identity);
        if (group) group.push(profile);
        else groupsByIdentity.set(identity, [profile]);
    }

    let changed = false;
    const idRewrite = new Map<string, string>();
    const next: Record<string, ServerProfile> = { ...params.servers };

    for (const group of groupsByIdentity.values()) {
        if (group.length <= 1) continue;
        changed = true;

        const preferred = pickPreferredEquivalentProfile(group, {
            sameOriginServerUrl: params.sameOriginServerUrl,
            preferredServerId: params.preferredServerId,
        });
        const merged: ServerProfile = group.reduce<ServerProfile>((acc, current) => {
            if (current.id === acc.id) return acc;
            return {
                ...acc,
                createdAt: Math.min(acc.createdAt, current.createdAt),
                updatedAt: Math.max(acc.updatedAt, current.updatedAt),
                lastUsedAt: Math.max(acc.lastUsedAt, current.lastUsedAt),
                ...(acc.shareableServerUrl ?? current.shareableServerUrl
                    ? { shareableServerUrl: acc.shareableServerUrl ?? current.shareableServerUrl ?? null }
                    : {}),
                ...(acc.shareableServerUrlValidatedAgainstServerUrl ?? current.shareableServerUrlValidatedAgainstServerUrl
                    ? {
                        shareableServerUrlValidatedAgainstServerUrl:
                            acc.shareableServerUrlValidatedAgainstServerUrl
                            ?? current.shareableServerUrlValidatedAgainstServerUrl
                            ?? null,
                    }
                    : {}),
                ...(acc.canonicalServerUrl ?? current.canonicalServerUrl ? { canonicalServerUrl: acc.canonicalServerUrl ?? current.canonicalServerUrl } : {}),
                ...(acc.publicServerUrl !== undefined || current.publicServerUrl !== undefined
                    ? { publicServerUrl: acc.publicServerUrl ?? current.publicServerUrl ?? null } : {}),
            };
        }, preferred);
        const identityMetadata = mergeProfileIdentityMetadata(group, merged);

        for (const current of group) {
            if (current.id !== merged.id) {
                delete next[current.id];
                idRewrite.set(current.id, merged.id);
            }
        }
        next[merged.id] = { ...merged, ...identityMetadata };
    }

    return { servers: next, idRewrite, changed };
}

// Parse cache keyed by the raw persisted string: readPersistedState sits on hot selector
// paths and re-parsing the whole blob per call costs CPU and breaks referential stability.
// Keying by the raw value (re-read every call) stays correct for cross-tab and self-heal
// writes without invalidation wiring; local writes clear it explicitly.
let persistedStateParseCache: { raw: string; state: Required<PersistedServerState> } | null = null;

function parseAccountServiceEndpoint(value: unknown): AccountServiceEndpointV1 | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const url = typeof record.url === 'string' ? normalizeUrl(record.url) : '';
    const source = record.source;
    if (!url || source !== 'default' && source !== 'configured' && source !== 'user') return null;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const identity = normalizeServerIdentityId(record.serverIdentityId);
    return {
        url,
        ...(identity ? { serverIdentityId: identity } : {}),
        ...(typeof record.displayName === 'string' && record.displayName.trim() ? { displayName: record.displayName.trim() } : {}),
        source,
    };
}

function parseHomeViewState(value: unknown): HomeViewStateV1 | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return null;
    const kind = record.activeTargetKind === 'server' || record.activeTargetKind === 'group'
        ? record.activeTargetKind : null;
    const id = typeof record.activeTargetId === 'string' && record.activeTargetId.trim()
        ? record.activeTargetId.trim() : null;
    return {
        version: 1,
        groups: normalizeStoredServerSelectionGroups(record.groups).map((group) => ({ ...group })),
        activeTargetKind: kind,
        activeTargetId: id,
    };
}

function rewriteHomeViewStateIdentity(state: HomeViewStateV1 | null, rewrites: ReadonlyMap<string, string>): HomeViewStateV1 | null {
    if (!state || rewrites.size === 0) return state;
    const rewrite = (id: string | null): string | null => id ? (rewrites.get(id) ?? id) : null;
    return {
        ...state,
        groups: state.groups.map((group) => ({
            ...group,
            serverIds: group.serverIds.map((id) => rewrites.get(id) ?? id),
        })),
        activeTargetId: rewrite(state.activeTargetId),
    };
}

function readPersistedState(): Required<PersistedServerState> {
    const raw = getPersistedStateStorage().getString(STATE_KEY);
    if (!raw) {
        const seeded = applyRuntimeSeedPolicy({});
        return {
            activeServerIdIsExplicit: false,
            activeServerId: resolvePrimaryActiveServerId(seeded, null),
            servers: seeded,
            accountServiceEndpoint: null,
            homeViewState: null,
        };
    }
    if (persistedStateParseCache && persistedStateParseCache.raw === raw) {
        return persistedStateParseCache.state;
    }

    try {
        const parsed = JSON.parse(raw) as PersistedServerState;
        const serversRaw = parsed?.servers && typeof parsed.servers === 'object' ? parsed.servers : {};
        const servers: Record<string, ServerProfile> = {};
        for (const [id, value] of Object.entries(serversRaw)) {
            const profile = parseProfile(id, value);
            if (!profile) continue;
            servers[profile.id] = profile;
        }
        const desiredActive = normalizeServerId(parsed.activeServerId);
        const activeServerIdIsExplicit = parsed.activeServerIdIsExplicit === true;

        // Stable Home identity is authoritative. Deduplicate by identity first,
        // then use canonical URL only for remaining compatible legacy entries.
        const dedupedIdentity = dedupeIdentityProfiles({
            servers,
            sameOriginServerUrl: getWebSameOriginServerUrl(),
            preferredServerId: desiredActive,
        });
        const rewrittenAfterEquivalent =
            desiredActive && dedupedIdentity.idRewrite.has(desiredActive)
                ? dedupedIdentity.idRewrite.get(desiredActive)!
                : desiredActive;
        const deduped = dedupeEquivalentProfiles({
            servers: dedupedIdentity.servers,
            sameOriginServerUrl: getWebSameOriginServerUrl(),
            preferredServerId: rewrittenAfterEquivalent,
        });

        const rewrittenDesiredActive =
            rewrittenAfterEquivalent && deduped.idRewrite.has(rewrittenAfterEquivalent)
                ? deduped.idRewrite.get(rewrittenAfterEquivalent)!
                : rewrittenAfterEquivalent;
        const activeServerId = resolvePrimaryActiveServerId(deduped.servers, rewrittenDesiredActive);
        const accountServiceEndpoint = parseAccountServiceEndpoint(parsed.accountServiceEndpoint);
        const homeViewState = rewriteHomeViewStateIdentity(parseHomeViewState(parsed.homeViewState), deduped.idRewrite);

        const state: Required<PersistedServerState> = {
            activeServerIdIsExplicit,
            activeServerId,
            servers: deduped.servers,
            accountServiceEndpoint,
            homeViewState,
        };

        if (dedupedIdentity.changed || deduped.changed) {
            writePersistedState(state);
        }

        persistedStateParseCache = { raw, state };
        return state;
    } catch {
        const seeded = applyRuntimeSeedPolicy({});
        return {
            activeServerIdIsExplicit: false,
            activeServerId: resolvePrimaryActiveServerId(seeded, null),
            servers: seeded,
            accountServiceEndpoint: null,
            homeViewState: null,
        };
    }
}

function writePersistedState(state: Required<PersistedServerState>): void {
    getPersistedStateStorage().set(STATE_KEY, JSON.stringify(state));
    // Invalidate rather than prime: the next read re-parses so the parse path stays the
    // single canonicalization owner for cached state shapes.
    persistedStateParseCache = null;
}

export function loadHomeViewState(): HomeViewStateV1 | null {
    return readPersistedState().homeViewState;
}

export function saveHomeViewState(state: HomeViewStateV1): void {
    const current = readPersistedState();
    writePersistedState({ ...current, homeViewState: state });
}

/** One-time migration from focused account settings into device-global server state. */
export function migrateHomeViewStateFromSettings(settings: Readonly<Record<string, unknown>>): HomeViewStateV1 | null {
    const existing = loadHomeViewState();
    if (existing) return existing;
    const state: HomeViewStateV1 = {
        version: 1,
        groups: normalizeStoredServerSelectionGroups(settings.serverSelectionGroups),
        activeTargetKind:
            settings.serverSelectionActiveTargetKind === 'server' || settings.serverSelectionActiveTargetKind === 'group'
                ? settings.serverSelectionActiveTargetKind : null,
        activeTargetId:
            typeof settings.serverSelectionActiveTargetId === 'string' && settings.serverSelectionActiveTargetId.trim()
                ? settings.serverSelectionActiveTargetId.trim() : null,
    };
    saveHomeViewState(state);
    return state;
}

function readTabActiveServerId(): string | null {
    if (!isWebRuntime()) return null;
    try {
        const value = (globalThis as any).sessionStorage?.getItem?.(SESSION_STORAGE_ACTIVE_ID_KEY);
        const normalized = typeof value === 'string' ? value.trim() : '';
        return normalizeServerId(normalized);
    } catch {
        return null;
    }
}

function writeTabActiveServerId(id: string | null): void {
    if (!isWebRuntime()) return;
    try {
        const sessionStorage = (globalThis as any).sessionStorage;
        if (!sessionStorage) return;
        if (id) sessionStorage.setItem(SESSION_STORAGE_ACTIVE_ID_KEY, id);
        else sessionStorage.removeItem(SESSION_STORAGE_ACTIVE_ID_KEY);
    } catch {
        // ignore
    }
}

function getWebSameOriginServerUrl(): string | null {
    if (!isWebRuntime()) return null;
    const origin = (globalThis as any).window?.location?.origin;
    if (!origin || origin === 'null') return null;
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        // Official hosted web app (app.happier.dev) is a static SPA; the API lives on api.happier.dev.
        // When builds are missing EXPO_PUBLIC_HAPPIER_SERVER_URL (and legacy aliases), this prevents the default server
        // from incorrectly pointing at the web host.
        if (parsed.hostname.toLowerCase() === 'app.happier.dev') {
            return HAPPIER_CLOUD_SERVER_URL;
        }
        // In stack context, the UI can be served by an Expo/Metro dev server (e.g. http://localhost:8081).
        // Do not treat the UI origin as a relay server. Only allow same-origin fallback for stack-served
        // hosts (happier-<stack>.localhost).
        if (isStackContext()) {
            const host = parsed.hostname.toLowerCase();
            const isStackServedOrigin = host.startsWith('happier-') && host.endsWith('.localhost');
            if (!isStackServedOrigin) {
                return null;
            }
        }
        return origin;
    } catch {
        return null;
    }
}

function buildActiveSnapshotFromState(state: Required<PersistedServerState>): ActiveServerSnapshot {
    const tabId = readTabActiveServerId();
    const tabProfile = findProfileByServerIdentifier(state.servers, tabId);
    const tabExplicit = Boolean(tabProfile);
    const isSelectionExplicit = tabExplicit || state.activeServerIdIsExplicit === true;
    const selectedId = tabProfile
        ? tabProfile.id
        : resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    const selected = selectedId ? state.servers[selectedId] : null;
    const sameOriginUrl = getWebSameOriginServerUrl();

    if (selected) {
        return {
            serverId: resolveServerProfileScopeId(selected),
            serverUrl: selected.canonicalServerUrl ?? selected.serverUrl,
            activeShareableServerUrl: selected.shareableServerUrl ?? null,
            activeShareableServerUrlValidatedAgainstServerUrl: selected.shareableServerUrlValidatedAgainstServerUrl ?? null,
            activeLocalRelayUrl: sameOriginUrl && comparableUrlKey(sameOriginUrl) !== comparableUrlKey(selected.serverUrl)
                ? sameOriginUrl
                : null,
            isSelectionExplicit,
            ...(activeRuntimeOrigin ? { runtimeOrigin: activeRuntimeOrigin } : {}),
            ...(activeCarrier ? { carrier: activeCarrier } : {}),
            generation: activeServerGeneration,
        };
    }

    return {
        serverId: selectedId || '',
        serverUrl: sameOriginUrl ?? '',
        activeShareableServerUrl: null,
        activeShareableServerUrlValidatedAgainstServerUrl: null,
        activeLocalRelayUrl: sameOriginUrl,
        ...(activeRuntimeOrigin ? { runtimeOrigin: activeRuntimeOrigin } : {}),
        ...(activeCarrier ? { carrier: activeCarrier } : {}),
        isSelectionExplicit,
        generation: activeServerGeneration,
    };
}

/** Update transient request origin/carrier without mutating stable profile identity fields. */
export function updateActiveServerRuntimeOrigin(params: Readonly<{ runtimeOrigin?: string; carrier?: 'https' | 'iroh' }>): void {
    const previous = getActiveServerSnapshot();
    activeRuntimeOrigin = params.runtimeOrigin?.trim() || undefined;
    activeCarrier = params.carrier;
    activeServerSnapshotCache = null;
    emitActiveServerChanged(previous, { force: true });
    const snapshot = getActiveServerSnapshot();
    for (const listener of runtimeOriginListeners) listener(snapshot);
}

export function subscribeActiveServerRuntimeOrigin(listener: (snapshot: ActiveServerSnapshot) => void): () => void {
    runtimeOriginListeners.add(listener);
    return () => runtimeOriginListeners.delete(listener);
}

function getStableActiveServerSnapshot(next: ActiveServerSnapshot): ActiveServerSnapshot {
    const cached = activeServerSnapshotCache;
    if (
        cached
        && cached.serverId === next.serverId
        && cached.serverUrl === next.serverUrl
        && (cached.activeShareableServerUrl ?? null) === (next.activeShareableServerUrl ?? null)
        && (cached.activeShareableServerUrlValidatedAgainstServerUrl ?? null) === (next.activeShareableServerUrlValidatedAgainstServerUrl ?? null)
        && (cached.activeLocalRelayUrl ?? null) === (next.activeLocalRelayUrl ?? null)
        && (cached.runtimeOrigin ?? null) === (next.runtimeOrigin ?? null)
        && (cached.carrier ?? null) === (next.carrier ?? null)
        && (cached.isSelectionExplicit ?? null) === (next.isSelectionExplicit ?? null)
        && cached.generation === next.generation
    ) {
        return cached;
    }
    activeServerSnapshotCache = next;
    return next;
}

function emitActiveServerChanged(
    previous: ActiveServerSnapshot | null,
    options: Readonly<{ force?: boolean }> = {},
): void {
    let next = getActiveServerSnapshot();
    // A runtime origin belongs to one focused Home generation. Never carry an ephemeral
    // loopback listener across an active-profile switch; the native lease will be reacquired
    // for the new Home and publish a fresh origin through updateActiveServerRuntimeOrigin().
    if (previous && previous.serverId !== next.serverId) {
        activeRuntimeOrigin = undefined;
        activeCarrier = undefined;
        activeServerSnapshotCache = null;
        next = getActiveServerSnapshot();
    }
    if (
        !options.force
        && previous
        && previous.serverId === next.serverId
        && previous.serverUrl === next.serverUrl
        && (previous.activeShareableServerUrl ?? null) === (next.activeShareableServerUrl ?? null)
        && (previous.activeShareableServerUrlValidatedAgainstServerUrl ?? null) === (next.activeShareableServerUrlValidatedAgainstServerUrl ?? null)
        && (previous.activeLocalRelayUrl ?? null) === (next.activeLocalRelayUrl ?? null)
        && (previous.runtimeOrigin ?? null) === (next.runtimeOrigin ?? null)
        && (previous.carrier ?? null) === (next.carrier ?? null)
        && (previous.isSelectionExplicit ?? null) === (next.isSelectionExplicit ?? null)
    ) return;
    activeServerGeneration += 1;
    const emitted: ActiveServerSnapshot = getStableActiveServerSnapshot({ ...next, generation: activeServerGeneration });
    for (const listener of activeServerListeners) listener(emitted);
}

export function listServerProfiles(): ServerProfile[] {
    return Object.values(readPersistedState().servers);
}

export function getServerProfilesGeneration(): number {
    return serverProfilesGeneration;
}

export function subscribeServerProfiles(listener: (generation: number) => void): () => void {
    serverProfilesListeners.add(listener);
    return () => {
        serverProfilesListeners.delete(listener);
    };
}

const accountServiceEndpointListeners = new Set<(endpoint: AccountServiceEndpointV1 | null) => void>();

export function getAccountServiceEndpointSnapshot(): AccountServiceEndpointV1 | null {
    return readPersistedState().accountServiceEndpoint ?? null;
}

export function subscribeAccountServiceEndpoint(listener: (endpoint: AccountServiceEndpointV1 | null) => void): () => void {
    accountServiceEndpointListeners.add(listener);
    return () => accountServiceEndpointListeners.delete(listener);
}

export function setAccountServiceEndpoint(endpoint: AccountServiceEndpointV1): void {
    const parsed = parseAccountServiceEndpoint(endpoint);
    if (!parsed) throw new Error('Invalid Account Service endpoint');
    const state = readPersistedState();
    writePersistedState({ ...state, accountServiceEndpoint: parsed });
    for (const listener of accountServiceEndpointListeners) listener(parsed);
}

export function resetAccountServiceToDefault(): void {
    const state = readPersistedState();
    const endpoint: AccountServiceEndpointV1 = { url: HAPPIER_CLOUD_SERVER_URL, source: 'default', displayName: 'Happier Cloud' };
    writePersistedState({ ...state, accountServiceEndpoint: endpoint });
    for (const listener of accountServiceEndpointListeners) listener(endpoint);
}

export async function adoptHomeProfile(params: Readonly<{
    descriptor: HomeConnectionDescriptorV1 | LegacyManualHomeDescriptor;
    source: ServerProfileSource;
    preserveUserLabel?: boolean;
}>): Promise<ServerProfile> {
    const descriptor = params.descriptor;
    if (!descriptor || typeof descriptor !== 'object') {
        throw new Error('Invalid Home connection descriptor');
    }
    const strictDescriptor = params.source === 'qr' || params.source === 'account-directory';
    if (strictDescriptor && (!('v' in descriptor) || descriptor.v !== 1 || !Number.isInteger(descriptor.revision) || !Array.isArray(descriptor.endpoints))) {
        throw new Error('Invalid Home connection descriptor');
    }
    const endpointUrl = 'endpoints' in descriptor
        ? descriptor.endpoints.find((endpoint) => endpoint.kind === 'https')?.url
        : undefined;
    // canonicalServerUrl is the stable auth/profile origin; serverUrl is retained
    // only as a legacy/manual alias when no canonical value is supplied.
    const url = normalizeUrl(descriptor.canonicalServerUrl ?? ('serverUrl' in descriptor ? descriptor.serverUrl : undefined) ?? endpointUrl ?? '');
    if (!url) throw new Error('Invalid Home connection URL');
    const identity = normalizeServerIdentityId(descriptor.homeServerIdentityId);
    if (strictDescriptor && (!identity || !normalizeUrl(descriptor.canonicalServerUrl ?? ''))) {
        throw new Error('Home identity is required for strict adoption');
    }
    const state = readPersistedState();
    const byIdentity = identity ? Object.values(state.servers).filter((p) => p.serverIdentityId === identity || (p.legacyServerIds ?? []).includes(identity)) : [];
    const byUrl = findProfileByEquivalentUrl(state.servers, normalizeUrl(descriptor.canonicalServerUrl ?? url));
    if (identity && byIdentity.length > 1) throw new Error('Ambiguous Home identity');
    if (identity && byIdentity.length === 1 && byUrl && byUrl.id !== byIdentity[0]!.id) throw new Error('Home identity conflicts with URL');
    const existing = byIdentity[0] ?? byUrl;
    const displayName = 'displayName' in descriptor ? descriptor.displayName : undefined;
    const profile = existing ?? upsertServerProfile({ serverUrl: url, name: displayName, source: params.source, replaceEquivalentStoredUrl: true });
    const updated: ServerProfile = {
        ...profile,
        ...(existing ? { serverUrl: url } : {}),
        ...(!params.preserveUserLabel && displayName ? { name: displayName.trim() } : {}),
        ...(identity ? { serverIdentityId: identity } : {}),
        ...(descriptor.canonicalServerUrl ? { canonicalServerUrl: normalizeUrl(descriptor.canonicalServerUrl) } : {}),
        ...('publicServerUrl' in descriptor && descriptor.publicServerUrl === null ? { publicServerUrl: null } : 'publicServerUrl' in descriptor && descriptor.publicServerUrl ? { publicServerUrl: normalizeUrl(descriptor.publicServerUrl) } : {}),
    };
    if (JSON.stringify(updated) !== JSON.stringify(profile)) {
        const next = { ...state, servers: { ...state.servers, [updated.id]: updated } };
        writePersistedState(next);
        emitServerProfilesChanged();
    }
    return updated;
}

export function getServerProfileById(idRaw: string): ServerProfile | null {
    const id = normalizeServerId(idRaw);
    if (!id) return null;
    return findProfileByServerIdentifier(readPersistedState().servers, id);
}

/**
 * Resolves only a portable server identity to the current device-local profile
 * that can be used for routing. Profile ids themselves are intentionally not
 * accepted here: they must never be promoted into Account-synced selections.
 */
export function resolveServerProfileForPortableIdentity(
    serverIdentityIdRaw: string | null | undefined,
): PortableServerIdentityProfileResolution {
    const serverIdentityId = normalizeServerIdentityId(serverIdentityIdRaw) ?? '';
    if (!serverIdentityId) {
        return { kind: 'missing', serverIdentityId: '' };
    }

    const profiles = Object.values(readPersistedState().servers);
    const matchingProfiles = profiles.filter((profile) => (
        profile.serverIdentityId === serverIdentityId
        || (profile.legacyServerIds ?? []).includes(serverIdentityId)
    ));
    if (matchingProfiles.length === 1) {
        return {
            kind: 'resolved',
            serverIdentityId,
            profile: matchingProfiles[0]!,
        };
    }
    if (matchingProfiles.length > 1) {
        return {
            kind: 'ambiguous',
            serverIdentityId,
            profiles: matchingProfiles,
        };
    }
    return { kind: 'missing', serverIdentityId };
}

export function resolveServerProfileScopeIdForIdentifier(idRaw: string | null | undefined): string {
    const id = normalizeServerId(idRaw);
    if (!id) return '';
    const profile = findProfileByServerIdentifier(readPersistedState().servers, id);
    return profile ? resolveServerProfileScopeId(profile) : id;
}

export function areServerProfileIdentifiersEquivalent(
    leftRaw: string | null | undefined,
    rightRaw: string | null | undefined,
): boolean {
    const left = normalizeServerId(leftRaw);
    const right = normalizeServerId(rightRaw);
    if (!left || !right) return false;
    if (left === right) return true;

    const state = readPersistedState();
    const leftProfile = findProfileByServerIdentifier(state.servers, left);
    if (!leftProfile) return false;
    const rightProfile = findProfileByServerIdentifier(state.servers, right);
    return Boolean(rightProfile && rightProfile.id === leftProfile.id);
}

export function upsertServerProfile(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        source?: ServerProfileSource;
        replaceEquivalentStoredUrl?: boolean;
    }>,
): ServerProfile {
    const url = normalizeUrl(params.serverUrl);
    if (!url) throw new Error('serverUrl is required');

    const state = readPersistedState();
    const existingEquivalent = findProfileByEquivalentUrl(state.servers, url);
    const id = existingEquivalent?.id
        ?? createUniqueServerId(state.servers, deriveServerIdFromUrl(url), url);
    const existing = state.servers[id];
    const now = nowMs();

    const profile: ServerProfile = {
        id,
        name: String(
            existingEquivalent?.name
            ?? params.name
            ?? existing?.name
            ?? defaultServerNameFromUrl(url)
            ?? id,
        ).trim() || id,
        serverUrl:
            existingEquivalent && params.replaceEquivalentStoredUrl !== true
                ? existingEquivalent.serverUrl
                : url,
        ...(existingEquivalent?.shareableServerUrl
            ? { shareableServerUrl: existingEquivalent.shareableServerUrl }
            : existing?.shareableServerUrl
                ? { shareableServerUrl: existing.shareableServerUrl }
                : {}),
        ...(existingEquivalent?.shareableServerUrlValidatedAgainstServerUrl
            ? { shareableServerUrlValidatedAgainstServerUrl: existingEquivalent.shareableServerUrlValidatedAgainstServerUrl }
            : existing?.shareableServerUrlValidatedAgainstServerUrl
                ? { shareableServerUrlValidatedAgainstServerUrl: existing.shareableServerUrlValidatedAgainstServerUrl }
                : {}),
        ...(existingEquivalent?.serverIdentityId ?? existing?.serverIdentityId
            ? { serverIdentityId: existingEquivalent?.serverIdentityId ?? existing?.serverIdentityId ?? null }
            : {}),
        ...(existingEquivalent?.canonicalServerUrl ?? existing?.canonicalServerUrl
            ? { canonicalServerUrl: existingEquivalent?.canonicalServerUrl ?? existing?.canonicalServerUrl }
            : {}),
        ...(existingEquivalent?.publicServerUrl !== undefined || existing?.publicServerUrl !== undefined
            ? { publicServerUrl: existingEquivalent?.publicServerUrl ?? existing?.publicServerUrl ?? null }
            : {}),
        ...((existingEquivalent?.legacyServerIds ?? existing?.legacyServerIds)?.length
            ? { legacyServerIds: existingEquivalent?.legacyServerIds ?? existing?.legacyServerIds ?? [] }
            : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        source: params.source ?? existing?.source ?? 'manual',
        ...(existing?.legacySource ? { legacySource: existing.legacySource } : {}),
    };

    const previousSnapshot = getActiveServerSnapshot();
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [id]: profile,
        },
    });
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot, { force: true });
    return profile;
}

export function getOrCreateHappierCloudServerProfile(): ServerProfile {
    const state = readPersistedState();
    const existing = findProfileByEquivalentUrl(state.servers, HAPPIER_CLOUD_SERVER_URL);
    if (existing) return existing;

    return upsertServerProfile({
        serverUrl: HAPPIER_CLOUD_SERVER_URL,
        name: 'Happier Cloud',
        source: 'preconfigured',
    });
}

export function setServerProfileIdentityForUrl(serverUrlRaw: string, identityRaw: string | null | undefined): ServerProfile | null {
    const url = normalizeUrl(serverUrlRaw);
    const serverIdentityId = normalizeServerIdentityId(identityRaw);
    if (!url || !serverIdentityId) return null;

    const state = readPersistedState();
    const existing = findProfileByEquivalentUrl(state.servers, url);
    const hasCompetingIdentityProfile = Object.values(state.servers).some((profile) => (
        profile.id !== existing?.id
        && (
            profile.serverIdentityId === serverIdentityId
            || comparableUrlKey(profile.serverUrl) === comparableUrlKey(url)
        )
    ));
    if (
        existing?.serverIdentityId === serverIdentityId
        && !hasCompetingIdentityProfile
    ) {
        return existing;
    }
    const id = existing?.id ?? createUniqueServerId(state.servers, deriveServerIdFromUrl(url), url);
    const now = nowMs();
    const profile: ServerProfile = {
        id,
        name: existing?.name ?? defaultServerNameFromUrl(url) ?? id,
        serverUrl: existing?.serverUrl ?? url,
        ...(existing?.shareableServerUrl ? { shareableServerUrl: existing.shareableServerUrl } : {}),
        ...(existing?.shareableServerUrlValidatedAgainstServerUrl
            ? { shareableServerUrlValidatedAgainstServerUrl: existing.shareableServerUrlValidatedAgainstServerUrl }
            : {}),
        serverIdentityId,
        legacyServerIds: uniqueServerIds([...(existing?.legacyServerIds ?? []), existing?.serverIdentityId, id]).filter(
            (legacyId) => legacyId !== serverIdentityId,
        ),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        source: existing?.source ?? 'url',
        ...(existing?.legacySource ? { legacySource: existing.legacySource } : {}),
    };

    const previousSnapshot = getActiveServerSnapshot();
    const withIdentity: Record<string, ServerProfile> = {
        ...state.servers,
        [id]: profile,
    };
    const deduped = dedupeIdentityProfiles({
        servers: withIdentity,
        sameOriginServerUrl: getWebSameOriginServerUrl(),
        preferredServerId: state.activeServerId,
    });
    const activeServerId =
        deduped.idRewrite.has(state.activeServerId)
            ? deduped.idRewrite.get(state.activeServerId)!
            : resolvePrimaryActiveServerId(deduped.servers, state.activeServerId);
    const tabId = readTabActiveServerId();
    if (tabId && deduped.idRewrite.has(tabId)) {
        writeTabActiveServerId(deduped.idRewrite.get(tabId)!);
    }

    const nextState: Required<PersistedServerState> = {
        ...state,
        activeServerId,
        servers: deduped.servers,
    };
    writePersistedState(nextState);
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot, { force: true });
    return findProfileByServerIdentifier(nextState.servers, serverIdentityId);
}

export function getServerProfileLegacyServerIds(idRaw: string): string[] {
    const state = readPersistedState();
    const profile = findProfileByServerIdentifier(state.servers, idRaw);
    if (!profile) return [];
    return uniqueServerIds([
        profile.id,
        ...(profile.legacyServerIds ?? []),
    ]).filter((id) => id !== profile.serverIdentityId);
}

export function setActiveServerId(
    idRaw: string,
    opts: Readonly<{ scope: 'tab' | 'device' }> = { scope: 'device' },
): void {
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    const state = readPersistedState();
    const profile = findProfileByServerIdentifier(state.servers, id);
    if (!profile) {
        if (opts.scope === 'tab') {
            const previousSnapshot = getActiveServerSnapshot();
            writeTabActiveServerId(null);
            emitActiveServerChanged(previousSnapshot, { force: true });
        }
        return;
    }

    const previousSnapshot = getActiveServerSnapshot();
    if (opts.scope === 'tab') {
        writeTabActiveServerId(profile.id);
        if (previousSnapshot.serverId !== resolveServerProfileScopeId(profile)) {
            activeRuntimeOrigin = undefined;
            activeCarrier = undefined;
        }
        emitActiveServerChanged(previousSnapshot, { force: true });
        return;
    }

    const now = nowMs();
    const existing = state.servers[profile.id]!;
    writePersistedState({
        ...state,
        activeServerIdIsExplicit: true,
        activeServerId: profile.id,
        servers: {
            ...state.servers,
            [profile.id]: { ...existing, lastUsedAt: now, updatedAt: now },
        },
    });
    if (previousSnapshot.serverId !== resolveServerProfileScopeId(profile)) {
        activeRuntimeOrigin = undefined;
        activeCarrier = undefined;
    }
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot, { force: true });
}

export function getResetToDefaultServerId(): string {
    const state = readPersistedState();
    const preconfiguredId = getPrimaryPreconfiguredServerId(state.servers);
    if (preconfiguredId) return preconfiguredId;
    return Object.keys(state.servers)[0] ?? '';
}

export function getTabActiveServerId(): string | null {
    return readTabActiveServerId();
}

export function clearTabActiveServerId(): void {
    if (!readTabActiveServerId()) return;
    const previousSnapshot = getActiveServerSnapshot();
    writeTabActiveServerId(null);
    emitActiveServerChanged(previousSnapshot, { force: true });
}

export function getDeviceDefaultServerId(): string {
    const state = readPersistedState();
    return resolvePrimaryActiveServerId(state.servers, state.activeServerId);
}

export function getDeviceDefaultServerScopeId(): string {
    const state = readPersistedState();
    const profileId = resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    const profile = profileId ? state.servers[profileId] : null;
    return profile ? resolveServerProfileScopeId(profile) : profileId;
}

export function getActiveServerId(): string {
    return getActiveServerSnapshot().serverId;
}

export function isActiveServerSelectionExplicit(): boolean {
    const state = readPersistedState();
    const tab = readTabActiveServerId();
    if (findProfileByServerIdentifier(state.servers, tab)) return true;
    return state.activeServerIdIsExplicit === true;
}

export function getActiveServerUrl(): string {
    const state = readPersistedState();
    const tab = readTabActiveServerId();
    const tabProfile = findProfileByServerIdentifier(state.servers, tab);
    if (tabProfile) return tabProfile.canonicalServerUrl ?? tabProfile.serverUrl;

    const explicit = findProfileByServerIdentifier(state.servers, state.activeServerId);
    if (state.activeServerIdIsExplicit && explicit) {
        return explicit.canonicalServerUrl ?? explicit.serverUrl;
    }

    const fallbackId = resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    if (fallbackId && state.servers[fallbackId]) return state.servers[fallbackId]!.canonicalServerUrl ?? state.servers[fallbackId]!.serverUrl;

    const sameOrigin = getWebSameOriginServerUrl();
    if (sameOrigin) return sameOrigin;

    return '';
}

export function getActiveServerSnapshot(): ActiveServerSnapshot {
    const state = readPersistedState();
    return getStableActiveServerSnapshot(buildActiveSnapshotFromState(state));
}

export function subscribeActiveServer(listener: (snapshot: ActiveServerSnapshot) => void): () => void {
    activeServerListeners.add(listener);
    return () => {
        activeServerListeners.delete(listener);
    };
}

export function removeServerProfile(idRaw: string): void {
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    const state = readPersistedState();
    if (!(id in state.servers)) throw new Error(`Server profile not found: ${id}`);

    const previousSnapshot = getActiveServerSnapshot();
    const { [id]: _removed, ...rest } = state.servers;
    const nextActive = state.activeServerId === id
        ? resolvePrimaryActiveServerId(rest, null)
        : resolvePrimaryActiveServerId(rest, state.activeServerId);
    const tab = readTabActiveServerId();
    if (tab === id) writeTabActiveServerId(null);

    writePersistedState({
        ...state,
        activeServerId: nextActive,
        activeServerIdIsExplicit: true,
        servers: rest,
    });
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot, { force: true });
}

export function renameServerProfile(idRaw: string, nameRaw: string): void {
    const id = normalizeServerId(idRaw);
    const name = String(nameRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (!name) throw new Error('server name is required');

    const state = readPersistedState();
    const existing = state.servers[id];
    if (!existing) throw new Error(`Server profile not found: ${id}`);

    const previousSnapshot = getActiveServerSnapshot();
    const now = nowMs();
    const updated: ServerProfile = {
        ...existing,
        name,
        updatedAt: now,
    };
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [id]: updated,
        },
    });
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot, { force: true });
}

export function setServerProfileShareableUrl(
    idRaw: string,
    shareableServerUrl: string | null | undefined,
    options: Readonly<{ validatedAgainstServerUrl?: string | null | undefined }> = {},
): void {
    const id = normalizeServerId(idRaw);
    if (!id) return;

    const normalized = sanitizeServerUrlForShareableLink(shareableServerUrl ?? null);
    const validatedAgainstServerUrl = normalized
        ? normalizeUrl(String(options.validatedAgainstServerUrl ?? '')) || null
        : null;
    const state = readPersistedState();
    const existing = state.servers[id];
    if (!existing) return;
    if (
        (existing.shareableServerUrl ?? null) === normalized
        && (existing.shareableServerUrlValidatedAgainstServerUrl ?? null) === validatedAgainstServerUrl
    ) return;

    const previousSnapshot = getActiveServerSnapshot();
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [id]: {
                ...existing,
                shareableServerUrl: normalized,
                shareableServerUrlValidatedAgainstServerUrl: validatedAgainstServerUrl,
                updatedAt: nowMs(),
            },
        },
    });
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot, { force: true });
}
