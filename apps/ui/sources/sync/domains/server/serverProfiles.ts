import { MMKV } from 'react-native-mmkv';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { HomeConnectionDescriptorV1Schema, StoredHomeConnectionDescriptorV1Schema, type HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { DEFAULT_HAPPIER_CLOUD_SERVER_URL } from '@happier-dev/cli-common/happierCloud';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { isStackContext } from './serverContext';
import { canonicalizeServerUrl, createServerUrlComparableKey } from './url/serverUrlCanonical';
import { sanitizeServerUrlForShareableLink } from './url/shareableServerUrl';
import { readConfiguredServerUrlEnv, readConfiguredServerUrlEnvRaw } from './readConfiguredServerUrlEnv';
import { resolveSetupSurfacePolicy } from './setup/setupSurfacePolicy';
import { retireIrohHomeTransportDiagnostics } from '@/sync/runtime/irohHomeTransportDiagnostics';
import { ALL_HOMES_MINIMUM_HOME_COUNT, isAllHomesSelectionTargetId } from './selection/allHomesSelectionTarget';
import { normalizeStoredServerSelectionGroups } from './selection/serverSelectionMutations';
import type { ServerSelectionGroup } from './selection/serverSelectionTypes';
import { withHomeMutationAuthority, type HomeMutationAuthority } from './homeMutationLock';

export type ServerProfileSource =
    | 'manual' | 'qr' | 'account-directory' | 'desktop-personal-home' | 'legacy'
    | 'url' | 'stack-env' | 'notification' | 'preconfigured';

export type AccountServiceEndpointV1 = Readonly<{
    url: string;
    serverIdentityId?: string;
    displayName?: string;
    source: 'default' | 'user';
}>;

type LegacyManualHomeDescriptor = Readonly<{
    serverUrl: string;
    canonicalServerUrl?: string;
    publicServerUrl?: string | null;
    homeServerIdentityId?: string;
    displayName?: string;
}>;

export const HAPPIER_CLOUD_SERVER_URL = DEFAULT_HAPPIER_CLOUD_SERVER_URL;

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
    /** Exact server-published outer descriptor retained for transport and share flows. */
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    /**
     * This device completed and verified managed Personal Home bootstrap for this exact Home
     * identity. It is deliberately separate from mutable adoption provenance and live health.
     */
    personalHomeBootstrapCompleted?: true;
    /**
     * Single descriptor-provenance marker: present only on advisory-only Directory
     * placeholders whose connection facts were never established by a Home/user
     * authority. Absent means established.
     */
    descriptorProvenance?: 'advisory-only';
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
    connectionDescriptorRevision?: number;
    isSelectionExplicit?: boolean;
    generation: number;
}>;

export type ActiveServerRuntimeTarget = Readonly<{
    serverId: string;
    generation: number;
}>;

type PersistedServerState = {
    activeServerIdIsExplicit?: boolean;
    activeServerId?: string;
    servers?: Record<string, ServerProfile>;
    accountServiceEndpoint?: AccountServiceEndpointV1 | null;
    homeViewState?: HomeViewStateV1 | null;
    /**
     * Explicit initialization/version marker for `homeViewState`. Absent/false means the
     * legacy pre-marker world where a missing payload still permits the one-time scoped
     * migration; true means the payload is authoritative and corruption repairs to the
     * normalized focused fallback instead of re-consulting scoped settings.
     */
    homeViewStateInitialized?: boolean;
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
// Profile mutations advance this only when the material focused snapshot changes;
// explicit selection operations may force a publication. This remains separate
// from the native publication generation, whose narrower lease target excludes
// shareable/presentation facts from its release fencing.
let activeRuntimeTargetGeneration = 0;
const activeServerListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();
let activeServerSnapshotCache: ActiveServerSnapshot | null = null;
/**
 * The one focused-Home transport publication. It is either URL-addressed (an
 * independent HTTPS origin, or the loopback origin a native Iroh lease binds)
 * or a semantic carrier that owns its own bytes and has no origin at all. A
 * browser Iroh Home is the second case: fabricating a loopback origin for it
 * would put an untrue value into request URLs, reachability keys, and logs.
 */
let activeRuntimeOriginLease: Readonly<{
    target: ActiveServerRuntimeTarget;
    leaseId: string;
    runtimeOrigin: string | null;
    homeCarrier: HomeCarrier | null;
    carrier: 'https' | 'iroh';
}> | null = null;
const runtimeOriginListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();

let serverProfilesGeneration = 0;
const serverProfilesListeners = new Set<(generation: number) => void>();
const homeViewStateListeners = new Set<() => void>();
let webPersistedStateObserverInstalled = false;

function notifyIndependentListeners<TArgs extends readonly unknown[]>(
    listeners: ReadonlySet<(...args: TArgs) => void>,
    args: TArgs,
    eventName: string,
): void {
    for (const listener of listeners) {
        try {
            listener(...args);
        } catch (error) {
            // Persistence/state mutation is already committed before notification.
            // One observer must neither reclassify that commit as a failure nor
            // prevent independent observers from seeing the same publication.
            console.error(`[serverProfiles] ${eventName} observer failed`, error);
        }
    }
}

function emitServerProfilesChanged(): void {
    serverProfilesGeneration += 1;
    notifyIndependentListeners(serverProfilesListeners, [serverProfilesGeneration], 'profiles_changed');
}

function emitHomeViewStateChanged(): void {
    notifyIndependentListeners(homeViewStateListeners, [], 'home_view_changed');
}

function ensureWebPersistedStateObserver(): void {
    if (isEmbedWindowContext()) return;
    if (webPersistedStateObserverInstalled || !isWebRuntime()) return;
    const eventTarget = globalThis.window;
    if (!eventTarget || typeof eventTarget.addEventListener !== 'function') return;
    webPersistedStateObserverInstalled = true;
    eventTarget.addEventListener('storage', (event: StorageEvent) => {
        if (event.key !== `${storageId()}:${STATE_KEY}`) return;

        const previousState = persistedStateParseCache?.state ?? null;
        const previousSnapshot = activeServerSnapshotCache;
        persistedStateParseCache = null;
        const nextState = readPersistedState();

        const serversChanged = !previousState
            || JSON.stringify(previousState.servers) !== JSON.stringify(nextState.servers);
        if (serversChanged) {
            emitServerProfilesChanged();
        }
        if (!previousState || JSON.stringify(previousState.homeViewState) !== JSON.stringify(nextState.homeViewState)) {
            emitHomeViewStateChanged();
        }
        if (!previousState || JSON.stringify(previousState.accountServiceEndpoint) !== JSON.stringify(nextState.accountServiceEndpoint)) {
            const endpoint = nextState.accountServiceEndpoint ?? null;
            notifyIndependentListeners(accountServiceEndpointListeners, [endpoint], 'account_service_endpoint_changed');
        }
        if (
            !previousState
            || serversChanged
            || previousState.activeServerId !== nextState.activeServerId
            || previousState.activeServerIdIsExplicit !== nextState.activeServerIdIsExplicit
        ) {
            emitActiveServerChanged(previousSnapshot);
        }
    });
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

export function defaultHomeNameForAddress(serverUrl: string): string {
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

/**
 * Whether a stored name is only an address (a URL, IP, `host:port`, `localhost`, or a dotted host
 * name) and so not a name at all. Names are defaulted to addresses, and the place may since have
 * moved, so the address need not match its current URL. Single words ("devbox") and phrases stay
 * names. The one rule for every surface that names a Home or a sign-in service.
 */
export function isAddressOnlyName(nameRaw: string): boolean {
    const name = nameRaw.trim();
    if (!name) return false;
    if (/\s/.test(name)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) return true;
    if (/^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(name)) return true;
    if (/^[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*$/i.test(name)) return true;
    const withoutPort = name.replace(/:\d{1,5}$/, '');
    const hasPort = withoutPort !== name;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(withoutPort)) return true;
    if (withoutPort.toLowerCase() === 'localhost') return true;
    const labels = withoutPort.split('.');
    if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
    return hasPort || (labels.length > 1 && /^[a-z]{2,}$/i.test(labels[labels.length - 1]!));
}

/**
 * The name a person or Home gave this profile, or null when the stored name is only an address
 * (the one it was defaulted from, or any other: see `isAddressOnlyName`).
 */
export function readServerProfileHomeName(profile: Pick<ServerProfile, 'name' | 'serverUrl' | 'canonicalServerUrl' | 'publicServerUrl'>): string | null {
    const name = profile.name.trim();
    if (!name) return null;
    if (isAddressOnlyName(name)) return null;
    const comparable = name.toLocaleLowerCase();
    for (const url of [profile.serverUrl, profile.canonicalServerUrl, profile.publicServerUrl]) {
        if (!url) continue;
        if (comparable === defaultHomeNameForAddress(url).toLocaleLowerCase()) return null;
        if (comparable === normalizeUrl(url).toLocaleLowerCase()) return null;
    }
    return name;
}

function nowMs(): number {
    return Date.now();
}

function storageId(): string {
    const scope = readStorageScopeFromEnv();
    return scopedStorageId('server-profiles', scope);
}

/**
 * Runs the complete latest-read/mutate/write operation under one browser-wide
 * lock. Native and other single-JS-runtime owners execute the same callback
 * directly, before the returned Promise settles, preserving their existing
 * immediate observable semantics.
 */
function withPersistedStateMutation<T>(
    mutate: () => T,
    authority?: HomeMutationAuthority,
): Promise<T> {
    return withHomeMutationAuthority(authority, mutate);
}

type PersistedStateStorage = Readonly<{
    getString: (key: string) => string | undefined;
    set: (key: string, value: string) => boolean;
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
            if (!storage) {
                fallback.set(resolvedKey, value);
                return true;
            }
            try {
                storage.setItem(resolvedKey, value);
            } catch {
                return false;
            }
            fallback.set(resolvedKey, value);
            return true;
        },
    };
}

function createNativePersistedStateStorage(): PersistedStateStorage {
    const storage = new MMKV({ id: storageId() });
    return {
        getString: (key: string) => storage.getString(key),
        set: (key: string, value: string) => {
            try {
                storage.set(key, value);
                return true;
            } catch {
                return false;
            }
        },
    };
}

function getPersistedStateStorage(): PersistedStateStorage {
    if (persistedStateStorage) return persistedStateStorage;
    if (isEmbedWindowContext()) {
        persistedStateStorage = createInMemoryPersistedStateStorage(undefined);
        return persistedStateStorage;
    }
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
            return true;
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
    return findProfilesByEquivalentUrl(servers, serverUrl)[0] ?? null;
}

function findProfilesByEquivalentUrl(servers: Record<string, ServerProfile>, serverUrl: string): ServerProfile[] {
    const targetKey = comparableUrlKey(serverUrl);
    if (!targetKey) return [];
    return Object.values(servers).filter(
        (profile) => comparableUrlKey(profile.canonicalServerUrl ?? profile.serverUrl) === targetKey,
    );
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
            name: configured.name || defaultHomeNameForAddress(configured.url) || id,
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

    const rawSource = typeof record.source === 'string' ? record.source : '';
    const normalizedSource = rawSource.trim().toLowerCase();
    const source: ServerProfileSource | undefined =
        normalizedSource === 'manual'
            || normalizedSource === 'url'
            || normalizedSource === 'stack-env'
            || normalizedSource === 'notification'
            || normalizedSource === 'preconfigured'
            || normalizedSource === 'qr'
            || normalizedSource === 'account-directory'
            || normalizedSource === 'desktop-personal-home'
            || normalizedSource === 'legacy'
            ? normalizedSource
            : normalizedSource ? 'legacy' : undefined;
    const legacySource = source === 'legacy' && normalizedSource !== 'legacy' ? rawSource : undefined;
    // `desktop-personal-home` was the previous durable completion receipt.  Read it
    // once into the identity-bound scalar so later adoption may freely update source.
    const serverIdentityId = normalizeServerIdentityId(record.serverIdentityId);
    const personalHomeBootstrapCompleted = serverIdentityId
        && (record.personalHomeBootstrapCompleted === true || source === 'desktop-personal-home')
        ? true as const
        : undefined;

    const canonicalServerUrl = typeof record.canonicalServerUrl === 'string'
        ? normalizeUrl(record.canonicalServerUrl) : '';
    const publicServerUrl = record.publicServerUrl === null
        ? null
        : typeof record.publicServerUrl === 'string' ? normalizeUrl(record.publicServerUrl) : undefined;
    // Only the exact server-published descriptor owns transport facts. The
    // never-released scalar endpoint/revision drafts are not persistence inputs.
    const homeConnectionDescriptorResult = StoredHomeConnectionDescriptorV1Schema.safeParse(
        record.homeConnectionDescriptor,
    );
    // Tolerant, additive provenance read: unknown values are dropped, never trusted.
    const descriptorProvenance = homeConnectionDescriptorResult.success
        && record.descriptorProvenance === 'advisory-only'
        ? 'advisory-only' as const
        : undefined;

    return {
        id: sid,
        name,
        serverUrl,
        ...(canonicalServerUrl ? { canonicalServerUrl } : {}),
        ...(publicServerUrl !== undefined ? { publicServerUrl } : {}),
        ...(homeConnectionDescriptorResult.success
            ? { homeConnectionDescriptor: homeConnectionDescriptorResult.data }
            : {}),
        ...(descriptorProvenance ? { descriptorProvenance } : {}),
        ...(typeof record.shareableServerUrl === 'string'
            ? { shareableServerUrl: sanitizeServerUrlForShareableLink(record.shareableServerUrl) }
            : {}),
        ...(typeof record.shareableServerUrlValidatedAgainstServerUrl === 'string'
            ? { shareableServerUrlValidatedAgainstServerUrl: normalizeUrl(String(record.shareableServerUrlValidatedAgainstServerUrl)) }
            : {}),
        ...(serverIdentityId
            ? { serverIdentityId }
            : {}),
        ...(Array.isArray(record.legacyServerIds)
            ? { legacyServerIds: uniqueServerIds(record.legacyServerIds).filter((legacyId) => legacyId !== sid) }
            : {}),
        createdAt: Number(record.createdAt ?? 0) || 0,
        updatedAt: Number(record.updatedAt ?? 0) || 0,
        lastUsedAt: Number(record.lastUsedAt ?? 0) || 0,
        source,
        ...(legacySource ? { legacySource } : {}),
        ...(personalHomeBootstrapCompleted ? { personalHomeBootstrapCompleted } : {}),
    };
}

function pickPreferredEquivalentProfile(
    profiles: readonly ServerProfile[],
    opts: Readonly<{ sameOriginServerUrl: string | null; preferredServerId: string | null }>,
): ServerProfile {
    if (profiles.length === 1) return profiles[0]!;

    // Directory projections are advisory metadata only. When persisted state
    // contains both an established Home profile and an advisory placeholder for
    // the same identity/URL, choose the established authority before applying
    // origin, focus, source, or recency tie-breakers.
    const establishedProfiles = profiles.filter((profile) => profile.descriptorProvenance !== 'advisory-only');
    const candidates = establishedProfiles.length > 0 ? establishedProfiles : profiles;

    const sameOrigin = opts.sameOriginServerUrl ? normalizeUrl(opts.sameOriginServerUrl) : '';
    if (sameOrigin) {
        const sameOriginMatch = candidates.find((p) => normalizeUrl(p.serverUrl) === sameOrigin);
        if (sameOriginMatch) return sameOriginMatch;
    }

    const preferredId = normalizeServerId(opts.preferredServerId);
    if (preferredId) {
        const preferredMatch = candidates.find((p) => normalizeServerId(p.id) === preferredId);
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

    return [...candidates].sort((a, b) => {
        const aRevision = a.homeConnectionDescriptor?.revision ?? -1;
        const bRevision = b.homeConnectionDescriptor?.revision ?? -1;
        if (aRevision !== bRevision) return bRevision - aRevision;

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
    const establishedProfiles = profiles.filter((profile) => profile.descriptorProvenance !== 'advisory-only');
    const preferredIsEstablished = preferred.descriptorProvenance !== 'advisory-only';
    // Advisory Directory rows may explain why two local rows share a URL, but
    // they cannot establish identity on the retained established profile. If
    // every row is advisory, retain only the selected placeholder's own
    // identity; never import another advisory row's identity or aliases.
    const identity = preferredIsEstablished
        ? preferred.serverIdentityId
            ?? establishedProfiles.find((profile) => profile.serverIdentityId)?.serverIdentityId
            ?? null
        : preferred.serverIdentityId ?? null;
    const legacyIds = uniqueServerIds([
        preferred.id,
        ...profiles.map((profile) => profile.id),
        ...establishedProfiles.map((profile) => profile.serverIdentityId),
        ...establishedProfiles.flatMap((profile) => profile.legacyServerIds ?? []),
    ]).filter((id) => id !== preferred.id && id !== identity);

    return {
        ...(identity ? { serverIdentityId: identity } : {}),
        ...(legacyIds.length > 0 ? { legacyServerIds: legacyIds } : {}),
    };
}

export function isServerProfilePersonalHomeBootstrapCompleted(
    profile: ServerProfile | null | undefined,
): profile is ServerProfile & Readonly<{
    serverIdentityId: string;
    personalHomeBootstrapCompleted: true;
}> {
    return profile?.personalHomeBootstrapCompleted === true
        && normalizeServerIdentityId(profile.serverIdentityId) != null;
}

function personalHomeBootstrapCompletionForIdentity(
    profiles: readonly ServerProfile[],
    identityRaw: string | null | undefined,
): true | undefined {
    const identity = normalizeServerIdentityId(identityRaw);
    if (!identity) return undefined;
    return profiles.some((profile) => (
        profile.serverIdentityId === identity
        && profile.personalHomeBootstrapCompleted === true
    )) ? true : undefined;
}

/**
 * Returns this device's one managed Personal Home completion profile. Multiple
 * identity-bound receipts are ambiguous rather than a basis for readiness or controls.
 */
export function findPersonalHomeBootstrapCompletedProfile(
    profiles: readonly ServerProfile[],
): ServerProfile | null {
    const completed = profiles.filter(isServerProfilePersonalHomeBootstrapCompleted);
    return completed.length === 1 ? completed[0]! : null;
}

/** Retires verified readiness only for the Home whose data was irreversibly erased. */
export function retirePersonalHomeBootstrapCompletion(serverIdentityId: string): Promise<void> {
    const identity = normalizeServerIdentityId(serverIdentityId);
    if (!identity) throw new Error('A stable Home identity is required to retire bootstrap completion');
    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        const servers = { ...state.servers };
        let changed = false;
        for (const profile of Object.values(servers)) {
            if (profile.serverIdentityId !== identity || !isServerProfilePersonalHomeBootstrapCompleted(profile)) continue;
            const { personalHomeBootstrapCompleted: _completed, ...retained } = profile;
            // The legacy source is also a receipt on read; clear both representations
            // so a later parse cannot recreate completion after a cleanup refusal.
            servers[profile.id] = { ...retained, ...(profile.source === 'desktop-personal-home' ? { source: 'manual' as const } : {}) };
            changed = true;
        }
        if (!changed) return;
        const previousSnapshot = getActiveServerSnapshot();
        writePersistedState({ ...state, servers });
        emitServerProfilesChanged();
        emitActiveServerChanged(previousSnapshot);
    });
}

/**
 * Equivalent-profile merges select one exact descriptor atomically, after
 * established Home authority outranks advisory Directory placeholders. Never
 * splice endpoints or revisions across snapshots. Groups do not span identities.
 */
type HomeConnectionDescriptorFacts = Pick<
    ServerProfile,
    'homeConnectionDescriptor' | 'descriptorProvenance'
>;

function copyHomeConnectionDescriptorFacts(
    source: ServerProfile | null | undefined,
): HomeConnectionDescriptorFacts {
    if (!source?.homeConnectionDescriptor) {
        return {
            homeConnectionDescriptor: undefined,
            descriptorProvenance: undefined,
        };
    }
    return {
        homeConnectionDescriptor: source.homeConnectionDescriptor,
        descriptorProvenance: source.descriptorProvenance,
    };
}

function coalesceHomeConnectionDescriptor(
    group: readonly ServerProfile[],
    preferred: ServerProfile,
): Pick<ServerProfile, 'homeConnectionDescriptor' | 'descriptorProvenance' | 'serverUrl' | 'canonicalServerUrl' | 'publicServerUrl'> {
    const establishedProfiles = group.filter((profile) => profile.descriptorProvenance !== 'advisory-only');
    const candidates = establishedProfiles.length > 0 ? establishedProfiles : group;
    let source = candidates.includes(preferred) ? preferred : candidates[0]!;
    for (const profile of candidates) {
        if (
            profile.homeConnectionDescriptor !== undefined
            && (source.homeConnectionDescriptor === undefined
                || profile.homeConnectionDescriptor.revision > source.homeConnectionDescriptor.revision)
        ) {
            source = profile;
        }
    }
    const descriptor = source.homeConnectionDescriptor;
    return descriptor
        ? {
            ...copyHomeConnectionDescriptorFacts(source),
            serverUrl: normalizeUrl(descriptor.canonicalServerUrl),
            canonicalServerUrl: normalizeUrl(descriptor.canonicalServerUrl),
            publicServerUrl: descriptor.endpoints.find((endpoint) => endpoint.kind === 'https')?.url ?? null,
        }
        : {
            ...copyHomeConnectionDescriptorFacts(source),
            serverUrl: source.serverUrl,
            canonicalServerUrl: source.canonicalServerUrl,
            publicServerUrl: source.publicServerUrl,
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
        const allProfilesPrecedeCanonicalHomeIdentity = profiles.every(
            (profile) => !profile.canonicalServerUrl,
        );
        if (identities.size <= 1 || allProfilesPrecedeCanonicalHomeIdentity) {
            groupsByKey.set(urlKey, profiles);
            continue;
        }
        // Stable identities outrank URL equality. Keep conflicting Homes
        // separate. Persisted profiles from before canonical Home URLs existed
        // are the migration exception: those duplicate rows represented the
        // same URL-selected Home, so the preferred row keeps the other
        // identities as aliases rather than manufacturing distinct Homes.
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
                ...coalesceHomeConnectionDescriptor(group, acc),
            };
        }, preferred);

        const identityMetadata = mergeProfileIdentityMetadata(group, merged);

        next[merged.id] = {
            ...merged,
            ...identityMetadata,
            ...(personalHomeBootstrapCompletionForIdentity(group, identityMetadata.serverIdentityId)
                ? { personalHomeBootstrapCompleted: true as const }
                : {}),
        };

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
                ...coalesceHomeConnectionDescriptor(group, acc),
            };
        }, preferred);
        const identityMetadata = mergeProfileIdentityMetadata(group, merged);

        for (const current of group) {
            if (current.id !== merged.id) {
                delete next[current.id];
                idRewrite.set(current.id, merged.id);
            }
        }
        next[merged.id] = {
            ...merged,
            ...identityMetadata,
            ...(personalHomeBootstrapCompletionForIdentity(group, identityMetadata.serverIdentityId)
                ? { personalHomeBootstrapCompleted: true as const }
                : {}),
        };
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
    const url = typeof record.url === 'string'
        ? normalizeAccountDirectoryEndpoint(record.url)
        : null;
    const source = record.source;
    if (!url || source !== 'default' && source !== 'user') return null;
    const identity = normalizeServerIdentityId(record.serverIdentityId);
    if (Object.prototype.hasOwnProperty.call(record, 'serverIdentityId') && !identity) return null;
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

function normalizeHomeViewStateAgainstProfiles(
    state: HomeViewStateV1,
    servers: Readonly<Record<string, ServerProfile>>,
    activeServerId: string,
): HomeViewStateV1 {
    const scopeIdByAlias = new Map<string, string>();
    for (const profile of Object.values(servers)) {
        const scopeId = resolveServerProfileScopeId(profile);
        if (!scopeId) continue;
        scopeIdByAlias.set(profile.id, scopeId);
        scopeIdByAlias.set(scopeId, scopeId);
        for (const legacyId of profile.legacyServerIds ?? []) {
            const normalizedLegacyId = normalizeServerId(legacyId);
            if (normalizedLegacyId) scopeIdByAlias.set(normalizedLegacyId, scopeId);
        }
    }

    const groups = state.groups
        .map((group) => {
            const seen = new Set<string>();
            const serverIds: string[] = [];
            for (const rawId of group.serverIds) {
                const id = normalizeServerId(rawId);
                if (!id) continue;
                const mapped = scopeIdByAlias.get(id) ?? id;
                if (seen.has(mapped)) continue;
                seen.add(mapped);
                serverIds.push(mapped);
            }
            return serverIds.length === group.serverIds.length
                && serverIds.every((id, index) => id === group.serverIds[index])
                ? group
                : { ...group, serverIds };
        })
        .filter((group) => group.serverIds.length > 0);

    const targetId = state.activeTargetId ? normalizeServerId(state.activeTargetId) : null;
    let activeTargetKind = state.activeTargetKind;
    let activeTargetId = targetId;
    let targetIsValid = activeTargetKind === null && activeTargetId === null;
    if (activeTargetKind === 'server' && activeTargetId) {
        const mapped = scopeIdByAlias.get(activeTargetId) ?? activeTargetId;
        // A persisted Home scope may arrive before its profile (for example while
        // Account Directory adoption is still reconciling). Keep that explicit
        // target until an authoritative removal says otherwise.
        targetIsValid = true;
        activeTargetId = mapped;
    } else if (activeTargetKind === 'group' && isAllHomesSelectionTargetId(activeTargetId)) {
        // "All Homes" is virtual: it stands while there are Homes enough to gather.
        targetIsValid = new Set(scopeIdByAlias.values()).size >= ALL_HOMES_MINIMUM_HOME_COUNT;
    } else if (activeTargetKind === 'group' && activeTargetId) {
        targetIsValid = groups.some((group) => group.id === activeTargetId && group.serverIds.length > 0);
    }

    if (!targetIsValid) {
        const focused = activeServerId ? servers[activeServerId] : null;
        const fallbackId = focused ? resolveServerProfileScopeId(focused) : null;
        activeTargetKind = fallbackId ? 'server' : null;
        activeTargetId = fallbackId;
    }

    return {
        version: 1,
        groups,
        activeTargetKind,
        activeTargetId,
    };
}

function rewriteHomeViewStateIdentity(state: HomeViewStateV1 | null, rewrites: ReadonlyMap<string, string>): HomeViewStateV1 | null {
    if (!state || rewrites.size === 0) return state;
    const rewrite = (id: string | null): string | null => id ? (rewrites.get(id) ?? id) : null;
    return {
        ...state,
        groups: normalizeStoredServerSelectionGroups(state.groups.map((group) => ({
            ...group,
            serverIds: group.serverIds.map((id) => rewrites.get(id) ?? id),
        }))),
        activeTargetId: state.activeTargetKind === 'server' ? rewrite(state.activeTargetId) : state.activeTargetId,
    };
}

/**
 * Corruption repair for an initialized (marker-present) `homeViewState`: normalized
 * empty groups and the current focused profile scope as target, or no target when no
 * focused profile exists. Never derived from scoped account settings.
 */
function createRepairedHomeViewState(
    servers: Readonly<Record<string, ServerProfile>>,
    activeServerId: string,
): HomeViewStateV1 {
    const focused = activeServerId ? servers[activeServerId] : null;
    const focusedScopeId = focused ? resolveServerProfileScopeId(focused) : null;
    return {
        version: 1,
        groups: [],
        activeTargetKind: focusedScopeId ? 'server' : null,
        activeTargetId: focusedScopeId,
    };
}

function addProfileScopeIdentityRewrites(
    rewrites: Map<string, string>,
    servers: Readonly<Record<string, ServerProfile>>,
): void {
    for (const profile of Object.values(servers)) {
        const scopeId = resolveServerProfileScopeId(profile);
        rewrites.set(profile.id, scopeId);
        for (const legacyId of profile.legacyServerIds ?? []) rewrites.set(legacyId, scopeId);
    }
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
            homeViewStateInitialized: false,
        };
    }
    if (persistedStateParseCache && persistedStateParseCache.raw === raw) {
        return persistedStateParseCache.state;
    }

    try {
        const parsed = JSON.parse(raw) as PersistedServerState;
        const serversRaw = parsed?.servers && typeof parsed.servers === 'object' ? parsed.servers : {};
        const servers: Record<string, ServerProfile> = {};
        let needsPersonalHomeBootstrapCompletionMigration = false;
        for (const [id, value] of Object.entries(serversRaw)) {
            const profile = parseProfile(id, value);
            if (!profile) continue;
            servers[profile.id] = profile;
            if (
                profile.personalHomeBootstrapCompleted === true
                && value
                && typeof value === 'object'
                && (value as Record<string, unknown>).personalHomeBootstrapCompleted !== true
            ) {
                needsPersonalHomeBootstrapCompletionMigration = true;
            }
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
        const combinedIdRewrite = new Map<string, string>();
        for (const [from, intermediate] of dedupedIdentity.idRewrite) {
            combinedIdRewrite.set(from, deduped.idRewrite.get(intermediate) ?? intermediate);
        }
        for (const [from, to] of deduped.idRewrite) combinedIdRewrite.set(from, to);
        addProfileScopeIdentityRewrites(combinedIdRewrite, deduped.servers);
        const rewrittenHomeViewState = rewriteHomeViewStateIdentity(parseHomeViewState(parsed.homeViewState), combinedIdRewrite);
        const parsedHomeViewState = rewrittenHomeViewState
            ? normalizeHomeViewStateAgainstProfiles(rewrittenHomeViewState, deduped.servers, activeServerId)
            : null;
        const needsHomeViewCanonicalizationWrite = rewrittenHomeViewState !== null
            && JSON.stringify(rewrittenHomeViewState) !== JSON.stringify(parsedHomeViewState);

        // The initialization marker separates the legacy pre-marker world (missing/invalid
        // payload still permits the one-time scoped migration) from the initialized world
        // (marker + invalid payload is corruption: repair to the normalized focused
        // fallback and never consult stale scoped state again).
        const persistedHomeViewStateInitialized = parsed.homeViewStateInitialized === true;
        let homeViewState = parsedHomeViewState;
        let homeViewStateInitialized = persistedHomeViewStateInitialized;
        let needsHomeViewInitializationWrite = false;
        if (parsedHomeViewState === null) {
            if (persistedHomeViewStateInitialized) {
                homeViewState = createRepairedHomeViewState(deduped.servers, activeServerId);
                homeViewStateInitialized = true;
                needsHomeViewInitializationWrite = true;
            }
            // No marker: keep the store eligible for the legacy one-time migration.
        } else if (!persistedHomeViewStateInitialized) {
            // A valid pre-marker Home view state is preserved as-is; it acquires the
            // marker through this ordinary canonical read/write path.
            homeViewStateInitialized = true;
            needsHomeViewInitializationWrite = true;
        }

        const state: Required<PersistedServerState> = {
            activeServerIdIsExplicit,
            activeServerId,
            servers: deduped.servers,
            accountServiceEndpoint,
            homeViewState,
            homeViewStateInitialized,
        };

        if (
            dedupedIdentity.changed
            || deduped.changed
            || needsHomeViewInitializationWrite
            || needsHomeViewCanonicalizationWrite
            || needsPersonalHomeBootstrapCompletionMigration
        ) {
            // Snapshot readers stay synchronous and side-effect free. The next
            // explicit mutation persists this canonical projection from inside
            // the browser-wide latest-read/mutate/write critical section.
            return state;
        }

        persistedStateParseCache = { raw, state };
        return state;
    } catch (error) {
        if (error instanceof ServerProfilesPersistenceError) throw error;
        const seeded = applyRuntimeSeedPolicy({});
        return {
            activeServerIdIsExplicit: false,
            activeServerId: resolvePrimaryActiveServerId(seeded, null),
            servers: seeded,
            accountServiceEndpoint: null,
            homeViewState: null,
            homeViewStateInitialized: false,
        };
    }
}

class ServerProfilesPersistenceError extends Error {
    constructor() {
        super('Failed to persist Home profiles');
        this.name = 'ServerProfilesPersistenceError';
    }
}

function serializePersistedState(state: Required<PersistedServerState>): string {
    const servers = Object.fromEntries(Object.entries(state.servers).map(([id, profile]) => {
        if (profile.source !== 'legacy' || !profile.legacySource) return [id, profile];
        const { legacySource, ...persisted } = profile;
        return [id, { ...persisted, source: legacySource }];
    }));
    return JSON.stringify({ ...state, servers });
}

function writePersistedState(state: Required<PersistedServerState>): void {
    try {
        if (!getPersistedStateStorage().set(STATE_KEY, serializePersistedState(state))) {
            throw new ServerProfilesPersistenceError();
        }
    } catch (error) {
        if (error instanceof ServerProfilesPersistenceError) throw error;
        throw new ServerProfilesPersistenceError();
    }
    // Invalidate rather than prime: the next read re-parses so the parse path stays the
    // single canonicalization owner for cached state shapes.
    persistedStateParseCache = null;
}

/**
 * A read may project a supported legacy/corrupt payload into the canonical
 * in-memory shape, but reads themselves stay side-effect free. When a
 * successful explicit mutation is otherwise a semantic no-op, persist that
 * projection here while the caller still owns the browser-wide mutation lock.
 */
function persistCanonicalStateAfterNoop(state: Required<PersistedServerState>): void {
    const serialized = serializePersistedState(state);
    if (getPersistedStateStorage().getString(STATE_KEY) === serialized) {
        persistedStateParseCache = { raw: serialized, state };
        return;
    }
    writePersistedState(state);
}

export function loadHomeViewState(): HomeViewStateV1 | null {
    return readPersistedState().homeViewState;
}

/**
 * Returns the effective Home view for this runtime. Group definitions always come
 * from device-global state; only the active target may be overridden by a web tab.
 */
export function saveHomeViewState(state: HomeViewStateV1): Promise<void> {
    const parsed = parseHomeViewState(state);
    if (!parsed) throw new Error('invalid Home view state');
    return withPersistedStateMutation(() => {
        const current = readPersistedState();
        const normalized = normalizeHomeViewStateAgainstProfiles(parsed, current.servers, current.activeServerId);
        if (JSON.stringify(current.homeViewState) === JSON.stringify(normalized) && current.homeViewStateInitialized) {
            persistCanonicalStateAfterNoop(current);
            return;
        }
        // Any save is itself initialization evidence: write the marker so the legacy
        // one-time scoped migration can never re-run over this store.
        writePersistedState({ ...current, homeViewState: normalized, homeViewStateInitialized: true });
        emitHomeViewStateChanged();
    });
}

export function updateHomeViewState(
    update: (current: HomeViewStateV1) => HomeViewStateV1,
): Promise<HomeViewStateV1> {
    return withPersistedStateMutation(() => {
        const persisted = readPersistedState();
        const current = persisted.homeViewState ?? {
            version: 1,
            groups: [],
            activeTargetKind: null,
            activeTargetId: null,
        };
        const parsed = parseHomeViewState(update(current));
        if (!parsed) throw new Error('invalid Home view state');
        const normalized = normalizeHomeViewStateAgainstProfiles(parsed, persisted.servers, persisted.activeServerId);
        if (JSON.stringify(persisted.homeViewState) !== JSON.stringify(normalized) || !persisted.homeViewStateInitialized) {
            writePersistedState({ ...persisted, homeViewState: normalized, homeViewStateInitialized: true });
            emitHomeViewStateChanged();
        } else {
            persistCanonicalStateAfterNoop(persisted);
        }
        return normalized;
    });
}

export function subscribeHomeViewState(listener: () => void): () => void {
    homeViewStateListeners.add(listener);
    ensureWebPersistedStateObserver();
    return () => {
        homeViewStateListeners.delete(listener);
    };
}

/** One-time migration from focused account settings into device-global server state. */
export function migrateHomeViewStateFromSettings(settings: Readonly<Record<string, unknown>>): Promise<HomeViewStateV1 | null> {
    return withPersistedStateMutation(() => {
        const current = readPersistedState();
        if (current.homeViewState) {
            persistCanonicalStateAfterNoop(current);
            return current.homeViewState;
        }
        const state = normalizeHomeViewStateAgainstProfiles({
            version: 1,
            groups: normalizeStoredServerSelectionGroups(settings.serverSelectionGroups),
            activeTargetKind:
                settings.serverSelectionActiveTargetKind === 'server' || settings.serverSelectionActiveTargetKind === 'group'
                    ? settings.serverSelectionActiveTargetKind : null,
            activeTargetId:
                typeof settings.serverSelectionActiveTargetId === 'string' && settings.serverSelectionActiveTargetId.trim()
                    ? settings.serverSelectionActiveTargetId.trim() : null,
        }, current.servers, current.activeServerId);
        writePersistedState({ ...current, homeViewState: state, homeViewStateInitialized: true });
        emitHomeViewStateChanged();
        return state;
    });
}

function readTabActiveServerId(): string | null {
    if (isEmbedWindowContext()) return null;
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
    if (isEmbedWindowContext()) return;
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
    // The desktop app's page is its own bundle (http://tauri.localhost on Windows, the devUrl in
    // `tauri dev`), never a relay, so its origin is neither a profile nor this computer's local relay.
    if (!isWebRuntime() || isDesktopHost()) return null;
    const origin = (globalThis as any).window?.location?.origin;
    if (!origin || origin === 'null') return null;
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        // Official hosted web apps are static SPAs; the API lives on api.happier.dev.
        // When builds are missing EXPO_PUBLIC_HAPPIER_SERVER_URL (and legacy aliases), this prevents the default server
        // from incorrectly pointing at the web host.
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === 'cloud.happier.dev' || hostname === 'app.happier.dev') {
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
    const selectedId = tabProfile
        ? tabProfile.id
        : resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    const selected = selectedId ? state.servers[selectedId] : null;
    const sameOriginUrl = getWebSameOriginServerUrl();
    // Navigating to a Home's own web UI names that Home, just as ?server= does.
    // Static Cloud/Metro and desktop bundle origins are not serving Homes.
    // This is ephemeral entry context; it does not persist another selection.
    const servingHomeSelected = sameOriginUrl !== null
        && comparableUrlKey(sameOriginUrl) === comparableUrlKey(window.location.origin)
        && comparableUrlKey(sameOriginUrl) === comparableUrlKey(selected?.canonicalServerUrl ?? selected?.serverUrl ?? '');
    const isSelectionExplicit = tabExplicit || state.activeServerIdIsExplicit === true || servingHomeSelected;

    if (selected) {
        const runtimeLease = activeRuntimeOriginLease?.target.serverId === resolveServerProfileScopeId(selected)
            && activeRuntimeOriginLease.target.generation === activeRuntimeTargetGeneration
            ? activeRuntimeOriginLease
            : null;
        return {
            serverId: resolveServerProfileScopeId(selected),
            serverUrl: selected.canonicalServerUrl ?? selected.serverUrl,
            activeShareableServerUrl: selected.shareableServerUrl ?? null,
            activeShareableServerUrlValidatedAgainstServerUrl: selected.shareableServerUrlValidatedAgainstServerUrl ?? null,
            activeLocalRelayUrl: sameOriginUrl && comparableUrlKey(sameOriginUrl) !== comparableUrlKey(selected.serverUrl)
                ? sameOriginUrl
                : null,
            isSelectionExplicit,
            ...(selected.homeConnectionDescriptor === undefined
                ? {}
                : { connectionDescriptorRevision: selected.homeConnectionDescriptor.revision }),
            ...(runtimeLease ? {
                ...(runtimeLease.runtimeOrigin ? { runtimeOrigin: runtimeLease.runtimeOrigin } : {}),
                carrier: runtimeLease.carrier,
            } : {}),
            generation: activeServerGeneration,
        };
    }

    return {
        serverId: selectedId || '',
        serverUrl: sameOriginUrl ?? '',
        activeShareableServerUrl: null,
        activeShareableServerUrlValidatedAgainstServerUrl: null,
        activeLocalRelayUrl: sameOriginUrl,
        isSelectionExplicit,
        generation: activeServerGeneration,
    };
}

/** Capture the focused Home basis to which a native runtime-origin lease may publish. */
export function captureActiveServerRuntimeTarget(): ActiveServerRuntimeTarget {
    return {
        serverId: getActiveServerSnapshot().serverId,
        generation: activeRuntimeTargetGeneration,
    };
}

/**
 * Publish only for the still-focused Home and make the acquiring lease the
 * clearing authority. Exactly one transport form is published: a `runtimeOrigin`
 * a request can be addressed to, or a `homeCarrier` that moves the bytes itself.
 */
export function publishActiveServerRuntimeOrigin(params: Readonly<{
    target: ActiveServerRuntimeTarget;
    leaseId: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    carrier: 'https' | 'iroh';
}>): boolean {
    const runtimeOrigin = String(params.runtimeOrigin ?? '').trim();
    const homeCarrier = params.homeCarrier ?? null;
    const leaseId = params.leaseId.trim();
    const current = captureActiveServerRuntimeTarget();
    // A semantic carrier is Iroh-only: HTTPS is addressable by definition, and a
    // publication naming both forms would leave two transports for one Home.
    const publishesExactlyOneTransport = runtimeOrigin.length > 0 !== (homeCarrier !== null);
    if (
        !publishesExactlyOneTransport
        || (homeCarrier !== null && params.carrier !== 'iroh')
        || !leaseId
        || current.serverId !== params.target.serverId
        || current.generation !== params.target.generation
    ) {
        return false;
    }
    activeRuntimeOriginLease = {
        target: params.target,
        leaseId,
        runtimeOrigin: runtimeOrigin || null,
        homeCarrier,
        carrier: params.carrier,
    };
    activeServerSnapshotCache = null;
    const snapshot = getActiveServerSnapshot();
    notifyIndependentListeners(activeServerListeners, [snapshot], 'active_server_changed');
    notifyIndependentListeners(runtimeOriginListeners, [snapshot], 'runtime_origin_changed');
    return true;
}

/** Clear only the runtime origin still owned by this focused-Home lease. */
export function releaseActiveServerRuntimeOrigin(params: Readonly<{
    target: ActiveServerRuntimeTarget;
    leaseId: string;
}>): boolean {
    const owner = activeRuntimeOriginLease;
    if (
        !owner
        || owner.leaseId !== params.leaseId
        || owner.target.serverId !== params.target.serverId
        || owner.target.generation !== params.target.generation
    ) {
        return false;
    }
    activeRuntimeOriginLease = null;
    activeServerSnapshotCache = null;
    const snapshot = getActiveServerSnapshot();
    notifyIndependentListeners(activeServerListeners, [snapshot], 'active_server_changed');
    notifyIndependentListeners(runtimeOriginListeners, [snapshot], 'runtime_origin_changed');
    return true;
}

/**
 * The semantic carrier owned by the current focused-Home publication, if any.
 * It is read alongside the snapshot rather than embedded in it: the snapshot is
 * a compared, cached, logged value, and a carrier is a live handle.
 */
export function getActiveServerHomeCarrier(): HomeCarrier | null {
    const lease = activeRuntimeOriginLease;
    if (!lease || lease.homeCarrier === null) return null;
    const current = captureActiveServerRuntimeTarget();
    return current.serverId === lease.target.serverId && current.generation === lease.target.generation
        ? lease.homeCarrier
        : null;
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
        && (cached.connectionDescriptorRevision ?? null) === (next.connectionDescriptorRevision ?? null)
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
    const targetChanged = Boolean(
        previous
        && (
            previous.serverId !== next.serverId
            || previous.serverUrl !== next.serverUrl
            || (previous.connectionDescriptorRevision ?? null) !== (next.connectionDescriptorRevision ?? null)
        )
    );
    const invalidateRuntimeOrigin = targetChanged;
    // A runtime origin belongs to one focused Home generation. Never carry an ephemeral
    // loopback listener across an active-profile/descriptor change; the native
    // lease is reacquired and publishes against the next authoritative generation.
    if (invalidateRuntimeOrigin) {
        activeRuntimeTargetGeneration += 1;
        activeRuntimeOriginLease = null;
        activeServerSnapshotCache = null;
        next = getActiveServerSnapshot();
    }
    const materiallyChanged = !previous
        || previous.serverId !== next.serverId
        || previous.serverUrl !== next.serverUrl
        || (previous.activeShareableServerUrl ?? null) !== (next.activeShareableServerUrl ?? null)
        || (previous.activeShareableServerUrlValidatedAgainstServerUrl ?? null) !== (next.activeShareableServerUrlValidatedAgainstServerUrl ?? null)
        || (previous.activeLocalRelayUrl ?? null) !== (next.activeLocalRelayUrl ?? null)
        || (previous.connectionDescriptorRevision ?? null) !== (next.connectionDescriptorRevision ?? null)
        || (previous.isSelectionExplicit ?? null) !== (next.isSelectionExplicit ?? null)
        || invalidateRuntimeOrigin;
    if (!materiallyChanged && !options.force) return;
    activeServerGeneration += 1;
    const emitted: ActiveServerSnapshot = getStableActiveServerSnapshot({ ...next, generation: activeServerGeneration });
    notifyIndependentListeners(activeServerListeners, [emitted], 'active_server_changed');
}

export function listServerProfiles(): ServerProfile[] {
    return Object.values(readPersistedState().servers);
}

export type SavedServerProfileUrlResolution =
    | Readonly<{ kind: 'resolved'; profile: ServerProfile }>
    | Readonly<{ kind: 'missing' | 'ambiguous' }>;

/** URL-only intents may select a saved Home only when that address names exactly one profile. */
export function resolveSavedServerProfileByUrl(
    serverUrl: string,
    options: Readonly<{ includeCanonicalServerUrl?: boolean }> = {},
): SavedServerProfileUrlResolution {
    const targetKey = comparableUrlKey(serverUrl);
    if (!targetKey) return { kind: 'missing' };
    const matches = listServerProfiles().filter((profile) => (
        comparableUrlKey(profile.serverUrl) === targetKey
        || (options.includeCanonicalServerUrl === true && comparableUrlKey(profile.canonicalServerUrl ?? '') === targetKey)
    ));
    if (matches.length === 0) return { kind: 'missing' };
    if (matches.length > 1) return { kind: 'ambiguous' };
    return { kind: 'resolved', profile: matches[0]! };
}

export function resolveUniqueServerProfileByUrl(
    serverUrl: string,
    options: Readonly<{ includeCanonicalServerUrl?: boolean }> = {},
): ServerProfile | null {
    const resolution = resolveSavedServerProfileByUrl(serverUrl, options);
    return resolution.kind === 'resolved' ? resolution.profile : null;
}

export function getServerProfilesGeneration(): number {
    return serverProfilesGeneration;
}

export function subscribeServerProfiles(listener: (generation: number) => void): () => void {
    serverProfilesListeners.add(listener);
    ensureWebPersistedStateObserver();
    return () => {
        serverProfilesListeners.delete(listener);
    };
}

const accountServiceEndpointListeners = new Set<(endpoint: AccountServiceEndpointV1 | null) => void>();

/**
 * Owner-defined selected sign-in service used until the user explicitly selects another one.
 * Frozen and shared so `resolveSelectedAccountServiceEndpoint()` stays referentially stable for
 * `useSyncExternalStore` consumers.
 */
export const DEFAULT_ACCOUNT_SERVICE_ENDPOINT: AccountServiceEndpointV1 = Object.freeze({
    url: HAPPIER_CLOUD_SERVER_URL,
    displayName: 'Happier Cloud',
    source: 'default',
});

export function getAccountServiceEndpointSnapshot(): AccountServiceEndpointV1 | null {
    return readPersistedState().accountServiceEndpoint ?? null;
}

/**
 * The selected sign-in service, which exists before any Home profile or focused Home. This is a
 * pure selection read: it never creates a `ServerProfile`, group member, or Home runtime.
 */
export function resolveSelectedAccountServiceEndpoint(): AccountServiceEndpointV1 {
    return getAccountServiceEndpointSnapshot() ?? DEFAULT_ACCOUNT_SERVICE_ENDPOINT;
}

export function subscribeAccountServiceEndpoint(listener: (endpoint: AccountServiceEndpointV1 | null) => void): () => void {
    accountServiceEndpointListeners.add(listener);
    ensureWebPersistedStateObserver();
    return () => accountServiceEndpointListeners.delete(listener);
}

export function setAccountServiceEndpoint(endpoint: AccountServiceEndpointV1): Promise<void> {
    const parsed = parseAccountServiceEndpoint(endpoint);
    if (!parsed) throw new Error('Invalid Account Service endpoint');
    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        writePersistedState({ ...state, accountServiceEndpoint: parsed });
        notifyIndependentListeners(accountServiceEndpointListeners, [parsed], 'account_service_endpoint_changed');
    });
}

/**
 * Returns the exact server-published outer descriptor retained by the profile owner.
 * Shareable QR/link producers must not synthesize endpoint membership or revisions from
 * profile scalars: absence means the server has not published an exact shareable descriptor.
 */
export function buildHomeConnectionDescriptorForProfile(profile: ServerProfile): HomeConnectionDescriptorV1 | null {
    if (profile.descriptorProvenance === 'advisory-only') return null;
    const parsed = HomeConnectionDescriptorV1Schema.safeParse(profile.homeConnectionDescriptor);
    return parsed.success ? parsed.data : null;
}

/**
 * Explicit descriptor provenance states at this canonical profile owner. Callers must
 * declare authority here rather than inferring it from descriptor revision or source name.
 */
export type HomeProfileDescriptorAuthority =
    | 'advisory'
    | 'current_connection_observation';

type HomeProfileAdoptionParams = Readonly<{
    descriptor: HomeConnectionDescriptorV1 | LegacyManualHomeDescriptor;
    source: ServerProfileSource;
    preserveUserLabel?: boolean;
    preserveProfileSource?: boolean;
    descriptorAuthority?: HomeProfileDescriptorAuthority;
    suggestedName?: string;
}>;

export type HomeProfileAdoptionPreflight = Readonly<{
    canonicalServerUrl: string;
    serverIdentityId: string | null;
    /**
     * Advisory discovery may authenticate a signed-out, already-established Home,
     * but it must not replace an established credential. An unknown/advisory-only
     * Home first requires a current identity-bound observation.
     */
    credentialWrite: 'required' | 'preserveExisting' | 'requiresCurrentObservation';
}>;

export type HomeConnectionDescriptorReconciliationResult =
    | Readonly<{ kind: 'applied' | 'unchanged' | 'stale'; profile: ServerProfile }>
    | Readonly<{
        kind: 'conflict';
        code: 'invalid_descriptor' | 'identity_mismatch' | 'profile_missing' | 'equal_revision_conflict';
        profile: ServerProfile | null;
    }>;

export type HomeProfileAdoptionConflictCode = 'equal_revision_conflict';

export class HomeProfileAdoptionConflictError extends Error {
    readonly code: HomeProfileAdoptionConflictCode;

    constructor(code: HomeProfileAdoptionConflictCode) {
        super('Home connection descriptor conflicts with the persisted revision');
        this.name = 'HomeProfileAdoptionConflictError';
        this.code = code;
    }
}

function descriptorSnapshotMatchesProfile(
    descriptor: HomeConnectionDescriptorV1,
    profile: ServerProfile,
): boolean {
    return profile.homeConnectionDescriptor !== undefined
        && JSON.stringify(descriptor) === JSON.stringify(profile.homeConnectionDescriptor);
}

type DescriptorRevisionAdjudication =
    | 'apply'
    | 'unchanged'
    | 'stale'
    | 'equal_revision_conflict';

function adjudicateDescriptorRevision(
    descriptor: HomeConnectionDescriptorV1,
    profile: ServerProfile,
): DescriptorRevisionAdjudication {
    const currentRevision = profile.homeConnectionDescriptor?.revision;
    if (currentRevision === undefined || descriptor.revision > currentRevision) return 'apply';
    if (descriptor.revision < currentRevision) return 'stale';
    return descriptorSnapshotMatchesProfile(descriptor, profile)
        ? 'unchanged'
        : 'equal_revision_conflict';
}

/**
 * Reconciles the exact descriptor published by a Home after the ordinary
 * feature probe has established that Home's server identity. Profile storage,
 * focus, grouping, labels, and runtime invalidation remain owned here; callers
 * only supply the observed identity and snapshot.
 */
function reconcileServerProfileHomeConnectionDescriptorUnlocked(params: Readonly<{
    serverUrl: string;
    observedServerIdentityId: string;
    descriptor: HomeConnectionDescriptorV1;
    observation?: 'exact' | 'public';
}>): HomeConnectionDescriptorReconciliationResult {
    const parsed = HomeConnectionDescriptorV1Schema.safeParse(params.descriptor);
    const observedIdentity = normalizeServerIdentityId(params.observedServerIdentityId);
    const state = readPersistedState();
    const profile = findProfileByEquivalentUrl(state.servers, normalizeUrl(params.serverUrl))
        ?? (observedIdentity ? findProfileByServerIdentifier(state.servers, observedIdentity) : null);
    if (!parsed.success) {
        return { kind: 'conflict', code: 'invalid_descriptor', profile };
    }
    const descriptor = parsed.data;
    if (!observedIdentity || descriptor.homeServerIdentityId !== observedIdentity) {
        return { kind: 'conflict', code: 'identity_mismatch', profile };
    }
    if (!profile) {
        return { kind: 'conflict', code: 'profile_missing', profile: null };
    }
    if (profile.serverIdentityId !== observedIdentity) {
        return { kind: 'conflict', code: 'identity_mismatch', profile };
    }
    if (params.observation === 'public') {
        // Public features are first-contact verification only. A redacted public
        // projection can never establish or replace an exact outer generation.
        return descriptor.revision < (profile.homeConnectionDescriptor?.revision ?? 0)
            ? { kind: 'stale', profile }
            : { kind: 'unchanged', profile };
    }

    // Observation authority establishes an advisory-only placeholder wholesale; the
    // Directory-authored revision can never make the Home's own descriptor stale.
    if (profile.descriptorProvenance !== 'advisory-only') {
        const adjudication = adjudicateDescriptorRevision(descriptor, profile);
        if (adjudication === 'stale') return { kind: 'stale', profile };
        if (adjudication === 'unchanged') return { kind: 'unchanged', profile };
        if (adjudication === 'equal_revision_conflict') {
            return { kind: 'conflict', code: 'equal_revision_conflict', profile };
        }
    }

    const updated = adoptHomeProfileWithOptionsUnlocked({
        descriptor,
        source: profile.source ?? 'manual',
        preserveUserLabel: true,
        preserveProfileSource: true,
        descriptorAuthority: 'current_connection_observation',
    });
    return { kind: 'applied', profile: updated };
}

export async function reconcileServerProfileHomeConnectionDescriptor(params: Readonly<{
    serverUrl: string;
    observedServerIdentityId: string;
    descriptor: HomeConnectionDescriptorV1;
    observation?: 'exact' | 'public';
}>): Promise<HomeConnectionDescriptorReconciliationResult> {
    return await withPersistedStateMutation(() => {
        const result = reconcileServerProfileHomeConnectionDescriptorUnlocked(params);
        if (result.kind === 'unchanged' || result.kind === 'stale') {
            persistCanonicalStateAfterNoop(readPersistedState());
        }
        return result;
    });
}

type ResolvedHomeProfileAdoption = Readonly<{
    descriptor: HomeConnectionDescriptorV1 | LegacyManualHomeDescriptor;
    canonicalServerUrl: string;
    serverIdentityId: string | null;
    state: Required<PersistedServerState>;
    existing: ServerProfile | null;
    descriptorAdjudication: DescriptorRevisionAdjudication | null;
}>;

function resolveHomeProfileAdoption(
    params: HomeProfileAdoptionParams,
): ResolvedHomeProfileAdoption {
    if (
        params.descriptorAuthority !== undefined
        && params.descriptorAuthority !== 'advisory'
        && params.descriptorAuthority !== 'current_connection_observation'
    ) {
        throw new Error('Invalid Home descriptor authority');
    }
    let descriptor = params.descriptor;
    if (!descriptor || typeof descriptor !== 'object') {
        throw new Error('Invalid Home connection descriptor');
    }
    const strictDescriptor = params.source === 'qr' || params.source === 'account-directory'
        || 'endpoints' in descriptor || 'revision' in descriptor || 'v' in descriptor;
    if (strictDescriptor) {
        const parsed = HomeConnectionDescriptorV1Schema.safeParse(descriptor);
        if (!parsed.success) throw new Error('Invalid Home connection descriptor');
        descriptor = parsed.data;
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
    const byUrlProfiles = findProfilesByEquivalentUrl(state.servers, normalizeUrl(descriptor.canonicalServerUrl ?? url));
    const byUrl = byUrlProfiles[0] ?? null;
    if (identity && byIdentity.length > 1) throw new Error('Ambiguous Home identity');
    if (identity && byUrlProfiles.some((profile) => (
        (profile.serverIdentityId && profile.serverIdentityId !== identity)
        || (byIdentity.length === 1 && profile.id !== byIdentity[0]!.id)
    ))) throw new Error('Home identity conflicts with URL');
    const existing = byIdentity[0] ?? byUrl;
    const parsedCanonicalDescriptor = HomeConnectionDescriptorV1Schema.safeParse(descriptor);
    if (
        existing?.homeConnectionDescriptor
        && !parsedCanonicalDescriptor.success
        && comparableUrlKey(url) !== comparableUrlKey(existing.homeConnectionDescriptor.canonicalServerUrl)
    ) {
        throw new Error('Exact Home descriptor is required to change this Home connection');
    }
    let descriptorAdjudication: DescriptorRevisionAdjudication | null;
    if (parsedCanonicalDescriptor.success && existing) {
        if (params.descriptorAuthority === 'advisory') {
            // Advisory Directory data never retargets an existing Home profile.
            descriptorAdjudication = 'unchanged';
        } else if (existing.descriptorProvenance === 'advisory-only') {
            // Any Home/user authority outranks advisory-authored placeholder facts: a
            // Directory revision can never block the authority that establishes the Home.
            descriptorAdjudication = 'apply';
        } else {
            // current_connection_observation and the established default retain the
            // existing revision-adjudicated reconciliation authority.
            descriptorAdjudication = adjudicateDescriptorRevision(parsedCanonicalDescriptor.data, existing);
        }
    } else {
        descriptorAdjudication = parsedCanonicalDescriptor.success ? 'apply' : null;
    }
    if (descriptorAdjudication === 'equal_revision_conflict') {
        throw new HomeProfileAdoptionConflictError('equal_revision_conflict');
    }
    return {
        descriptor,
        canonicalServerUrl: url,
        serverIdentityId: identity,
        state,
        existing,
        descriptorAdjudication,
    };
}

/**
 * Read-only adoption validation for authority-bearing callers that must verify
 * the exact Home target before an asynchronous credential write. The mutating
 * owner reuses the same resolver and therefore revalidates before persistence.
 */
export function preflightHomeProfileAdoption(
    params: HomeProfileAdoptionParams,
): HomeProfileAdoptionPreflight {
    const resolved = resolveHomeProfileAdoption(params);
    const existingEstablished = resolved.existing !== null
        && resolved.existing.descriptorProvenance !== 'advisory-only';
    const preserveExisting = existingEstablished
        && params.descriptorAuthority === 'advisory';
    const requiresCurrentObservation = !existingEstablished
        && params.descriptorAuthority === 'advisory';
    const existingServerUrl = resolved.existing
        ? normalizeUrl(resolved.existing.canonicalServerUrl ?? resolved.existing.serverUrl)
        : resolved.canonicalServerUrl;
    return {
        canonicalServerUrl: resolved.existing?.descriptorProvenance === 'advisory-only'
            ? existingServerUrl
            : (preserveExisting ? existingServerUrl : resolved.canonicalServerUrl),
        serverIdentityId: resolved.serverIdentityId,
        credentialWrite: requiresCurrentObservation
            ? 'requiresCurrentObservation'
            : preserveExisting
                ? 'preserveExisting'
                : 'required',
    };
}

function adoptHomeProfileWithOptionsUnlocked(
    params: HomeProfileAdoptionParams,
    options: Readonly<{ completePersonalHomeBootstrap?: true }> = {},
): ServerProfile {
    const {
        descriptor,
        canonicalServerUrl: url,
        serverIdentityId: identity,
        state,
        existing,
        descriptorAdjudication,
    } = resolveHomeProfileAdoption(params);
    const displayNameRaw = ('displayName' in descriptor ? descriptor.displayName : undefined)
        ?? params.suggestedName;
    const displayName = typeof displayNameRaw === 'string' && displayNameRaw.trim()
        ? displayNameRaw.trim()
        : undefined;
    const profile = existing ?? buildUpsertedServerProfile(state, {
        serverUrl: url,
        name: displayName,
        source: params.source,
        replaceEquivalentStoredUrl: true,
    });
    // The exact outer descriptor is the only persisted transport snapshot.
    // Endpoint selection and revision projection read it directly; manual URL
    // adoption cannot invent a partial descriptor generation.
    const descriptorEndpoints = 'endpoints' in descriptor ? descriptor.endpoints : undefined;
    const adoptedPublicEndpoint = descriptorEndpoints?.find((endpoint) => endpoint.kind === 'https');
    if (
        (descriptorAdjudication === 'unchanged' || descriptorAdjudication === 'stale')
        && options.completePersonalHomeBootstrap !== true
    ) {
        persistCanonicalStateAfterNoop(state);
        return profile;
    }
    if (options.completePersonalHomeBootstrap === true && !identity) {
        throw new Error('Personal Home bootstrap completion requires a stable Home identity');
    }
    // Revisioned descriptor snapshots are monotonic at this single writer. Only
    // a strictly newer generation may replace snapshot-owned identity/transport
    // facts; equal is idempotent and lower is stale. Revision-less manual/legacy
    // adoption retains its established classification behavior but has no
    // authority over persisted revisioned transport facts.
    const acceptsDescriptorSnapshot = descriptorAdjudication === null || descriptorAdjudication === 'apply';
    const transportFacts = 'endpoints' in descriptor && acceptsDescriptorSnapshot
        ? { homeConnectionDescriptor: descriptor }
        : {};
    const publicEndpointFacts = 'endpoints' in descriptor
        ? acceptsDescriptorSnapshot
            ? { publicServerUrl: adoptedPublicEndpoint ? normalizeUrl(adoptedPublicEndpoint.url) : null }
            : {}
        : profile.homeConnectionDescriptor
            ? {}
            : 'publicServerUrl' in descriptor && descriptor.publicServerUrl === null
                ? { publicServerUrl: null }
                : 'publicServerUrl' in descriptor && descriptor.publicServerUrl
                    ? { publicServerUrl: normalizeUrl(descriptor.publicServerUrl) }
                    : {};
    const updated: ServerProfile = {
        ...profile,
        // Adoption source is mutable provenance. Durable managed-Home readiness lives
        // on the identity-bound completion scalar preserved by the profile itself.
        ...(acceptsDescriptorSnapshot
            ? {
                source: profile.legacySource
                    ? 'legacy'
                    : params.preserveProfileSource
                        ? profile.source
                        : params.source,
                legacySource: profile.legacySource,
                ...(existing ? { serverUrl: url } : {}),
                ...((!existing || !params.preserveUserLabel) && displayName
                    ? { name: displayName }
                    : {}),
                ...(identity ? { serverIdentityId: identity } : {}),
                ...(descriptor.canonicalServerUrl ? { canonicalServerUrl: normalizeUrl(descriptor.canonicalServerUrl) } : {}),
            }
            : {}),
        ...publicEndpointFacts,
        ...transportFacts,
        // Provenance marker: advisory authority minting a fresh placeholder records it;
        // any establishing authority (created or upgraded) clears it.
        descriptorProvenance: params.descriptorAuthority === 'advisory'
            ? (existing ? profile.descriptorProvenance : 'advisory-only')
            : undefined,
        ...(options.completePersonalHomeBootstrap === true
            ? { personalHomeBootstrapCompleted: true as const }
            : {}),
    };
    if (!existing || JSON.stringify(updated) !== JSON.stringify(profile)) {
        const previousSnapshot = getActiveServerSnapshot();
        const next = { ...state, servers: { ...state.servers, [updated.id]: updated } };
        writePersistedState(next);
        emitServerProfilesChanged();
        emitActiveServerChanged(previousSnapshot);
    }
    return updated;
}

export async function adoptHomeProfile(params: HomeProfileAdoptionParams): Promise<ServerProfile> {
    return await withPersistedStateMutation(() => adoptHomeProfileWithOptionsUnlocked(params));
}

/** Used only by a composition that already owns the shared Home mutation authority. */
export async function adoptHomeProfileUnderMutationAuthority(
    params: HomeProfileAdoptionParams,
    authority: HomeMutationAuthority,
): Promise<ServerProfile> {
    return await withPersistedStateMutation(
        () => adoptHomeProfileWithOptionsUnlocked(params),
        authority,
    );
}

/**
 * Commits the verified Personal Home identity, mutable adoption provenance, and
 * durable completion scalar through the profile owner's one persistence mutation.
 * Callers must reach this operation only after their live refusal/authenticated
 * readback checks; this owner binds the receipt to the descriptor's stable identity.
 */
export async function adoptPersonalHomeProfileAndComplete(
    params: Omit<HomeProfileAdoptionParams, 'source'> & Readonly<{
        source: 'desktop-personal-home';
    }>,
): Promise<ServerProfile> {
    return await withPersistedStateMutation(() => (
        adoptHomeProfileWithOptionsUnlocked(params, { completePersonalHomeBootstrap: true })
    ));
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

type UpsertServerProfileParams = Readonly<{
    serverUrl: string;
    name?: string;
    source?: ServerProfileSource;
    replaceEquivalentStoredUrl?: boolean;
}>;

function buildUpsertedServerProfile(
    state: Required<PersistedServerState>,
    params: UpsertServerProfileParams,
): ServerProfile {
    const url = normalizeUrl(params.serverUrl);
    if (!url) throw new Error('serverUrl is required');

    const existingEquivalent = findProfileByEquivalentUrl(state.servers, url);
    const id = existingEquivalent?.id
        ?? createUniqueServerId(state.servers, deriveServerIdFromUrl(url), url);
    const existing = state.servers[id];
    const now = nowMs();
    const descriptorSource = existingEquivalent?.homeConnectionDescriptor
        ? existingEquivalent
        : existing?.homeConnectionDescriptor
            ? existing
            : null;

    const profile: ServerProfile = {
        id,
        name: String(
            existingEquivalent?.name
            ?? params.name
            ?? existing?.name
            ?? defaultHomeNameForAddress(url)
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
        ...copyHomeConnectionDescriptorFacts(descriptorSource),
        ...((existingEquivalent?.legacyServerIds ?? existing?.legacyServerIds)?.length
            ? { legacyServerIds: existingEquivalent?.legacyServerIds ?? existing?.legacyServerIds ?? [] }
            : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        source: params.source ?? existingEquivalent?.source ?? existing?.source ?? 'manual',
        ...(personalHomeBootstrapCompletionForIdentity(
            [existingEquivalent, existing].filter((value): value is ServerProfile => value != null),
            existingEquivalent?.serverIdentityId ?? existing?.serverIdentityId,
        ) ? { personalHomeBootstrapCompleted: true as const } : {}),
        ...(existing?.legacySource ? { legacySource: existing.legacySource } : {}),
    };

    return profile;
}

function upsertServerProfileUnlocked(params: UpsertServerProfileParams): ServerProfile {
    const state = readPersistedState();
    const profile = buildUpsertedServerProfile(state, params);

    const previousSnapshot = getActiveServerSnapshot();
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [profile.id]: profile,
        },
    });
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot);
    return profile;
}

export function upsertServerProfile(params: UpsertServerProfileParams): Promise<ServerProfile> {
    return withPersistedStateMutation(() => upsertServerProfileUnlocked(params));
}

export function getOrCreateHappierCloudServerProfile(): Promise<ServerProfile> {
    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        const existing = findProfileByEquivalentUrl(state.servers, HAPPIER_CLOUD_SERVER_URL);
        if (existing) {
            persistCanonicalStateAfterNoop(state);
            return existing;
        }

        return upsertServerProfileUnlocked({
            serverUrl: HAPPIER_CLOUD_SERVER_URL,
            name: 'Happier Cloud',
            source: 'preconfigured',
        });
    });
}

function setServerProfileIdentityForUrlUnlocked(serverUrlRaw: string, identityRaw: string | null | undefined): ServerProfile | null {
    const url = normalizeUrl(serverUrlRaw);
    const serverIdentityId = normalizeServerIdentityId(identityRaw);
    if (!url || !serverIdentityId) return null;

    const state = readPersistedState();
    const existing = findProfileByEquivalentUrl(state.servers, url);
    if (existing?.serverIdentityId && existing.serverIdentityId !== serverIdentityId) {
        return null;
    }
    // Public feature discovery may learn an identity only for the URL it
    // actually contacted. Once another profile owns that stable identity,
    // relocating it is an authoritative adoption transaction, not an
    // unauthenticated identity-learning merge.
    if (Object.values(state.servers).some((profile) => (
        profile.id !== existing?.id && profile.serverIdentityId === serverIdentityId
    ))) {
        return null;
    }
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
        persistCanonicalStateAfterNoop(state);
        return existing;
    }
    const id = existing?.id ?? createUniqueServerId(state.servers, deriveServerIdFromUrl(url), url);
    const now = nowMs();
    const profile: ServerProfile = {
        ...(existing ?? {}),
        id,
        name: existing?.name ?? defaultHomeNameForAddress(url) ?? id,
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

    const selectionRewrites = new Map(deduped.idRewrite);
    addProfileScopeIdentityRewrites(selectionRewrites, deduped.servers);
    const nextState: Required<PersistedServerState> = {
        ...state,
        activeServerId,
        servers: deduped.servers,
        homeViewState: rewriteHomeViewStateIdentity(state.homeViewState, selectionRewrites),
    };
    writePersistedState(nextState);
    if (nextState.homeViewState !== state.homeViewState) emitHomeViewStateChanged();
    emitServerProfilesChanged();
    emitActiveServerChanged(previousSnapshot);
    return findProfileByServerIdentifier(nextState.servers, serverIdentityId);
}

export function setServerProfileIdentityForUrl(
    serverUrlRaw: string,
    identityRaw: string | null | undefined,
): Promise<ServerProfile | null> {
    return withPersistedStateMutation(() => (
        setServerProfileIdentityForUrlUnlocked(serverUrlRaw, identityRaw)
    ));
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
): Promise<void> {
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    if (opts.scope === 'tab') {
        const state = readPersistedState();
        const profile = findProfileByServerIdentifier(state.servers, id);
        if (!profile) {
            const previousSnapshot = getActiveServerSnapshot();
            writeTabActiveServerId(null);
            emitActiveServerChanged(previousSnapshot, { force: true });
            return Promise.resolve();
        }
        const previousSnapshot = getActiveServerSnapshot();
        writeTabActiveServerId(profile.id);
        emitActiveServerChanged(previousSnapshot, { force: true });
        return Promise.resolve();
    }

    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        const profile = findProfileByServerIdentifier(state.servers, id);
        if (!profile) {
            persistCanonicalStateAfterNoop(state);
            return;
        }
        const previousSnapshot = getActiveServerSnapshot();
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
        emitServerProfilesChanged();
        emitActiveServerChanged(previousSnapshot, { force: true });
    });
}

/**
 * Makes a newly adopted local Home the implicit default only while no user-owned
 * device or tab selection exists. This is the one first-local activation policy;
 * ordinary profile adoption remains non-focusing.
 */
export function activateServerProfileIfSelectionImplicit(idRaw: string): Promise<boolean> {
    const id = normalizeServerId(idRaw);
    if (!id) return Promise.resolve(false);
    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        const profile = findProfileByServerIdentifier(state.servers, id);
        if (!profile || state.activeServerIdIsExplicit || findProfileByServerIdentifier(state.servers, readTabActiveServerId())) {
            persistCanonicalStateAfterNoop(state);
            return false;
        }
        if (state.activeServerId === profile.id) {
            persistCanonicalStateAfterNoop(state);
            return true;
        }

        const previousSnapshot = getActiveServerSnapshot();
        writePersistedState({
            ...state,
            activeServerId: profile.id,
            activeServerIdIsExplicit: false,
        });
        emitActiveServerChanged(previousSnapshot, { force: true });
        return true;
    });
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
    // Establish the comparison basis before the web storage observer can receive
    // its first cross-tab write. Subscription itself does not publish.
    getActiveServerSnapshot();
    activeServerListeners.add(listener);
    ensureWebPersistedStateObserver();
    return () => {
        activeServerListeners.delete(listener);
    };
}

export function removeServerProfile(idRaw: string): Promise<void> {
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        if (!(id in state.servers)) throw new Error(`Server profile not found: ${id}`);

        const previousSnapshot = getActiveServerSnapshot();
        const { [id]: removed, ...rest } = state.servers;
        const nextActive = state.activeServerId === id
            ? resolvePrimaryActiveServerId(rest, null)
            : resolvePrimaryActiveServerId(rest, state.activeServerId);
        const tab = readTabActiveServerId();
        if (tab === id) writeTabActiveServerId(null);

        const removedIds = new Set(uniqueServerIds([
            removed.id,
            removed.serverIdentityId,
            ...(removed.legacyServerIds ?? []),
        ]));
        const groups = (state.homeViewState?.groups ?? [])
            .map((group) => ({
                ...group,
                // Explicit removal owns pruning for this Home only. Other unresolved
                // scope IDs may represent profiles that have not been adopted yet.
                serverIds: group.serverIds.filter((serverId) => !removedIds.has(serverId)),
            }))
            .filter((group) => group.serverIds.length > 0);
        const removedWasActiveTarget = state.homeViewState?.activeTargetKind === 'server'
            && state.homeViewState.activeTargetId !== null
            && removedIds.has(state.homeViewState.activeTargetId);
        const fallbackTargetId = nextActive ? resolveServerProfileScopeId(rest[nextActive]!) : null;
        const nextHomeViewState = state.homeViewState
            ? normalizeHomeViewStateAgainstProfiles({
                ...state.homeViewState,
                groups,
                ...(removedWasActiveTarget
                    ? {
                        activeTargetKind: fallbackTargetId ? 'server' as const : null,
                        activeTargetId: fallbackTargetId,
                    }
                    : {}),
            }, rest, nextActive)
            : null;

        writePersistedState({
            ...state,
            activeServerId: nextActive,
            activeServerIdIsExplicit: true,
            servers: rest,
            homeViewState: nextHomeViewState,
        });
        for (const removedId of removedIds) retireIrohHomeTransportDiagnostics(removedId);
        if (nextHomeViewState !== state.homeViewState) emitHomeViewStateChanged();
        emitServerProfilesChanged();
        emitActiveServerChanged(previousSnapshot);
    });
}

export function setServerProfileShareableUrl(
    idRaw: string,
    shareableServerUrl: string | null | undefined,
    options: Readonly<{ validatedAgainstServerUrl?: string | null | undefined }> = {},
): Promise<void> {
    const id = normalizeServerId(idRaw);
    if (!id) return Promise.resolve();

    const normalized = sanitizeServerUrlForShareableLink(shareableServerUrl ?? null);
    const validatedAgainstServerUrl = normalized
        ? normalizeUrl(String(options.validatedAgainstServerUrl ?? '')) || null
        : null;
    return withPersistedStateMutation(() => {
        const state = readPersistedState();
        const existing = state.servers[id];
        if (!existing) {
            persistCanonicalStateAfterNoop(state);
            return;
        }
        if (
            (existing.shareableServerUrl ?? null) === normalized
            && (existing.shareableServerUrlValidatedAgainstServerUrl ?? null) === validatedAgainstServerUrl
        ) {
            persistCanonicalStateAfterNoop(state);
            return;
        }

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
        emitActiveServerChanged(previousSnapshot);
    });
}

/** Resets process-local profile caches between owner tests without reloading the module graph. */
export function resetServerProfilesRuntimeForTests(): void {
    activeServerGeneration = 0;
    activeRuntimeTargetGeneration = 0;
    activeServerSnapshotCache = null;
    activeRuntimeOriginLease = null;
    serverProfilesGeneration = 0;
    persistedStateStorage = null;
    persistedStateParseCache = null;
    demoPersistenceSuspendDepth = 0;
    durablePersistedStateStorageDuringDemo = null;
    activeServerListeners.clear();
    runtimeOriginListeners.clear();
    serverProfilesListeners.clear();
    homeViewStateListeners.clear();
    accountServiceEndpointListeners.clear();
}
