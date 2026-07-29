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
    /** True for the lifetime of a `refreshQuotaSnapshot` (server refresh + poll). */
    refreshing: boolean;
}>;

export type LegacyQuotaSnapshotLoadContext = Readonly<{
    transport?: 'legacy';
    credentials: AuthCredentials;
    credentialScope: string;
    serverBasis: ExpectedActiveServerFetchBasis;
    serviceId: ConnectedServiceId;
    profileId: string;
    resolveAccountMode: () => Promise<CredentialScopedAccountMode>;
    assertOperationAllowed(
        operation: BuiltInLegacyConnectedAccountOperation,
    ): Promise<void>;
}>;

export type QuotaSnapshotLoadContext = LegacyQuotaSnapshotLoadContext;

export type QuotaRecoveryConsumeContext =
    LegacyQuotaSnapshotLoadContext & Readonly<{
    machineId: string;
    providerCreditId?: string | null;
}>;

export type QuotaRecoveryConsumeResult =
    | Readonly<{ ok: true; receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>
    | Readonly<{ ok: false; error: string; receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>;

type InternalEntry = {
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    loading: boolean;
    error: string | null;
    refreshing: boolean;
    loadAttempted: boolean;
    nextFetchAtMs: number;
    consecutiveErrors: number;
    loadPromise: Promise<ConnectedServiceQuotaSnapshotV1 | null> | null;
    refreshPromise: Promise<void> | null;
    pollRetainCount: number;
    pollTimer: ReturnType<typeof setTimeout> | null;
    pollContext: QuotaSnapshotLoadContext | null;
    /** Public, immutable projection handed to subscribers (stable when unchanged). */
    view: QuotaSnapshotStoreEntry;
};

const REFRESH_RELOAD_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 3_000, 4_000] as const;
const QUOTA_SNAPSHOT_POLL_MS = 30_000;
const QUOTA_SNAPSHOT_MISS_RETRY_MS = 30_000;
const QUOTA_SNAPSHOT_ERROR_BACKOFF_MIN_MS = 30_000;
const QUOTA_SNAPSHOT_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

const EMPTY_VIEW: QuotaSnapshotStoreEntry = { snapshot: null, loading: false, error: null, refreshing: false };

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
        loadAttempted: false,
        nextFetchAtMs: 0,
        consecutiveErrors: 0,
        loadPromise: null,
        refreshPromise: null,
        pollRetainCount: 0,
        pollTimer: null,
        pollContext: null,
        view: EMPTY_VIEW,
    };
    entries.set(key, created);
    return created;
}

function computeErrorBackoffMs(consecutiveErrors: number): number {
    const exp = QUOTA_SNAPSHOT_ERROR_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, consecutiveErrors - 1));
    return Math.max(
        QUOTA_SNAPSHOT_ERROR_BACKOFF_MIN_MS,
        Math.min(QUOTA_SNAPSHOT_ERROR_BACKOFF_MAX_MS, Math.trunc(exp)),
    );
}

function notify(key: string): void {
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function publish(key: string, entry: InternalEntry): void {
    entry.view = { snapshot: entry.snapshot, loading: entry.loading, error: entry.error, refreshing: entry.refreshing };
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

function sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearPollTimer(entry: InternalEntry): void {
    if (!entry.pollTimer) return;
    clearTimeout(entry.pollTimer);
    entry.pollTimer = null;
}

function schedulePolling(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    clearPollTimer(entry);
    if (entry.pollRetainCount <= 0 || entry.loadPromise || entry.refreshPromise) return;
    if (!entry.pollContext || !isScopeActive(entry.pollContext.credentialScope)) return;

    const delayMs = Math.max(0, entry.nextFetchAtMs - Date.now());
    entry.pollTimer = setTimeout(() => {
        entry.pollTimer = null;
        const latest = entries.get(key);
        if (!latest || latest.pollRetainCount <= 0 || latest.loadPromise || latest.refreshPromise) return;
        const ctx = latest.pollContext;
        if (!ctx || !isScopeActive(ctx.credentialScope)) return;
        latest.loadAttempted = true;
        void runLoad(key, ctx);
    }, delayMs);
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
    };
}

async function runLoad(key: string, ctx: QuotaSnapshotLoadContext): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    const entry = getOrCreateEntry(key);
    if (entry.loadPromise) return entry.loadPromise;
    clearPollTimer(entry);

    const promise = (async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        if (!isScopeActive(ctx.credentialScope)) return null;
        entry.loading = true;
        entry.error = null;
        publish(key, entry);
        try {
            const mode = await ctx.resolveAccountMode();
            if (!isScopeActive(ctx.credentialScope)) return null;
            await ctx.assertOperationAllowed('quota_read');
            if (!isScopeActive(ctx.credentialScope)) return null;

            if (mode === 'plain') {
                const opened = await getConnectedServiceQuotaSnapshotPlain(ctx.credentials, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                }, {
                    expectedActiveServer: ctx.serverBasis,
                });
                if (!isScopeActive(ctx.credentialScope)) return null;
                entry.snapshot = opened;
                entry.consecutiveErrors = 0;
                entry.nextFetchAtMs = Date.now() + (opened
                    ? Math.max(
                        QUOTA_SNAPSHOT_POLL_MS,
                        Math.trunc(opened.staleAfterMs ?? QUOTA_SNAPSHOT_POLL_MS),
                    )
                    : QUOTA_SNAPSHOT_MISS_RETRY_MS);
                return opened;
            }

            const sealed = await getConnectedServiceQuotaSnapshotSealed(ctx.credentials, {
                serviceId: ctx.serviceId,
                profileId: ctx.profileId,
            }, {
                expectedActiveServer: ctx.serverBasis,
            });
            const opened = sealed
                ? openConnectedServiceQuotaViewSnapshot(ctx.credentials, sealed.sealed, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                })
                : null;
            if (!isScopeActive(ctx.credentialScope)) return null;
            entry.snapshot = opened;
            entry.consecutiveErrors = 0;
            entry.nextFetchAtMs = Date.now() + (opened
                ? Math.max(
                    QUOTA_SNAPSHOT_POLL_MS,
                    Math.trunc(opened.staleAfterMs ?? QUOTA_SNAPSHOT_POLL_MS),
                )
                : QUOTA_SNAPSHOT_MISS_RETRY_MS);
            return opened;
        } catch (error) {
            if (!isScopeActive(ctx.credentialScope)) return null;
            entry.error = sanitizeEndpointErrorMessage(error) ?? t('common.error');
            entry.consecutiveErrors += 1;
            entry.nextFetchAtMs = Date.now() + computeErrorBackoffMs(entry.consecutiveErrors);
            if (!entry.snapshot) entry.snapshot = null;
            return null;
        } finally {
            if (isScopeActive(ctx.credentialScope)) {
                entry.loading = false;
            }
            entry.loadPromise = null;
            publish(key, entry);
            schedulePolling(key);
        }
    })();

    entry.loadPromise = promise;
    return promise;
}

export function retainQuotaSnapshotPolling(key: string, ctx: QuotaSnapshotLoadContext): () => void {
    const releaseCredentialScope = retainCredentialScope(ctx.credentialScope);
    const entry = getOrCreateEntry(key);
    entry.pollRetainCount += 1;
    entry.pollContext = ctx;

    if (!entry.loadAttempted || (!entry.loadPromise && Date.now() >= entry.nextFetchAtMs)) {
        entry.loadAttempted = true;
        void runLoad(key, ctx);
    } else {
        schedulePolling(key);
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCredentialScope();
        const current = entries.get(key);
        if (!current) return;
        current.pollRetainCount = Math.max(0, current.pollRetainCount - 1);
        if (current.pollRetainCount === 0) {
            current.pollContext = null;
            clearPollTimer(current);
        }
    };
}

export async function refreshQuotaSnapshot(key: string, ctx: QuotaSnapshotLoadContext): Promise<void> {
    const entry = getOrCreateEntry(key);
    clearPollTimer(entry);
    if (entry.refreshPromise) {
        await entry.refreshPromise;
        return;
    }

    if (!isScopeActive(ctx.credentialScope)) return;
    entry.refreshing = true;
    publish(key, entry);
    const promise = (async () => {
        const inFlightFetchedAt = (await entry.loadPromise
            ?.then((snapshot) => snapshot?.fetchedAt ?? 0)
            .catch(() => 0)) ?? 0;
        if (!isScopeActive(ctx.credentialScope)) return;
        const sinceFetchedAt = Math.max(entry.snapshot?.fetchedAt ?? 0, inFlightFetchedAt);
        try {
            const mode = await ctx.resolveAccountMode();
            if (!isScopeActive(ctx.credentialScope)) return;
            try {
                await ctx.assertOperationAllowed('quota_refresh');
            } catch (error) {
                if (isScopeActive(ctx.credentialScope)) {
                    entry.error =
                        sanitizeEndpointErrorMessage(error)
                        ?? t('common.error');
                    publish(key, entry);
                }
                return;
            }
            if (!isScopeActive(ctx.credentialScope)) return;
            await (mode === 'plain'
                ? requestConnectedServiceQuotaSnapshotRefreshV3(
                    ctx.credentials,
                    {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    },
                    { expectedActiveServer: ctx.serverBasis },
                )
                : requestConnectedServiceQuotaSnapshotRefresh(
                    ctx.credentials,
                    {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    },
                    { expectedActiveServer: ctx.serverBasis },
                ));
        } catch {
            // Best-effort only.
        }
        for (const delayMs of REFRESH_RELOAD_DELAYS_MS) {
            await sleep(delayMs);
            if (!isScopeActive(ctx.credentialScope)) break;
            const opened = await runLoad(key, ctx);
            if (opened && opened.fetchedAt > sinceFetchedAt) break;
        }
    })();

    entry.refreshPromise = promise;
    try {
        await promise;
    } finally {
        if (entry.refreshPromise === promise) entry.refreshPromise = null;
        entry.refreshing = false;
        publish(key, entry);
        schedulePolling(key);
    }
}

export async function consumeQuotaRecoveryCredit(
    key: string,
    ctx: QuotaRecoveryConsumeContext,
): Promise<QuotaRecoveryConsumeResult> {
    const entry = getOrCreateEntry(key);
    try {
        await ctx.assertOperationAllowed('recovery_credit_consume');
        if (!isScopeActive(ctx.credentialScope)) {
            return {
                ok: false,
                error: t('common.error'),
            };
        }
        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: ctx.machineId,
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
        clearPollTimer(entry);
    }
    entries.clear();
    listenersByKey.clear();
    activeCredentialScopeRetainCounts.clear();
}
