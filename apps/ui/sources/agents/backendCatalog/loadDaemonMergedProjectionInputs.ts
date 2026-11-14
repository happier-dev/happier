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
import { readHomeAccountDepartures, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
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
import { daemonProjectionSectionsCover, demandedDaemonProjectionSections, readDaemonProjectionSectionPlugins,
    type DaemonProjectionDeferredSectionsResponse, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getPreferredLanguage } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { mergeProjectionSections } from './mergeProjectionSections';
import { entryIsFresh, matchesProjectionCurrentness } from './projectionCurrentness';
export { entryIsFresh } from './projectionCurrentness';
export type { DaemonMergedProjectionInputs } from './daemonContributionRegistryProjectionAdapters';

type MountedActionsSelection = Pick<Extract<NonNullable<Parameters<typeof machineContributionRegistryProjectionDescribe>[1]>,
    { selection: 'mountedActions' }>, 'callers' | 'actions'>;

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
    /** Exact selected caller/Action identities; absent for the complete catalogue. */
    questionKey?: string;
    retirement?: Readonly<{ dispose(): void }>;
    /** Daemon content identity of the held full answer; never a freshness authority. */
    projectionDigest?: string;
    deferredProjection?: DeferredDaemonProjection;
    deferredHydrationRejection?: DaemonProjectionHydrationRejection;
    sectionHolding?: ProjectionSectionHolding;
    accountScope?: ServerAccountScope | null;
    /** The Home this answer was read from; null is the focused Home. */
    targetServerId?: string | null;
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

/**
 * What a loading reader asks a Machine for. Every loader names it: the
 * sections its fields read, or `'complete'` for a reader that genuinely
 * presents the whole catalogue. An omitted demand used to mean the complete
 * catalogue, so one unsectioned reader hydrated every section page on a cold
 * Machine (P03-CATALOG-SECTIONS).
 */
export type DaemonProjectionSectionDemand = readonly string[] | 'complete';
/** The loader's internal section list; `undefined` is the complete catalogue. */
export function daemonProjectionSectionList(demand: DaemonProjectionSectionDemand): readonly string[] | undefined {
    return demand === 'complete' ? undefined : demand;
}

/** An unfetched dictionary is unknown, never an authoritative empty catalogue. */
export function daemonProjectionHasSections(entry: Readonly<{ deferredProjection?: DeferredDaemonProjection }>, sections?: readonly string[]): boolean {
    const deferred = entry.deferredProjection;
    return !deferred || daemonProjectionSectionsCover(deferred.manifest, deferred.loadedSections, sections);
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
    questionKey?: string;
    /** The Account it reads for; a successor Account never joins it. */
    accountScope: ServerAccountScope | null;
    /**
     * Every lifetime handle waiting on it. Readers of one Account hold separate
     * handles (one per credential-scope hook), so the answer is published while
     * any of them is still current, not only while the issuer is.
     */
    wait(reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal): Promise<ProjectionCacheEntry | null>;
    /** The sections this request hydrates; undefined is the complete set. */
    sections: readonly string[] | undefined;
    /**
     * Its admitted deferred manifest, as soon as the describe answers and
     * before its sections hydrate; null when it settles without one. A reader
     * holds the request like a waiter while it asks.
     */
    manifest(reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal): Promise<DaemonProjectionDeferredSectionsResponse | null>;
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

/**
 * This cache's key names no Account, so an answer leaves with the Account that read it: one whose
 * readers no longer hold (finished readers push nothing themselves, so a mounted summary wakes here),
 * and one read without an Account lifetime, which has no reader to retire it.
 */
let accountRetirementSubscribed = false;
function evictAnswersOnHomeAccountRetirement(): void {
    if (accountRetirementSubscribed) return;
    accountRetirementSubscribed = true;
    subscribeHomeCredentialChange((event, { accountLeft }) => {
        if (!accountLeft) return;
        const serverId = event.serverId;
        for (const [cacheKey, entry] of [...PROJECTION_CACHE]) {
            if (entry.accountCurrentness ? entry.accountCurrentness.isCurrent()
                : entry.targetServerId && !areServerProfileIdentifiersEquivalent(entry.targetServerId, serverId)) continue;
            PROJECTION_CACHE.delete(cacheKey);
            entry.retirement?.dispose();
            releaseProjectionSections(entry.sectionHolding);
            PROJECTION_SUMMARY_SUBSCRIPTIONS.get(cacheKey)?.notify();
        }
    });
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

/**
 * Which plugins' Actions this Machine's held answer read: `'all'`, the loaded
 * plugin slices, or null when no Action was read. A plugin outside the slices
 * is not loaded; its absence is never a retirement.
 */
export function readDaemonProjectionActionPlugins(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): 'all' | ReadonlySet<string> | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return null;
    const entry = currentProjectionCacheEntry(buildCacheKey(machineId, normalizeKeyPart(params.serverId) || null));
    if (!entry || (entry.kind !== 'ready' && entry.kind !== 'error') || !entry.inputs) return null;
    return entry.deferredProjection ? readDaemonProjectionSectionPlugins(entry.deferredProjection.loadedSections, 'actionsById') : 'all';
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
    /** Required: the sections this reader's fields read, or `'complete'`. */
    sections: DaemonProjectionSectionDemand;
    /** Existing purpose admission query; never authoritative for full presentation coverage. */
    selection?: 'connectedAccountAdmission';
    /** Mounted surfaces share this exact question, never the full-catalogue answer. */
    mountedActions?: MountedActionsSelection;
}>): Promise<ProjectionCacheEntry | null> {
    if (params.signal?.aborted) return null;
    const sections = daemonProjectionSectionList(params.sections);
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (accountLifetime && !accountLifetime.isCurrent()) return null;
    const locale = getPreferredLanguage();
    const machineCacheKey = buildCacheKey(params.machineId, params.serverId, params.selection);
    const selected = params.mountedActions;
    const full = !selected && !params.selection;
    const questionKey = selected ? stableJsonStringify({
        callers: selected.callers.map(caller => stableJsonStringify(caller)).sort(),
        actions: selected.actions.map(action => stableJsonStringify(action)).sort(),
    }) : undefined;
    // One held answer for this target's caller set. Changed occurrence, custody
    // or Action demand replaces it rather than retaining superseded bodies.
    const cacheKey = selected ? JSON.stringify([machineCacheKey, 'mountedActions',
        selected.callers.map(caller => caller.pluginId).sort()]) : machineCacheKey;
    // The canonical per-machine projection scope. Its revision advances on
    // an explicit invalidation, registry change, or known daemon replacement.
    // Initial inventory only discovers the endpoint a successful
    // read already asked; it does not make that answer stale. The machine
    // writer owns actual registry changes through this revision.
    const projectionScope = {
        machineId: normalizeKeyPart(params.machineId),
        serverId: normalizeKeyPart(params.serverId) || null,
    };
    const requestRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
    const accountScope = accountLifetime?.scope ?? null;
    // Section sets hydrate the same Account/Machine/locale answer. Join its
    // admission first; a reader missing coverage then hydrates the held manifest.
    // Purpose-specific questions retain their existing identity.
    // A read with no lifetime on its Home is bound to that Home's Account only by when it was issued.
    const isRoutedToLifetime = accountLifetime !== null
        && (!params.serverId || areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, params.serverId));
    const issuedDepartures = readHomeAccountDepartures(params.serverId);
    const requestKey = JSON.stringify([cacheKey, accountScope?.serverId ?? null, accountScope?.accountId ?? null, locale,
        selected ? questionKey : null, isRoutedToLifetime ? null : issuedDepartures]);
    const matchesRequest = (entry: ProjectionCacheEntry) => entry.questionKey === questionKey
        && matchesProjectionCurrentness(entry, { projectionRevision: requestRevision, locale, accountScope });
    const incumbentRequest = LATEST_PROJECTION_REQUEST.get(requestKey);
    // Demand the in-flight request does not cover hydrates beside it from its
    // manifest; shared bodies join its pending reads. Waiting for its whole
    // answer queued a Session's Composer behind the complete UI catalogue.
    let inFlightManifest: DaemonProjectionDeferredSectionsResponse | null = null;
    if (
        incumbentRequest?.revision === requestRevision
        && incumbentRequest.questionKey === questionKey
        && incumbentRequest.locale === locale
        && (incumbentRequest.accountScope === accountScope
            || areServerAccountScopesEqual(incumbentRequest.accountScope, accountScope))
    ) {
        const manifest = full ? await incumbentRequest.manifest(accountLifetime, params.signal) : null;
        if (params.signal?.aborted || (accountLifetime && !accountLifetime.isCurrent())) return null;
        if (manifest && !daemonProjectionSectionsCover(manifest,
            demandedDaemonProjectionSections(manifest, incumbentRequest.sections), sections)) {
            inFlightManifest = manifest;
        } else {
            const answer = await incumbentRequest.wait(accountLifetime, params.signal);
            if (!answer || answer.kind !== 'ready' || daemonProjectionHasSections(answer, sections)) return answer;
            return await loadDaemonMergedProjectionCacheEntry({ ...params, accountLifetime, reuseFreshReady: true });
        }
    }
    if (!inFlightManifest && incumbentRequest && (incumbentRequest.accountScope === accountScope
        || areServerAccountScopesEqual(incumbentRequest.accountScope, accountScope))) {
        // A newer revision needs its own fresh answer, but not a second
        // full body queued behind the first. Finish the issued read, then let
        // all waiting readers share one request for the latest facts.
        try { await incumbentRequest.wait(accountLifetime, params.signal); } catch { /* The successor still reads fresh authority. */ }
        if (params.signal?.aborted || (accountLifetime && !accountLifetime.isCurrent())) return null;
        return await loadDaemonMergedProjectionCacheEntry({ ...params, accountLifetime, reuseFreshReady: true });
    }
    if (selected && params.reuseFreshReady !== false) {
        const cached = currentProjectionCacheEntry(cacheKey);
        // Mounted demand has no age-based refresh or automatic failure retry.
        // Its existing currentness revision and explicit Retry own re-admission.
        if (cached && matchesRequest(cached)) {
            if (accountLifetime) cached.accountCurrentness?.retainReader(accountLifetime);
            return cached;
        }
    }
    const previousAttempt = params.shareRetryCadence ? currentProjectionCacheEntry(cacheKey) : null;
    if (params.shareRetryCadence && previousAttempt?.kind === 'error' && matchesRequest(previousAttempt)
        && (previousAttempt.retryAtMs === null || Date.now() < previousAttempt.retryAtMs)) {
        if (accountLifetime) previousAttempt.accountCurrentness?.retainReader(accountLifetime);
        return previousAttempt;
    }
    if (!selected && params.reuseFreshReady === true) {
        const cached = readReusableDaemonMergedProjectionCacheEntry({
            machineId: params.machineId,
            serverId: params.serverId,
            accountLifetime,
            sections,
            selection: params.selection,
        });
        if (cached) {
            return accountLifetime && !accountLifetime.isCurrent() ? null : cached;
        }
    }
    const readers = new Set<ActiveServerAccountScopeLifetime>(accountLifetime ? [accountLifetime] : []);
    const readerObservers = new Set<Readonly<{
        observe(reader: ActiveServerAccountScopeLifetime): void;
        forget(reader: ActiveServerAccountScopeLifetime): void;
    }>>();
    const retainReader = (reader: ActiveServerAccountScopeLifetime) => {
        for (const previous of readers) {
            if (previous === reader || (previous.isCurrent() && !previous.isReleased?.())) continue;
            readers.delete(previous);
            for (const observer of readerObservers) observer.forget(previous);
        }
        if (readers.has(reader)) return;
        readers.add(reader);
        for (const observer of readerObservers) observer.observe(reader);
    };
    const hasCurrentReader = () => [...readers].some(reader => reader.isCurrent());
    const routedAccount = accountLifetime && isRoutedToLifetime
        ? {
            scope: accountLifetime.scope,
            currentness: Object.freeze({
                isCurrent: hasCurrentReader,
                retainReader,
                onRetire: (cancel: () => void) => {
                    const retirements = new Map<ActiveServerAccountScopeLifetime, Readonly<{ dispose(): void }>>();
                    const forget = (reader: ActiveServerAccountScopeLifetime) => {
                        retirements.get(reader)?.dispose();
                        retirements.delete(reader);
                    };
                    const observe = (reader: ActiveServerAccountScopeLifetime) => {
                        if (!reader.isCurrent()) return;
                        let retirement: Readonly<{ dispose(): void }> | null = null;
                        retirement = reader.onRetire(() => {
                            readers.delete(reader);
                            if (retirement) forget(reader);
                            if (!hasCurrentReader()) cancel();
                        });
                        retirements.set(reader, retirement);
                    };
                    const observer = Object.freeze({ observe, forget });
                    readerObservers.add(observer);
                    for (const reader of readers) observe(reader);
                    return Object.freeze({ dispose: () => {
                        readerObservers.delete(observer);
                        for (const reader of retirements.keys()) forget(reader);
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
        // Refreshing an answer does not replace its Account's mounted readers.
        // Keep their shared custody when this request's issuer later retires.
        const accountCurrentness = routedAccount && current?.accountCurrentness
            && areServerAccountScopesEqual(current.accountScope ?? null, routedAccount.scope)
            ? current.accountCurrentness : routedAccount?.currentness;
        if (accountCurrentness && accountCurrentness !== routedAccount?.currentness) {
            for (const reader of readers) accountCurrentness.retainReader(reader);
        }
        const retirement = !full && accountCurrentness ? accountCurrentness.onRetire(() => {
            const cached = PROJECTION_CACHE.get(cacheKey);
            if (cached?.accountCurrentness === accountCurrentness && !accountCurrentness.isCurrent()) {
                PROJECTION_CACHE.delete(cacheKey);
                cached.retirement?.dispose();
            }
        }) : undefined;
        const published: ProjectionCacheEntry = Object.freeze({
            ...entry,
            // Freshness starts when the admitted answer becomes usable, not
            // before a cold describe and its section hydration have finished.
            fetchedAtMs: Date.now(),
            questionKey,
            ...(retirement ? { retirement } : {}),
            accountScope,
            targetServerId: projectionScope.serverId,
            locale,
            summaries: routedAccount && full
                ? current && inputs === previousInputs ? current.summaries : publishProjectionSummaries(inputs)
                : EMPTY_PROJECTION_SUMMARIES,
            ...(accountCurrentness ? { accountCurrentness } : {}),
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
            evictAnswersOnHomeAccountRetirement();
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
            const previousSections = current?.deferredProjection?.loadedSections;
            const nextSections = published.deferredProjection?.loadedSections;
            const sameCoverage = previousSections === nextSections || (previousSections && nextSections
                && previousSections.length === nextSections.length
                && previousSections.every(section => nextSections.includes(section)));
            const sameReadyFacts = current?.kind === 'ready' && published.kind === 'ready'
                && inputs === previousInputs && matchesProjectionCurrentness(current, published)
                && current.questionKey === published.questionKey && current.projectionDigest === published.projectionDigest
                && current.deferredHydrationRejection === published.deferredHydrationRejection && sameCoverage;
            // Freshness and held bytes renew above; unchanged published facts
            // do not wake every passive reader of this Machine.
            if (!sameReadyFacts) PROJECTION_SUMMARY_SUBSCRIPTIONS.get(cacheKey)?.notify();
        }
        return published;
    };
    const requestAbort = new AbortController();
    let revealManifest!: (manifest: DaemonProjectionDeferredSectionsResponse) => void;
    const manifestSeen = new Promise<DaemonProjectionDeferredSectionsResponse>(resolve => { revealManifest = resolve; });
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
            ...(selected ? { selection: 'mountedActions' as const, ...selected } : { selection: params.selection }),
            locale,
            ...(params.serverId ? { serverId: params.serverId } : {}),
            ...(accountLifetime ? { accountLifetime } : {}),
            signal: requestAbort.signal,
            ...(knownProjection ? { knownProjection } : {}),
            sections,
            onManifest: revealManifest,
            ...(inFlightManifest ? { deferredProjection: { manifest: inFlightManifest, loadedSections: [] }, reuseManifest: true }
            : held?.deferredProjection && heldInputs ? { deferredProjection: held.deferredProjection,
                reuseManifest: params.reuseFreshReady === true && matchesRequest(held) && held.kind === 'ready'
                    && !daemonProjectionHasSections(held, sections) } : {}),
            ...(sectionPool ? { sectionCache: sectionPool } : {}),
        });
        if (requestAbort.signal.aborted) return null;
        if (routedAccount ? !routedAccount.currentness.isCurrent() : issuedDepartures !== readHomeAccountDepartures(params.serverId)) return null;
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
        if (requestAbort.signal.aborted
            || (routedAccount ? !routedAccount.currentness.isCurrent() : issuedDepartures !== readHomeAccountDepartures(params.serverId))) return null;
        return publishFailure('error');
    });
    let waitingReaders = 0;
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const forget = () => {
        if (LATEST_PROJECTION_REQUEST.get(requestKey) === requestOwner) LATEST_PROJECTION_REQUEST.delete(requestKey);
    };
    const hold = async <T>(reader: ActiveServerAccountScopeLifetime | null, signal: AbortSignal | undefined,
        answer: Promise<T | null>): Promise<T | null> => {
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
            return await new Promise<T | null>((resolve, reject) => {
                onAbort = () => { release(); resolve(null); };
                signal?.addEventListener('abort', onAbort, { once: true });
                retirement = reader?.onRetire(onAbort);
                void answer.then(resolve, reject);
            });
        } finally {
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            retirement?.dispose();
            release();
        }
    };
    const requestOwner: ProjectionRequest = Object.freeze({
        revision: requestRevision,
        locale,
        questionKey,
        accountScope,
        sections,
        wait: (reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal) => hold(reader, signal, request),
        manifest: (reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal) => hold(reader, signal,
            Promise.race([manifestSeen, request.then(() => null, () => null)])),
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
    /** Required: the sections this reader's fields read, or `'complete'`. */
    sections: DaemonProjectionSectionDemand;
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
        sections: daemonProjectionSectionList(params.sections),
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
