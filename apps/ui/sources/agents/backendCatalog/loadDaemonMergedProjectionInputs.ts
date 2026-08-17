import {
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionDescribe,
} from '@/sync/ops/machineContributionRegistryProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    type PluginProjectionDiagnostic,
    type PluginProjectionEntry,
} from './daemonContributionRegistryProjectionAdapters';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';
import type {
    DaemonContributionRegistryProjectionMountedTargetV1,
    DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    DaemonPluginUiTargetedSurfaceMountV1,
    PreparedPluginJsonSchema,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import {
    normalizePluginJsonSchema,
    preparePluginJsonSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';

import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

/**
 * One exact target/contributor mount plus the sole generation-retained input
 * validator. This is host-private executable state, never an RPC projection:
 * the response remains raw JSON-schema data and this cache owns the one
 * prepared pair for its exact target snapshot.
 */
export type PreparedDaemonPluginUiTargetedSurfaceMountV1 = Readonly<
    Omit<DaemonPluginUiTargetedSurfaceMountV1, 'inputSchema'> & {
        /** The canonical schema identity paired with `inputValidation`. */
        inputSchema: PreparedPluginJsonSchema['jsonSchema'];
        inputValidation: PreparedPluginJsonSchema;
    }
>;

export type DaemonMergedProjectionInputs = Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    /** The one response snapshot correlated to this cache entry's mounted target. */
    targetedContributions?: PluginUiTargetedContributionsV1;
    /**
     * The exact host-private embedded mounts correlated to this target
     * snapshot, each retaining the sole prepared schema/validator pair.
     */
    preparedTargetedSurfaceMounts?: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
    /** One daemon-selected Composer renderer catalog carried by this projection snapshot. */
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    /** Current cold Event-automation composer facts carried by the same daemon projection. */
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>;

type ProjectionCacheEntry = Readonly<{
    projectionRevision: number;
    /**
     * Host-private exact-generation validator bindings. A drifted response can
     * fail closed at the renderer boundary without retiring a previously
     * admitted binding before a clean response for that same authority arrives.
     */
    retainedTargetedSurfaceMounts?: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
}> & (
    | Readonly<{ kind: 'ready'; fetchedAtMs: number; inputs: DaemonMergedProjectionInputs }>
    | Readonly<{ kind: 'unsupported'; fetchedAtMs: number }>
    | Readonly<{
        kind: 'error';
        fetchedAtMs: number;
        inputs?: DaemonMergedProjectionInputs;
    }>
);

const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry>();
type ProjectionRequest = Readonly<{
    revision: number;
    promise: Promise<ProjectionCacheEntry | null>;
}>;
const LATEST_PROJECTION_REQUEST = new Map<string, ProjectionRequest>();
type MountedTargetProjectionCacheScope = {
    retainedHostCount: number;
};
/**
 * Exact embedded-target cache residency is owned by mounted React hosts. The
 * generic projection cache predates embedded surfaces; only target entries
 * retain executable validators and therefore must retire with their admitted
 * target generation.
 */
const MOUNTED_TARGET_CACHE_SCOPES = new Map<string, MountedTargetProjectionCacheScope>();

// This is an opaque identity bridge for the incumbent Account lifetime, not a
// second projection or validator cache. The lifetime itself remains the sole
// Account currentness/retirement owner.
let nextTargetAccountLifetimeIdentity = 0;
let targetAccountLifetimeIdentities = new WeakMap<ActiveServerAccountScopeLifetime, number>();

export function clearDaemonMergedProjectionCacheForTests(): void {
    PROJECTION_CACHE.clear();
    LATEST_PROJECTION_REQUEST.clear();
    MOUNTED_TARGET_CACHE_SCOPES.clear();
    nextTargetAccountLifetimeIdentity = 0;
    targetAccountLifetimeIdentities = new WeakMap();
}

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function targetAccountLifetimeIdentity(lifetime: ActiveServerAccountScopeLifetime | null | undefined): string | null {
    if (!lifetime) return null;
    try {
        if (!lifetime.isCurrent()) return null;
    } catch {
        return null;
    }
    let identity = targetAccountLifetimeIdentities.get(lifetime);
    if (identity === undefined) {
        identity = nextTargetAccountLifetimeIdentity + 1;
        nextTargetAccountLifetimeIdentity = identity;
        targetAccountLifetimeIdentities.set(lifetime, identity);
    }
    return `account:${identity}`;
}

function buildCacheKey(
    machineId: string,
    serverId: string | null | undefined,
    mountedTarget?: DaemonContributionRegistryProjectionMountedTargetV1,
    accountLifetime?: ActiveServerAccountScopeLifetime | null,
): string | null {
    const accountLifetimeIdentity = mountedTarget
        ? targetAccountLifetimeIdentity(accountLifetime)
        : null;
    if (mountedTarget && !accountLifetimeIdentity) return null;
    return JSON.stringify([
        normalizeKeyPart(serverId),
        normalizeKeyPart(machineId),
        mountedTarget
            ? [mountedTarget.pluginId, mountedTarget.immutableGenerationId, accountLifetimeIdentity]
            : null,
    ]);
}

/**
 * Retains the one target-scoped cache entry while a mounted host can consume
 * it. Releasing the final host retires its executable validator pair together
 * with that target generation; this does not create a second cache owner.
 */
export function retainMountedTargetProjectionCacheScope(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    mountedTarget: DaemonContributionRegistryProjectionMountedTargetV1;
    /** The exact active Account lifetime that owns this executable target cache. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): () => void {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return () => {};
    const cacheKey = buildCacheKey(machineId, params.serverId, params.mountedTarget, params.accountLifetime);
    if (!cacheKey || !params.accountLifetime) return () => {};
    const scope = MOUNTED_TARGET_CACHE_SCOPES.get(cacheKey) ?? { retainedHostCount: 0 };
    scope.retainedHostCount += 1;
    MOUNTED_TARGET_CACHE_SCOPES.set(cacheKey, scope);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        if (MOUNTED_TARGET_CACHE_SCOPES.get(cacheKey) !== scope) return;
        scope.retainedHostCount -= 1;
        if (scope.retainedHostCount > 0) {
            return;
        }
        MOUNTED_TARGET_CACHE_SCOPES.delete(cacheKey);
        PROJECTION_CACHE.delete(cacheKey);
        // A successor mount with the same target coordinates must start its
        // own request. It cannot join a promise admitted by the retired scope.
        LATEST_PROJECTION_REQUEST.delete(cacheKey);
    };
    const retirement = params.accountLifetime.onRetire(release);
    return () => {
        retirement.dispose();
        release();
    };
}

function activeMountedTargetProjectionCacheScope(cacheKey: string): MountedTargetProjectionCacheScope | null {
    return MOUNTED_TARGET_CACHE_SCOPES.get(cacheKey) ?? null;
}

function targetCacheScopeIsCurrent(
    cacheKey: string,
    scope: MountedTargetProjectionCacheScope | null,
): boolean {
    return scope !== null && MOUNTED_TARGET_CACHE_SCOPES.get(cacheKey) === scope;
}

export function entryIsFresh(entry: Readonly<{ fetchedAtMs: number }>, staleMs: number): boolean {
    const ageMs = Date.now() - entry.fetchedAtMs;
    return ageMs >= 0 && ageMs <= staleMs;
}

export function readCachedDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    mountedTarget?: DaemonContributionRegistryProjectionMountedTargetV1;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): ProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }
    const serverId = normalizeKeyPart(params.serverId);
    const cacheKey = buildCacheKey(machineId, serverId || null, params.mountedTarget, params.accountLifetime);
    return cacheKey ? PROJECTION_CACHE.get(cacheKey) ?? null : null;
}

type TargetedSurfaceMountAuthority = Pick<DaemonPluginUiTargetedSurfaceMountV1,
    'target' | 'point' | 'contributor' | 'role'>;

function targetMountAuthorityKey(mount: TargetedSurfaceMountAuthority): string {
    return stableJsonStringify({
        target: {
            pluginId: mount.target.pluginId,
            immutableGenerationId: mount.target.immutableGenerationId,
        },
        point: {
            pointId: mount.point.pointId,
            protocol: {
                id: mount.point.protocol.id,
                version: mount.point.protocol.version,
            },
        },
        contributor: {
            pluginId: mount.contributor.pluginId,
            immutableGenerationId: mount.contributor.immutableGenerationId,
        },
        role: mount.role,
    });
}

type TargetedSurfaceMountCandidate = Readonly<{
    mount: DaemonPluginUiTargetedSurfaceMountV1;
    authorityKey: string;
    inputSchema: PreparedPluginJsonSchema['jsonSchema'];
    inputSchemaKey: string;
}>;

type PreparedTargetedSurfaceMountPreparation = Readonly<{
    /** Current response mounts that may reach a renderer. */
    prepared: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
    /** Exact generation bindings retained only by this target cache lifecycle. */
    retained: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
}>;

function sameTargetedSurfaceMountBinding(
    left: Readonly<{
        presentation: DaemonPluginUiTargetedSurfaceMountV1['presentation'];
        inputSchema: PreparedPluginJsonSchema['jsonSchema'];
    }>,
    right: Readonly<{
        presentation: DaemonPluginUiTargetedSurfaceMountV1['presentation'];
        inputSchema: PreparedPluginJsonSchema['jsonSchema'];
    }>,
): boolean {
    return left.presentation === right.presentation
        && stableJsonStringify(left.inputSchema) === stableJsonStringify(right.inputSchema);
}

function sameTargetedSurfaceMountCandidateBinding(
    left: TargetedSurfaceMountCandidate,
    right: TargetedSurfaceMountCandidate,
): boolean {
    return left.mount.presentation === right.mount.presentation
        && left.inputSchemaKey === right.inputSchemaKey;
}

/**
 * Retain one validator under its exact admitted authority. Presentation and
 * schema are response-consistency facts, not cache identity: drift for the
 * same authority is ambiguous and therefore fails closed. There is no
 * process-wide validator cache; target, contributor, or Account replacement
 * receives a new retained pair.
 */
function prepareTargetedSurfaceMounts(input: Readonly<{
    mounts?: readonly DaemonPluginUiTargetedSurfaceMountV1[];
    previous?: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
}>): PreparedTargetedSurfaceMountPreparation | undefined {
    if (input.mounts === undefined) return undefined;
    const previousByAuthority = new Map<string, PreparedDaemonPluginUiTargetedSurfaceMountV1>();
    const rejectedAuthorities = new Set<string>();
    for (const mount of input.previous ?? []) {
        const authorityKey = targetMountAuthorityKey(mount);
        const retained = previousByAuthority.get(authorityKey);
        if (retained && !sameTargetedSurfaceMountBinding(retained, mount)) {
            rejectedAuthorities.add(authorityKey);
            previousByAuthority.delete(authorityKey);
            continue;
        }
        if (!retained) previousByAuthority.set(authorityKey, mount);
    }

    const candidates: TargetedSurfaceMountCandidate[] = [];
    const candidateByAuthority = new Map<string, TargetedSurfaceMountCandidate>();
    const seenAuthorities = new Set<string>();
    for (const mount of input.mounts) {
        const authorityKey = targetMountAuthorityKey(mount);
        seenAuthorities.add(authorityKey);
        try {
            const inputSchema = normalizePluginJsonSchema(mount.inputSchema);
            const candidate: TargetedSurfaceMountCandidate = Object.freeze({
                mount,
                authorityKey,
                inputSchema,
                inputSchemaKey: stableJsonStringify(inputSchema),
            });
            const priorCandidate = candidateByAuthority.get(authorityKey);
            if (priorCandidate && !sameTargetedSurfaceMountCandidateBinding(priorCandidate, candidate)) {
                rejectedAuthorities.add(authorityKey);
            } else if (!priorCandidate) {
                candidateByAuthority.set(authorityKey, candidate);
            }
            candidates.push(candidate);
        } catch {
            // An invalid response-local role schema must not grant this
            // authority a physical child mount. The raw RPC response remains
            // transport data only; no fallback validator or renderer exists.
            rejectedAuthorities.add(authorityKey);
        }
    }

    const retainedByAuthority = new Map<string, PreparedDaemonPluginUiTargetedSurfaceMountV1>();
    for (const authorityKey of seenAuthorities) {
        const previous = previousByAuthority.get(authorityKey);
        if (rejectedAuthorities.has(authorityKey)) {
            // Keep a known-good binding private so a later clean response for
            // this exact authority can reuse it; the drifted response itself
            // remains absent from the renderer-facing list below.
            if (previous) retainedByAuthority.set(authorityKey, previous);
            continue;
        }
        const candidate = candidateByAuthority.get(authorityKey);
        if (!candidate) continue;
        if (previous) {
            if (!sameTargetedSurfaceMountBinding(previous, {
                presentation: candidate.mount.presentation,
                inputSchema: candidate.inputSchema,
            })) {
                rejectedAuthorities.add(authorityKey);
                retainedByAuthority.set(authorityKey, previous);
                continue;
            }
            retainedByAuthority.set(authorityKey, previous);
            continue;
        }
        try {
            const inputValidation = preparePluginJsonSchema(candidate.inputSchema);
            // Insert the new binding before rendering subsequent duplicate rows
            // from this response, so exact duplicates compile once and reuse.
            retainedByAuthority.set(authorityKey, Object.freeze({
                ...candidate.mount,
                inputSchema: inputValidation.jsonSchema,
                inputValidation,
            }));
        } catch {
            rejectedAuthorities.add(authorityKey);
        }
    }

    const prepared: PreparedDaemonPluginUiTargetedSurfaceMountV1[] = [];
    for (const candidate of candidates) {
        if (rejectedAuthorities.has(candidate.authorityKey)) continue;
        const retained = retainedByAuthority.get(candidate.authorityKey);
        if (!retained || !sameTargetedSurfaceMountBinding(retained, {
            presentation: candidate.mount.presentation,
            inputSchema: candidate.inputSchema,
        })) {
            continue;
        }
        // Reuse only the generation-owned compiled validator. Renderer,
        // Artifact, origin, Resource, crash, and child-snapshot facts remain
        // current response data and replace their prior projection.
        prepared.push(Object.freeze({
            ...candidate.mount,
            inputSchema: retained.inputValidation.jsonSchema,
            inputValidation: retained.inputValidation,
        }));
    }
    return Object.freeze({
        prepared: Object.freeze(prepared),
        retained: Object.freeze([...retainedByAuthority.values()]),
    });
}

function toInputs(params: Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    targetedContributions?: PluginUiTargetedContributionsV1;
    preparedTargetedSurfaceMounts?: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
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
        ...(params.targetedContributions === undefined
            ? {}
            : { targetedContributions: params.targetedContributions }),
        ...(params.preparedTargetedSurfaceMounts === undefined
            ? {}
            : { preparedTargetedSurfaceMounts: params.preparedTargetedSurfaceMounts }),
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
    mountedTarget?: DaemonContributionRegistryProjectionMountedTargetV1;
    /** Required for an Account-scoped executable target projection. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): Promise<ProjectionCacheEntry | null> {
    const cacheKey = buildCacheKey(
        params.machineId,
        params.serverId,
        params.mountedTarget,
        params.accountLifetime,
    );
    if (!cacheKey) return null;
    const requestRevision = getMachineContributionRegistryProjectionRevision({
        machineId: normalizeKeyPart(params.machineId),
        serverId: normalizeKeyPart(params.serverId) || null,
    });
    const incumbentRequest = LATEST_PROJECTION_REQUEST.get(cacheKey);
    if (incumbentRequest?.revision === requestRevision) {
        return await incumbentRequest.promise;
    }
    // A target response can only prepare or publish for the exact mounted-host
    // lifetime that admitted it. A later remount with the same target key has
    // a distinct scope object, so it cannot revive an old validator pair.
    const mountedTargetScopeAtRequest = params.mountedTarget === undefined
        ? null
        : activeMountedTargetProjectionCacheScope(cacheKey);
    let request!: Promise<ProjectionCacheEntry | null>;
    let requestOwner!: ProjectionRequest;
    const publishIfLatest = (entry: ProjectionCacheEntry): ProjectionCacheEntry => {
        if (LATEST_PROJECTION_REQUEST.get(cacheKey) !== requestOwner) {
            return PROJECTION_CACHE.get(cacheKey) ?? entry;
        }
        // A direct cold target read can consume its response, but it must not
        // pin a compiled validator. A mounted read can do so only while the
        // exact lifetime that admitted it remains current.
        if (!params.mountedTarget || targetCacheScopeIsCurrent(cacheKey, mountedTargetScopeAtRequest)) {
            PROJECTION_CACHE.set(cacheKey, entry);
        }
        return entry;
    };
    request = (async () => {
        const fetchedAtMs = Date.now();
        const res = await machineContributionRegistryProjectionDescribe(params.machineId, {
            ...(params.serverId ? { serverId: params.serverId } : {}),
            timeoutMs: 10_000,
            ...(params.mountedTarget ? { mountedTarget: params.mountedTarget } : {}),
        });
        if (params.mountedTarget && !targetAccountLifetimeIdentity(params.accountLifetime)) {
            return null;
        }
        // The cache entry keeps the transport's existing monotonic revision
        // with its target-local lifetime. Once H has published, a late G
        // response cannot compile a validator merely to be discarded.
        const currentCacheEntry = PROJECTION_CACHE.get(cacheKey);
        if (currentCacheEntry !== undefined && currentCacheEntry.projectionRevision > requestRevision) {
            return currentCacheEntry;
        }
        // A response has no authority to prepare an executable target-schema
        // validator once a newer request owns this same target snapshot.
        const newerRequest = LATEST_PROJECTION_REQUEST.get(cacheKey);
        if (newerRequest !== undefined && newerRequest !== requestOwner) {
            return await newerRequest.promise;
        }
        if (mountedTargetScopeAtRequest !== null
            && !targetCacheScopeIsCurrent(cacheKey, mountedTargetScopeAtRequest)) {
            return null;
        }
        if (res.supported !== true) {
            const previous = PROJECTION_CACHE.get(cacheKey);
            return publishIfLatest(res.reason === 'not-supported'
                ? { kind: 'unsupported', fetchedAtMs, projectionRevision: requestRevision }
                : {
                    kind: 'error',
                    fetchedAtMs,
                    projectionRevision: requestRevision,
                    ...(previous?.retainedTargetedSurfaceMounts === undefined
                        ? {}
                        : { retainedTargetedSurfaceMounts: previous.retainedTargetedSurfaceMounts }),
                    ...(
                        previous?.kind === 'ready' || previous?.kind === 'error'
                            ? { inputs: previous.inputs }
                            : {}
                    ),
                });
        }

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(res.projection);
        const previous = PROJECTION_CACHE.get(cacheKey);
        const targetedSurfaceMountPreparation = res.targetedSurfaceMounts === undefined
            ? undefined
            : prepareTargetedSurfaceMounts({
                mounts: res.targetedSurfaceMounts,
                previous: previous?.retainedTargetedSurfaceMounts,
            });
        return publishIfLatest({
            kind: 'ready',
            fetchedAtMs,
            projectionRevision: requestRevision,
            ...(targetedSurfaceMountPreparation === undefined
                ? {}
                : { retainedTargetedSurfaceMounts: targetedSurfaceMountPreparation.retained }),
            inputs: toInputs({
                ...adapted,
                pluginProjectionV2: res.projection.v === 2 ? res.projection : null,
                ...(res.targetedContributions === undefined
                    ? {}
                    : { targetedContributions: res.targetedContributions }),
                ...(targetedSurfaceMountPreparation === undefined
                    ? {}
                    : { preparedTargetedSurfaceMounts: targetedSurfaceMountPreparation.prepared }),
                ...(res.composerSurfaceCatalog === undefined
                    ? {}
                    : { composerSurfaceCatalog: res.composerSurfaceCatalog }),
                ...(res.automationEligibleEvents === undefined
                    ? {}
                    : { automationEligibleEvents: res.automationEligibleEvents }),
            }),
        });
    })();
    requestOwner = Object.freeze({ revision: requestRevision, promise: request });
    LATEST_PROJECTION_REQUEST.set(cacheKey, requestOwner);
    try {
        return await request;
    } finally {
        if (LATEST_PROJECTION_REQUEST.get(cacheKey) === requestOwner) {
            LATEST_PROJECTION_REQUEST.delete(cacheKey);
        }
    }
}

export async function loadDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    staleMs?: number;
    mountedTarget?: DaemonContributionRegistryProjectionMountedTargetV1;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
}>): Promise<DaemonMergedProjectionInputs | null> {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }

    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : 60_000;
    const cacheKey = buildCacheKey(machineId, serverId || null, params.mountedTarget, params.accountLifetime);
    if (!cacheKey) return null;
    const cached = PROJECTION_CACHE.get(cacheKey) ?? null;
    if (cached?.kind === 'ready' && entryIsFresh(cached, staleMs)) {
        return cached.inputs;
    }

    const entry = await loadDaemonMergedProjectionCacheEntry({
        machineId,
        ...(serverId ? { serverId } : {}),
        ...(params.mountedTarget ? { mountedTarget: params.mountedTarget } : {}),
        ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
    });
    return entry?.kind === 'ready' ? entry.inputs : null;
}
