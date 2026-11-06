import {
    getConnectedServiceQuotaSnapshotSealed,
    requestConnectedServiceQuotaSnapshotRefresh,
} from '@/sync/api/account/apiConnectedServicesQuotasV2';
import {
    getConnectedServiceQuotaSnapshotPlain,
    requestConnectedServiceQuotaSnapshotRefreshV3,
} from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { openConnectedServiceQuotaViewSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaViewSnapshot';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { getUsageProjectionNextReadAtMs, observeUsageProjection } from '@/sync/api/account/usageQueryInvalidation';
import {
    connectedServiceQuotaRecoveryCreditConsume,
} from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type {
    ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import type { CredentialScopedAccountMode } from './useCredentialScopedAccountModeResolver';
import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedServiceId,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { t } from '@/text';

/**
 * Shared, module-level loader cache for connected-service quota snapshots.
 *
 * The same account rendered in multiple mounted blocks must NOT duplicate
 * fetches, so the per-account loader is centralized here and keyed by the full
 * scope (credential scope + serviceId + profileId). Every `isCurrentLoadScope` guard
 * from the original loader is preserved as an `isScopeActive` check so a
 * credential change can never let a stale in-flight request choose the wrong
 * endpoint or commit the wrong snapshot.
 */

export type QuotaSnapshotStoreEntry = Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    loading: boolean;
    error: string | null;
    /** True until the producer settles the requested refresh, it fails, or is cancelled. */
    refreshing: boolean;
    /** A read has completed (with or without a snapshot): "no snapshot" is then an answer, not a wait. */
    read: boolean;
}>;

export type LegacyQuotaSnapshotLoadContext = Readonly<{
    transport?: 'legacy';
    credentials: AuthCredentials;
    credentialScope: string;
    serverBasis: ExpectedActiveServerFetchBasis;
    serviceId: ConnectedServiceId;
    profileId: string;
    resolveAccountMode: () => Promise<CredentialScopedAccountMode>;
}>;

export type QuotaSnapshotLoadContext = LegacyQuotaSnapshotLoadContext;

export type QuotaSnapshotRefreshContext = QuotaSnapshotLoadContext & Readonly<{
    assertOperationAllowed(
        operation: BuiltInLegacyConnectedAccountOperation,
        signal?: AbortSignal,
    ): Promise<void>;
}>;

export type QuotaRecoveryConsumeContext =
    QuotaSnapshotRefreshContext & Readonly<{
    machineId: string;
    providerCreditId?: string | null;
    signal?: AbortSignal;
}>;

export type QuotaRecoveryConsumeResult =
    | Readonly<{ ok: true; receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>
    | Readonly<{ ok: false; error: string; receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>;

type InternalEntry = {
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    loading: boolean;
    error: string | null;
    refreshing: boolean;
    /** Credential scope this entry was last retained for; drives eviction. */
    credentialScope: string | null;
    loadAttempted: boolean;
    nextFetchAtMs: number;
    loadPromise: Promise<ConnectedServiceQuotaSnapshotV1 | null> | null;
    refreshPromise: Promise<void> | null;
    refreshController: AbortController | null;
    refreshSinceFetchedAt: number | null;
    pollRetainCount: number;
    observation: ReturnType<typeof observeUsageProjection> | null;
    pollContext: QuotaSnapshotLoadContext | null;
    /** Public, immutable projection handed to subscribers (stable when unchanged). */
    view: QuotaSnapshotStoreEntry;
};


const EMPTY_VIEW: QuotaSnapshotStoreEntry = { snapshot: null, loading: false, error: null, refreshing: false, read: false };

const entries = new Map<string, InternalEntry>();
const listenersByKey = new Map<string, Set<() => void>>();

const activeCredentialScopeRetainCounts = new Map<string, number>();

export function buildQuotaSnapshotScopeKey(
    credentialScope: string,
    serviceId: ConnectedServiceId,
    profileId: string,
): string {
    return [credentialScope, connectedServiceProfileKey({ serviceId, profileId })].join(' ');
}

function getOrCreateEntry(key: string): InternalEntry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: InternalEntry = {
        snapshot: null,
        loading: false,
        error: null,
        refreshing: false,
        credentialScope: null,
        loadAttempted: false,
        nextFetchAtMs: 0,
        loadPromise: null,
        refreshPromise: null,
        refreshController: null,
        refreshSinceFetchedAt: null,
        pollRetainCount: 0,
        observation: null,
        pollContext: null,
        view: EMPTY_VIEW,
    };
    entries.set(key, created);
    return created;
}

function notify(key: string): void {
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function publish(key: string, entry: InternalEntry): void {
    entry.view = {
        snapshot: entry.snapshot,
        loading: entry.loading,
        error: entry.error,
        refreshing: entry.refreshing,
        read: entry.loadAttempted && !entry.loading,
    };
    notify(key);
}

function isScopeActive(credentialScope: string): boolean {
    return (activeCredentialScopeRetainCounts.get(credentialScope) ?? 0) > 0;
}

function retainCredentialScope(credentialScope: string): () => void {
    activeCredentialScopeRetainCounts.set(
        credentialScope,
        (activeCredentialScopeRetainCounts.get(credentialScope) ?? 0) + 1,
    );
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next =
            (activeCredentialScopeRetainCounts.get(credentialScope) ?? 0) - 1;
        if (next > 0) {
            activeCredentialScopeRetainCounts.set(credentialScope, next);
        } else {
            activeCredentialScopeRetainCounts.delete(credentialScope);
        }
    };
}

function hasPollingDemand(key: string, entry: InternalEntry): boolean {
    // Cached surfaces do not poll normally; an explicit refresh stays live while observed.
    return entry.pollRetainCount > 0 || (entry.refreshing && (listenersByKey.get(key)?.size ?? 0) > 0);
}

function reconcilePolling(key: string, initialReadCompleted = false): void {
    const entry = entries.get(key);
    if (!entry) return;
    const ctx = entry.pollContext;
    if (!hasPollingDemand(key, entry) || !ctx || !isScopeActive(ctx.credentialScope)) {
        entry.observation?.dispose();
        entry.refreshController?.abort();
        entry.observation = null;
        return;
    }
    if (!entry.observation) entry.observation = observeUsageProjection({
        serverId: ctx.serverBasis.serverId,
        initialReadCompleted,
        read: () => { entry.loadAttempted = true; return runLoad(key, ctx); },
        busy: () => Boolean(entry.loadPromise || entry.refreshPromise),
        nextReadAtMs: () => entry.nextFetchAtMs,
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
function evictEntriesOutsideCredentialScope(activeCredentialScope: string): void {
    for (const [key, entry] of entries) {
        if (hasPollingDemand(key, entry)) continue;
        if (entry.credentialScope === activeCredentialScope) continue;
        entry.observation?.dispose();
        entries.delete(key);
    }
}

export function getQuotaSnapshotEntry(key: string | null): QuotaSnapshotStoreEntry {
    if (!key) return EMPTY_VIEW;
    return entries.get(key)?.view ?? EMPTY_VIEW;
}

export function subscribeQuotaSnapshotEntry(key: string | null, listener: () => void): () => void {
    if (!key) return () => {};
    let listeners = listenersByKey.get(key);
    if (!listeners) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners && listeners.size === 0) listenersByKey.delete(key);
        const entry = entries.get(key);
        if (entry && !hasPollingDemand(key, entry)) {
            entry.refreshController?.abort();
            entry.refreshSinceFetchedAt = null;
            entry.refreshing = false;
            publish(key, entry);
            reconcilePolling(key);
        }
    };
}

async function runLoad(key: string, ctx: QuotaSnapshotLoadContext, signal?: AbortSignal): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    const entry = getOrCreateEntry(key);
    if (entry.loadPromise) return entry.loadPromise;
    if (!isScopeActive(ctx.credentialScope)) return null;
    entry.loading = true;
    entry.error = null;
    publish(key, entry);

    const promise = Promise.resolve().then(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        const isCurrent = () => entries.get(key) === entry && entry.loadPromise === promise;
        try {
            const mode = await ctx.resolveAccountMode();
            if (!isCurrent() || !isScopeActive(ctx.credentialScope)) return null;
            // A read is the server's GET: the server decides the route and storage mode (404/409),
            // so no machine is asked. Daemon-executed operations (refresh, recovery) stay admitted.

            if (mode === 'plain') {
                const read = await getConnectedServiceQuotaSnapshotPlain(ctx.credentials, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                }, {
                    expectedActiveServer: ctx.serverBasis,
                    ...(signal ? { signal } : {}),
                });
                if (!isCurrent() || !isScopeActive(ctx.credentialScope)) return null;
                const opened = read?.snapshot ?? null;
                entry.snapshot = opened ?? (entry.refreshing ? entry.snapshot : null);
                entry.nextFetchAtMs = getUsageProjectionNextReadAtMs({
                    legacyStaleAfterMs: read?.metadata.staleAfterMs });
                if (entry.refreshSinceFetchedAt !== null && read && read.metadata.refreshRequestedAt === undefined) {
                    entry.refreshing = false;
                    entry.refreshSinceFetchedAt = null;
                }
                return opened;
            }

            const sealed = await getConnectedServiceQuotaSnapshotSealed(ctx.credentials, {
                serviceId: ctx.serviceId,
                profileId: ctx.profileId,
            }, {
                expectedActiveServer: ctx.serverBasis,
                ...(signal ? { signal } : {}),
            });
            if (!isCurrent() || !isScopeActive(ctx.credentialScope)) return null;
            const opened = sealed
                ? openConnectedServiceQuotaViewSnapshot(ctx.credentials, sealed.sealed, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                })
                : null;
            entry.snapshot = opened ?? (entry.refreshing ? entry.snapshot : null);
            entry.nextFetchAtMs = getUsageProjectionNextReadAtMs({
                legacyStaleAfterMs: sealed?.metadata.staleAfterMs });
            if (entry.refreshSinceFetchedAt !== null && sealed && sealed.metadata.refreshRequestedAt === undefined) {
                entry.refreshing = false;
                entry.refreshSinceFetchedAt = null;
            }
            return opened;
        } catch (error) {
            if (!isCurrent() || !isScopeActive(ctx.credentialScope)) return null;
            entry.error = sanitizeEndpointErrorMessage(error) ?? t('common.error');
            entry.nextFetchAtMs = getUsageProjectionNextReadAtMs();
            if (!entry.snapshot) entry.snapshot = null;
            return null;
        } finally {
            if (isCurrent()) {
                entry.loading = false;
                if (entry.refreshSinceFetchedAt !== null) {
                    if (entry.error) {
                        entry.refreshing = false;
                        entry.refreshSinceFetchedAt = null;
                    }
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

/**
 * Read an account's snapshot once per launch (if nothing was read yet) without polling; the credential
 * scope stays live while the caller is mounted so the answer lands.
 */
export function retainQuotaSnapshotOnce(key: string, ctx: QuotaSnapshotLoadContext): () => void {
    const releaseCredentialScope = retainCredentialScope(ctx.credentialScope);
    const entry = getOrCreateEntry(key);
    entry.credentialScope = ctx.credentialScope;
    evictEntriesOutsideCredentialScope(ctx.credentialScope);
    if (!entry.loadAttempted) {
        entry.loadAttempted = true;
        void runLoad(key, ctx);
    }
    return releaseCredentialScope;
}

export function retainQuotaSnapshotPolling(key: string, ctx: QuotaSnapshotLoadContext): () => void {
    const releaseCredentialScope = retainCredentialScope(ctx.credentialScope);
    const entry = getOrCreateEntry(key);
    entry.pollRetainCount += 1;
    entry.pollContext = ctx;
    entry.credentialScope = ctx.credentialScope;
    evictEntriesOutsideCredentialScope(ctx.credentialScope);

    reconcilePolling(key);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCredentialScope();
        const current = entries.get(key);
        if (current !== entry) return;
        current.pollRetainCount = Math.max(0, current.pollRetainCount - 1);
        if (!hasPollingDemand(key, current)) {
            current.refreshController?.abort();
            current.pollContext = null;
            current.observation?.dispose();
            current.observation = null;
            current.refreshSinceFetchedAt = null;
            current.refreshing = false;
            publish(key, current);
        }
    };
}

export async function refreshQuotaSnapshot(key: string, ctx: QuotaSnapshotRefreshContext): Promise<void> {
    const entry = getOrCreateEntry(key);
    const previousRefresh = entry.refreshPromise;
    if (previousRefresh && entry.refreshing) {
        await previousRefresh;
        return;
    }
    if (entry.refreshing) return;

    if (!isScopeActive(ctx.credentialScope)) return;
    entry.pollContext = ctx;
    const controller = new AbortController();
    entry.refreshController = controller;
    entry.refreshing = true;
    entry.error = null;
    publish(key, entry);
    const promise = Promise.resolve(previousRefresh).then(async () => {
        // A new intent waits for the cancelled request without inheriting its completion.
        if (entry.refreshPromise !== promise || !entry.refreshing || !isScopeActive(ctx.credentialScope)) return;
        try {
            const mode = await ctx.resolveAccountMode();
            if (entry.refreshPromise !== promise || !isScopeActive(ctx.credentialScope) || !entry.refreshing) return;
            await ctx.assertOperationAllowed('quota_refresh', controller.signal);
            if (entry.refreshPromise !== promise || !isScopeActive(ctx.credentialScope) || !entry.refreshing) return;
            const ok = await (mode === 'plain'
                ? requestConnectedServiceQuotaSnapshotRefreshV3(
                    ctx.credentials,
                    {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    },
                    { expectedActiveServer: ctx.serverBasis, signal: controller.signal },
                )
                : requestConnectedServiceQuotaSnapshotRefresh(
                    ctx.credentials,
                    {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    },
                    { expectedActiveServer: ctx.serverBasis, signal: controller.signal },
                ));
            if (!ok) throw new Error(t('common.error'));
            if (entry.refreshPromise !== promise || !isScopeActive(ctx.credentialScope) || !entry.refreshing) return;
            // Only reads issued after the accepted request may settle it. An older GET
            // may still land its data first, but is no longer current once this read starts.
            entry.refreshSinceFetchedAt = entry.snapshot?.fetchedAt ?? 0;
            entry.loadPromise = null;
            await runLoad(key, ctx, controller.signal);
        } catch (error) {
            if (entry.refreshPromise !== promise || !isScopeActive(ctx.credentialScope) || !entry.refreshing) return;
            entry.error = sanitizeEndpointErrorMessage(error) ?? t('common.error');
            entry.refreshSinceFetchedAt = null;
            entry.refreshing = false;
        }
    });

    entry.refreshPromise = promise;
    try {
        await promise;
    } finally {
        if (entry.refreshPromise === promise) {
            entry.refreshController = null;
            entry.refreshPromise = null;
            if (!isScopeActive(ctx.credentialScope) || !hasPollingDemand(key, entry)) {
                entry.refreshSinceFetchedAt = null;
                entry.refreshing = false;
            }
            publish(key, entry);
            reconcilePolling(key, entry.refreshSinceFetchedAt !== null && entry.error === null);
        }
    }
}

export async function consumeQuotaRecoveryCredit(
    key: string,
    ctx: QuotaRecoveryConsumeContext,
): Promise<QuotaRecoveryConsumeResult> {
    const entry = getOrCreateEntry(key);
    try {
        await ctx.assertOperationAllowed('recovery_credit_consume', ctx.signal);
        if (!isScopeActive(ctx.credentialScope)) {
            return {
                ok: false,
                error: t('common.error'),
            };
        }
        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: ctx.machineId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            serverId: ctx.serverBasis.serverId,
            expectedActiveServer: ctx.serverBasis,
            serviceId: ctx.serviceId,
            profileId: ctx.profileId,
            sourceSnapshotFetchedAtMs: entry.snapshot?.fetchedAt ?? null,
            ...(ctx.providerCreditId ? { providerCreditId: ctx.providerCreditId } : {}),
        });
        if (result.ok) {
            entry.snapshot = result.snapshot;
            entry.error = null;
            publish(key, entry);
            return { ok: true, receipt: result.receipt };
        }
        return {
            ok: false,
            error: result.error || result.errorCode,
            ...(result.receipt ? { receipt: result.receipt } : {}),
        };
    } catch (error) {
        return { ok: false, error: sanitizeEndpointErrorMessage(error) ?? t('common.error') };
    }
}

/** Test-only: clear the module-level cache and active credential-scope leases. */
export function __resetConnectedServiceQuotaSnapshotStore(): void {
    for (const entry of entries.values()) {
        entry.observation?.dispose();
        entry.refreshController?.abort();
    }
    entries.clear();
    listenersByKey.clear();
    activeCredentialScopeRetainCounts.clear();
}
