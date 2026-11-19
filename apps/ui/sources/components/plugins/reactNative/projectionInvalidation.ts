import {
    derivePluginReactNativeBundleCacheKey,
    getInstalledPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';
import {
    getInstalledPluginReactNativeModuleRegistry,
    type PluginReactNativeModuleRegistry,
} from './moduleRegistry';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    readPluginUiReactNativeBundleCacheIdentity,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readPluginUiArtifactGraph } from '@/sync/domains/plugins/ui/artifactIdentityRead';
import { readCurrentPluginUiRendererProjection, resolveBundledPluginUiRendererArtifact } from '@/sync/domains/plugins/availability/bundledPluginUiRendererArtifact';

export type PluginUiReactNativeRuntimeProjectionReconcilerTargets = Readonly<{
    cache: Pick<PluginReactNativeBundleCache, 'reconcileActiveProjectionIdentities'>;
    surfaceModules: Pick<PluginReactNativeModuleRegistry, 'reconcileActiveCacheKeys'>;
}>;

export type PluginUiReactNativeRuntimeProjectionSourceInput = Readonly<{
    projection: PluginUiProjectionModel | null;
    /** The captured Account lifetime which admitted this scoped projection. */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** The request/currentness owner decides whether this snapshot remains live. */
    isCurrent: () => boolean;
}>;

export type PluginUiReactNativeRuntimeProjectionSource = Readonly<{
    update: (input: PluginUiReactNativeRuntimeProjectionSourceInput) => void;
    dispose: () => void;
}>;

export type PluginUiReactNativeRuntimeProjectionReconciler = Readonly<{
    createSource: () => PluginUiReactNativeRuntimeProjectionSource;
    /**
     * The Account's enabled plugin census. Retained Artifacts of every other
     * plugin (disabled or removed) are released.
     */
    retainEnabledPlugins: (
        accountLifetime: ActiveServerAccountScopeLifetime | null,
        enabledPluginIds: ReadonlySet<string>,
    ) => void;
    /**
     * The platform's memory-pressure signal: release every retained Artifact no
     * current source still declares. They are re-created on the next mount.
     */
    releaseRetained: () => void;
}>;

type Artifact = Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    cacheKey: string;
}>;

type Retention = Readonly<{
    key: string;
    lifetime: ActiveServerAccountScopeLifetime;
}>;

type RetainedArtifact = Artifact & Readonly<{ retention: Retention }>;

type SourceArtifacts = Readonly<{
    byCacheKey: ReadonlyMap<string, Artifact>;
    byRetentionSlot: ReadonlyMap<string, RetainedArtifact>;
}>;

type SourceState = {
    snapshot: PluginUiReactNativeRuntimeProjectionSourceInput | null;
    artifacts: SourceArtifacts;
    active: SourceArtifacts;
};

type RetentionSlot = {
    active: Map<number, RetainedArtifact>;
    retained: RetainedArtifact | null;
};

const EMPTY_ARTIFACTS: SourceArtifacts = { byCacheKey: new Map(), byRetentionSlot: new Map() };

function retainedArtifactKey(scope: ActiveServerAccountScopeLifetime['scope'], identity: PluginReactNativeBundleCacheIdentity): string {
    return JSON.stringify([scope.serverId, scope.accountId, identity.pluginId, identity.contributionId]);
}

function isCurrentLifetime(lifetime: ActiveServerAccountScopeLifetime): boolean {
    try {
        return lifetime.isCurrent();
    } catch {
        return false;
    }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isCurrentSnapshot(snapshot: PluginUiReactNativeRuntimeProjectionSourceInput): boolean {
    try {
        return snapshot.projection !== null
            && snapshot.isCurrent()
            && (snapshot.accountLifetime?.isCurrent() ?? true);
    } catch {
        return false;
    }
}

/**
 * The projection currentness owner reports complete scoped snapshots here. This
 * existing RN invalidation owner then takes their union, so one consumer cannot
 * evict a process-global byte/module cache entry still owned by another current
 * scope. It does not decide currentness, cache identity, or Account authority.
 *
 * Bytes and the compiled program belong to the Artifact (its digest), not to
 * the scope that mounted it: an Account-scoped declaration stays retained after
 * its source withdraws (a Session leave), so the next mount reuses them without
 * re-acquiring or recompiling. Evaluated surface modules are not retained. Retention
 * ends when the same plugin contribution is declared with another digest
 * (Artifact changed), when the plugin leaves the Account's enabled census, or
 * when the Account lifetime retires. It is bounded by one digest per enabled
 * plugin contribution of the current Account.
 */
export function createPluginUiReactNativeRuntimeProjectionReconciler(
    targets: PluginUiReactNativeRuntimeProjectionReconcilerTargets,
): PluginUiReactNativeRuntimeProjectionReconciler {
    // Source order preserves the winner for overlapping declarations of one slot.
    let nextSourceId = 0;
    const sources = new Map<number, SourceState>();
    const activeByCacheKey = new Map<string, { artifact: Artifact; owners: number }>();
    const retentionSlots = new Map<string, RetentionSlot>();
    const retiringLifetimes = new Map<ActiveServerAccountScopeLifetime, {
        slots: Set<RetentionSlot>;
        retirement: Readonly<{ dispose: () => void }>;
    }>();
    // Resolved declaration rows are immutable and structurally shared across publications.
    const artifactsByDeclaration = new WeakMap<Readonly<Record<string, unknown>>, Artifact | null>();
    const retentionsByLifetime = new WeakMap<ActiveServerAccountScopeLifetime, WeakMap<Artifact, RetainedArtifact>>();

    const readArtifact = (entry: Readonly<Record<string, unknown>>): Artifact | null => {
        const cached = artifactsByDeclaration.get(entry);
        if (cached !== undefined) return cached;

        const runtime = readRecord(entry.runtime);
        const decision = readRecord(runtime?.decision);
        const loadPolicy = readRecord(runtime?.loadPolicy);
        let artifact: Artifact | null = null;
        if (decision?.state === 'load' && loadPolicy?.source === 'installedArtifact') {
            const cacheKey = readNonEmptyString(runtime?.cacheKey);
            const pluginId = readNonEmptyString(entry.pluginId);
            const contributionId = readNonEmptyString(entry.contributionId);
            const graph = readPluginUiArtifactGraph(entry.artifactGraph);
            const identity = pluginId && contributionId && graph?.tier === 'reactNative'
                ? readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity, {
                    pluginId, contributionId, artifactId: graph.artifactId, platform: 'web',
                })
                : null;
            if (
                identity
                && cacheKey
                && identity.pluginId === pluginId
                && identity.contributionId === contributionId
                && cacheKey === derivePluginReactNativeBundleCacheKey(identity)
            ) {
                artifact = { identity, cacheKey };
            }
        }
        artifactsByDeclaration.set(entry, artifact);
        return artifact;
    };

    const readArtifacts = ({ projection, accountLifetime }: PluginUiReactNativeRuntimeProjectionSourceInput): SourceArtifacts => {
        if (!projection) return EMPTY_ARTIFACTS;
        const rendererProjection = accountLifetime ? readCurrentPluginUiRendererProjection(accountLifetime.scope) : null;
        let scopedArtifacts = accountLifetime ? retentionsByLifetime.get(accountLifetime) : undefined;
        if (accountLifetime && !scopedArtifacts) {
            scopedArtifacts = new WeakMap();
            retentionsByLifetime.set(accountLifetime, scopedArtifacts);
        }
        const byCacheKey = new Map<string, Artifact>();
        const byRetentionSlot = new Map<string, RetainedArtifact>();
        for (const bundle of Object.values(projection.reactNativeBundlesById)) {
            const entry = resolveBundledPluginUiRendererArtifact(readRecord(bundle), rendererProjection);
            const artifact = entry && readArtifact(entry);
            if (!artifact) continue;
            byCacheKey.set(artifact.cacheKey, artifact);
            if (!accountLifetime || !scopedArtifacts) continue;
            let scoped = scopedArtifacts.get(artifact);
            if (!scoped) {
                scoped = { ...artifact, retention: {
                    key: retainedArtifactKey(accountLifetime.scope, artifact.identity),
                    lifetime: accountLifetime,
                } };
                scopedArtifacts.set(artifact, scoped);
            }
            byRetentionSlot.set(scoped.retention.key, scoped);
        }
        return byCacheKey.size > 0 ? { byCacheKey, byRetentionSlot } : EMPTY_ARTIFACTS;
    };

    const setRetained = (slot: RetentionSlot, artifact: RetainedArtifact | null): void => {
        const previousLifetime = slot.retained?.retention.lifetime;
        const lifetime = artifact?.retention.lifetime;
        slot.retained = artifact;
        if (previousLifetime === lifetime) return;
        if (previousLifetime) {
            const previous = retiringLifetimes.get(previousLifetime);
            previous?.slots.delete(slot);
            if (previous?.slots.size === 0) {
                previous.retirement.dispose();
                retiringLifetimes.delete(previousLifetime);
            }
        }
        if (lifetime) {
            const bound = retiringLifetimes.get(lifetime);
            if (bound) {
                bound.slots.add(slot);
            } else {
                retiringLifetimes.set(lifetime, {
                    slots: new Set([slot]),
                    retirement: lifetime.onRetire(() => reconcile()),
                });
            }
        }
    };

    const reconcile = (release?: (artifact: RetainedArtifact) => boolean): void => {
        const changedSlots = new Set<RetentionSlot>();
        // Currentness callbacks can change before their producers publish a new snapshot.
        // Recheck them, but visit artifacts only when a source's active declarations change.
        for (const [sourceId, source] of sources) {
            const active = source.snapshot && isCurrentSnapshot(source.snapshot) ? source.artifacts : EMPTY_ARTIFACTS;
            if (source.active === active) continue;
            for (const key of source.active.byCacheKey.keys()) {
                if (active.byCacheKey.has(key)) continue;
                const current = activeByCacheKey.get(key)!;
                if (--current.owners === 0) activeByCacheKey.delete(key);
            }
            for (const [key, artifact] of active.byCacheKey) {
                if (source.active.byCacheKey.has(key)) continue;
                const current = activeByCacheKey.get(key);
                if (current) current.owners += 1;
                else activeByCacheKey.set(key, { artifact, owners: 1 });
            }

            for (const key of source.active.byRetentionSlot.keys()) {
                if (active.byRetentionSlot.has(key)) continue;
                const slot = retentionSlots.get(key)!;
                slot.active.delete(sourceId);
                changedSlots.add(slot);
            }
            for (const [key, artifact] of active.byRetentionSlot) {
                if (source.active.byRetentionSlot.get(key) === artifact) continue;
                let slot = retentionSlots.get(key);
                if (!slot) {
                    slot = { active: new Map(), retained: null };
                    retentionSlots.set(key, slot);
                }
                slot.active.set(sourceId, artifact);
                changedSlots.add(slot);
            }
            source.active = active;
        }

        for (const slot of changedSlots) {
            let latest = -1;
            let winner: RetainedArtifact | undefined;
            for (const [sourceId, artifact] of slot.active) {
                if (sourceId <= latest) continue;
                latest = sourceId;
                winner = artifact;
            }
            if (winner) setRetained(slot, winner);
        }
        for (const [lifetime, { slots }] of retiringLifetimes) {
            if (isCurrentLifetime(lifetime)) continue;
            for (const slot of slots) setRetained(slot, null);
        }

        // Evaluated namespaces follow mounted scopes. Bytes and compiled programs
        // also stay warm for retained Artifacts.
        const activeCacheKeys = [...activeByCacheKey.keys()];
        const artifactCacheKeys = new Set(activeCacheKeys);
        const identities = Array.from(activeByCacheKey.values(), ({ artifact }) => artifact.identity);
        for (const [key, slot] of retentionSlots) {
            const retained = slot.retained;
            if (!retained || (slot.active.size === 0 && release?.(retained))) {
                if (retained) setRetained(slot, null);
                if (slot.active.size === 0) retentionSlots.delete(key);
                continue;
            }
            if (artifactCacheKeys.has(retained.cacheKey)) continue;
            artifactCacheKeys.add(retained.cacheKey);
            identities.push(retained.identity);
        }
        targets.cache.reconcileActiveProjectionIdentities(identities);
        targets.surfaceModules.reconcileActiveCacheKeys(activeCacheKeys);
    };

    const releaseRetainedWhere = (release: (artifact: RetainedArtifact) => boolean): void => {
        for (const { retained } of retentionSlots.values()) {
            if (!retained || !release(retained)) continue;
            reconcile(release);
            return;
        }
    };

    return Object.freeze({
        retainEnabledPlugins: (accountLifetime, enabledPluginIds) => {
            if (!accountLifetime || !isCurrentLifetime(accountLifetime)) return;
            releaseRetainedWhere(({ identity, retention }) =>
                areServerAccountScopesEqual(retention.lifetime.scope, accountLifetime.scope)
                && !enabledPluginIds.has(identity.pluginId));
        },
        releaseRetained: () => releaseRetainedWhere(() => true),
        createSource: () => {
            const sourceId = nextSourceId++;
            const source: SourceState = { snapshot: null, artifacts: EMPTY_ARTIFACTS, active: EMPTY_ARTIFACTS };
            let disposed = false;
            let boundLifetime: ActiveServerAccountScopeLifetime | null = null;
            let retirement: Readonly<{ dispose: () => void }> | null = null;

            const update = (input: PluginUiReactNativeRuntimeProjectionSourceInput): void => {
                if (disposed) return;
                if (boundLifetime !== input.accountLifetime) {
                    retirement?.dispose();
                    boundLifetime = input.accountLifetime;
                    retirement = boundLifetime?.onRetire(() => {
                        if (disposed || boundLifetime !== input.accountLifetime) return;
                        source.snapshot = null;
                        source.artifacts = EMPTY_ARTIFACTS;
                        reconcile();
                    }) ?? null;
                }
                const previous = source.snapshot;
                if (!previous || previous.accountLifetime !== input.accountLifetime
                    || previous.projection?.reactNativeBundlesById !== input.projection?.reactNativeBundlesById) {
                    source.artifacts = readArtifacts(input);
                }
                source.snapshot = input;
                reconcile();
            };

            sources.set(sourceId, source);
            return Object.freeze({
                update,
                dispose: () => {
                    if (disposed) return;
                    disposed = true;
                    retirement?.dispose();
                    retirement = null;
                    boundLifetime = null;
                    source.snapshot = null;
                    source.artifacts = EMPTY_ARTIFACTS;
                    reconcile();
                    sources.delete(sourceId);
                },
            });
        },
    });
}

const installedPluginUiReactNativeRuntimeProjectionReconciler =
    createPluginUiReactNativeRuntimeProjectionReconciler({
        cache: getInstalledPluginReactNativeBundleCache(),
        surfaceModules: getInstalledPluginReactNativeModuleRegistry(),
    });

export function createInstalledPluginUiReactNativeRuntimeProjectionSource(): PluginUiReactNativeRuntimeProjectionSource {
    return installedPluginUiReactNativeRuntimeProjectionReconciler.createSource();
}

/** iOS memory warnings release retained Artifacts that no mounted scope still declares. */
export function releaseRetainedInstalledPluginUiReactNativeArtifacts(): void {
    installedPluginUiReactNativeRuntimeProjectionReconciler.releaseRetained();
}

/** AppShell's enabled-plugin census releases retained Artifacts of disabled or removed plugins. */
export function retainInstalledPluginUiReactNativeArtifactsForEnabledPlugins(
    accountLifetime: ActiveServerAccountScopeLifetime | null,
    enabledPluginIds: ReadonlySet<string>,
): void {
    installedPluginUiReactNativeRuntimeProjectionReconciler.retainEnabledPlugins(accountLifetime, enabledPluginIds);
}
