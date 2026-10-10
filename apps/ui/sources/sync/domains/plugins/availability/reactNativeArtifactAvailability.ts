import {
    createPluginReactNativeArtifactLeaseCacheSink,
    createPluginReactNativeArtifactLeasePersistentScope,
    getInstalledPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';

import type {
    PluginArtifactSourceCandidate,
    PluginSelectedArtifactLeaseAcquireResult,
} from './artifactLease';
import {
    fetchPluginArtifactBytesViaMachineRpc,
    type PluginArtifactDaemonByteFetcher,
} from './artifactDaemonSource';
import {
    createBundledPluginUiAppExactArtifactSource,
} from './bundledAppExactArtifactSource';
import {
    acquirePluginReactNativeArtifactLease,
    materializePluginReactNativeArtifactLeaseInCache,
    type PluginReactNativeArtifactLeaseCacheMaterializationResult,
    type PluginReactNativeArtifactLeaseInput,
} from './reactNativeArtifactLease';

/**
 * Consumer-facing input deliberately excludes source candidates, persistent
 * custody, and daemon transport. Availability owns their composition.
 */
export type PluginReactNativeArtifactAvailabilityInput = Omit<
    PluginReactNativeArtifactLeaseInput,
    'persistent' | 'appExact' | 'fetchDaemonArtifactBytes'
> & Readonly<{
    /** Consumer currentness gates adoption only; it never selects a source. */
    isCurrent: () => boolean;
}>;

/** An opaque capability for an already-selected, verified React Native Artifact. */
export type PluginReactNativeArtifactAvailabilityHandle = Readonly<{
    cacheKey: string;
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
    dispose: () => void;
}>;

export type PluginReactNativeArtifactAvailability =
    | (Readonly<{ kind: 'available' }> & PluginReactNativeArtifactAvailabilityHandle)
    | Extract<PluginSelectedArtifactLeaseAcquireResult, { kind: 'unavailable' }>
    | Extract<PluginReactNativeArtifactLeaseCacheMaterializationResult, { kind: 'unavailable' }>;

export type PluginReactNativeArtifactAvailabilityProducer = Readonly<{
    acquire: (
        input: PluginReactNativeArtifactAvailabilityInput,
    ) => Promise<PluginReactNativeArtifactAvailability>;
}>;

export type PluginReactNativeArtifactAvailabilityProducerDependencies = Readonly<{
    /** Existing React Native cache owner; this producer only composes its Artifact adapters. */
    getCache: () => PluginReactNativeBundleCache;
    /** Immutable packaged app bytes; Availability decides when this exact candidate may be used. */
    appExact: PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }>;
    /** Exact daemon boundary; production uses the canonical machine-RPC transport. */
    fetchDaemonArtifactBytes: PluginArtifactDaemonByteFetcher;
}>;

function isCurrent(input: PluginReactNativeArtifactAvailabilityInput): boolean {
    try {
        return !input.signal?.aborted && input.accountLifetime.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

/**
 * The only React Native production composition point for Artifact source order,
 * exact persistent-byte custody, and React Native cache materialization. Consumers
 * receive only a revocable cache capability.
 */
export function createPluginReactNativeArtifactAvailabilityProducer(
    dependencies: PluginReactNativeArtifactAvailabilityProducerDependencies,
): PluginReactNativeArtifactAvailabilityProducer {
    return Object.freeze({
        acquire: async (input): Promise<PluginReactNativeArtifactAvailability> => {
            if (!isCurrent(input)) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const cache = dependencies.getCache();
            const persistent = createPluginReactNativeArtifactLeasePersistentScope({
                cache,
                lifetime: input.accountLifetime,
            });
            const cacheSink = createPluginReactNativeArtifactLeaseCacheSink({
                cache,
                lifetime: input.accountLifetime,
            });
            try {
                if (!isCurrent(input)) {
                    return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                }

                const selected = await acquirePluginReactNativeArtifactLease({
                    reader: input.reader,
                    artifactGraph: input.artifactGraph,
                    cacheIdentity: input.cacheIdentity,
                    accountLifetime: input.accountLifetime,
                    ...(input.signal ? { signal: input.signal } : {}),
                    appExact: dependencies.appExact,
                    persistent,
                    fetchDaemonArtifactBytes: dependencies.fetchDaemonArtifactBytes,
                    ...(input.daemonProjectionSelection
                        ? { daemonProjectionSelection: input.daemonProjectionSelection }
                        : {}),
                    ...(input.daemon ? { daemon: input.daemon } : {}),
                });
                if (selected.kind !== 'available') return selected;
                if (!isCurrent(input)) {
                    selected.lease.dispose();
                    return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                }

                const materialized = await materializePluginReactNativeArtifactLeaseInCache({
                    lease: selected.lease,
                    cacheIdentity: input.cacheIdentity,
                    accountScope: input.accountLifetime.scope,
                    cacheSink,
                    isCurrent: () => isCurrent(input),
                });
                if (materialized.kind !== 'available') {
                    selected.lease.dispose();
                    return materialized;
                }
                return Object.freeze({
                    kind: 'available' as const,
                    cacheKey: materialized.cacheKey,
                    isCurrent: materialized.isCurrent,
                    onRevoke: selected.lease.onRevoke,
                    dispose: selected.lease.dispose,
                });
            } finally {
                persistent.release();
            }
        },
    });
}

const installedReactNativeArtifactAvailabilityProducer = createPluginReactNativeArtifactAvailabilityProducer({
    getCache: getInstalledPluginReactNativeBundleCache,
    appExact: createBundledPluginUiAppExactArtifactSource(),
    fetchDaemonArtifactBytes: fetchPluginArtifactBytesViaMachineRpc,
});

/** Production renderer entry point; hosts receive only an opaque cache capability. */
export function acquirePluginReactNativeArtifactAvailability(
    input: PluginReactNativeArtifactAvailabilityInput,
): Promise<PluginReactNativeArtifactAvailability> {
    return installedReactNativeArtifactAvailabilityProducer.acquire(input);
}
