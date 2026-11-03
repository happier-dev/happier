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
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
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
}>;

type SourceSnapshot = PluginUiReactNativeRuntimeProjectionSourceInput & Readonly<{
    identities: readonly PluginReactNativeBundleCacheIdentity[];
}>;

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
 */
export function createPluginUiReactNativeRuntimeProjectionReconciler(
    targets: PluginUiReactNativeRuntimeProjectionReconcilerTargets,
): PluginUiReactNativeRuntimeProjectionReconciler {
    const sources = new Map<symbol, SourceSnapshot | null>();

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
                const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(entry?.artifactGraph);
                const identity = pluginId && contributionId && graph.success && graph.data.tier === 'reactNative'
                    ? readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity, {
                        pluginId,
                        contributionId,
                        artifactId: graph.data.artifactId,
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

    const reconcile = (): void => {
        const identitiesByCacheKey = new Map<string, PluginReactNativeBundleCacheIdentity>();
        for (const snapshot of sources.values()) {
            // Authority can retire without replacing the immutable declaration.
            if (!snapshot || !isCurrentSnapshot(snapshot)) continue;
            for (const identity of snapshot.identities) {
                identitiesByCacheKey.set(derivePluginReactNativeBundleCacheKey(identity), identity);
            }
        }

        const cacheKeys = [...identitiesByCacheKey.keys()];
        targets.cache.reconcileActiveProjectionIdentities([...identitiesByCacheKey.values()]);
        targets.surfaceModules.reconcileActiveCacheKeys(cacheKeys);
    };

    return Object.freeze({
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
