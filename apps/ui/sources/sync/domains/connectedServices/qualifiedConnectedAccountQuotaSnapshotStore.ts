import type {
    ProviderAccountUsageRecordId,
    QualifiedConnectedAccountRef,
    QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';
import { t } from '@/text';
import { isProviderAccountUsageIdentityMatch, type ProviderAccountUsageOrganizationContext } from '@happier-dev/protocol/connect/accountUsage';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { getConnectedServiceUsageIdentity } from './connectedServiceRegistry';
import { parseToken } from '@/utils/auth/parseToken';
import { ConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';

import {
    readConnectedServiceSettingsErrorCode,
    resolveConnectedServiceSettingsErrorMessage,
} from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import { getUsageProjectionNextReadAtMs, observeUsageProjection } from '@/sync/api/account/usageQueryInvalidation';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import {
    readQualifiedConnectedAccountQuota,
    readQualifiedConnectedAccountQuotaCredentialContext,
    refreshQualifiedConnectedAccountQuota,
    type QualifiedConnectedAccountQuotaTransportContext,
} from '@/sync/api/account/qualifiedConnectedAccountQuotaTransport';

export type QualifiedQuotaSnapshotStoreContext =
    QualifiedConnectedAccountQuotaTransportContext & Readonly<{
        credentialScope: string;
    }>;

export type QualifiedQuotaSnapshotStoreEntry = Readonly<{
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null;
    usageRecordId: ProviderAccountUsageRecordId | null;
    supported: boolean | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    /** A read has completed (with or without a snapshot): "no snapshot" is then an answer, not a wait. */
    read: boolean;
}>;

type InternalEntry = {
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null;
    usageRecordId: ProviderAccountUsageRecordId | null;
    supported: boolean | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    /** Credential scope this entry was last retained for; drives eviction. */
    credentialScope: string | null;
    producerRefreshPending: boolean;
    loadAttempted: boolean;
    loadPromise:
        Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> | null;
    refreshPromise: Promise<void> | null;
    refreshSinceFetchedAt: number | null;
    nextFetchAtMs: number;
    retainCount: number;
    observation: ReturnType<typeof observeUsageProjection> | null;
    pollContext: QualifiedQuotaSnapshotStoreContext | null;
    view: QualifiedQuotaSnapshotStoreEntry;
    publishedAtMs: number;
};

const EMPTY_VIEW: QualifiedQuotaSnapshotStoreEntry = Object.freeze({
    snapshot: null,
    usageRecordId: null,
    supported: null,
    loading: false,
    refreshing: false,
    error: null,
    read: false,
});

const entries = new Map<string, InternalEntry>();
const listenersByKey = new Map<string, Set<() => void>>();
let detachProfileChanges: (() => void) | null = null;

function clearSnapshot(entry: InternalEntry): void {
    entry.snapshot = null;
    entry.usageRecordId = null;
}

function retirePendingReads(entry: InternalEntry): void {
    // The existing promise identity fences both old reads and refresh intents.
    entry.loadPromise = null;
    entry.refreshPromise = null;
    entry.loading = false;
    entry.refreshing = false;
    entry.producerRefreshPending = false;
    entry.refreshSinceFetchedAt = null;
}

function ensureProfileChanges(): void {
    if (detachProfileChanges) return;
    let previous = readRegisteredStorageState()?.profile;
    detachProfileChanges = subscribeRegisteredStorageState(state => {
        const next = state.profile;
        if (next === previous) return;
        const old = previous;
        previous = next;
        if (old?.connectedAccountsV4 === next.connectedAccountsV4) return;
        for (const [key, entry] of entries) {
            const context = entry.pollContext;
            if (!context || state.profileScope?.serverId !== context.serverBasis.serverId
                || state.profileScope.accountId !== parseToken(context.credentials.token)) continue;
            const before = old?.connectedAccountsV4.find(account => sameQualifiedConnectedAccountRef(account.ref, context.ref));
            const after = next.connectedAccountsV4.find(account => sameQualifiedConnectedAccountRef(account.ref, context.ref));
            const requiresOrganization = getConnectedServiceUsageIdentity(context.ref.service)?.requiredContext === 'organization'
                || Boolean(entry.snapshot?.providerOrganizationId || before?.providerIdentity?.organizationId || after?.providerIdentity?.organizationId);
            const replacementIdentityUnknown = before?.credentialRevision !== after?.credentialRevision
                && (!after?.providerIdentity?.accountId || requiresOrganization && !after.providerIdentity.organizationId);
            if (before?.providerIdentity?.accountId === after?.providerIdentity?.accountId
                && (!requiresOrganization || before?.providerIdentity?.organizationId === after?.providerIdentity?.organizationId)
                && Boolean(before) === Boolean(after) && !replacementIdentityUnknown) continue;
            clearSnapshot(entry);
            retirePendingReads(entry);
            entry.loadAttempted = false;
            entry.error = null;
            publish(key, entry);
            entry.observation?.invalidate();
        }
    });
}

export function buildQualifiedQuotaSnapshotScopeKey(
    context: Pick<
        QualifiedQuotaSnapshotStoreContext,
        'credentialScope' | 'ref' | 'serverBasis'
    >,
): string {
    return JSON.stringify([
        context.credentialScope,
        context.serverBasis.serverId,
        context.serverBasis.generation,
        context.ref.service.pluginId,
        context.ref.service.localId,
        context.ref.accountId,
    ]);
}

function getOrCreateEntry(key: string): InternalEntry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: InternalEntry = {
        snapshot: null,
        usageRecordId: null,
        supported: null,
        loading: false,
        refreshing: false,
        error: null,
        credentialScope: null,
        producerRefreshPending: false,
        loadAttempted: false,
        loadPromise: null,
        refreshPromise: null,
        refreshSinceFetchedAt: null,
        nextFetchAtMs: 0,
        retainCount: 0,
        observation: null,
        pollContext: null,
        view: EMPTY_VIEW,
        publishedAtMs: Date.now(),
    };
    entries.set(key, created);
    ensureProfileChanges();
    return created;
}

function publish(key: string, entry: InternalEntry): void {
    const nowMs = Date.now();
    if (sameStrictJsonValue(entry.snapshot, entry.view.snapshot)) entry.snapshot = entry.view.snapshot;
    const next = {
        snapshot: entry.snapshot,
        usageRecordId: entry.usageRecordId,
        supported: entry.supported,
        loading: entry.loading,
        refreshing: entry.refreshing || entry.producerRefreshPending,
        error: entry.error,
        read: entry.loadAttempted && !entry.loading,
    };
    // The observer also publishes the time-derived stale transition without a GET.
    const wasStale = Boolean(entry.view.snapshot
        && entry.publishedAtMs > entry.view.snapshot.fetchedAt + entry.view.snapshot.staleAfterMs);
    const isStale = Boolean(entry.snapshot && nowMs > entry.snapshot.fetchedAt + entry.snapshot.staleAfterMs);
    if (entry.view.snapshot === next.snapshot && sameStrictJsonValue(entry.view, next) && wasStale === isStale) return;
    entry.view = Object.freeze(next);
    entry.publishedAtMs = nowMs;
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function hasPollingDemand(key: string, entry: InternalEntry): boolean {
    // Cached surfaces do not poll normally; an explicit refresh stays live while observed.
    return entry.retainCount > 0 || (entry.refreshing && (listenersByKey.get(key)?.size ?? 0) > 0);
}

function reconcilePolling(key: string, initialReadCompleted = false): void {
    const entry = entries.get(key);
    if (!entry) return;
    const context = entry.pollContext;
    if (!hasPollingDemand(key, entry) || !context) {
        entry.observation?.dispose();
        entry.observation = null;
        return;
    }
    if (!entry.observation) entry.observation = observeUsageProjection({
        serverId: context.serverBasis.serverId,
        initialReadCompleted,
        read: () => { entry.loadAttempted = true; return runLoad(key, context); },
        busy: () => Boolean(entry.loadPromise || entry.refreshPromise),
        nextReadAtMs: () => entry.nextFetchAtMs,
        presentationDeadlineMs: () => entry.snapshot ? entry.snapshot.fetchedAt + entry.snapshot.staleAfterMs + 1 : undefined,
        publish: () => publish(key, entry),
    });
    entry.observation.reconcile();
}
/**
 * Drops cached entries that belong to a superseded credential scope.
 *
 * A retained entry is what preserves last-known-good across an unmount, so an
 * entry is never dropped while its scope is the one in use. Once a re-login,
 * server switch, or generation bump makes a different scope active, the old
 * scope's keys can never be read again, so its unretained entries are released
 * instead of being stranded for the session lifetime.
 */
function evictEntriesOutsideCredentialScope(
    activeCredentialScope: string,
): void {
    for (const [key, entry] of entries) {
        if (hasPollingDemand(key, entry)) continue;
        if (entry.credentialScope === activeCredentialScope) continue;
        entry.observation?.dispose();
        entries.delete(key);
    }
}

async function runLoad(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
    credentialMutation = false,
): Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> {
    const entry = getOrCreateEntry(key);
    if (entry.loadPromise) return entry.loadPromise;
    entry.loading = true;
    entry.error = null;
    publish(key, entry);

    const promise = Promise.resolve().then(async () => {
        const isCurrent = () => entries.get(key) === entry && entry.loadPromise === promise;
        let credentialReadCompleted = false;
        try {
            let currentIdentity: ProviderAccountUsageOrganizationContext | null = null;
            const usageIdentity = getConnectedServiceUsageIdentity(context.ref.service) ?? undefined;
            const requiresOrganization = usageIdentity?.requiredContext === 'organization'
                || Boolean(entry.snapshot?.providerOrganizationId);
            if (requiresOrganization || credentialMutation) {
                currentIdentity = await readQualifiedConnectedAccountQuotaCredentialContext(context);
                if (!isCurrent()) return null;
                credentialReadCompleted = true;
                // An opaque unknown-user observation may be valid generally; it
                // cannot establish continuity after a known credential replacement.
                if (entry.snapshot && (credentialMutation && !currentIdentity.providerAccountId
                    || !isProviderAccountUsageIdentityMatch(entry.snapshot, currentIdentity, usageIdentity))) {
                    clearSnapshot(entry);
                    publish(key, entry);
                }
            }
            if (credentialMutation) {
                // Authentication already succeeded. Only establish its identity here;
                // quota acquisition remains with the existing observed load lifecycle.
                entry.nextFetchAtMs = getUsageProjectionNextReadAtMs();
                if (!entry.snapshot) {
                    entry.loadAttempted = false;
                    entry.observation?.invalidate();
                }
                return entry.snapshot;
            }
            const read = requiresOrganization && (!currentIdentity?.providerAccountId || !currentIdentity.providerOrganizationId)
                ? null : await readQualifiedConnectedAccountQuota(context);
            if (!isCurrent()) return null;
            let snapshot = read?.snapshot ?? null;
            if (snapshot?.providerOrganizationId && !requiresOrganization) {
                currentIdentity = await readQualifiedConnectedAccountQuotaCredentialContext(context);
                if (!isCurrent()) return null;
                credentialReadCompleted = true;
                if (entry.snapshot && !isProviderAccountUsageIdentityMatch(entry.snapshot, currentIdentity, usageIdentity)) clearSnapshot(entry);
            }
            let admitted = true;
            if (snapshot && !isProviderAccountUsageIdentityMatch(snapshot, currentIdentity, usageIdentity)) {
                admitted = false;
                snapshot = null;
                clearSnapshot(entry);
            }
            entry.snapshot = snapshot ?? (entry.refreshing ? entry.snapshot : null);
            entry.usageRecordId = admitted ? read?.recordId ?? (entry.refreshing ? entry.usageRecordId : null) : null;
            const diagnostic = read?.diagnostics?.find((value) => value.kind === 'provider_http');
            // The producer removes this fact when acquisition settles, including
            // writes that preserve the snapshot's material and timestamp.
            entry.producerRefreshPending = read?.refreshRequestedAt !== undefined;
            // An absent producer observation says nothing about quota capability.
            // Manual refresh still goes through the canonical runtime admission.
            if (snapshot) entry.supported = true;
            entry.error = null;
            if (read?.status === 'error') {
                // Provider messages/headers stay diagnostic-only, never user-facing copy.
                const error = `${t('connectedServices.errors.quotaRefreshFailed')}${diagnostic?.status ? ` (HTTP ${diagnostic.status})` : ''}`;
                entry.error = typeof diagnostic?.retryAtMs === 'number'
                    ? t('connectedServices.errors.quotaRefreshRetryAt', {
                        error,
                        time: new Date(diagnostic.retryAtMs).toLocaleString(),
                    })
                    : error;
            }
            entry.nextFetchAtMs = getUsageProjectionNextReadAtMs();
            if (entry.refreshSinceFetchedAt !== null && read && !entry.producerRefreshPending) {
                entry.refreshing = false;
                entry.refreshSinceFetchedAt = null;
            }
            return snapshot;
        } catch (error) {
            if (!isCurrent()) return null;
            // A connected receipt proves a new credential, but an unreadable replacement
            // context is unknown. Ordinary background read failures retain verified data.
            if (credentialMutation && !credentialReadCompleted) clearSnapshot(entry);
            // Offline/provider errors retain presentation; an authoritative
            // Account refusal retires the admission and its protected bytes.
            if (error instanceof ConnectedServiceApiError && (error.status === 401 || error.status === 403)) {
                entry.supported = false;
                entry.snapshot = null;
                entry.usageRecordId = null;
            }
            entry.producerRefreshPending = false;
            entry.error = resolveConnectedServiceSettingsErrorMessage(error);
            entry.nextFetchAtMs = getUsageProjectionNextReadAtMs();
            return null;
        } finally {
            if (isCurrent()) {
                entry.loading = false;
                if (entry.refreshSinceFetchedAt !== null && entry.error) {
                    entry.refreshing = false;
                    entry.refreshSinceFetchedAt = null;
                }
                entry.loadPromise = null;
                publish(key, entry);
                entry.observation?.reconcile();
            }
        }
    });
    entry.loadPromise = promise;
    return promise;
}

export function getQualifiedQuotaSnapshotEntry(
    key: string | null,
): QualifiedQuotaSnapshotStoreEntry {
    if (!key) return EMPTY_VIEW;
    return entries.get(key)?.view ?? EMPTY_VIEW;
}

export function subscribeQualifiedQuotaSnapshotEntry(
    key: string | null,
    listener: () => void,
): () => void {
    if (!key) return () => {};
    let listeners = listenersByKey.get(key);
    if (!listeners) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) listenersByKey.delete(key);
        const entry = entries.get(key);
        if (entry && !hasPollingDemand(key, entry)) {
            entry.refreshSinceFetchedAt = null;
            entry.refreshing = false;
            publish(key, entry);
            reconcilePolling(key);
        }
    };
}

/** Read an account's snapshot once per launch (if nothing was read yet) without polling. */
export function loadQualifiedQuotaSnapshotOnce(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): () => void {
    const entry = getOrCreateEntry(key);
    entry.pollContext = context;
    entry.credentialScope = context.credentialScope;
    evictEntriesOutsideCredentialScope(context.credentialScope);
    if (!entry.loadAttempted) {
        entry.loadAttempted = true;
        void runLoad(key, context);
    }
    return () => {};
}

/** Recovery already refreshed the provider and persisted its usage; only read that result. */
export async function reloadQualifiedQuotaSnapshotAfterRecovery(input: Readonly<{
    ref: QualifiedConnectedAccountRef;
    serverBasis: QualifiedQuotaSnapshotStoreContext['serverBasis'];
}>): Promise<void> {
    await Promise.all([...entries].flatMap(([key, entry]) => {
        const context = entry.pollContext;
        if (!context
            || context.serverBasis.serverId !== input.serverBasis.serverId
            || context.serverBasis.generation !== input.serverBasis.generation
            || context.ref.service.pluginId !== input.ref.service.pluginId
            || context.ref.service.localId !== input.ref.service.localId
            || context.ref.accountId !== input.ref.accountId) return [];
        return [(async () => {
            await entry.loadPromise;
            await runLoad(key, context);
        })()];
    }));
}

/** A connected receipt proves replacement, but does not identify its new organization. */
export async function revalidateQualifiedQuotaSnapshotAfterCredentialChange(input: Readonly<{
    ref: QualifiedConnectedAccountRef;
    serverBasis: QualifiedQuotaSnapshotStoreContext['serverBasis'];
    accountId?: string;
}>): Promise<void> {
    await Promise.all([...entries].flatMap(([key, entry]) => {
        const context = entry.pollContext;
        if (!context || context.serverBasis.serverId !== input.serverBasis.serverId
            || context.serverBasis.generation !== input.serverBasis.generation
            || input.accountId !== undefined && parseToken(context.credentials.token) !== input.accountId
            || !sameQualifiedConnectedAccountRef(context.ref, input.ref)) return [];
        retirePendingReads(entry);
        return [runLoad(key, context, true)];
    }));
}

export function retainQualifiedQuotaSnapshotPolling(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): () => void {
    const entry = getOrCreateEntry(key);
    entry.retainCount += 1;
    entry.pollContext = context;
    entry.credentialScope = context.credentialScope;
    evictEntriesOutsideCredentialScope(context.credentialScope);
    reconcilePolling(key);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (entries.get(key) !== entry) return;
        entry.retainCount = Math.max(0, entry.retainCount - 1);
        if (!hasPollingDemand(key, entry)) {
            entry.refreshSinceFetchedAt = null;
            entry.refreshing = false;
            publish(key, entry);
            entry.observation?.dispose();
            entry.observation = null;
        }
    };
}

export async function refreshQualifiedQuotaSnapshot(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): Promise<void> {
    const entry = getOrCreateEntry(key);
    const previousRefresh = entry.refreshPromise;
    if (previousRefresh && entry.refreshing) return previousRefresh;
    if (entry.refreshing) return;
    entry.pollContext = context;
    entry.credentialScope = context.credentialScope;
    // The last-known-good snapshot stays visible for the whole refresh:
    // `refreshing` is the in-flight signal, and blanking here would flash an
    // empty gauge on every manual refresh.
    entry.refreshing = true;
    entry.error = null;
    publish(key, entry);

    const promise = Promise.resolve(previousRefresh).then(async () => {
        try {
            // Cancelled admission cannot complete a later explicit intent.
            if (entry.refreshPromise !== promise || !entry.refreshing) return;
            await refreshQualifiedConnectedAccountQuota(context);
            if (entry.refreshPromise !== promise || !entry.refreshing) return;
            // Only reads issued after the accepted request may settle it. An older GET
            // may still land its data first, but is no longer current once this read starts.
            entry.refreshSinceFetchedAt = entry.snapshot?.fetchedAt ?? 0;
            entry.loadPromise = null;
            await runLoad(key, context);
        } catch (error) {
            if (entry.refreshPromise !== promise || !entry.refreshing) return;
            if (readConnectedServiceSettingsErrorCode(error) === 'connected_account_v4_operation_unsupported') {
                entry.supported = false;
            }
            entry.producerRefreshPending = false;
            entry.error = resolveConnectedServiceSettingsErrorMessage(error);
            entry.refreshSinceFetchedAt = null;
            entry.refreshing = false;
        } finally {
            if (entry.refreshPromise === promise) {
                entry.refreshPromise = null;
                if (!hasPollingDemand(key, entry)) {
                    entry.refreshSinceFetchedAt = null;
                    entry.refreshing = false;
                }
                publish(key, entry);
                reconcilePolling(key, entry.refreshSinceFetchedAt !== null && entry.error === null);
            }
        }
    });
    entry.refreshPromise = promise;
    return promise;
}

export function __resetQualifiedConnectedAccountQuotaSnapshotStore(): void {
    for (const entry of entries.values()) entry.observation?.dispose();
    entries.clear();
    listenersByKey.clear();
    detachProfileChanges?.();
    detachProfileChanges = null;
}
