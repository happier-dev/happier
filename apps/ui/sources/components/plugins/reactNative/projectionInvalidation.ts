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

type SourceSnapshot = PluginUiReactNativeRuntimeProjectionSourceInput & Readonly<{
    identities: readonly PluginReactNativeBundleCacheIdentity[];
}>;

type RetainedArtifact = Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    accountLifetime: ActiveServerAccountScopeLifetime;
}>;

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
    const sources = new Map<symbol, SourceSnapshot | null>();
    const retained = new Map<string, RetainedArtifact>();
    const retiringLifetimes = new Map<ActiveServerAccountScopeLifetime, Readonly<{ dispose: () => void }>>();

    // Normalized bundle maps are immutable. Derive each source's identities on
    // publication; a neighboring source update does not revalidate its graphs.
    const readIdentities = (input: PluginUiReactNativeRuntimeProjectionSourceInput): readonly PluginReactNativeBundleCacheIdentity[] => {
        const { projection, accountLifetime } = input;
        const currentProjection = accountLifetime
            ? readCurrentPluginUiRendererProjection(accountLifetime.scope) : null;
        const identities: PluginReactNativeBundleCacheIdentity[] = [];
        if (projection) {
            for (const bundle of Object.values(projection.reactNativeBundlesById)) {
                const entry = resolveBundledPluginUiRendererArtifact(readRecord(bundle), currentProjection);
                const runtime = readRecord(entry?.runtime);
                const decision = readRecord(runtime?.decision);
                const loadPolicy = readRecord(runtime?.loadPolicy);
                if (
                    decision?.state !== 'load'
                    || loadPolicy?.source !== 'installedArtifact'
                ) {
                    continue;
                }

                const cacheKey = readNonEmptyString(runtime?.cacheKey);
                const pluginId = readNonEmptyString(entry?.pluginId);
                const contributionId = readNonEmptyString(entry?.contributionId);
                const graph = readPluginUiArtifactGraph(entry?.artifactGraph);
                const identity = pluginId && contributionId && graph !== null && graph.tier === 'reactNative'
                    ? readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity, {
                        pluginId,
                        contributionId,
                        artifactId: graph.artifactId,
                        platform: 'web',
                    })
                    : null;
                if (
                    !identity
                    || !cacheKey
                    || !pluginId
                    || !contributionId
                    || identity.pluginId !== pluginId
                    || identity.contributionId !== contributionId
                    || cacheKey !== derivePluginReactNativeBundleCacheKey(identity)
                ) {
                    continue;
                }
                identities.push(identity);
            }
        }
        return identities;
    };

    const releaseRetiredLifetimes = (): void => {
        for (const [key, artifact] of retained) {
            if (!isCurrentLifetime(artifact.accountLifetime)) retained.delete(key);
        }
        for (const [lifetime, retirement] of retiringLifetimes) {
            if ([...retained.values()].some((artifact) => artifact.accountLifetime === lifetime)) continue;
            retirement.dispose();
            retiringLifetimes.delete(lifetime);
        }
    };

    const retain = (snapshot: SourceSnapshot): void => {
        const lifetime = snapshot.accountLifetime;
        if (!lifetime) return;
        for (const identity of snapshot.identities) {
            retained.set(retainedArtifactKey(lifetime.scope, identity), { identity, accountLifetime: lifetime });
        }
        if (snapshot.identities.length > 0 && !retiringLifetimes.has(lifetime)) {
            retiringLifetimes.set(lifetime, lifetime.onRetire(() => reconcile()));
        }
    };

    const reconcile = (): void => {
        const identitiesByCacheKey = new Map<string, PluginReactNativeBundleCacheIdentity>();
        for (const snapshot of sources.values()) {
            // Authority can retire without replacing the immutable declaration.
            if (!snapshot || !isCurrentSnapshot(snapshot)) continue;
            retain(snapshot);
            for (const identity of snapshot.identities) {
                identitiesByCacheKey.set(derivePluginReactNativeBundleCacheKey(identity), identity);
            }
        }
        releaseRetiredLifetimes();
        // Evaluated surface namespaces stay with the mounting scopes: a Triage artifact's
        // evaluation holds hundreds of MB of native memory (P03-NATIVE-MEMORY). Only the
        // bytes and the compiled program are retained past a scope's withdrawal.
        const activeCacheKeys = [...identitiesByCacheKey.keys()];
        for (const { identity } of retained.values()) {
            identitiesByCacheKey.set(derivePluginReactNativeBundleCacheKey(identity), identity);
        }

        targets.cache.reconcileActiveProjectionIdentities([...identitiesByCacheKey.values()]);
        targets.surfaceModules.reconcileActiveCacheKeys(activeCacheKeys);
    };

    return Object.freeze({
        retainEnabledPlugins: (accountLifetime, enabledPluginIds) => {
            if (!accountLifetime || !isCurrentLifetime(accountLifetime)) return;
            let released = false;
            for (const [key, artifact] of retained) {
                if (!areServerAccountScopesEqual(artifact.accountLifetime.scope, accountLifetime.scope)
                    || enabledPluginIds.has(artifact.identity.pluginId)) continue;
                retained.delete(key);
                released = true;
            }
            if (released) reconcile();
        },
        releaseRetained: () => {
            if (retained.size === 0) return;
            retained.clear();
            reconcile();
        },
        createSource: () => {
            const sourceId = Symbol('plugin-ui-react-native-projection-source');
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
                        sources.set(sourceId, null);
                        reconcile();
                    }) ?? null;
                }
                const previous = sources.get(sourceId);
                const identities = previous && previous.projection?.reactNativeBundlesById === input.projection?.reactNativeBundlesById
                    ? previous.identities : readIdentities(input);
                sources.set(sourceId, { ...input, identities });
                reconcile();
            };

            sources.set(sourceId, null);
            return Object.freeze({
                update,
                dispose: () => {
                    if (disposed) return;
                    disposed = true;
                    retirement?.dispose();
                    retirement = null;
                    boundLifetime = null;
                    sources.delete(sourceId);
                    reconcile();
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
