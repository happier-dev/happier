import {
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionDescribe,
    type MachineContributionRegistryProjectionFailureReason,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';
import { machineContributionRegistryProjectionScopeKey } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import {
    forgetPluginUiProjectionAdmissionSnapshot,
    pluginUiProjectionAdmissionTargetKey,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    readProjectedAgentUiBehaviorDescriptors,
    type PluginProjectionDiagnostic,
    type PluginProjectionEntry,
} from './daemonContributionRegistryProjectionAdapters';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';
import type {
    DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import { getPreferredLanguage } from '@/text';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

export type DaemonMergedProjectionInputs = Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    /** One daemon-selected Composer renderer catalog carried by this projection snapshot. */
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    /** Current cold Event-automation composer facts carried by the same daemon projection. */
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>;

type ProjectionCacheResult = (
    | Readonly<{ kind: 'ready'; fetchedAtMs: number; inputs: DaemonMergedProjectionInputs }>
    | Readonly<{ kind: 'unsupported'; fetchedAtMs: number }>
    | Readonly<{
        kind: 'error';
        fetchedAtMs: number;
        /** Why the latest read failed; the last good inputs stay available. */
        reason: MachineContributionRegistryProjectionFailureReason;
        inputs?: DaemonMergedProjectionInputs;
    }>
);
type ProjectionCacheEntry = Readonly<{
    projectionRevision: number;
    accountScope?: ServerAccountScope | null;
    hasObservedMachine: boolean;
    /** The locale whose narrowed translation bundles this answer carries. */
    locale: string;
    /** The exact routed Home credential that authorized this projection. */
    accountCurrentness?: Readonly<{ isCurrent(): boolean }>;
}> & ProjectionCacheResult;
type ReusableProjectionCacheEntry = Extract<ProjectionCacheEntry, { kind: 'ready' | 'unsupported' }>;

/**
 * The one UI owner of each machine's daemon projection. Every reader — the
 * AppShell plugin UI currentness, `useDaemonMergedProjectionInputs`, and the
 * direct callers — goes through this cache and its single in-flight request
 * per machine scope, projection revision and requested locale.
 */
const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry>();
const DEFAULT_PROJECTION_STALE_MS = 60_000;
type ProjectionRequest = Readonly<{
    revision: number;
    hasObservedMachine: boolean;
    locale: string;
    /** The Account it reads for; a successor Account never joins it. */
    accountScope: ServerAccountScope | null;
    /**
     * Every lifetime handle waiting on it. Readers of one Account hold separate
     * handles (one per credential-scope hook), so the answer is published while
     * any of them is still current, not only while the issuer is.
     */
    readers: Set<ActiveServerAccountScopeLifetime>;
    promise: Promise<ProjectionCacheEntry | null>;
}>;
const LATEST_PROJECTION_REQUEST = new Map<string, ProjectionRequest>();

export function clearDaemonMergedProjectionCacheForTests(): void {
    PROJECTION_CACHE.clear();
    clearProjectedAgentUiBehaviorDescriptors();
    LATEST_PROJECTION_REQUEST.clear();
}

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function buildCacheKey(
    machineId: string,
    serverId: string | null | undefined,
): string {
    return machineContributionRegistryProjectionScopeKey({
        serverId: normalizeKeyPart(serverId) || null,
        machineId: normalizeKeyPart(machineId),
    });
}

export function entryIsFresh(entry: Readonly<{ fetchedAtMs: number }>, staleMs: number): boolean {
    const ageMs = Date.now() - entry.fetchedAtMs;
    return ageMs >= 0 && ageMs <= staleMs;
}

function currentProjectionCacheEntry(cacheKey: string): ProjectionCacheEntry | null {
    const entry = PROJECTION_CACHE.get(cacheKey) ?? null;
    if (entry?.accountCurrentness && !entry.accountCurrentness.isCurrent()) {
        PROJECTION_CACHE.delete(cacheKey);
        return null;
    }
    return entry;
}

export function readCachedDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): ProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }
    return currentProjectionCacheEntry(buildCacheKey(machineId, normalizeKeyPart(params.serverId) || null));
}

function hasObservedMachine(machineId: string, serverId: string | null): boolean {
    const state = readRegisteredStorageState();
    return state !== null && resolveServerScopedMachine(state, serverId, machineId) !== null;
}

/** The single authoritative reuse decision for every projection reader. */
export function readReusableDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    staleMs?: number;
}>): ReusableProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return null;
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!accountLifetime?.isCurrent()) return null;
    const serverId = normalizeKeyPart(params.serverId) || null;
    const cached = currentProjectionCacheEntry(buildCacheKey(machineId, serverId));
    const staleMs = params.staleMs ?? DEFAULT_PROJECTION_STALE_MS;
    if (
        !cached || cached.kind === 'error'
        || !entryIsFresh(cached, staleMs)
        || cached.projectionRevision !== getMachineContributionRegistryProjectionRevision({ machineId, serverId })
        || cached.hasObservedMachine !== hasObservedMachine(machineId, serverId)
        || cached.locale !== getPreferredLanguage()
        || (cached.accountScope !== accountLifetime.scope
            && !areServerAccountScopesEqual(cached.accountScope ?? null, accountLifetime.scope))
    ) return null;
    return cached;
}

function toInputs(params: Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>): DaemonMergedProjectionInputs {
    return {
        mergedProviderProjectionById: params.mergedProviderProjectionById,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        discoveredBackendIds: Object.keys(params.mergedBackendProjectionById ?? {}),
        pluginProjectionById: params.pluginProjectionById,
        pluginProjectionV2: params.pluginProjectionV2,
        ...(params.composerSurfaceCatalog === undefined
            ? {}
            : { composerSurfaceCatalog: params.composerSurfaceCatalog }),
        ...(params.automationEligibleEvents === undefined
            ? {}
            : { automationEligibleEvents: params.automationEligibleEvents }),
        registryDiagnostics: params.registryDiagnostics,
    };
}

export async function loadDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    /** Exact routed Account lifetime; required for background descriptor publication. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** App-shell readers may reuse the same fresh, Account-qualified projection. */
    reuseFreshReady?: boolean;
}>): Promise<ProjectionCacheEntry | null> {
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    const locale = getPreferredLanguage();
    const cacheKey = buildCacheKey(params.machineId, params.serverId);
    // The canonical per-machine projection scope. Its revision advances on
    // socket reconnect, on an explicit invalidation, and on a known daemon
    // replacement. Only the first exact-Home inventory observation qualifies
    // bootstrap reuse separately; subsequent state decisions belong to this
    // revision, never to the generic daemon-state version.
    const projectionScope = {
        machineId: normalizeKeyPart(params.machineId),
        serverId: normalizeKeyPart(params.serverId) || null,
    };
    const requestRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
    const requestHasObservedMachine = hasObservedMachine(projectionScope.machineId, projectionScope.serverId);
    const accountScope = accountLifetime?.scope ?? null;
    const incumbentRequest = LATEST_PROJECTION_REQUEST.get(cacheKey);
    if (
        incumbentRequest?.revision === requestRevision
        && incumbentRequest.hasObservedMachine === requestHasObservedMachine
        && incumbentRequest.locale === locale
        && (incumbentRequest.accountScope === accountScope
            || areServerAccountScopesEqual(incumbentRequest.accountScope, accountScope))
    ) {
        if (accountLifetime) incumbentRequest.readers.add(accountLifetime);
        const shared = await incumbentRequest.promise;
        return accountLifetime && !accountLifetime.isCurrent() ? null : shared;
    }
    if (params.reuseFreshReady === true) {
        const cached = readReusableDaemonMergedProjectionCacheEntry({
            machineId: params.machineId,
            serverId: params.serverId,
            accountLifetime,
        });
        if (cached?.kind === 'ready') {
            return accountLifetime && !accountLifetime.isCurrent() ? null : cached;
        }
    }
    const readers = new Set<ActiveServerAccountScopeLifetime>(accountLifetime ? [accountLifetime] : []);
    const routedAccount = accountLifetime
        && (!params.serverId || areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, params.serverId))
        ? {
            scope: accountLifetime.scope,
            currentness: Object.freeze({
                isCurrent: () => [...readers].some((reader) => reader.isCurrent()),
            }),
        }
        : null;
    // Every answer is published tagged with the revision it answered, unless a
    // newer one is already cached. A read never waits on a newer read: when the
    // daemon's state keeps advancing, waiting would never settle.
    const publish = (entry: ProjectionCacheResult & Readonly<{ projectionRevision: number }>): ProjectionCacheEntry => {
        const current = currentProjectionCacheEntry(cacheKey);
        if (current !== null && current.projectionRevision > entry.projectionRevision) return current;
        const published = Object.freeze({
            ...entry,
            accountScope,
            hasObservedMachine: requestHasObservedMachine,
            locale,
            ...(routedAccount ? { accountCurrentness: routedAccount.currentness } : {}),
        });
        // A former locale may settle after the current one. It still answers
        // its reader, but never replaces the current locale's shared cache.
        if (locale === getPreferredLanguage()) PROJECTION_CACHE.set(cacheKey, published);
        return published;
    };
    const request = (async (): Promise<ProjectionCacheEntry | null> => {
        const fetchedAtMs = Date.now();
        const res = await machineContributionRegistryProjectionDescribe(params.machineId, {
            ...(params.serverId ? { serverId: params.serverId } : {}),
            ...(accountLifetime ? { accountLifetime } : {}),
        });
        if (routedAccount && !routedAccount.currentness.isCurrent()) return null;
        if (res.supported !== true) {
            const previous = currentProjectionCacheEntry(cacheKey);
            // Retiring retained custody is destructive, so only the endpoint
            // that is still current may do it.
            if (
                res.reason === 'not-supported'
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
            return publish(res.reason === 'not-supported'
                ? { kind: 'unsupported', fetchedAtMs, projectionRevision: requestRevision }
                : {
                    kind: 'error',
                    fetchedAtMs,
                    projectionRevision: requestRevision,
                    reason: res.reason,
                    ...(
                        previous?.kind === 'ready' || previous?.kind === 'error'
                            ? (previous.inputs ? { inputs: previous.inputs } : {})
                            : {}
                    ),
                });
        }

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(res.projection);
        // The machine-wide read sees every installed Agent, so it owns this
        // machine's descriptor set — unless a newer answer already replaced it.
        const newerPublished = currentProjectionCacheEntry(cacheKey);
        if (newerPublished !== null && newerPublished.projectionRevision > requestRevision) return newerPublished;
        if (routedAccount && locale === getPreferredLanguage()) {
            publishProjectedAgentUiBehaviorDescriptors({
                machineId: projectionScope.machineId,
                accountScope: routedAccount.scope,
                accountLifetime: routedAccount.currentness,
                descriptorsByAgentId: readProjectedAgentUiBehaviorDescriptors(adapted.mergedProviderProjectionById),
                pluginUiProjection: normalizePluginUiProjection(res.projection),
                locale,
            });
        }
        return publish({
            kind: 'ready',
            fetchedAtMs,
            projectionRevision: requestRevision,
            inputs: toInputs({
                ...adapted,
                pluginProjectionV2: res.projection,
                ...(res.composerSurfaceCatalog === undefined
                    ? {}
                    : { composerSurfaceCatalog: res.composerSurfaceCatalog }),
                ...(res.automationEligibleEvents === undefined
                    ? {}
                    : { automationEligibleEvents: res.automationEligibleEvents }),
            }),
        });
    })();
    const requestOwner: ProjectionRequest = Object.freeze({
        revision: requestRevision,
        hasObservedMachine: requestHasObservedMachine,
        locale,
        accountScope,
        readers,
        promise: request,
    });
    LATEST_PROJECTION_REQUEST.set(cacheKey, requestOwner);
    try {
        const entry = await request;
        return accountLifetime && !accountLifetime.isCurrent() ? null : entry;
    } finally {
        if (LATEST_PROJECTION_REQUEST.get(cacheKey) === requestOwner) {
            LATEST_PROJECTION_REQUEST.delete(cacheKey);
        }
    }
}

/**
 * Returns this machine's current projection inputs, reusing a ready entry
 * younger than `staleMs` for the current projection revision.
 */
export async function loadDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    staleMs?: number;
    /** Exact routed Account lifetime; background Home descriptors never borrow focus. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): Promise<DaemonMergedProjectionInputs | null> {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }

    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : DEFAULT_PROJECTION_STALE_MS;
    const cached = readReusableDaemonMergedProjectionCacheEntry({
        machineId,
        serverId: serverId || null,
        accountLifetime: params.accountLifetime,
        staleMs,
    });
    if (cached?.kind === 'ready') {
        return cached.inputs;
    }

    const entry = await loadDaemonMergedProjectionCacheEntry({
        machineId,
        ...(serverId ? { serverId } : {}),
        ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
    });
    return entry?.kind === 'ready' ? entry.inputs : null;
}
