import {
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionDescribe,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionFailureReason,
    type DeferredDaemonProjection,
    type DaemonProjectionHydrationRejection,
    type DaemonProjectionSectionCache,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { captureMachineContributionRegistryProjectionScope, machineContributionRegistryProjectionScopeKey } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import {
    forgetPluginUiProjectionAdmissionSnapshot,
    pluginUiProjectionAdmissionTargetKey,
    savePluginUiProjectionAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

import {
    publishDaemonMergedProjectionInputs,
    readProjectedAgentUiBehaviorDescriptors,
    type DaemonMergedProjectionInputs,
} from './daemonContributionRegistryProjectionAdapters';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getPreferredLanguage } from '@/text';
import { mergeProjectionSections } from './mergeProjectionSections';
import { entryIsFresh, matchesProjectionCurrentness } from './projectionCurrentness';
export { entryIsFresh } from './projectionCurrentness';
export type { DaemonMergedProjectionInputs } from './daemonContributionRegistryProjectionAdapters';

type ProjectionCacheResult = (
    | Readonly<{ kind: 'ready'; inputs: DaemonMergedProjectionInputs }>
    | Readonly<{ kind: 'unsupported' }>
    | Readonly<{
        kind: 'error';
        /** Why the latest read failed; the last good inputs stay available. */
        reason: MachineContributionRegistryProjectionFailureReason;
        retryAttempt: number;
        /** Null settles a semantic failure until fresh demand or authority change. */
        retryAtMs: number | null;
        inputs?: DaemonMergedProjectionInputs;
    }>
);
type ProjectionCacheEntry = Readonly<{
    fetchedAtMs: number;
    projectionRevision: number;
    retirement?: Readonly<{ dispose(): void }>;
    /** Daemon content identity of the held full answer; never a freshness authority. */
    projectionDigest?: string;
    deferredProjection?: DeferredDaemonProjection;
    deferredHydrationRejection?: DaemonProjectionHydrationRejection;
    sectionHolding?: ProjectionSectionHolding;
    accountScope?: ServerAccountScope | null;
    /** The locale whose narrowed translation bundles this answer carries. */
    locale: string;
    summaries: ProjectionSummaries;
    /** The exact routed Home credential that authorized this projection. */
    accountCurrentness?: Pick<ActiveServerAccountScopeLifetime, 'isCurrent' | 'onRetire'> & Readonly<{
        retainReader(reader: ActiveServerAccountScopeLifetime): void;
    }>;
}> & ProjectionCacheResult;
type ReusableProjectionCacheEntry = Extract<ProjectionCacheEntry, { kind: 'ready' | 'unsupported' }>;

/**
 * The one UI owner of each machine's daemon projection. Every reader — the
 * AppShell plugin UI currentness, `useDaemonMergedProjectionInputs`, and the
 * direct callers — goes through this cache and its single in-flight request
 * per machine scope, projection revision, requested locale and section demand.
 */
const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry>();
type ProjectionSectionPool = DaemonProjectionSectionCache & {
    key: string;
    references: Map<string, number>;
    pending: number;
};
type ProjectionSectionHolding = {
    pool: ProjectionSectionPool;
    bodies: ReadonlyMap<string, readonly string[]>;
    retirement?: Readonly<{ dispose(): void }>;
};
// This is the byte inventory of the existing held Machine answers. Replacement
// and Account retirement release their references; superseded bodies do not linger.
const PROJECTION_SECTION_POOLS = new Map<string, ProjectionSectionPool>();

/** An unfetched dictionary is unknown, never an authoritative empty catalogue. */
export function daemonProjectionHasSections(entry: Readonly<{ deferredProjection?: DeferredDaemonProjection }>, sections?: readonly string[]): boolean {
    const deferred = entry.deferredProjection;
    return !deferred || (sections ?? Object.keys(deferred.manifest.sections))
        .every(id => !(id in deferred.manifest.sections) || deferred.loadedSections.includes(id));
}
function discardEmptySectionPool(pool: ProjectionSectionPool): void {
    if (pool.pending === 0) {
        for (const digest of pool.bodies.keys()) {
            if (!pool.references.has(digest)) pool.bodies.delete(digest);
        }
    }
    if (pool.pending === 0 && pool.references.size === 0 && PROJECTION_SECTION_POOLS.get(pool.key) === pool) {
        PROJECTION_SECTION_POOLS.delete(pool.key);
    }
}
function releaseProjectionSections(holding: ProjectionSectionHolding | undefined): void {
    if (!holding) return;
    holding.retirement?.dispose();
    for (const digest of holding.bodies.keys()) {
        const references = (holding.pool.references.get(digest) ?? 0) - 1;
        if (references > 0) holding.pool.references.set(digest, references);
        else {
            holding.pool.references.delete(digest);
            if (holding.pool.pending === 0) holding.pool.bodies.delete(digest);
        }
    }
    discardEmptySectionPool(holding.pool);
}
type ProjectionSummarySubscription = Readonly<{
    listeners: Set<() => void>;
    notify(): void;
    dispose(): void;
}>;
const PROJECTION_SUMMARY_SUBSCRIPTIONS = new Map<string, ProjectionSummarySubscription>();

export type DaemonMergedProjectionSummary = Readonly<{
    inputs: (Pick<DaemonMergedProjectionInputs, 'mergedBackendProjectionById' | 'mergedProviderProjectionById'> & Readonly<{
        agentDeclarationsById: PluginProjectionV2['agentsById'] | null;
    }>) | null;
    current: boolean;
}>;
const EMPTY_PROJECTION_SUMMARY: DaemonMergedProjectionSummary = Object.freeze({ inputs: null, current: false });
type ProjectionSummaries = Readonly<{
    current: DaemonMergedProjectionSummary;
    stale: DaemonMergedProjectionSummary;
}>;
const EMPTY_PROJECTION_SUMMARIES: ProjectionSummaries = Object.freeze({ current: EMPTY_PROJECTION_SUMMARY, stale: EMPTY_PROJECTION_SUMMARY });

function publishProjectionSummaries(inputs: DaemonMergedProjectionInputs | undefined): ProjectionSummaries {
    if (!inputs) return EMPTY_PROJECTION_SUMMARIES;
    const summaryInputs = Object.freeze({
        mergedBackendProjectionById: inputs.mergedBackendProjectionById,
        mergedProviderProjectionById: inputs.mergedProviderProjectionById,
        agentDeclarationsById: inputs.pluginProjectionV2?.agentsById ?? null,
    });
    return Object.freeze({
        current: Object.freeze({ inputs: summaryInputs, current: true }),
        stale: Object.freeze({ inputs: summaryInputs, current: false }),
    });
}

/** Chrome observes this owner's published summary; it never resolves credentials or describes a daemon. */
export function readDaemonMergedProjectionSummary(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): DaemonMergedProjectionSummary {
    const entry = readCachedDaemonMergedProjectionCacheEntry({ ...params, sections: ['agentsById'] });
    return readProjectionSummary(entry, () => getMachineContributionRegistryProjectionRevision({
        machineId: normalizeKeyPart(params.machineId), serverId: normalizeKeyPart(params.serverId) || null,
    }));
}

function readProjectionSummary(entry: ProjectionCacheEntry | null, readRevision: () => number): DaemonMergedProjectionSummary {
    if (!entry || !daemonProjectionHasSections(entry, ['agentsById']) || !entry.accountCurrentness || (entry.kind !== 'ready' && entry.kind !== 'error') || !entry.inputs) {
        return EMPTY_PROJECTION_SUMMARY;
    }
    return entry.kind === 'ready'
        && entry.projectionRevision === readRevision()
        && entry.locale === getPreferredLanguage()
        ? entry.summaries.current : entry.summaries.stale;
}

/** One upstream subscription and lifetime observer per cache scope, shared by every row. */
export function subscribeDaemonMergedProjectionSummary(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    selection?: 'connectedAccountAdmission';
}>, listener: () => void): () => void {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return () => {};
    const serverId = normalizeKeyPart(params.serverId) || null;
    const key = buildCacheKey(machineId, serverId, params.selection);
    return subscribeProjectionSummary(key, listener => subscribeMachineContributionRegistryProjectionInvalidation({ machineId, serverId }, listener), listener);
}

function subscribeProjectionSummary(
    key: string,
    subscribeRevision: (listener: () => void) => () => void,
    listener: () => void,
): () => void {
    let subscription = PROJECTION_SUMMARY_SUBSCRIPTIONS.get(key);
    if (!subscription) {
        const listeners = new Set<() => void>();
        let observedEntry: ProjectionCacheEntry | null = null;
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const notify = () => {
            const entry = currentProjectionCacheEntry(key);
            if (entry !== observedEntry) {
                retirement?.dispose();
                observedEntry = entry;
                retirement = entry?.accountCurrentness?.onRetire(notify);
            }
            for (const consumer of listeners) consumer();
        };
        const unsubscribe = subscribeRevision(notify);
        subscription = { listeners, notify, dispose: () => { unsubscribe(); retirement?.dispose(); } };
        PROJECTION_SUMMARY_SUBSCRIPTIONS.set(key, subscription);
        notify();
    }
    subscription.listeners.add(listener);
    const captured = subscription;
    return () => {
        captured.listeners.delete(listener);
        if (captured.listeners.size === 0) {
            captured.dispose();
            if (PROJECTION_SUMMARY_SUBSCRIPTIONS.get(key) === captured) PROJECTION_SUMMARY_SUBSCRIPTIONS.delete(key);
        }
    };
}

/** Prepare only correspondence/key parts. Account, revision and locale stay live on every read. */
export function captureDaemonMergedProjectionReader(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    sections?: readonly string[];
}>, resolveScopeId?: ProfileScopeResolver) {
    const machineId = normalizeKeyPart(params.machineId);
    const scope = captureMachineContributionRegistryProjectionScope({
        machineId, serverId: normalizeKeyPart(params.serverId) || null,
    }, resolveScopeId);
    const readAny = () => machineId ? currentProjectionCacheEntry(scope.key) : null;
    const readCached = () => {
        const entry = readAny();
        return entry && daemonProjectionHasSections(entry, params.sections) ? entry : null;
    };
    return {
        readCached,
        readRevision: scope.readRevision,
        subscribeInvalidation: scope.subscribe,
        readSummary: () => readProjectionSummary(readAny(), scope.readRevision),
        subscribeSummary: (listener: () => void) => machineId
            ? subscribeProjectionSummary(scope.key, scope.subscribe, listener) : () => {},
    };
}
// Preserve the incumbent transient burst and 30 s recovery cadence. Attempts
// belong to the shared Machine question, not each mounted reader's timer.
const PROJECTION_RETRY_BACKOFF_MS = [250, 1_000, 2_500, 5_000, 30_000] as const;

export function readDaemonMergedProjectionRetryDelayMs(entry?: ProjectionCacheEntry | null): number | null {
    return entry?.kind === 'error'
        ? entry.retryAtMs === null ? null : Math.max(0, entry.retryAtMs - Date.now())
        : PROJECTION_RETRY_BACKOFF_MS[0];
}
type ProjectionRequest = Readonly<{
    revision: number;
    locale: string;
    /** The Account it reads for; a successor Account never joins it. */
    accountScope: ServerAccountScope | null;
    /**
     * Every lifetime handle waiting on it. Readers of one Account hold separate
     * handles (one per credential-scope hook), so the answer is published while
     * any of them is still current, not only while the issuer is.
     */
    wait(reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal): Promise<ProjectionCacheEntry | null>;
}>;
const LATEST_PROJECTION_REQUEST = new Map<string, ProjectionRequest>();

export function clearDaemonMergedProjectionCacheForTests(): void {
    for (const entry of PROJECTION_CACHE.values()) { entry.retirement?.dispose(); releaseProjectionSections(entry.sectionHolding); }
    PROJECTION_CACHE.clear();
    PROJECTION_SECTION_POOLS.clear();
    for (const subscription of PROJECTION_SUMMARY_SUBSCRIPTIONS.values()) subscription.notify();
    clearProjectedAgentUiBehaviorDescriptors();
    LATEST_PROJECTION_REQUEST.clear();
}

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function buildCacheKey(
    machineId: string,
    serverId: string | null | undefined,
    selection?: 'connectedAccountAdmission',
): string {
    const key = machineContributionRegistryProjectionScopeKey({
        serverId: normalizeKeyPart(serverId) || null,
        machineId: normalizeKeyPart(machineId),
    });
    return selection ? JSON.stringify([key, selection]) : key;
}

function currentProjectionCacheEntry(cacheKey: string): ProjectionCacheEntry | null {
    const entry = PROJECTION_CACHE.get(cacheKey) ?? null;
    if (entry?.accountCurrentness && !entry.accountCurrentness.isCurrent()) {
        PROJECTION_CACHE.delete(cacheKey);
        entry.retirement?.dispose();
        releaseProjectionSections(entry.sectionHolding);
        return null;
    }
    return entry;
}

export function readCachedDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    sections?: readonly string[];
    selection?: 'connectedAccountAdmission';
}>): ProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }
    const entry = currentProjectionCacheEntry(buildCacheKey(machineId, normalizeKeyPart(params.serverId) || null, params.selection));
    return entry && daemonProjectionHasSections(entry, params.sections) ? entry : null;
}

/** Current Account/locale/revision facts, including failures, for passive observers. */
export function readObservedDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    sections?: readonly string[];
    selection?: 'connectedAccountAdmission';
}>): ProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return null;
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!accountLifetime?.isCurrent()) return null;
    const serverId = normalizeKeyPart(params.serverId) || null;
    const cached = currentProjectionCacheEntry(buildCacheKey(machineId, serverId, params.selection));
    if (
        !cached
        // Missing bodies make a successful answer incomplete, not a settled
        // failure pending. Passive readers must see the source's typed refusal.
        || (cached.kind === 'ready' && !daemonProjectionHasSections(cached, params.sections))
        || !matchesProjectionCurrentness(cached, {
            projectionRevision: getMachineContributionRegistryProjectionRevision({ machineId, serverId }),
            locale: getPreferredLanguage(), accountScope: accountLifetime.scope,
        })
    ) return null;
    // A settled answer belongs to every current reader that reuses it, just
    // as an in-flight answer does. Retiring its issuer cannot evict a sibling's
    // projection or make that sibling describe the same question again.
    cached.accountCurrentness?.retainReader(accountLifetime);
    return cached;
}

/** The single authoritative reuse decision for every projection reader. */
export function readReusableDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    staleMs?: number;
    sections?: readonly string[];
    selection?: 'connectedAccountAdmission';
}>): ReusableProjectionCacheEntry | null {
    const cached = readObservedDaemonMergedProjectionCacheEntry(params);
    return cached && cached.kind !== 'error' && entryIsFresh(cached, params.staleMs)
        ? cached : null;
}

export async function loadDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    /** Exact routed Account lifetime; required for background descriptor publication. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** App-shell readers may reuse a fresh Account-qualified answer, including unsupported. */
    reuseFreshReady?: boolean;
    /** Automatic recovery: share its cadence, or false to refresh its authority.
     * Omit for an explicit one-shot read with ordinary fresh/rejection semantics. */
    shareRetryCadence?: boolean;
    signal?: AbortSignal;
    /** Omitted means the complete catalogue, for existing full consumers. */
    sections?: readonly string[];
    /** Existing purpose admission query; never authoritative for full presentation coverage. */
    selection?: 'connectedAccountAdmission';
}>): Promise<ProjectionCacheEntry | null> {
    if (params.signal?.aborted) return null;
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (accountLifetime && !accountLifetime.isCurrent()) return null;
    const locale = getPreferredLanguage();
    const cacheKey = buildCacheKey(params.machineId, params.serverId, params.selection);
    const full = !params.selection;
    // The canonical per-machine projection scope. Its revision advances on
    // socket reconnect, on an explicit invalidation, and on a known daemon
    // replacement. Initial inventory only discovers the endpoint a successful
    // read already asked; it does not make that answer stale. The machine
    // writer owns actual registry changes through this revision.
    const projectionScope = {
        machineId: normalizeKeyPart(params.machineId),
        serverId: normalizeKeyPart(params.serverId) || null,
    };
    const requestRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
    const accountScope = accountLifetime?.scope ?? null;
    // Only the same Account, locale and demand share a pending question.
    // Newer revisions of that question keep the existing serial admission;
    // unrelated sections and locales never wait for its answer.
    const requestKey = JSON.stringify([cacheKey, accountScope?.serverId ?? null, accountScope?.accountId ?? null, locale,
        params.sections === undefined ? null : [...new Set(params.sections)].sort()]);
    const matchesRequest = (entry: ProjectionCacheEntry) => matchesProjectionCurrentness(entry, { projectionRevision: requestRevision, locale, accountScope });
    const incumbentRequest = LATEST_PROJECTION_REQUEST.get(requestKey);
    if (
        incumbentRequest?.revision === requestRevision
        && incumbentRequest.locale === locale
        && (incumbentRequest.accountScope === accountScope
            || areServerAccountScopesEqual(incumbentRequest.accountScope, accountScope))
    ) {
        const answer = await incumbentRequest.wait(accountLifetime, params.signal);
        if (!answer || answer.kind !== 'ready' || daemonProjectionHasSections(answer, params.sections)) return answer;
        return await loadDaemonMergedProjectionCacheEntry({ ...params, accountLifetime, reuseFreshReady: true });
    }
    if (incumbentRequest && (incumbentRequest.accountScope === accountScope
        || areServerAccountScopesEqual(incumbentRequest.accountScope, accountScope))) {
        // A newer revision needs its own fresh answer, but not a second
        // full body queued behind the first. Finish the issued read, then let
        // all waiting readers share one request for the latest facts.
        try { await incumbentRequest.wait(accountLifetime, params.signal); } catch { /* The successor still reads fresh authority. */ }
        if (params.signal?.aborted || (accountLifetime && !accountLifetime.isCurrent())) return null;
        return await loadDaemonMergedProjectionCacheEntry({ ...params, accountLifetime, reuseFreshReady: true });
    }
    const previousAttempt = params.shareRetryCadence ? currentProjectionCacheEntry(cacheKey) : null;
    if (params.shareRetryCadence && previousAttempt?.kind === 'error' && matchesRequest(previousAttempt)
        && (previousAttempt.retryAtMs === null || Date.now() < previousAttempt.retryAtMs)) {
        if (accountLifetime) previousAttempt.accountCurrentness?.retainReader(accountLifetime);
        return previousAttempt;
    }
    if (params.reuseFreshReady === true) {
        const cached = readReusableDaemonMergedProjectionCacheEntry({
            machineId: params.machineId,
            serverId: params.serverId,
            accountLifetime,
            sections: params.sections,
            selection: params.selection,
        });
        if (cached) {
            return accountLifetime && !accountLifetime.isCurrent() ? null : cached;
        }
    }
    const readers = new Set<ActiveServerAccountScopeLifetime>(accountLifetime ? [accountLifetime] : []);
    const readerObservers = new Set<(reader: ActiveServerAccountScopeLifetime) => void>();
    const retainReader = (reader: ActiveServerAccountScopeLifetime) => {
        for (const previous of readers) {
            if (!previous.isCurrent()) readers.delete(previous);
        }
        if (readers.has(reader)) return;
        readers.add(reader);
        for (const observe of readerObservers) observe(reader);
    };
    const routedAccount = accountLifetime
        && (!params.serverId || areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, params.serverId))
        ? {
            scope: accountLifetime.scope,
            currentness: Object.freeze({
                isCurrent: () => [...readers].some((reader) => reader.isCurrent()),
                retainReader,
                onRetire: (cancel: () => void) => {
                    const retirements = new Set<Readonly<{ dispose(): void }>>();
                    const observe = (reader: ActiveServerAccountScopeLifetime) => {
                        if (!reader.isCurrent()) return;
                        let retirement: Readonly<{ dispose(): void }> | null = null;
                        retirement = reader.onRetire(() => {
                            readers.delete(reader);
                            if (retirement) {
                                retirements.delete(retirement);
                                retirement.dispose();
                            }
                            cancel();
                        });
                        retirements.add(retirement);
                    };
                    readerObservers.add(observe);
                    for (const reader of readers) observe(reader);
                    return Object.freeze({ dispose: () => {
                        readerObservers.delete(observe);
                        for (const retirement of retirements) retirement.dispose();
                    } });
                },
            }),
        }
        : null;
    // Every answer is published tagged with the revision it answered, unless a
    // newer one is already cached. A read never waits on a newer read: when the
    // daemon's state keeps advancing, waiting would never settle.
    const publish = (entry: ProjectionCacheResult & Readonly<{ projectionRevision: number; projectionDigest?: string;
        deferredProjection?: DeferredDaemonProjection;
        sectionHolding?: ProjectionSectionHolding }>): ProjectionCacheEntry => {
        const current = currentProjectionCacheEntry(cacheKey);
        if (current !== null && current.projectionRevision > entry.projectionRevision) return current;
        const inputs = entry.kind === 'ready' || entry.kind === 'error' ? entry.inputs : undefined;
        const previousInputs = current?.kind === 'ready' || current?.kind === 'error' ? current.inputs : undefined;
        const retirement = !full && routedAccount ? routedAccount.currentness.onRetire(() => {
            const cached = PROJECTION_CACHE.get(cacheKey);
            if (cached?.accountCurrentness === routedAccount.currentness && !routedAccount.currentness.isCurrent()) {
                PROJECTION_CACHE.delete(cacheKey);
                cached.retirement?.dispose();
            }
        }) : undefined;
        const published = Object.freeze({
            ...entry,
            // Freshness starts when the admitted answer becomes usable, not
            // before a cold describe and its section hydration have finished.
            fetchedAtMs: Date.now(),
            ...(retirement ? { retirement } : {}),
            accountScope,
            locale,
            summaries: routedAccount && full
                ? current && inputs === previousInputs ? current.summaries : publishProjectionSummaries(inputs)
                : EMPTY_PROJECTION_SUMMARIES,
            ...(routedAccount ? { accountCurrentness: routedAccount.currentness } : {}),
        });
        // A former locale may settle after the current one. It still answers
        // its reader, but never replaces the current locale's shared cache.
        if (locale === getPreferredLanguage()) {
            const holding = published.sectionHolding;
            if (holding) {
                for (const [digest, body] of holding.bodies) {
                    holding.pool.bodies.set(digest, body);
                    holding.pool.references.set(digest, (holding.pool.references.get(digest) ?? 0) + 1);
                }
            }
            PROJECTION_CACHE.set(cacheKey, published);
            current?.retirement?.dispose();
            releaseProjectionSections(current?.sectionHolding);
            if (holding && published.accountCurrentness) {
                holding.retirement = published.accountCurrentness.onRetire(() => {
                    if (PROJECTION_CACHE.get(cacheKey) === published && !published.accountCurrentness?.isCurrent()) {
                        PROJECTION_CACHE.delete(cacheKey);
                        releaseProjectionSections(holding);
                        PROJECTION_SUMMARY_SUBSCRIPTIONS.get(cacheKey)?.notify();
                    }
                });
            }
            PROJECTION_SUMMARY_SUBSCRIPTIONS.get(cacheKey)?.notify();
        }
        return published;
    };
    const requestAbort = new AbortController();
    const publishFailure = (reason: MachineContributionRegistryProjectionFailureReason,
        deferredHydrationRejection?: DaemonProjectionHydrationRejection) => {
        const previous = currentProjectionCacheEntry(cacheKey);
        const retryAttempt = params.shareRetryCadence && previous?.kind === 'error' && matchesRequest(previous)
            ? previous.retryAttempt + 1 : 0;
        return publish({ kind: 'error', projectionRevision: requestRevision, reason, retryAttempt,
            ...(deferredHydrationRejection ? { deferredHydrationRejection } : {}),
            // An answered malformed/mismatched body or a second build replacement
            // is not a transport blip.
            // Keep its typed failure; real invalidation or explicit fresh
            // demand can recover without mounted readers polling that body.
            retryAtMs: reason === 'invalid-response' || reason === 'projection-stale' ? null : Date.now() + PROJECTION_RETRY_BACKOFF_MS[
                Math.min(retryAttempt, PROJECTION_RETRY_BACKOFF_MS.length - 1)
            ]!,
            ...(previous?.deferredProjection && previous.locale === locale
                && areServerAccountScopesEqual(previous.accountScope ?? null, accountScope)
                ? { deferredProjection: previous.deferredProjection } : {}),
            ...(previous?.projectionDigest && previous.locale === locale
                && areServerAccountScopesEqual(previous.accountScope ?? null, accountScope)
                ? { projectionDigest: previous.projectionDigest } : {}),
            ...(previous?.sectionHolding && previous.locale === locale
                && areServerAccountScopesEqual(previous.accountScope ?? null, accountScope)
                ? { sectionHolding: { pool: previous.sectionHolding.pool, bodies: previous.sectionHolding.bodies } } : {}),
            ...((previous?.kind === 'ready' || previous?.kind === 'error') && previous.inputs
                ? { inputs: previous.inputs } : {}),
        });
    };
    const held = currentProjectionCacheEntry(cacheKey);
    const heldInputs = held && (held.kind === 'ready' || held.kind === 'error')
        && held.locale === locale && areServerAccountScopesEqual(held.accountScope ?? null, accountScope)
        ? held.inputs : undefined;
    const knownProjection = held?.projectionDigest && heldInputs?.pluginProjectionV2
        ? { projection: heldInputs.pluginProjectionV2, projectionDigest: held.projectionDigest,
            ...(heldInputs.composerSurfaceCatalog === undefined ? {} : { composerSurfaceCatalog: heldInputs.composerSurfaceCatalog }),
            ...(heldInputs.automationEligibleEvents === undefined ? {} : { automationEligibleEvents: heldInputs.automationEligibleEvents }) }
        : undefined;
    const request = (async (): Promise<ProjectionCacheEntry | null> => {
        const poolKey = routedAccount && full ? JSON.stringify([routedAccount.scope.serverId, routedAccount.scope.accountId, locale]) : null;
        let sectionPool = poolKey ? PROJECTION_SECTION_POOLS.get(poolKey) : undefined;
        if (!sectionPool && poolKey) {
            sectionPool = { key: poolKey, bodies: new Map(), pendingReads: new Map(), references: new Map(), pending: 0 };
            PROJECTION_SECTION_POOLS.set(poolKey, sectionPool);
        }
        if (sectionPool) {
            sectionPool.pending += 1;
        }
        try {
        if (requestAbort.signal.aborted || (routedAccount && !routedAccount.currentness.isCurrent())) return null;
        let res = await machineContributionRegistryProjectionDescribe(params.machineId, {
            selection: params.selection,
            locale,
            ...(params.serverId ? { serverId: params.serverId } : {}),
            ...(accountLifetime ? { accountLifetime } : {}),
            signal: requestAbort.signal,
            ...(knownProjection ? { knownProjection } : {}),
            sections: params.sections,
            ...(held?.deferredProjection && heldInputs ? { deferredProjection: held.deferredProjection,
                reuseManifest: params.reuseFreshReady === true && matchesRequest(held) && held.kind === 'ready'
                    && !daemonProjectionHasSections(held, params.sections) } : {}),
            ...(sectionPool ? { sectionCache: sectionPool } : {}),
        });
        if (requestAbort.signal.aborted) return null;
        if (routedAccount && !routedAccount.currentness.isCurrent()) return null;
        if (res.supported !== true) {
            // A cancelled read supplies no new projection fact. Leave the
            // held answer intact; only a new consumer demand may reacquire.
            if (res.reason === 'aborted') return null;
            // Retiring retained custody is destructive, so only the endpoint
            // that is still current may do it.
            if (
                full && res.reason === 'not-supported'
                && getMachineContributionRegistryProjectionRevision(projectionScope) === requestRevision
            ) {
                // Method-not-found is a machine fact: the endpoint that answered
                // does not serve the projection. Retire the retained entry for
                // that machine so a later offline process cannot restore what
                // the daemon disclaimed. A transient failure keeps custody.
                forgetPluginUiProjectionAdmissionSnapshot({
                    scope: accountLifetime?.scope ?? null,
                    targetKey: pluginUiProjectionAdmissionTargetKey(projectionScope),
                });
            }
            return res.reason === 'not-supported'
                ? publish({ kind: 'unsupported', projectionRevision: requestRevision,
                    ...(res.deferredHydrationRejection ? { deferredHydrationRejection: res.deferredHydrationRejection } : {}) })
                : publishFailure(res.reason, res.deferredHydrationRejection);
        }

        // The machine-wide read sees every installed Agent, so it owns this
        // machine's descriptor set — unless a newer answer already replaced it.
        const newerPublished = currentProjectionCacheEntry(cacheKey);
        if (newerPublished !== null && newerPublished.projectionRevision > requestRevision) return newerPublished;
        // Locale chooses the fresh RPC/cache answer, not an unrelated mounted
        // catalog lifetime. Reconcile the actual new response against the same
        // Account's owned predecessor, including unchanged attachment schemas.
        const previousInputs = newerPublished
            && areServerAccountScopesEqual(newerPublished.accountScope ?? null, accountScope)
            && (newerPublished.kind === 'ready' || newerPublished.kind === 'error')
            ? newerPublished.inputs : undefined;
        if (full && newerPublished && previousInputs?.pluginProjectionV2
            && matchesRequest(newerPublished)) {
            res = mergeProjectionSections(res, {
                supported: true,
                projection: previousInputs.pluginProjectionV2,
                projectionDigest: newerPublished.projectionDigest,
                deferredProjection: newerPublished.deferredProjection,
                sectionBodies: newerPublished.sectionHolding?.bodies,
                ...(previousInputs.composerSurfaceCatalog === undefined ? {} : { composerSurfaceCatalog: previousInputs.composerSurfaceCatalog }),
                ...(previousInputs.automationEligibleEvents === undefined ? {} : { automationEligibleEvents: previousInputs.automationEligibleEvents }),
            });
        }
        const inputs = res.unchanged && heldInputs ? heldInputs : publishDaemonMergedProjectionInputs({
            projection: res.projection,
            ...(full && daemonProjectionHasSections(res, ['resourcesById']) ? { resourceDeclarations: 'complete' as const } : {}),
            ...(res.composerSurfaceCatalog === undefined ? {} : { composerSurfaceCatalog: res.composerSurfaceCatalog }),
            ...(res.automationEligibleEvents === undefined ? {} : { automationEligibleEvents: res.automationEligibleEvents }),
        }, previousInputs);
        if (full && !res.unchanged && daemonProjectionHasSections(res, ['familiesById.pluginUi', 'resourcesById'])
            && routedAccount && locale === getPreferredLanguage()
            && getMachineContributionRegistryProjectionRevision(projectionScope) === requestRevision) {
            savePluginUiProjectionAdmissionSnapshot({
                scope: routedAccount.scope,
                targetKey: pluginUiProjectionAdmissionTargetKey(projectionScope),
                machineId: projectionScope.machineId,
                projection: res.projection,
            });
        }
        if (full && daemonProjectionHasSections(res, ['agentsById']) && routedAccount && locale === getPreferredLanguage()) {
            publishProjectedAgentUiBehaviorDescriptors({
                machineId: projectionScope.machineId,
                accountScope: routedAccount.scope,
                accountLifetime: routedAccount.currentness,
                descriptorsByAgentId: readProjectedAgentUiBehaviorDescriptors(inputs.mergedProviderProjectionById),
                pluginUiProjection: inputs.pluginUiProjection,
                locale,
            });
        }
        return publish({
            kind: 'ready',
            projectionRevision: requestRevision,
            ...(res.deferredHydrationRejection ? { deferredHydrationRejection: res.deferredHydrationRejection } : {}),
            ...(res.projectionDigest === undefined ? {} : { projectionDigest: res.projectionDigest }),
            ...(res.deferredProjection ? { deferredProjection: res.deferredProjection } : {}),
            ...(sectionPool && (res.sectionBodies || (res.unchanged && held?.sectionHolding))
                ? { sectionHolding: { pool: sectionPool, bodies: res.sectionBodies ?? held!.sectionHolding!.bodies } } : {}),
            inputs,
        });
        } finally {
            if (sectionPool) {
                sectionPool.pending -= 1;
                discardEmptySectionPool(sectionPool);
            }
        }
    })().catch((error: unknown) => {
        // Automatic recovery owns failures after transport normalization too.
        // Explicit one-shot callers retain their ordinary rejection contract.
        if (params.shareRetryCadence === undefined) throw error;
        if (requestAbort.signal.aborted || (routedAccount && !routedAccount.currentness.isCurrent())) return null;
        return publishFailure('error');
    });
    let waitingReaders = 0;
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const forget = () => {
        if (LATEST_PROJECTION_REQUEST.get(requestKey) === requestOwner) LATEST_PROJECTION_REQUEST.delete(requestKey);
    };
    const requestOwner: ProjectionRequest = Object.freeze({
        revision: requestRevision,
        locale,
        accountScope,
        wait: async (reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal) => {
            if (reader) retainReader(reader);
            waitingReaders++;
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                if (--waitingReaders === 0 && !settled) {
                    forget();
                    requestAbort.abort();
                }
            };
            let onAbort: (() => void) | undefined;
            let retirement: Readonly<{ dispose(): void }> | undefined;
            try {
                if (signal?.aborted || (reader && !reader.isCurrent())) return null;
                return await new Promise<ProjectionCacheEntry | null>((resolve, reject) => {
                    onAbort = () => { release(); resolve(null); };
                    signal?.addEventListener('abort', onAbort, { once: true });
                    retirement = reader?.onRetire(onAbort);
                    void request.then(resolve, reject);
                });
            } finally {
                if (onAbort) signal?.removeEventListener('abort', onAbort);
                retirement?.dispose();
                release();
            }
        },
    });
    LATEST_PROJECTION_REQUEST.set(requestKey, requestOwner);
    void request.then(forget, forget);
    return await requestOwner.wait(accountLifetime, params.signal);
}

/**
 * Returns this machine's admitted projection until its Account, locale or
 * currentness revision changes. Explicit fresh callers may still set staleMs.
 */
export async function loadDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    staleMs?: number;
    /** Exact routed Account lifetime; background Home descriptors never borrow focus. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    signal?: AbortSignal;
    sections?: readonly string[];
}>): Promise<DaemonMergedProjectionInputs | null> {
    if (params.signal?.aborted) return null;
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }

    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : undefined;
    const cached = readReusableDaemonMergedProjectionCacheEntry({
        machineId,
        serverId: serverId || null,
        accountLifetime: params.accountLifetime,
        staleMs,
        sections: params.sections,
    });
    if (cached?.kind === 'ready') {
        return cached.inputs;
    }

    const entry = await loadDaemonMergedProjectionCacheEntry({
        machineId,
        signal: params.signal,
        sections: params.sections,
        reuseFreshReady: readReusableDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null,
            accountLifetime: params.accountLifetime, staleMs, sections: [] }) !== null,
        ...(serverId ? { serverId } : {}),
        ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
    });
    return entry?.kind === 'ready' ? entry.inputs : null;
}
