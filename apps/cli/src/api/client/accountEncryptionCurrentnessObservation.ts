import { createAccountEncryptionCurrentnessObservation, projectAccountEncryptionIdentity, sameAccountEncryptionIdentity,
    waitForAccountEncryptionObservation, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY, type ManagedConnectionSupervisor, type ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { fetchAccountEncryptionCurrentnessFromServer, AccountEncryptionCurrentnessUnavailableError } from './accountEncryptionCurrentness';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { logger } from '@/ui/logger';
import { DEFAULT_ACCOUNT_CHANGES_PAGE_LIMIT, fetchChanges } from '@/api/changes';
import { readSessionFollowChangeHintV1, readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { readConnectedServicesAccountChangeV1, readProviderAccountUsageRefreshRecordIdV1, readSessionFollowSourceChangedV1, readSessionFollowReceiverAvailabilityChangedV1 } from '@happier-dev/protocol/changes';
import { parseConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

export type RunFollowAvailability = Extract<RunFollowOriginalV1['source'], { kind: 'execution_run' }>
    | Readonly<{ kind: 'reconnected' }> | Readonly<{ kind: 'machine'; machineId: string }>;
export type RequesterSessionFollowRuleInvalidation = Readonly<{ full: true; continuityReset?: true }>;

type Scope = Readonly<{ accountId: string; token: string; serverBaseUrl: string; signal?: AbortSignal }>;
export type RequesterAccountSettingsObservation = Readonly<
    { kind: 'settings'; update: unknown } | { kind: 'hint'; version: unknown }
    | { kind: 'reconnected' } | { kind: 'disconnected' }
>;
export type RequesterConnectedAccountObservation = Readonly<{
    quotaRefreshRecordIds?: readonly string[];
    quotaRefreshOnly?: boolean;
    services?: readonly import('@happier-dev/protocol').QualifiedConnectedAccountRef['service'][];
    resetQuotaSchedule?: boolean;
}>;
/** Private invalidations over the existing Account cursor, never Session access authority. */
export type RequesterSessionInventoryObservation =
    | Readonly<{ kind: 'changes'; sessionIds: readonly string[]; reset: boolean }>
    | Readonly<{ kind: 'connected' | 'disconnected' | 'currentness' | 'unavailable' }>
    | Readonly<{ kind: 'activity'; id: string; active: boolean; activeAt: number }>;
type Observation = Readonly<{
    read(signal?: AbortSignal, options?: Readonly<{ requireLiveObservation?: true }>): Promise<AccountEncryptionIdentity>;
    isCurrent(expected: AccountEncryptionIdentity): boolean;
    subscribeAccountSettings(listener: (event: RequesterAccountSettingsObservation) => void): () => void;
    subscribeSessionFollowRules(listener: (change?: RequesterSessionFollowRuleInvalidation) => void): () => void;
    subscribeRunFollowAvailability(listener: (change: RunFollowAvailability) => void): () => void;
    subscribeConnectedAccounts(listener: (event: RequesterConnectedAccountObservation) => void): () => void;
    /** Exact Session invalidation; null rebuilds demanded ranges after a gap/reconnect. */
    subscribeSessionFollowSources(listener: (sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) => void): () => void;
    subscribeSessionInventory(listener: (event: RequesterSessionInventoryObservation) => void): () => void;
    dispose(): Promise<void>;
}>;
type SharedObservation = Observation & {
    scope: Readonly<{ accountId: string; serverBaseUrl: string }>;
    references: Map<string, { count: number }>;
    releaseCredential(token: string): Promise<void>;
};

// Only lifetimes with an authenticated Account/Home populate this map.
// It stores a fact, never credentials selected by Account id or invocation authorization.
const observations = new Map<string, SharedObservation>();
const scopeKey = (scope: Scope) => JSON.stringify([normalizeServerHttpBaseUrl(scope.serverBaseUrl), scope.accountId]);

function admittedObservation(scope: Readonly<{ accountId?: string; token: string; serverBaseUrl: string }>): SharedObservation | undefined {
    const accountId = scope.accountId ?? readAccountIdFromToken(scope.token);
    const candidate = accountId ? observations.get(scopeKey({ ...scope, accountId })) : undefined;
    if (candidate?.references.has(scope.token)) return candidate;
    if (scope.accountId !== undefined) return undefined;
    // Opaque credentials need no decoded subject: the authenticated holder
    // already registered this exact credential and Home. No second index.
    const serverBaseUrl = normalizeServerHttpBaseUrl(scope.serverBaseUrl);
    for (const observed of observations.values()) {
        if (observed.scope.serverBaseUrl === serverBaseUrl && observed.references.has(scope.token)) return observed;
    }
    return undefined;
}

async function readAdmittedObservation(observed: SharedObservation, scope: Readonly<{
    accountId?: string; token: string; serverBaseUrl: string; signal?: AbortSignal;
}>): Promise<AccountEncryptionIdentity> {
    const credentialReference = observed.references.get(scope.token);
    const identity = await observed.read(scope.signal);
    // A surviving peer (or a newly admitted reference for the same token)
    // cannot extend this borrower's captured credential-reference lifetime.
    if (scope.signal?.aborted) throw scope.signal.reason ?? new AccountEncryptionCurrentnessUnavailableError();
    if (!credentialReference || admittedObservation(scope) !== observed
        || observed.references.get(scope.token) !== credentialReference) {
        throw new AccountEncryptionCurrentnessUnavailableError();
    }
    return identity;
}

/** Only an authenticated live holder's exact credential can borrow the shared fact. */
export function readObservedAccountEncryptionCurrentness(scope: Readonly<{
    token: string; serverBaseUrl: string; signal?: AbortSignal;
}>): Promise<AccountEncryptionIdentity> | null {
    const observed = admittedObservation(scope);
    return observed ? readAdmittedObservation(observed, scope) : null;
}

export function sameRequesterAccountEncryptionCurrentness(a: AccountEncryptionIdentity, b: AccountEncryptionIdentity): boolean {
    return sameAccountEncryptionIdentity(a, b);
}

/** Encryption identity only; exact Account cursor/Settings witnesses still use fresh HTTP. */
export async function readRequesterAccountEncryptionCurrentness(scope: Readonly<{
    accountId?: string; token: string; serverBaseUrl?: string; signal?: AbortSignal;
    authorizationHeaders?: Readonly<Record<string, string>>;
}>): Promise<AccountEncryptionIdentity> {
    const serverBaseUrl = scope.serverBaseUrl ?? resolveServerHttpBaseUrl();
    const suppliedAuthorization = scope.authorizationHeaders
        ? Object.entries(scope.authorizationHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
        : null;
    // A signed Action request must retain its own fresh authenticated transport.
    const observed = !scope.authorizationHeaders || suppliedAuthorization === `Bearer ${scope.token}`
        ? admittedObservation({ ...scope, serverBaseUrl }) : undefined;
    return observed ? await readAdmittedObservation(observed, { ...scope, serverBaseUrl })
        : projectAccountEncryptionIdentity(await fetchAccountEncryptionCurrentnessFromServer({ ...scope, serverBaseUrl }));
}

/** A synchronous fence after distinct Machine/Home awaits, without another HTTP read. */
export function isRequesterAccountEncryptionCurrentnessObserved(scope: Scope, expected: AccountEncryptionIdentity): boolean {
    return !observations.has(scopeKey(scope)) || (admittedObservation(scope)?.isCurrent(expected) ?? false);
}

/** One exact Account/Home observation shared by live finite and Session custody. */
export function acquireRequesterAccountEncryptionCurrentness(scope: Scope): Observation {
    const key = scopeKey(scope);
    let shared = observations.get(key);
    if (!shared) {
        shared = createObservation(scope);
        observations.set(key, shared);
    }
    const credentialReferences = shared.references.get(scope.token) ?? { count: 0 };
    shared.references.set(scope.token, credentialReferences);
    credentialReferences.count++;
    const owned = shared;
    const retirement = new AbortController();
    let released = false;
    const subscriptions = new Set<() => void>();
    return {
        read: (signal, options) => released ? Promise.reject(new AccountEncryptionCurrentnessUnavailableError())
            : owned.read(signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal, options),
        isCurrent: expected => !released && owned.isCurrent(expected),
        subscribeAccountSettings(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeAccountSettings(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        subscribeSessionFollowRules(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeSessionFollowRules(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        subscribeRunFollowAvailability(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeRunFollowAvailability(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        subscribeSessionFollowSources(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeSessionFollowSources(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        subscribeSessionInventory(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeSessionInventory(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        subscribeConnectedAccounts(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeConnectedAccounts(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        async dispose() {
            if (released) return;
            released = true;
            retirement.abort();
            for (const release of subscriptions) release();
            subscriptions.clear();
            if (--credentialReferences.count === 0) owned.references.delete(scope.token);
            if (owned.references.size !== 0) {
                await owned.releaseCredential(scope.token);
                return;
            }
            observations.delete(key);
            await owned.dispose();
        },
    };
}

function createObservation(scope: Scope): SharedObservation {
    const references = new Map<string, { count: number }>();
    let activeToken = scope.token;
    let activeTransport: ManagedConnectionTransport | undefined;
    let connectionReady: Promise<void> | null = null;
    let stopping: Promise<void> | null = null;
    let lifetime = new AbortController();
    const retirement = new AbortController();
    let connected = false;
    let hasConnected = false;
    let disposed = false;
    let unsupported = false;
    const currentness = createAccountEncryptionCurrentnessObservation({
        accountId: scope.accountId,
        readFresh: signal => fetchAccountEncryptionCurrentnessFromServer({ token: activeToken,
            serverBaseUrl: scope.serverBaseUrl, signal }),
        unavailable: () => new AccountEncryptionCurrentnessUnavailableError(),
    });
    let supervisor: ManagedConnectionSupervisor | undefined;
    const settingsListeners = new Set<(event: RequesterAccountSettingsObservation) => void>();
    let settingsEvent: RequesterAccountSettingsObservation | null = null;
    const followListeners = new Set<(change?: RequesterSessionFollowRuleInvalidation) => void>();
    const runAvailabilityListeners = new Set<(change: RunFollowAvailability) => void>();
    const publishRunAvailability = (change: RunFollowAvailability) => {
        for (const listener of runAvailabilityListeners) listener(change);
    };
    const sourceListeners = new Set<(sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) => void>();
    const connectedAccountListeners = new Set<(event: RequesterConnectedAccountObservation) => void>();
    const inventoryListeners = new Set<(event: RequesterSessionInventoryObservation) => void>();
    const publishInventory = (event: RequesterSessionInventoryObservation) => {
        for (const listener of inventoryListeners) listener(event);
    };
    let followCursor = 0;
    let followCursorAcknowledged = false;
    let followSyncRequested = false;
    let followRequestedCursor: number | undefined;
    let followSyncPending: Promise<void> | null = null;
    const publishFollow = (continuityReset?: true) => {
        for (const listener of followListeners) listener({ full: true, ...(continuityReset ? { continuityReset } : {}) });
    };
    const publishSource = (sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) => {
        for (const listener of sourceListeners) listener(sourceSessionId, receiver, availabilityChanged, sourceChanged);
    };
    const publishConnectedAccounts = (event: RequesterConnectedAccountObservation) => {
        for (const listener of connectedAccountListeners) listener(event);
    };
    const hasFollowDemand = () => followListeners.size > 0 || sourceListeners.size > 0 || connectedAccountListeners.size > 0
        || inventoryListeners.size > 0;
    const publishSettings = (event: RequesterAccountSettingsObservation) => {
        settingsEvent = event;
        for (const listener of settingsListeners) listener(event);
    };
    const invalidate = () => { lifetime.abort(); lifetime = new AbortController(); followCursorAcknowledged = false; currentness.invalidate(); };
    // Classify the incumbent Account feed before invalidating private rules:
    // ordinary Session updates must not reload the rule corpus per occurrence.
    const syncFollowChanges = (requestedCursor?: number) => {
        if (disposed || !connected || !hasFollowDemand()) return;
        // The wake seq is the durable Account cursor, as in the Machine feed.
        // Unknown/lower cursors retain a full catch-up (including Home restores).
        const cursor = requestedCursor !== undefined && requestedCursor >= followCursor ? requestedCursor : undefined;
        if (followCursorAcknowledged && cursor === followCursor) return;
        followRequestedCursor = !followSyncRequested ? cursor
            : followRequestedCursor !== undefined && cursor !== undefined
                ? Math.max(followRequestedCursor, cursor) : undefined;
        followSyncRequested = true;
        if (followSyncPending) return;
        const captured = lifetime;
        const token = activeToken;
        const current = () => !disposed && connected && lifetime === captured && activeToken === token
            && references.has(token) && hasFollowDemand();
        const work = (async () => {
            while (followSyncRequested && current()) {
                // The in-flight response may have consumed every queued wake.
                // Keep the existing cursor as acknowledgment, not another read/cache.
                if (followCursorAcknowledged && followRequestedCursor !== undefined && followRequestedCursor <= followCursor) {
                    followSyncRequested = false;
                    followRequestedCursor = undefined;
                    break;
                }
                followSyncRequested = false;
                followRequestedCursor = undefined;
                const sessionIds = inventoryListeners.size ? new Set<string>() : null;
                let resetInventory = false;
                let inventoryUnavailable = false;
                let more = false;
                do {
                    followCursorAcknowledged = false;
                    const result = await runWithServerHttpBaseUrl(scope.serverBaseUrl, () => fetchChanges({
                        token, after: followCursor, signal: captured.signal,
                    }));
                    if (!current()) return;
                    if (result.status === 'ok') {
                        if (result.response.changes.some(change => change.kind === 'account'
                            && readSessionFollowChangeHintV1(change.hint) !== null)) publishFollow();
                        for (const change of result.response.changes) {
                            const receiver = readSessionFollowReceiverChangeV1(change);
                            if (receiver !== null) publishSource(receiver, true);
                            if (change.kind === 'session') {
                                const availabilityChanged = readSessionFollowReceiverAvailabilityChangedV1(change, followCursor);
                                const sourceChanged = readSessionFollowSourceChangedV1(change, followCursor);
                                // An older server can classify a metadata write as
                                // non-source without qualifying receiver availability.
                                // Preserve that distinction for bounded own-receiver recovery.
                                if (availabilityChanged !== false || sourceChanged) {
                                    publishSource(change.entityId, undefined, availabilityChanged, sourceChanged ? undefined : false);
                                }
                                sessionIds?.add(change.entityId);
                            }
                        }
                        resetInventory ||= inventoryListeners.size > 0 && result.response.changes.some(change => change.kind === 'share'
                            || change.kind === 'account' && change.entityId === 'teams');
                        const quotaRefreshRecordIds = result.response.changes.flatMap(change => {
                            const recordId = readProviderAccountUsageRefreshRecordIdV1(change);
                            return recordId ? [recordId] : [];
                        });
                        const serviceChanges = result.response.changes.flatMap(change => {
                            const scope = readConnectedServicesAccountChangeV1(change);
                            return scope ? [scope] : [];
                        });
                        const hasCatalogChange = result.response.changes.some(change => change.kind === 'account'
                            && parseConnectedAccountCatalogPhysicalKeyV1(change.entityId) !== null);
                        const hasConnectedAccountChange = hasCatalogChange || serviceChanges.length > 0;
                        const services = !hasCatalogChange && serviceChanges.length > 0 && serviceChanges.every(change => change.scope === 'service')
                            ? serviceChanges.flatMap(change => change.scope === 'service' ? [change.ref] : [])
                            : undefined;
                        if (quotaRefreshRecordIds.length || hasConnectedAccountChange) {
                            publishConnectedAccounts({
                                ...(quotaRefreshRecordIds.length ? { quotaRefreshRecordIds } : {}),
                                ...(!hasConnectedAccountChange ? { quotaRefreshOnly: true } : {}),
                                ...(services ? { services } : {}),
                            });
                        }
                        followCursor = result.response.nextCursor;
                        followCursorAcknowledged = true;
                        more = result.response.changes.length === DEFAULT_ACCOUNT_CHANGES_PAGE_LIMIT;
                    } else {
                        // A gap/failed classification cannot preserve a trusted cached rule set.
                        publishFollow(true);
                        publishSource(null);
                        publishConnectedAccounts({ resetQuotaSchedule: true });
                        if (result.status === 'cursor-gone') {
                            followCursor = result.currentCursor;
                            resetInventory = true;
                        } else {
                            inventoryUnavailable = true;
                            logger.warn('Requester Follow Account changes unavailable.');
                        }
                        more = false;
                    }
                } while (more && current());
                if (current() && inventoryListeners.size) publishInventory(inventoryUnavailable ? { kind: 'unavailable' }
                    : { kind: 'changes', sessionIds: sessionIds ? [...sessionIds] : [], reset: resetInventory });
            }
        })().finally(() => {
            if (followSyncPending === work) followSyncPending = null;
            if (followSyncRequested && !disposed && connected && hasFollowDemand()) syncFollowChanges(followRequestedCursor);
        });
        followSyncPending = work;
        // Transport failures are normalized by fetchChanges; keep listener failures observed, too.
        void work.catch(() => { if (current()) logger.warn('Requester Follow invalidation unavailable.'); });
    };
    // Stop settles the socket adapter's in-flight connect; never queue retirement
    // behind a connect or HTTP read that may still be waiting on the network.
    const stopConnection = () => {
        if (!stopping) {
            stopping = (supervisor?.stop() ?? Promise.resolve()).finally(() => { stopping = null; });
        }
        return stopping;
    };
    const startConnection = () => {
        const starting = supervisor!.start();
        connectionReady = starting;
        void starting.catch(() => {});
        return starting;
    };
    // The existing socket/managed-connection owners supply reconnection policy;
    // this observer adds no timer, freshness TTL or retry budget.
    const initial = (async () => {
        const { createUserScopedSocketConnection } = await import('@/api/session/sockets');
        if (disposed) return;
        let createdTransport = false;
        const createTransport = () => {
            const token = activeToken;
            const { socket, transport } = createUserScopedSocketConnection({ token, serverUrl: scope.serverBaseUrl,
                authorityCeiling: 'account_automation' });
            createdTransport = true;
            activeTransport = transport;
            const isActive = () => !disposed && activeTransport === transport
                && activeToken === token && references.has(token);
            socket.on('update', (raw: unknown) => {
                if (!isActive() || !connected || !transport.isConnected()) return;
                // The authenticated user channel owns Account routing. Preserve malformed
                // Settings publications for the Settings owner to withdraw admission.
                const body = raw && typeof raw === 'object' && 'body' in raw ? raw.body : null;
                if (body && typeof body === 'object' && 't' in body) {
                    if (body.t === 'account-change') {
                        const parsed = UpdateContainerSchema.safeParse(raw);
                        if (parsed.success) syncFollowChanges(Number.isSafeInteger(parsed.data.seq) && parsed.data.seq >= 0
                            ? parsed.data.seq : undefined);
                    } else if (body.t === 'update-account' && 'id' in body && body.id === scope.accountId && 'settingsV2' in body) {
                        publishSettings({ kind: 'settings', update: UpdateContainerSchema.safeParse(raw).success ? body.settingsV2 : undefined });
                    } else if (body.t === 'account-settings-changed') {
                        publishSettings({ kind: 'hint', version: UpdateContainerSchema.safeParse(raw).success && 'settingsVersion' in body ? body.settingsVersion : undefined });
                    }
                }
                if (currentness.update(raw)) {
                    lifetime.abort();
                    lifetime = new AbortController();
                    followCursorAcknowledged = false;
                    publishInventory({ kind: 'currentness' });
                    if (inventoryListeners.size) syncFollowChanges();
                }
            });
            socket.on('ephemeral', (raw: unknown) => {
                if (!isActive() || !connected || !transport.isConnected()) return;
                if (runAvailabilityListeners.size && raw && typeof raw === 'object' && 'type' in raw
                    && (raw.type === 'execution-run-updated' || raw.type === 'machine-activity')) {
                    const parsed = EphemeralUpdateSchema.safeParse(raw);
                    if (parsed.success && parsed.data.type === 'execution-run-updated') {
                        const update = parsed.data;
                        if ('sessionId' in update && typeof update.sessionId === 'string' && update.run && typeof update.run === 'object'
                            && 'runId' in update.run && typeof update.run.runId === 'string') {
                            publishRunAvailability({ kind: 'execution_run', sessionId: update.sessionId, runId: update.run.runId });
                        } else if (typeof update.machineId === 'string' && typeof update.runId === 'string') {
                            publishRunAvailability({ kind: 'execution_run', machineId: update.machineId, runId: update.runId });
                        }
                    } else if (parsed.success && parsed.data.type === 'machine-activity'
                        && parsed.data.active && parsed.data.reconnected === true) {
                        publishRunAvailability({ kind: 'machine', machineId: parsed.data.id });
                    }
                }
                if (inventoryListeners.size === 0) return;
                if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'activity') return;
                const parsed = EphemeralUpdateSchema.safeParse(raw);
                if (parsed.success && parsed.data.type === 'activity') {
                    const { id, active, activeAt } = parsed.data;
                    publishInventory({ kind: 'activity', id, active, activeAt });
                }
            });
            transport.onConnected(() => { if (isActive()) {
                const reconnected = hasConnected;
                hasConnected = true;
                connected = true; invalidate(); currentness.connected(); publishInventory({ kind: 'connected' });
                publishSettings({ kind: 'reconnected' }); publishFollow(true); publishSource(null);
                // Initial attachment already has its caller's cold demand.
                if (reconnected) publishRunAvailability({ kind: 'reconnected' });
                publishConnectedAccounts({ resetQuotaSchedule: true }); syncFollowChanges();
            } });
            transport.onDisconnected(() => { if (isActive()) { connected = false; invalidate(); currentness.disconnected(); publishInventory({ kind: 'disconnected' }); publishSettings({ kind: 'disconnected' }); publishFollow(true); publishSource(null); } });
            return transport;
        };
        supervisor = createManagedConnectionSupervisor({ ...DEFAULT_MANAGED_CONNECTION_POLICY,
            createTransport,
            probeReadiness: async () => ({ status: 'ready' }), classifyTransportErrorToProbeResult,
            onAuthFailed: () => {
                connected = false; invalidate(); currentness.disconnected();
                publishInventory({ kind: 'disconnected' });
                publishInventory({ kind: 'unavailable' });
            },
        });
        // A runtime without this transport keeps the incumbent fresh HTTP path.
        // Once a channel exists, connection failure is unknown, never fallback.
        try { await startConnection(); } catch (error) {
            publishInventory({ kind: 'unavailable' });
            if (createdTransport) throw error;
            logger.warn('Account encryption observation transport unavailable; using fresh HTTP reads.');
            unsupported = true;
        }
    })();
    return {
        scope: { accountId: scope.accountId, serverBaseUrl: normalizeServerHttpBaseUrl(scope.serverBaseUrl) },
        references,
        subscribeAccountSettings(listener) {
            settingsListeners.add(listener);
            if (settingsEvent) listener(settingsEvent);
            return () => { settingsListeners.delete(listener); };
        },
        subscribeSessionFollowRules(listener) {
            const alreadyDemanded = hasFollowDemand();
            followListeners.add(listener);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { followListeners.delete(listener); };
        },
        subscribeRunFollowAvailability(listener) {
            runAvailabilityListeners.add(listener);
            return () => { runAvailabilityListeners.delete(listener); };
        },
        subscribeSessionFollowSources(listener) {
            const alreadyDemanded = hasFollowDemand();
            sourceListeners.add(listener);
            listener(null);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { sourceListeners.delete(listener); };
        },
        subscribeConnectedAccounts(listener) {
            const alreadyDemanded = hasFollowDemand();
            connectedAccountListeners.add(listener);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { connectedAccountListeners.delete(listener); };
        },
        subscribeSessionInventory(listener) {
            inventoryListeners.add(listener);
            listener({ kind: connected ? 'connected' : 'disconnected' });
            // Join an in-flight catch-up, or establish this new demand's cursor baseline.
            syncFollowChanges();
            return () => { inventoryListeners.delete(listener); };
        },
        async releaseCredential(token) {
            if (disposed || token !== activeToken || references.has(token)) return;
            const nextToken = references.keys().next().value;
            if (nextToken === undefined) return;
            activeToken = nextToken;
            activeTransport = undefined;
            connected = false;
            invalidate();
            currentness.disconnected();
            publishInventory({ kind: 'disconnected' });
            // Settings holders lose the retired credential's channel like any disconnect.
            publishSettings({ kind: 'disconnected' });
            publishFollow(true);
            publishSource(null);
            // Before the async import completes, its first factory uses the new token.
            if (!supervisor || unsupported) return;
            await stopConnection();
            if (disposed || unsupported || activeToken !== nextToken || !references.has(nextToken)) return;
            void startConnection().catch(() => {
                if (!disposed && activeToken === nextToken) {
                    logger.warn('Account encryption observation transport restart failed.');
                }
            });
        },
        isCurrent: expected => !disposed && (unsupported || connected && currentness.isCurrent(expected)),
        async read(signal, options) {
            signal?.throwIfAborted();
            const readerSignal = signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal;
            await waitForObservation(initial, readerSignal);
            if (disposed) throw new AccountEncryptionCurrentnessUnavailableError();
            if (unsupported) {
                // Retained private snapshots require push continuity. Other
                // readers retain their incumbent fresh-HTTP fallback.
                if (options?.requireLiveObservation) throw new AccountEncryptionCurrentnessUnavailableError();
                const fallbackSignal = AbortSignal.any([readerSignal, lifetime.signal]);
                return projectAccountEncryptionIdentity(await waitForObservation(fetchAccountEncryptionCurrentnessFromServer({ token: activeToken,
                    serverBaseUrl: scope.serverBaseUrl, signal: fallbackSignal }), fallbackSignal));
            }
            // A credential may retire while its previous connection is still starting.
            while (connectionReady) {
                const starting = connectionReady;
                await waitForObservation(starting, readerSignal);
                if (connectionReady === starting) break;
            }
            signal?.throwIfAborted();
            if (disposed) throw new AccountEncryptionCurrentnessUnavailableError();
            if (!connected) throw Object.assign(new AccountEncryptionCurrentnessUnavailableError(), { retryable: true });
            return await currentness.read(readerSignal);
        },
        async dispose() {
            disposed = true; activeTransport = undefined; connected = false; retirement.abort(); invalidate();
            currentness.dispose();
            publishInventory({ kind: 'disconnected' });
            publishSettings({ kind: 'disconnected' });
            settingsListeners.clear();
            followListeners.clear();
            runAvailabilityListeners.clear();
            sourceListeners.clear();
            connectedAccountListeners.clear();
            inventoryListeners.clear();
            settingsEvent = null;
            await stopConnection();
            await initial;
        },
    };
}

/** Reader cancellation must not cancel a different holder's shared subscription. */
export function waitForObservation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return waitForAccountEncryptionObservation(operation, signal);
}
