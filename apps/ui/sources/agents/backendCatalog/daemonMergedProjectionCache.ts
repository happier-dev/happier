import type {
    MachineContributionRegistryProjectionFailureReason,
    DeferredDaemonProjection,
    DaemonProjectionHydrationRejection,
    DaemonProjectionSectionCache,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    captureMachineContributionRegistryProjectionScope,
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionScopeKey,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjectionRevision';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS, daemonProjectionSectionsCover, readDaemonProjectionSectionPlugins,
    type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getPreferredLanguage } from '@/text';
import { slicePluginSections } from '@/sync/domains/plugins/ui/projectionSections';
import type { DaemonMergedProjectionInputs } from './daemonContributionRegistryProjectionAdapters';
import type { ActionDiscoveryDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import type { WorkflowEventsListOutputV1 } from '@happier-dev/protocol/actions/specs/workflowEvents';

// The held projection answers and their synchronous readers. This module stays
// free of the Machine RPC stack so store domains can read a published Machine
// declaration without importing the network/socket graph (which imports the
// store back). loadDaemonMergedProjectionInputs owns loading and writes here.

export type ProjectionCacheResult = (
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
export type ProjectionCacheEntry = Readonly<{
    /** Demand-scoped Action discovery borrows this exact admitted projection. */
    workflowActionCatalog: { current: ProjectionActionCatalogRead | null };
    workflowEventCatalog: { current: ProjectionCatalogRead<WorkflowEventsListOutputV1['events']> | null };
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
export type ProjectionCatalogRead<T> = {
    readonly promise: Promise<T>;
    readers: number;
    dispose(): void;
};
export type ProjectionActionCatalogRead = ProjectionCatalogRead<readonly ActionDiscoveryDefinitionSummaryV1[]>;
/** An Account authoring demand has no daemon projection to fabricate. */
export type AccountActionCatalogEntry = Readonly<{
    kind: 'accountActionCatalog';
    accountScope: ServerAccountScope;
    accountCurrentness: ActiveServerAccountScopeLifetime;
    targetServerId: string;
    workflowActionCatalog: { current: ProjectionActionCatalogRead | null };
    retirement?: Readonly<{ dispose(): void }>;
    sectionHolding?: undefined;
}>;
export type ReusableProjectionCacheEntry = Extract<ProjectionCacheEntry, { kind: 'ready' | 'unsupported' }>;

/**
 * The one UI owner of each machine's daemon projection. Every reader — the
 * AppShell plugin UI currentness, `useDaemonMergedProjectionInputs`, and the
 * direct callers — goes through this cache and its single in-flight request
 * per machine scope, projection revision, requested locale and section demand.
 */
export const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry | AccountActionCatalogEntry>();
type ProjectionSectionPool = DaemonProjectionSectionCache & {
    key: string;
    references: Map<string, number>;
    pending: number;
};
export type ProjectionSectionHolding = {
    pool: ProjectionSectionPool;
    bodies: ReadonlyMap<string, readonly string[]>;
    retirement?: Readonly<{ dispose(): void }>;
};
// This is the byte inventory of the existing held Machine answers. Replacement
// and Account retirement release their references; superseded bodies do not linger.
export const PROJECTION_SECTION_POOLS = new Map<string, ProjectionSectionPool>();

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
const NO_PLUGINS: ReadonlySet<string> = Object.freeze(new Set<string>());
/**
 * Plugins whose slices of `sections` this held answer covers, for an answer that holds slices
 * rather than the whole sections: those plugins are presented; every other plugin is not loaded.
 */
export function readDaemonProjectionCoveredPlugins(entry: Readonly<{ deferredProjection?: DeferredDaemonProjection }>,
    sections: readonly string[]): ReadonlySet<string> {
    const deferred = entry.deferredProjection;
    if (!deferred) return NO_PLUGINS;
    const sliced = new Set<string>();
    for (const section of DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS) {
        const plugins = readDaemonProjectionSectionPlugins(deferred.loadedSections, section);
        if (plugins instanceof Set) for (const pluginId of plugins) sliced.add(pluginId);
    }
    const covered = [...sliced].filter(pluginId => daemonProjectionSectionsCover(deferred.manifest, deferred.loadedSections,
        slicePluginSections(sections, pluginId)));
    return covered.length ? new Set(covered.sort()) : NO_PLUGINS;
}
export function discardEmptySectionPool(pool: ProjectionSectionPool): void {
    if (pool.pending === 0) {
        for (const digest of pool.bodies.keys()) {
            if (!pool.references.has(digest)) pool.bodies.delete(digest);
        }
    }
    if (pool.pending === 0 && pool.references.size === 0 && PROJECTION_SECTION_POOLS.get(pool.key) === pool) {
        PROJECTION_SECTION_POOLS.delete(pool.key);
    }
}
export function releaseProjectionSections(holding: ProjectionSectionHolding | undefined): void {
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
export const PROJECTION_SUMMARY_SUBSCRIPTIONS = new Map<string, ProjectionSummarySubscription>();

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
export const EMPTY_PROJECTION_SUMMARIES: ProjectionSummaries = Object.freeze({ current: EMPTY_PROJECTION_SUMMARY, stale: EMPTY_PROJECTION_SUMMARY });

export function publishProjectionSummaries(inputs: DaemonMergedProjectionInputs | undefined): ProjectionSummaries {
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

export function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

export function buildCacheKey(
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
export function evictAnswersOnHomeAccountRetirement(): void {
    if (accountRetirementSubscribed) return;
    accountRetirementSubscribed = true;
    subscribeHomeCredentialChange((event, { accountLeft }) => {
        if (!accountLeft) return;
        const serverId = event.serverId;
        for (const [cacheKey, entry] of [...PROJECTION_CACHE]) {
            if (entry.accountCurrentness ? entry.accountCurrentness.isCurrent()
                : entry.targetServerId && !areServerProfileIdentifiersEquivalent(entry.targetServerId, serverId)) continue;
            PROJECTION_CACHE.delete(cacheKey);
            entry.workflowActionCatalog.current?.dispose();
            if (entry.kind !== 'accountActionCatalog') entry.workflowEventCatalog.current?.dispose();
            entry.retirement?.dispose();
            releaseProjectionSections(entry.sectionHolding);
            PROJECTION_SUMMARY_SUBSCRIPTIONS.get(cacheKey)?.notify();
        }
    });
}

export function currentProjectionCacheEntry(cacheKey: string): ProjectionCacheEntry | null {
    const entry = PROJECTION_CACHE.get(cacheKey) ?? null;
    if (entry?.accountCurrentness && !entry.accountCurrentness.isCurrent()) {
        PROJECTION_CACHE.delete(cacheKey);
        entry.workflowActionCatalog.current?.dispose();
        if (entry.kind !== 'accountActionCatalog') entry.workflowEventCatalog.current?.dispose();
        entry.retirement?.dispose();
        releaseProjectionSections(entry.sectionHolding);
        return null;
    }
    return entry?.kind === 'accountActionCatalog' ? null : entry;
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
