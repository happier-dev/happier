import type {
    ProviderAccountUsageRecordId,
    QualifiedConnectedAccountRef,
    QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { t } from '@/text';
import { ConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';

import {
    readConnectedServiceSettingsErrorCode,
    resolveConnectedServiceSettingsErrorMessage,
} from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import {
    computeConnectedServiceQuotaErrorBackoffMs,
} from '@/sync/domains/connectedServices/connectedServiceQuotaErrorBackoff';

import {
    readQualifiedConnectedAccountQuota,
    refreshQualifiedConnectedAccountQuota,
    type QualifiedConnectedAccountQuotaTransportContext,
} from './qualifiedConnectedAccountQuotaTransport';

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
    loadAttempted: boolean;
    loadPromise:
        Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> | null;
    refreshPromise: Promise<void> | null;
    nextFetchAtMs: number;
    consecutiveErrors: number;
    retainCount: number;
    pollTimer: ReturnType<typeof setTimeout> | null;
    pollContext: QualifiedQuotaSnapshotStoreContext | null;
    view: QualifiedQuotaSnapshotStoreEntry;
};

const QUOTA_SNAPSHOT_POLL_MS = 30_000;
const QUOTA_SNAPSHOT_MISS_RETRY_MS = 30_000;
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
let detachRuntimeActivity: (() => void) | null = null;

function ensureRuntimeActivityWatcher(): void {
    if (detachRuntimeActivity) return;
    let wasActive = isRuntimeActive();
    detachRuntimeActivity = subscribeToRuntimeActiveChange(() => {
        const active = isRuntimeActive();
        if (active === wasActive) return;
        wasActive = active;
        for (const [key, entry] of entries) {
            clearPollTimer(entry);
            if (!active || entry.retainCount <= 0 || !entry.pollContext) continue;
            // Returning to the surface invalidates freshness even before its cadence expires.
            entry.nextFetchAtMs = 0;
            entry.loadAttempted = true;
            if (!entry.loadPromise && !entry.refreshPromise) void runLoad(key, entry.pollContext);
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
        loadAttempted: false,
        loadPromise: null,
        refreshPromise: null,
        nextFetchAtMs: 0,
        consecutiveErrors: 0,
        retainCount: 0,
        pollTimer: null,
        pollContext: null,
        view: EMPTY_VIEW,
    };
    entries.set(key, created);
    return created;
}

function publish(key: string, entry: InternalEntry): void {
    entry.view = Object.freeze({
        snapshot: entry.snapshot,
        usageRecordId: entry.usageRecordId,
        supported: entry.supported,
        loading: entry.loading,
        refreshing: entry.refreshing,
        error: entry.error,
        read: entry.loadAttempted && !entry.loading,
    });
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function clearPollTimer(entry: InternalEntry): void {
    if (!entry.pollTimer) return;
    clearTimeout(entry.pollTimer);
    entry.pollTimer = null;
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
        if (entry.retainCount > 0) continue;
        if (entry.credentialScope === activeCredentialScope) continue;
        clearPollTimer(entry);
        entries.delete(key);
    }
}

function schedulePolling(key: string): void {
    const entry = entries.get(key);
    if (entry) clearPollTimer(entry);
    if (
        !entry
        || entry.retainCount <= 0
        || entry.loadPromise
        || entry.refreshPromise
        || !entry.pollContext
        || !isRuntimeActive()
    ) return;
    entry.pollTimer = setTimeout(() => {
        entry.pollTimer = null;
        if (
            entry.retainCount <= 0
            || entry.loadPromise
            || entry.refreshPromise
            || !entry.pollContext
            || !isRuntimeActive()
        ) return;
        void runLoad(key, entry.pollContext);
    }, Math.max(0, entry.nextFetchAtMs - Date.now()));
}

async function runLoad(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> {
    const entry = getOrCreateEntry(key);
    if (entry.loadPromise) return entry.loadPromise;
    clearPollTimer(entry);
    entry.loading = true;
    entry.error = null;
    publish(key, entry);

    const promise = (async () => {
        try {
            const read =
                await readQualifiedConnectedAccountQuota(context);
            const snapshot = read?.snapshot ?? null;
            entry.snapshot = snapshot;
            entry.usageRecordId = read?.recordId ?? null;
            // An absent producer observation says nothing about quota capability.
            // Manual refresh still goes through the canonical runtime admission.
            if (snapshot) entry.supported = true;
            entry.error = null;
            if (read?.status === 'error') {
                const diagnostic = snapshot?.diagnostics?.find((value) => value.kind === 'provider_http');
                // Provider messages/headers stay diagnostic-only, never user-facing copy.
                const error = `${t('connectedServices.errors.quotaRefreshFailed')}${diagnostic?.status ? ` (HTTP ${diagnostic.status})` : ''}`;
                entry.error = typeof diagnostic?.retryAtMs === 'number'
                    ? t('connectedServices.errors.quotaRefreshRetryAt', {
                        error,
                        time: new Date(diagnostic.retryAtMs).toLocaleString(),
                    })
                    : error;
            }
            entry.consecutiveErrors = 0;
            entry.nextFetchAtMs = Date.now() + (
                snapshot
                    ? Math.max(
                        QUOTA_SNAPSHOT_POLL_MS,
                        Math.trunc(
                            snapshot.staleAfterMs
                            ?? QUOTA_SNAPSHOT_POLL_MS,
                        ),
                    )
                    : QUOTA_SNAPSHOT_MISS_RETRY_MS
            );
            return snapshot;
        } catch (error) {
            // Offline/provider errors retain presentation; an authoritative
            // Account refusal retires the admission and its protected bytes.
            if (error instanceof ConnectedServiceApiError && (error.status === 401 || error.status === 403)) {
                entry.supported = false;
                entry.snapshot = null;
                entry.usageRecordId = null;
            }
            entry.error = resolveConnectedServiceSettingsErrorMessage(error);
            entry.consecutiveErrors += 1;
            entry.nextFetchAtMs = Date.now()
                + computeConnectedServiceQuotaErrorBackoffMs(
                    entry.consecutiveErrors,
                );
            return null;
        } finally {
            entry.loading = false;
            entry.loadPromise = null;
            publish(key, entry);
            schedulePolling(key);
        }
    })();
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

export function retainQualifiedQuotaSnapshotPolling(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): () => void {
    const entry = getOrCreateEntry(key);
    entry.retainCount += 1;
    ensureRuntimeActivityWatcher();
    entry.pollContext = context;
    entry.credentialScope = context.credentialScope;
    evictEntriesOutsideCredentialScope(context.credentialScope);
    if (isRuntimeActive() && (
        !entry.loadAttempted
        || (!entry.loadPromise && Date.now() >= entry.nextFetchAtMs)
    )) {
        entry.loadAttempted = true;
        void runLoad(key, context);
    } else {
        schedulePolling(key);
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (entries.get(key) !== entry) return;
        entry.retainCount = Math.max(0, entry.retainCount - 1);
        if (entry.retainCount === 0) {
            clearPollTimer(entry);
        }
        if (![...entries.values()].some((retained) => retained.retainCount > 0)) {
            detachRuntimeActivity?.();
            detachRuntimeActivity = null;
        }
    };
}

export async function refreshQualifiedQuotaSnapshot(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): Promise<void> {
    const entry = getOrCreateEntry(key);
    if (entry.refreshPromise) return entry.refreshPromise;
    clearPollTimer(entry);
    // The last-known-good snapshot stays visible for the whole refresh:
    // `refreshing` is the in-flight signal, and blanking here would flash an
    // empty gauge on every manual refresh.
    entry.refreshing = true;
    entry.error = null;
    publish(key, entry);

    const promise = (async () => {
        try {
            await entry.loadPromise;
            await refreshQualifiedConnectedAccountQuota(context);
            await runLoad(key, context);
        } catch (error) {
            if (readConnectedServiceSettingsErrorCode(error) === 'connected_account_v4_operation_unsupported') {
                entry.supported = false;
            }
            entry.error = resolveConnectedServiceSettingsErrorMessage(error);
        } finally {
            entry.refreshPromise = null;
            entry.refreshing = false;
            publish(key, entry);
            schedulePolling(key);
        }
    })();
    entry.refreshPromise = promise;
    return promise;
}

export function __resetQualifiedConnectedAccountQuotaSnapshotStore(): void {
    detachRuntimeActivity?.();
    detachRuntimeActivity = null;
    for (const entry of entries.values()) clearPollTimer(entry);
    entries.clear();
    listenersByKey.clear();
}
