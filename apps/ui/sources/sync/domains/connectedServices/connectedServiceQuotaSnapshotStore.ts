import { getConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { getConnectedServiceCredentialPlain } from '@/sync/api/account/apiConnectedServicesV3';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    assertConnectedServiceCredentialRecordBinding,
    buildConnectedServiceCredentialMetadata,
    connectedServiceUsageRequiresOrganizationId,
    ConnectedServiceCredentialRecordV1Schema,
    isProviderAccountUsageOrganizationContextMatch,
    openConnectedServiceCredentialCiphertext,
    type ProviderAccountUsageOrganizationContext,
    type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
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
import { connectedServiceQuotaRecoveryCreditConsume } from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';

import type {
    ConnectedServiceId,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { t } from '@/text';

export type CredentialScopedAccountMode = 'plain' | 'e2ee';

/**
 * Shared, module-level loader cache for connected-service quota snapshots.
 *
 * The same account rendered in multiple mounted blocks must NOT duplicate
 * fetches, so the per-instance loader that used to live in
 * `ConnectedServiceQuotaCard` is centralized here and keyed by the full scope
 * (credential scope + serviceId + profileId). Every `isCurrentLoadScope` guard
 * from the original loader is preserved as an `isScopeActive` check so a
 * credential change can never let a stale in-flight request choose the wrong
 * endpoint or commit the wrong snapshot.
 */

export type QuotaSnapshotStoreEntry = Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    loading: boolean;
    error: string | null;
    /** True until the requested refresh produces a newer snapshot, fails, or is cancelled. */
    refreshing: boolean;
}>;

export type QuotaSnapshotLoadContext = Readonly<{
    credentials: AuthCredentials;
    credentialScope: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    resolveAccountMode: () => Promise<CredentialScopedAccountMode>;
}>;

export type QuotaRecoveryConsumeContext = QuotaSnapshotLoadContext & Readonly<{
    machineId: string;
    serverId?: string | null;
    providerCreditId?: string | null;
}>;

export type QuotaRecoveryConsumeResult =
    | Readonly<{ ok: true; receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>
    | Readonly<{
        ok: false;
        error: string;
        receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1;
    }>;

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
    refreshSinceFetchedAt: number | null;
    pollRetainCount: number;
    pollTimer: ReturnType<typeof setTimeout> | null;
    pollContext: QuotaSnapshotLoadContext | null;
    /** Public, immutable projection handed to subscribers (stable when unchanged). */
    view: QuotaSnapshotStoreEntry;
};

const QUOTA_SNAPSHOT_POLL_MS = 30_000;
const QUOTA_SNAPSHOT_MISS_RETRY_MS = 30_000;
const QUOTA_SNAPSHOT_ERROR_BACKOFF_MIN_MS = 30_000;
const QUOTA_SNAPSHOT_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

const EMPTY_VIEW: QuotaSnapshotStoreEntry = { snapshot: null, loading: false, error: null, refreshing: false };

const entries = new Map<string, InternalEntry>();
const listenersByKey = new Map<string, Set<() => void>>();

/**
 * The most-recently-acted-on credential scope. A load/refresh started under an
 * older scope is dropped before any side effect once this advances (the
 * credential-change race guard).
 */
let activeCredentialScope = '';

export function buildQuotaSnapshotScopeKey(
    credentialScope: string,
    serviceId: ConnectedServiceId,
    profileId: string,
): string {
    return [credentialScope, connectedServiceProfileKey({ serviceId, profileId })].join('\u0000');
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
        refreshSinceFetchedAt: null,
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
    if (
        entry.view.snapshot === entry.snapshot
        && entry.view.loading === entry.loading
        && entry.view.error === entry.error
        && entry.view.refreshing === entry.refreshing
    ) return;
    entry.view = { snapshot: entry.snapshot, loading: entry.loading, error: entry.error, refreshing: entry.refreshing };
    notify(key);
}

function isScopeActive(credentialScope: string): boolean {
    return activeCredentialScope === credentialScope;
}

function clearPollTimer(entry: InternalEntry): void {
    if (!entry.pollTimer) return;
    clearTimeout(entry.pollTimer);
    entry.pollTimer = null;
}

function computeNextFetchAtMs(snapshot: ConnectedServiceQuotaSnapshotV1 | null): number {
    return Date.now() + (snapshot
        ? Math.max(
            QUOTA_SNAPSHOT_POLL_MS,
            Math.trunc(snapshot.staleAfterMs ?? QUOTA_SNAPSHOT_POLL_MS),
        )
        : QUOTA_SNAPSHOT_MISS_RETRY_MS);
}

/**
 * Quota polling is a network round trip per open session. It exists to keep a
 * meter the user is looking at honest, so it stops while the app is backgrounded
 * or the tab is hidden instead of waking the radio every 30 s behind a locked
 * screen, and resumes the moment the runtime is active again — immediately when
 * the cadence went overdue while away, so a returning user never reads a meter
 * that quietly went stale.
 */
let runtimeActiveResumeDetach: (() => void) | null = null;

function ensureRuntimeActiveResumeWatcher(): void {
    if (runtimeActiveResumeDetach) return;
    runtimeActiveResumeDetach = subscribeToRuntimeActiveChange(() => {
        if (!isRuntimeActive()) return;
        for (const key of [...entries.keys()]) {
            schedulePolling(key);
        }
    });
}

function schedulePolling(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    clearPollTimer(entry);
    if (entry.pollRetainCount <= 0 || entry.loadPromise || entry.refreshPromise) return;
    if (!entry.pollContext || !isScopeActive(entry.pollContext.credentialScope)) return;
    if (!isRuntimeActive()) {
        ensureRuntimeActiveResumeWatcher();
        return;
    }
    ensureRuntimeActiveResumeWatcher();

    const delayMs = Math.max(0, entry.nextFetchAtMs - Date.now());
    entry.pollTimer = setTimeout(() => {
        entry.pollTimer = null;
        const latest = entries.get(key);
        if (!latest || latest.pollRetainCount <= 0 || latest.loadPromise || latest.refreshPromise) return;
        const ctx = latest.pollContext;
        if (!ctx || !isScopeActive(ctx.credentialScope)) return;
        if (!isRuntimeActive()) {
            ensureRuntimeActiveResumeWatcher();
            return;
        }
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

/** Remove this credential's stale projection without creating a second usage cache. */
export function invalidateConnectedServiceQuotaSnapshotForCredential(
    credentials: AuthCredentials,
    record: ConnectedServiceCredentialRecordV1,
): void {
    const key = buildQuotaSnapshotScopeKey(resolveAuthCredentialsScopeKey(credentials), record.serviceId, record.profileId);
    const previous = entries.get(key);
    if (!previous) return;
    const identity = buildConnectedServiceCredentialMetadata(record);
    const matches = previous.snapshot && (connectedServiceUsageRequiresOrganizationId(record.serviceId)
        ? isProviderAccountUsageOrganizationContextMatch(previous.snapshot, {
            providerAccountId: identity.providerAccountId,
            providerOrganizationId: identity.providerOrganizationId ?? null,
        })
        : Boolean(identity.providerAccountId && previous.snapshot.activeAccountId === identity.providerAccountId));
    if (matches) return;

    // Entry identity already represents this cache operation's lifetime. Removing it also
    // prevents earlier reads or recovery-credit results from committing after this write.
    clearPollTimer(previous);
    entries.delete(key);
    const current = getOrCreateEntry(key);
    current.pollRetainCount = previous.pollRetainCount;
    current.pollContext = previous.pollContext;
    notify(key);
    if (current.pollRetainCount > 0 && current.pollContext) {
        current.loadAttempted = true;
        void runLoad(key, current.pollContext);
    }
}

async function readCurrentQuotaOrganizationContext(
    ctx: QuotaSnapshotLoadContext,
    mode: CredentialScopedAccountMode,
): Promise<ProviderAccountUsageOrganizationContext | null> {
    const binding = { serviceId: ctx.serviceId, profileId: ctx.profileId };
    let record: ConnectedServiceCredentialRecordV1 | undefined;
    if (mode === 'plain') {
        record = (await getConnectedServiceCredentialPlain(ctx.credentials, binding))?.content.v;
    } else {
        const sealed = await getConnectedServiceCredentialSealed(ctx.credentials, binding);
        if (!sealed) return null;
        const opened = openConnectedServiceCredentialCiphertext({
            material: resolveAccountScopedCryptoMaterialFromCredentials(ctx.credentials),
            ciphertext: sealed.sealed.ciphertext,
        });
        const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(opened?.value);
        if (!parsed.success) return null;
        record = assertConnectedServiceCredentialRecordBinding({ binding, record: parsed.data });
    }
    if (!record) return null;
    const metadata = buildConnectedServiceCredentialMetadata(record);
    return { providerAccountId: metadata.providerAccountId, providerOrganizationId: metadata.providerOrganizationId ?? null };
}

async function runLoad(key: string, ctx: QuotaSnapshotLoadContext): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    const entry = getOrCreateEntry(key);
    const isCurrentEntry = () => entries.get(key) === entry && isScopeActive(ctx.credentialScope);
    if (entry.loadPromise) return entry.loadPromise;
    clearPollTimer(entry);

    const promise = (async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        if (!isCurrentEntry()) return null;
        entry.loading = true;
        entry.error = null;
        publish(key, entry);
        const requiresOrganization = connectedServiceUsageRequiresOrganizationId(ctx.serviceId);
        let organizationContext: ProviderAccountUsageOrganizationContext | null = null;
        try {
            const mode = await ctx.resolveAccountMode();
            if (!isCurrentEntry()) return null;

            if (requiresOrganization) {
                // Read through the same coalesced load so old relays' missing public metadata
                // cannot let a same-user reconnect retain another organization's cloud usage.
                organizationContext = await readCurrentQuotaOrganizationContext(ctx, mode);
                if (!isCurrentEntry()) return null;
                if (entry.snapshot && !isProviderAccountUsageOrganizationContextMatch(entry.snapshot, organizationContext)) {
                    entry.snapshot = null;
                }
            }

            let opened: ConnectedServiceQuotaSnapshotV1 | null = null;
            if (mode === 'plain') {
                opened = await getConnectedServiceQuotaSnapshotPlain(ctx.credentials, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                });
            }

            if (!isCurrentEntry()) return null;
            if (mode !== 'plain' || !opened) {
                const sealed = await getConnectedServiceQuotaSnapshotSealed(ctx.credentials, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                });
                opened = sealed
                    ? openConnectedServiceQuotaViewSnapshot(ctx.credentials, sealed.sealed, {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    })
                    : null;
            }
            if (!isCurrentEntry()) return null;
            if (requiresOrganization && opened && !isProviderAccountUsageOrganizationContextMatch(opened, organizationContext)) {
                opened = null;
            }
            entry.snapshot = opened ?? (entry.refreshing ? entry.snapshot : null);
            entry.consecutiveErrors = 0;
            entry.nextFetchAtMs = computeNextFetchAtMs(opened);
            return opened;
        } catch (error) {
            if (!isCurrentEntry()) return null;
            entry.error = sanitizeEndpointErrorMessage(error) ?? t('common.error');
            entry.consecutiveErrors += 1;
            entry.nextFetchAtMs = Date.now() + computeErrorBackoffMs(entry.consecutiveErrors);
            if (!entry.snapshot) entry.snapshot = null;
            return null;
        } finally {
            if (isCurrentEntry()) {
                entry.loading = false;
                if (entry.refreshSinceFetchedAt !== null) {
                    if (entry.error || (entry.snapshot && entry.snapshot.fetchedAt > entry.refreshSinceFetchedAt)) {
                        entry.refreshing = false;
                        entry.refreshSinceFetchedAt = null;
                    } else {
                        // An accepted refresh is still pending, regardless of the old snapshot's freshness.
                        entry.nextFetchAtMs = Date.now() + QUOTA_SNAPSHOT_POLL_MS;
                    }
                }
            }
            entry.loadPromise = null;
            if (entries.get(key) === entry) {
                publish(key, entry);
                schedulePolling(key);
            }
        }
    })();

    entry.loadPromise = promise;
    return promise;
}

export function ensureQuotaSnapshotLoaded(key: string, ctx: QuotaSnapshotLoadContext): void {
    activeCredentialScope = ctx.credentialScope;
    const entry = getOrCreateEntry(key);
    if (entry.loadAttempted || entry.loadPromise) return;
    entry.loadAttempted = true;
    void runLoad(key, ctx);
}

export function retainQuotaSnapshotPolling(key: string, ctx: QuotaSnapshotLoadContext): () => void {
    activeCredentialScope = ctx.credentialScope;
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
        const current = entries.get(key);
        if (!current) return;
        current.pollRetainCount = Math.max(0, current.pollRetainCount - 1);
        if (current.pollRetainCount === 0) {
            current.pollContext = null;
            clearPollTimer(current);
            current.refreshSinceFetchedAt = null;
            current.refreshing = false;
            publish(key, current);
        }
    };
}

export async function refreshQuotaSnapshot(key: string, ctx: QuotaSnapshotLoadContext): Promise<void> {
    activeCredentialScope = ctx.credentialScope;
    const entry = getOrCreateEntry(key);
    const isCurrentEntry = () => entries.get(key) === entry && isScopeActive(ctx.credentialScope);
    clearPollTimer(entry);
    const previousRefresh = entry.refreshPromise;
    if (previousRefresh && entry.refreshing) {
        await previousRefresh;
        return;
    }
    if (entry.refreshing) return;

    entry.refreshing = true;
    entry.error = null;
    publish(key, entry);
    const promise = Promise.resolve(previousRefresh).then(async () => {
        // A new intent waits for the cancelled request without inheriting its completion.
        if (entry.refreshPromise !== promise || !entry.refreshing || !isCurrentEntry()) return;
        const inFlightFetchedAt = (await entry.loadPromise
            ?.then((snapshot) => snapshot?.fetchedAt ?? 0)
            .catch(() => 0)) ?? 0;
        if (entry.refreshPromise !== promise || !isCurrentEntry() || !entry.refreshing) return;
        entry.refreshSinceFetchedAt = Math.max(entry.snapshot?.fetchedAt ?? 0, inFlightFetchedAt);
        try {
            const mode = await ctx.resolveAccountMode();
            if (entry.refreshPromise !== promise || !isCurrentEntry() || !entry.refreshing) return;
            let ok = mode === 'plain'
                ? await requestConnectedServiceQuotaSnapshotRefreshV3(ctx.credentials, { serviceId: ctx.serviceId, profileId: ctx.profileId })
                : await requestConnectedServiceQuotaSnapshotRefresh(ctx.credentials, { serviceId: ctx.serviceId, profileId: ctx.profileId });
            if (!ok && mode === 'plain') {
                ok = await requestConnectedServiceQuotaSnapshotRefresh(ctx.credentials, { serviceId: ctx.serviceId, profileId: ctx.profileId });
            }
            if (!ok) throw new Error(t('common.error'));
            if (entry.refreshPromise !== promise || !isCurrentEntry() || !entry.refreshing) return;
            await runLoad(key, ctx);
        } catch (error) {
            if (entry.refreshPromise !== promise || !isCurrentEntry() || !entry.refreshing) return;
            entry.error = sanitizeEndpointErrorMessage(error) ?? t('common.error');
            entry.refreshSinceFetchedAt = null;
            entry.refreshing = false;
        }
    });

    entry.refreshPromise = promise;
    try {
        await promise;
    } finally {
        if (entries.get(key) === entry && entry.refreshPromise === promise) {
            entry.refreshPromise = null;
            if (!isCurrentEntry() || entry.pollRetainCount === 0) {
                entry.refreshSinceFetchedAt = null;
                entry.refreshing = false;
            }
            publish(key, entry);
            schedulePolling(key);
        }
    }
}

export async function consumeQuotaRecoveryCredit(
    key: string,
    ctx: QuotaRecoveryConsumeContext,
): Promise<QuotaRecoveryConsumeResult> {
    activeCredentialScope = ctx.credentialScope;
    const entry = getOrCreateEntry(key);
    try {
        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: ctx.machineId,
            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
            serviceId: ctx.serviceId,
            profileId: ctx.profileId,
            ...(ctx.providerCreditId ? { providerCreditId: ctx.providerCreditId } : {}),
            sourceSnapshotFetchedAtMs: entry.snapshot?.fetchedAt ?? null,
        });
        if (result.ok) {
            if (entries.get(key) !== entry || !isScopeActive(ctx.credentialScope)) {
                return { ok: true, receipt: result.receipt };
            }
            entry.snapshot = result.snapshot;
            entry.error = null;
            publish(key, entry);
            return { ok: true, receipt: result.receipt };
        }
        return {
            ok: false,
            error: result.error,
            ...(result.receipt ? { receipt: result.receipt } : {}),
        };
    } catch (error) {
        return { ok: false, error: sanitizeEndpointErrorMessage(error) ?? t('common.error') };
    }
}

/** Test-only: clear the module-level cache and the active credential scope. */
export function __resetConnectedServiceQuotaSnapshotStore(): void {
    for (const entry of entries.values()) {
        clearPollTimer(entry);
    }
    entries.clear();
    listenersByKey.clear();
    activeCredentialScope = '';
    runtimeActiveResumeDetach?.();
    runtimeActiveResumeDetach = null;
}
