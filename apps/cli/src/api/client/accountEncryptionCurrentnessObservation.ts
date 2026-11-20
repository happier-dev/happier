import { readApprovalProfileCatalogInvalidation, type ApprovalProfileCatalogInvalidation } from '@/settings/profiles/hydrateProfileCatalog';
import { createAccountEncryptionCurrentnessObservation, projectAccountEncryptionIdentity, sameAccountEncryptionIdentity,
    waitForAccountEncryptionObservation, type AccountE2eeCustody, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { readAccountE2eeCustodyForToken, type AccountE2eeCustodyHolder } from '@/persistence';
import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY, type ManagedConnectionSupervisor, type ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { fetchAccountEncryptionCurrentnessFromServer, AccountEncryptionCurrentnessUnavailableError } from './accountEncryptionCurrentness';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { logger } from '@/ui/logger';
import { DEFAULT_ACCOUNT_CHANGES_PAGE_LIMIT, fetchChanges } from '@/api/changes';
import { readSessionFollowChangeHintV1, readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { isChangesPageFull, readConnectedServicesAccountChangeV1, readProviderAccountUsageRefreshRecordIdV1, readSessionFollowSourceChangedV1, readSessionFollowReceiverAvailabilityChangedV1,
    type ChangeEntry } from '@happier-dev/protocol/changes';
import { parseConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, readAccountIdentitiesChangeV1 } from '@happier-dev/protocol/changes';
import { fetchPendingSessionFollowReceivers } from '@/session/transport/http/sessionFollowInactiveObservationsHttp';

export type RunFollowAvailability = Extract<RunFollowOriginalV1['source'], { kind: 'execution_run' }>
    | Readonly<{ kind: 'reconnected' }> | Readonly<{ kind: 'machine'; machineId: string }>;
export type RequesterSessionFollowRuleInvalidation = Readonly<{ full: true; continuityReset?: true }>;
/** Access invalidations only; current admission remains with the Environment read owner. */
export type RequesterEnvironmentAccessObservation =
    | Readonly<{ kind: 'changes'; environmentIds: readonly string[] }>
    | Readonly<{ kind: 'reset' }>
    | Readonly<{ kind: 'retired' }>;

type Scope = Readonly<{ accountId: string; token: string; serverBaseUrl: string; signal?: AbortSignal }>;
type FollowSourceListener = (sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false) => void;
type FollowReceiverRecovery = Readonly<{ machineId: string; installationId: string; getBoundSessionId: () => string | null }>;
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
    readWitness(signal?: AbortSignal, options?: Readonly<{ requireLiveObservation?: true; refresh?: true }>): Promise<AccountEncryptionCurrentnessResponse>;
    isCurrent(expected: AccountEncryptionIdentity): boolean;
    subscribeAccountSettings(listener: (event: RequesterAccountSettingsObservation) => void): () => void;
    subscribeApprovalProfiles(listener: (change: ApprovalProfileCatalogInvalidation) => void, isDemanded: () => boolean): () => void;
    subscribeSessionFollowRules(listener: (change?: RequesterSessionFollowRuleInvalidation) => void): () => void;
    subscribeRunFollowAvailability(listener: (change: RunFollowAvailability) => void): () => void;
    subscribeConnectedAccounts(listener: (event: RequesterConnectedAccountObservation) => void): () => void;
    hasCurrentConnectedAccountChangesObserver(): boolean;
    /** Exact Session invalidation; null rebuilds demanded ranges after a gap/reconnect. */
    subscribeSessionFollowSources(listener: FollowSourceListener, receiverRecovery?: FollowReceiverRecovery): () => void;
    subscribeSessionInventory(listener: (event: RequesterSessionInventoryObservation) => void): () => void;
    subscribeEnvironmentAccess(listener: (event: RequesterEnvironmentAccessObservation) => void): () => void;
    /**
     * A same-process reader of this exact Account feed (the Machine catch-up) becomes its feed owner:
     * while attached, Account wakes no longer trigger this observer's own `/v2/changes` read; the owner
     * hands each fully consumed page to `consumeOwnedFeedPage` instead. Every other trigger (connect,
     * new demand, currentness change, a page that does not continue this cursor) still reads itself.
     */
    attachFeedOwner(): () => void;
    consumeOwnedFeedPage(page: OwnedFeedPage): void;
    dispose(): Promise<void>;
}>;
/** One fully consumed page of the Account feed, in cursor order (`after` → `nextCursor`). */
export type OwnedFeedPage = Readonly<{ after: number; changes: readonly ChangeEntry[]; nextCursor: number }>;
type FollowPageEffects = {
    recoveringReceivers: boolean; sessionIds: Set<string> | null; environmentIds: Set<string>;
    resetEnvironmentAccess: boolean; environmentAccessRetired: boolean; resetInventory: boolean; inventoryUnavailable: boolean;
};
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

async function readAdmittedObservation<T>(observed: SharedObservation, scope: Readonly<{
    accountId?: string; token: string; serverBaseUrl: string; signal?: AbortSignal;
}>, read: () => Promise<T>): Promise<T> {
    const credentialReference = observed.references.get(scope.token);
    const identity = await read();
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
    return observed ? readAdmittedObservation(observed, scope, () => observed.read(scope.signal)) : null;
}

/** Full retained response for consumers already inside this exact Account/Home admission. */
export function readObservedAccountEncryptionCurrentnessWitness(scope: Readonly<{
    token: string; serverBaseUrl: string; signal?: AbortSignal;
}>): Promise<AccountEncryptionCurrentnessResponse> | null {
    const observed = admittedObservation(scope);
    return observed ? readAdmittedObservation(observed, scope, () => observed.readWitness(scope.signal)) : null;
}

/**
 * The currentness state for one Account credential on an Account update
 * transport. This computer's custody for the bearer is read from creation
 * (fail closed until then) and again beside every fresh HTTP read; the
 * transport feeds `connected`/`disconnected`/`update` (pushed identity changes).
 */
export function createCredentialAccountEncryptionCurrentness(input: Readonly<{
    accountId: string; serverBaseUrl: string; readToken: () => string;
}>) {
    let accountE2eeCustody: AccountE2eeCustody = 'active';
    const readCustody = () => readAccountE2eeCustodyForToken(input.readToken()).then(custody => { accountE2eeCustody = custody; });
    void readCustody();
    return createAccountEncryptionCurrentnessObservation({
        accountId: input.accountId,
        accountE2eeCustody: () => accountE2eeCustody,
        readFresh: async signal => (await Promise.all([readCustody(),
            fetchAccountEncryptionCurrentnessFromServer({ token: input.readToken(), serverBaseUrl: input.serverBaseUrl, signal })]))[1],
        unavailable: () => new AccountEncryptionCurrentnessUnavailableError(),
    });
}
export type CredentialAccountEncryptionCurrentness = ReturnType<typeof createCredentialAccountEncryptionCurrentness>;

/**
 * The Account encryption currentness read rule (one owner, two usages):
 *
 * - `read`: read-only consumers that open content the Home already stored
 *   (Session snapshot syncs and other display reads) reuse the held
 *   observation witness when this exact credential and Home hold one, and read
 *   fresh only when none is held. The held witness preserves the security
 *   contract these reads need: every fresh read and every pushed update is
 *   admitted against this device's custody (a Home-reported E2EE→plain
 *   downgrade is refused), a pushed identity change (mode or key fingerprint)
 *   invalidates it before any later read, and disconnects retire it. A read
 *   therefore never opens content under a mode or key the Home has retired.
 * - Writes and seals keep `fetchAccountEncryptionCurrentness`: their exact
 *   witness must carry the Account-wide cursor, which an observation cannot
 *   supply (a claim advances that cursor before its socket wake).
 */
export async function readAccountEncryptionCurrentnessForRead(params: Readonly<{
    token: string; credentials?: AccountE2eeCustodyHolder; serverBaseUrl?: string; signal?: AbortSignal;
    /** The caller's own connected Account update transport state for this exact credential. */
    held?: CredentialAccountEncryptionCurrentness | null;
}>): Promise<AccountEncryptionCurrentnessResponse> {
    const { held, ...read } = params;
    const serverBaseUrl = read.serverBaseUrl ?? resolveServerHttpBaseUrl();
    const observed = readObservedAccountEncryptionCurrentnessWitness({ token: read.token, serverBaseUrl,
        ...(read.signal ? { signal: read.signal } : {}) });
    if (observed) return await observed;
    // A disconnected transport holds no fact; its first read after (re)connect
    // is the one fresh read that every later read shares.
    if (held?.getDiagnosticState().connected) return await held.readWitness(read.signal);
    return await fetchAccountEncryptionCurrentnessFromServer({ ...read, serverBaseUrl });
}

export function sameRequesterAccountEncryptionCurrentness(a: AccountEncryptionIdentity, b: AccountEncryptionIdentity): boolean {
    return sameAccountEncryptionIdentity(a, b);
}

type RequesterCurrentnessReadScope = Readonly<{
    accountId?: string; token: string; serverBaseUrl?: string; signal?: AbortSignal;
    authorizationHeaders?: Readonly<Record<string, string>>;
    /** This finite operation independently authenticated and admitted the exact credential. */
    retainCredentialReference?: true;
}>;

/** Encryption identity only; exact Account cursor/Settings witnesses still use fresh HTTP. */
export function readRequesterAccountEncryptionCurrentness(scope: RequesterCurrentnessReadScope): Promise<AccountEncryptionIdentity>;
/** Keep a borrowed identity current through its consumer; fresh HTTP is independent of other holders. */
export function readRequesterAccountEncryptionCurrentness<T>(scope: RequesterCurrentnessReadScope,
    consume: (currentness: AccountEncryptionIdentity) => Promise<T>): Promise<T>;
export async function readRequesterAccountEncryptionCurrentness<T>(scope: RequesterCurrentnessReadScope,
    consume?: (currentness: AccountEncryptionIdentity) => Promise<T>): Promise<AccountEncryptionIdentity | T> {
    const serverBaseUrl = scope.serverBaseUrl ?? resolveServerHttpBaseUrl();
    const suppliedAuthorization = scope.authorizationHeaders
        ? Object.entries(scope.authorizationHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
        : null;
    // A signed Action request must retain its own fresh authenticated transport.
    const observed = !scope.authorizationHeaders || suppliedAuthorization === `Bearer ${scope.token}`
        ? admittedObservation({ ...scope, serverBaseUrl }) : undefined;
    const read = async () => {
        const currentness = observed ? await observed.read(scope.signal)
            : projectAccountEncryptionIdentity(await fetchAccountEncryptionCurrentnessFromServer({ ...scope, serverBaseUrl }));
        if (!consume) return currentness;
        const result = await consume(currentness);
        if (observed && !observed.isCurrent(currentness)) throw new AccountEncryptionCurrentnessUnavailableError();
        return result;
    };
    if (!observed) return await read();
    const retained = scope.retainCredentialReference
        ? acquireRequesterAccountEncryptionCurrentness({ ...observed.scope, token: scope.token }) : undefined;
    try {
        return await readAdmittedObservation(observed, { ...scope, serverBaseUrl }, read);
    } finally {
        await retained?.dispose();
    }
}

/** A synchronous fence after distinct Machine/Home awaits, without another HTTP read. */
export function isRequesterAccountEncryptionCurrentnessObserved(scope: Scope, expected: AccountEncryptionIdentity): boolean {
    return !observations.has(scopeKey(scope)) || (admittedObservation(scope)?.isCurrent(expected) ?? false);
}

/** One exact Account/Home observation shared by live finite and Session custody. */
/** The incumbent follow readers consume Account, Session and Share rows. */
const FOLLOW_CHANGE_KINDS: ReadonlySet<string> = new Set(['account', 'session', 'share']);

function isAccountWakeOutsideFollowKinds(body: unknown, machineAvailabilityDemanded: boolean, approvalProfilesDemanded: boolean): boolean {
    const kinds = body && typeof body === 'object' && 'changeKinds' in body ? body.changeKinds : undefined;
    return Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => typeof kind === 'string'
        && !FOLLOW_CHANGE_KINDS.has(kind) && !(machineAvailabilityDemanded && kind === 'machine')
        && !(approvalProfilesDemanded && kind === 'artifact'));
}

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
        readWitness: (signal, options) => released ? Promise.reject(new AccountEncryptionCurrentnessUnavailableError())
            : owned.readWitness(signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal, options),
        isCurrent: expected => !released && owned.isCurrent(expected),
        subscribeAccountSettings(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeAccountSettings(listener);
            subscriptions.add(release);
            return () => { subscriptions.delete(release); release(); };
        },
        subscribeApprovalProfiles(listener, isDemanded) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeApprovalProfiles(listener, isDemanded);
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
        subscribeSessionFollowSources(listener, receiverRecovery) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeSessionFollowSources(listener, receiverRecovery);
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
        hasCurrentConnectedAccountChangesObserver: () => !released && owned.hasCurrentConnectedAccountChangesObserver(),
        attachFeedOwner() {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const detach = owned.attachFeedOwner();
            subscriptions.add(detach);
            return () => { subscriptions.delete(detach); detach(); };
        },
        consumeOwnedFeedPage: page => { if (!released) owned.consumeOwnedFeedPage(page); },
        subscribeEnvironmentAccess(listener) {
            if (released) throw new AccountEncryptionCurrentnessUnavailableError();
            const release = owned.subscribeEnvironmentAccess(listener);
            const retire = () => { listener({ kind: 'retired' }); release(); };
            subscriptions.add(retire);
            return () => { subscriptions.delete(retire); release(); };
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
    const currentness = createCredentialAccountEncryptionCurrentness({ accountId: scope.accountId,
        serverBaseUrl: scope.serverBaseUrl, readToken: () => activeToken });
    let supervisor: ManagedConnectionSupervisor | undefined;
    const settingsListeners = new Set<(event: RequesterAccountSettingsObservation) => void>();
    const approvalProfileListeners = new Map<(change: ApprovalProfileCatalogInvalidation) => void, () => boolean>();
    const publishApprovalProfiles = (change: ApprovalProfileCatalogInvalidation) => {
        for (const [listener, isDemanded] of approvalProfileListeners) if (isDemanded()) listener(change);
    };
    let settingsEvent: RequesterAccountSettingsObservation | null = null;
    const followListeners = new Set<(change?: RequesterSessionFollowRuleInvalidation) => void>();
    const runAvailabilityListeners = new Set<(change: RunFollowAvailability) => void>();
    const publishRunAvailability = (change: RunFollowAvailability) => {
        for (const listener of runAvailabilityListeners) listener(change);
    };
    const sourceListeners = new Map<FollowSourceListener, FollowReceiverRecovery | undefined>();
    const connectedAccountListeners = new Set<(event: RequesterConnectedAccountObservation) => void>();
    const inventoryListeners = new Set<(event: RequesterSessionInventoryObservation) => void>();
    const environmentAccessListeners = new Set<(event: RequesterEnvironmentAccessObservation) => void>();
    const publishEnvironmentAccess = (event: RequesterEnvironmentAccessObservation) => {
        for (const listener of environmentAccessListeners) listener(event);
    };
    const publishInventory = (event: RequesterSessionInventoryObservation) => {
        for (const listener of inventoryListeners) listener(event);
    };
    let followCursor = 0;
    let followCursorAcknowledged = false;
    let feedOwners = 0;
    let followSyncRequested = false;
    let followRequestedCursor: number | undefined;
    let followSyncPending: Promise<void> | null = null;
    const publishFollow = (continuityReset?: true) => {
        for (const listener of followListeners) listener({ full: true, ...(continuityReset ? { continuityReset } : {}) });
    };
    const publishSource = (sourceSessionId: string | null, receiver?: true, availabilityChanged?: boolean, sourceChanged?: false,
        recovering = false) => {
        for (const [listener, recovery] of sourceListeners) {
            // Cache invalidation remains broad; bound receiver work comes from
            // the same Account pending-work owner used by the installed daemon.
            if (recovery && (sourceSessionId === null || recovering)) continue;
            listener(sourceSessionId, receiver, availabilityChanged, sourceChanged);
        }
    };
    const recoverFollowReceivers = async (token: string, signal: AbortSignal, current: () => boolean) => {
        const groups = new Map<string, { machineId: string; installationId: string; receivers: Map<string, FollowSourceListener[]> }>();
        for (const [listener, recovery] of sourceListeners) {
            const sessionId = recovery?.getBoundSessionId();
            if (!recovery || !sessionId) continue;
            const key = JSON.stringify([recovery.machineId, recovery.installationId]);
            let group = groups.get(key);
            if (!group) {
                group = { machineId: recovery.machineId, installationId: recovery.installationId, receivers: new Map() };
                groups.set(key, group);
            }
            group.receivers.set(sessionId, [...(group.receivers.get(sessionId) ?? []), listener]);
        }
        await Promise.all([...groups.values()].map(async group => {
            const pending = await runWithServerHttpBaseUrl(scope.serverBaseUrl, () => fetchPendingSessionFollowReceivers({
                token, machineId: group.machineId, installationId: group.installationId, signal, reason: 'receiver-recovery',
            }));
            if (!current()) return;
            if (pending && 'failure' in pending) logger.warn('Requester pending Follow recovery unavailable; source custody retained', {
                failure: pending.failure,
            });
            if (!pending?.ok) return;
            for (const sessionId of pending.sessionIds) {
                for (const listener of group.receivers.get(sessionId) ?? []) {
                    if (sourceListeners.has(listener)) listener(sessionId, true);
                }
            }
        }));
    };
    const publishConnectedAccounts = (event: RequesterConnectedAccountObservation) => {
        for (const listener of connectedAccountListeners) listener(event);
    };
    const hasApprovalProfileDemand = () => {
        for (const isDemanded of approvalProfileListeners.values()) if (isDemanded()) return true;
        return false;
    };
    const hasFollowDemand = () => followListeners.size > 0 || sourceListeners.size > 0 || connectedAccountListeners.size > 0
        || inventoryListeners.size > 0 || environmentAccessListeners.size > 0 || runAvailabilityListeners.size > 0
        || hasApprovalProfileDemand();
    const publishSettings = (event: RequesterAccountSettingsObservation) => {
        // Reconnect invalidates existing publications. A newly admitted holder
        // already bootstrapped Settings after its fresh witness and must not
        // recover again from a replayed connection edge.
        settingsEvent = event.kind === 'reconnected' ? null : event;
        for (const listener of settingsListeners) listener(event);
    };
    const invalidate = () => { lifetime.abort(); lifetime = new AbortController(); followCursorAcknowledged = false; currentness.invalidate(); };
    /** One classification of a consumed Account feed page for every follow reader. */
    const classifyFollowPage = (changes: readonly ChangeEntry[], page: FollowPageEffects) => {
        const approvalProfiles = readApprovalProfileCatalogInvalidation(changes);
        if (approvalProfiles) publishApprovalProfiles(approvalProfiles);
        if (changes.some(change => change.kind === 'account'
            && readSessionFollowChangeHintV1(change.hint) !== null)) publishFollow();
        for (const change of changes) {
            if (change.kind === 'machine') publishRunAvailability({ kind: 'machine', machineId: change.entityId });
            if (environmentAccessListeners.size > 0) {
                const deployment = readDeploymentAccountChangeV1(change);
                if (deployment && deployment.deploymentId === undefined) page.environmentIds.add(deployment.environmentId);
                if (readAccountIdentitiesChangeV1(change) || change.kind === 'account'
                    && (change.entityId === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1
                        || change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
                        || change.entityId === HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1)) {
                    page.resetEnvironmentAccess = true;
                }
            }
            const receiver = readSessionFollowReceiverChangeV1(change);
            if (receiver !== null) publishSource(receiver, true, undefined, undefined, page.recoveringReceivers);
            if (change.kind === 'session') {
                const availabilityChanged = readSessionFollowReceiverAvailabilityChangedV1(change, followCursor);
                const sourceChanged = readSessionFollowSourceChangedV1(change, followCursor);
                // An older server can classify a metadata write as
                // non-source without qualifying receiver availability.
                // Preserve that distinction for bounded own-receiver recovery.
                if (availabilityChanged !== false || sourceChanged) {
                    publishSource(change.entityId, undefined, availabilityChanged, sourceChanged ? undefined : false, page.recoveringReceivers);
                }
                page.sessionIds?.add(change.entityId);
            }
        }
        page.resetInventory ||= inventoryListeners.size > 0 && changes.some(change => change.kind === 'share'
            || change.kind === 'account' && change.entityId === 'teams');
        const quotaRefreshRecordIds = changes.flatMap(change => {
            const recordId = readProviderAccountUsageRefreshRecordIdV1(change);
            return recordId ? [recordId] : [];
        });
        const serviceChanges = changes.flatMap(change => {
            const scope = readConnectedServicesAccountChangeV1(change);
            return scope ? [scope] : [];
        });
        const hasCatalogChange = changes.some(change => change.kind === 'account'
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
    };
    const newFollowPageEffects = (recoveringReceivers: boolean): FollowPageEffects => ({ recoveringReceivers,
        sessionIds: inventoryListeners.size ? new Set<string>() : null, environmentIds: new Set<string>(),
        resetEnvironmentAccess: false, environmentAccessRetired: false, resetInventory: false, inventoryUnavailable: false });
    const publishFollowPageEffects = (page: FollowPageEffects) => {
        if (environmentAccessListeners.size) {
            if (page.environmentAccessRetired) publishEnvironmentAccess({ kind: 'retired' });
            else if (page.resetEnvironmentAccess) publishEnvironmentAccess({ kind: 'reset' });
            else if (page.environmentIds.size) publishEnvironmentAccess({ kind: 'changes', environmentIds: [...page.environmentIds] });
        }
        if (inventoryListeners.size) publishInventory(page.inventoryUnavailable ? { kind: 'unavailable' }
            : { kind: 'changes', sessionIds: page.sessionIds ? [...page.sessionIds] : [], reset: page.resetInventory });
    };
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
                const page = newFollowPageEffects(!followCursorAcknowledged);
                let more = false;
                do {
                    followCursorAcknowledged = false;
                    const result = await runWithServerHttpBaseUrl(scope.serverBaseUrl, () => fetchChanges({
                        token, after: followCursor, signal: captured.signal,
                    }));
                    if (!current()) return;
                    if (result.status === 'ok') {
                        classifyFollowPage(result.response.changes, page);
                        followCursor = result.response.nextCursor;
                        followCursorAcknowledged = true;
                        more = isChangesPageFull(result.response, DEFAULT_ACCOUNT_CHANGES_PAGE_LIMIT);
                    } else {
                        // A gap/failed classification cannot preserve a trusted cached rule set.
                        publishFollow(true);
                        publishSource(null);
                        publishApprovalProfiles({});
                        publishConnectedAccounts({ resetQuotaSchedule: true });
                        if (result.status === 'cursor-gone') {
                            page.recoveringReceivers = true;
                            followCursor = result.currentCursor;
                            page.resetInventory = true;
                            page.resetEnvironmentAccess = true;
                        } else {
                            page.inventoryUnavailable = true;
                            page.environmentAccessRetired = true;
                            logger.warn('Requester Follow Account changes unavailable.');
                        }
                        more = false;
                    }
                } while (more && current());
                if (page.recoveringReceivers && current()) await recoverFollowReceivers(token, captured.signal, current);
                if (current()) publishFollowPageEffects(page);
            }
        })().finally(() => {
            if (followSyncPending === work) followSyncPending = null;
            if (followSyncRequested && !disposed && connected && hasFollowDemand()) syncFollowChanges(followRequestedCursor);
        });
        followSyncPending = work;
        // Transport failures are normalized by fetchChanges; keep listener failures observed, too.
        void work.catch(() => { if (current()) {
            publishEnvironmentAccess({ kind: 'retired' });
            logger.warn('Requester Follow invalidation unavailable.');
        } });
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
                        // A wake routed only to kinds no follow reader classifies (for example first-boot
                        // plugin availability claims) carries nothing here; the cursor stays where it is,
                        // and the next relevant wake reads from it. Unrouted wakes stay coarse.
                        // An attached same-process feed owner reads this wake and hands its page over.
                        if (feedOwners === 0 && parsed.success && !isAccountWakeOutsideFollowKinds(parsed.data.body, runAvailabilityListeners.size > 0, hasApprovalProfileDemand())) {
                            syncFollowChanges(Number.isSafeInteger(parsed.data.seq) && parsed.data.seq >= 0
                                ? parsed.data.seq : undefined);
                        }
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
                    publishEnvironmentAccess({ kind: 'retired' });
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
                connected = true; invalidate(); currentness.connected({ refresh: false }); publishInventory({ kind: 'connected' });
                publishEnvironmentAccess({ kind: 'reset' });
                publishSettings({ kind: 'reconnected' }); publishFollow(true); publishSource(null);
                publishApprovalProfiles({});
                // Initial attachment already has its caller's cold demand.
                if (reconnected) publishRunAvailability({ kind: 'reconnected' });
                publishConnectedAccounts({ resetQuotaSchedule: true }); syncFollowChanges();
            } });
            transport.onDisconnected(() => { if (isActive()) { connected = false; invalidate(); currentness.disconnected(); publishEnvironmentAccess({ kind: 'retired' }); publishInventory({ kind: 'disconnected' }); publishSettings({ kind: 'disconnected' }); publishFollow(true); publishSource(null); } });
            return transport;
        };
        supervisor = createManagedConnectionSupervisor({ ...DEFAULT_MANAGED_CONNECTION_POLICY,
            createTransport,
            probeReadiness: async () => ({ status: 'ready' }), classifyTransportErrorToProbeResult,
            onAuthFailed: () => {
                connected = false; invalidate(); currentness.disconnected();
                publishEnvironmentAccess({ kind: 'retired' });
                publishInventory({ kind: 'disconnected' });
                publishInventory({ kind: 'unavailable' });
            },
        });
        // A runtime without this transport keeps the incumbent fresh HTTP path.
        // Once a channel exists, connection failure is unknown, never fallback.
        try { await startConnection(); } catch (error) {
            publishEnvironmentAccess({ kind: 'retired' });
            publishInventory({ kind: 'unavailable' });
            if (createdTransport) throw error;
            logger.warn('Account encryption observation transport unavailable; using fresh HTTP reads.');
            unsupported = true;
        }
    })();
    const prepareRead = async (signal?: AbortSignal, options?: Readonly<{ requireLiveObservation?: true }>) => {
        signal?.throwIfAborted();
        const readerSignal = signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal;
        await waitForObservation(initial, readerSignal);
        if (disposed) throw new AccountEncryptionCurrentnessUnavailableError();
        if (unsupported) {
            if (options?.requireLiveObservation) throw new AccountEncryptionCurrentnessUnavailableError();
            return readerSignal;
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
        return readerSignal;
    };
    const readFallback = (signal: AbortSignal) => {
        const fallbackSignal = AbortSignal.any([signal, lifetime.signal]);
        return waitForObservation(fetchAccountEncryptionCurrentnessFromServer({ token: activeToken,
            serverBaseUrl: scope.serverBaseUrl, signal: fallbackSignal }), fallbackSignal);
    };
    return {
        scope: { accountId: scope.accountId, serverBaseUrl: normalizeServerHttpBaseUrl(scope.serverBaseUrl) },
        references,
        subscribeAccountSettings(listener) {
            settingsListeners.add(listener);
            if (settingsEvent) listener(settingsEvent);
            return () => { settingsListeners.delete(listener); };
        },
        subscribeApprovalProfiles(listener, isDemanded) {
            const alreadyDemanded = hasFollowDemand();
            approvalProfileListeners.set(listener, isDemanded);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { approvalProfileListeners.delete(listener); };
        },
        subscribeSessionFollowRules(listener) {
            const alreadyDemanded = hasFollowDemand();
            followListeners.add(listener);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { followListeners.delete(listener); };
        },
        subscribeRunFollowAvailability(listener) {
            const alreadyDemanded = hasFollowDemand();
            runAvailabilityListeners.add(listener);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { runAvailabilityListeners.delete(listener); };
        },
        subscribeSessionFollowSources(listener, receiverRecovery) {
            const alreadyDemanded = hasFollowDemand();
            sourceListeners.set(listener, receiverRecovery);
            if (!receiverRecovery) listener(null);
            if (!alreadyDemanded) syncFollowChanges();
            return () => { sourceListeners.delete(listener); };
        },
        hasCurrentConnectedAccountChangesObserver: () => !disposed && connected
            && connectedAccountListeners.size > 0 && followCursorAcknowledged && !followSyncPending,
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
        attachFeedOwner() {
            feedOwners++;
            let attached = true;
            return () => {
                if (!attached) return;
                attached = false;
                feedOwners--;
                // Wakes are this observer's again; read anything the owner had not handed over.
                if (feedOwners === 0) syncFollowChanges();
            };
        },
        consumeOwnedFeedPage(feed) {
            if (disposed || !connected || !hasFollowDemand()) return;
            // Already classified through this cursor (the owner caught up from an older checkpoint).
            if (followCursorAcknowledged && !followSyncPending && feed.nextCursor <= followCursor) return;
            // Only an exact continuation of this cursor can be classified as-is; anything else reads itself.
            if (followSyncPending || !followCursorAcknowledged || feed.after !== followCursor) {
                syncFollowChanges(feed.nextCursor);
                return;
            }
            const page = newFollowPageEffects(false);
            classifyFollowPage(feed.changes, page);
            followCursor = feed.nextCursor;
            publishFollowPageEffects(page);
        },
        subscribeEnvironmentAccess(listener) {
            const alreadyDemanded = hasFollowDemand();
            environmentAccessListeners.add(listener);
            listener({ kind: connected ? 'reset' : 'retired' });
            if (!alreadyDemanded) syncFollowChanges();
            return () => { environmentAccessListeners.delete(listener); };
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
            publishEnvironmentAccess({ kind: 'retired' });
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
            const readerSignal = await prepareRead(signal, options);
            return unsupported ? projectAccountEncryptionIdentity(await readFallback(readerSignal))
                : await currentness.read(readerSignal);
        },
        async readWitness(signal, options) {
            const readerSignal = await prepareRead(signal, options);
            return unsupported ? await readFallback(readerSignal) : await currentness.readWitness(readerSignal, options);
        },
        async dispose() {
            disposed = true; activeTransport = undefined; connected = false; retirement.abort(); invalidate();
            currentness.dispose();
            publishEnvironmentAccess({ kind: 'retired' });
            publishInventory({ kind: 'disconnected' });
            publishSettings({ kind: 'disconnected' });
            settingsListeners.clear();
            approvalProfileListeners.clear();
            followListeners.clear();
            runAvailabilityListeners.clear();
            sourceListeners.clear();
            connectedAccountListeners.clear();
            inventoryListeners.clear();
            environmentAccessListeners.clear();
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
