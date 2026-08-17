import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';

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
    createBundledPluginUiAppExactArtifactSource,
} from './bundledAppExactArtifactSource';
import {
    acquirePluginReactNativeArtifactLease,
    materializePluginReactNativeArtifactLeaseInCache,
    type PluginReactNativeArtifactLeaseCacheMaterializationResult,
    type PluginReactNativeArtifactLeaseCommonInput,
    type PluginReactNativeArtifactOwner,
    type PluginReactNativeExactArtifactByteFetcher,
} from './reactNativeArtifactLease';
import {
    fetchReactNativeExactArtifactBytesViaMachineRpc,
} from './reactNativeArtifactDaemonTransport';

/**
 * Consumer-facing input deliberately excludes source candidates, persistent
 * custody, and daemon transport. Availability owns their composition.
 */
type PluginReactNativeArtifactAvailabilityCommonInput = Omit<
    PluginReactNativeArtifactLeaseCommonInput,
    'persistent' | 'daemon' | 'appExact'
> & Readonly<{
    daemon?: Readonly<{
        origin: PluginMachineExecutionOriginV1;
        serverId: string;
    }>;
    /** Consumer currentness gates adoption only; it never selects a source. */
    isCurrent: () => boolean;
}>;

export type PluginReactNativeArtifactAvailabilityInput =
    PluginReactNativeArtifactAvailabilityCommonInput & PluginReactNativeArtifactOwner;

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
    fetchDaemonArtifactBytes: PluginReactNativeExactArtifactByteFetcher;
}>;

function isCurrent(input: PluginReactNativeArtifactAvailabilityInput): boolean {
    try {
        return input.accountLifetime.isCurrent() && input.isCurrent();
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
                    ...(input.artifactOwnerKind === 'renderer'
                        ? {
                            artifactOwnerKind: 'renderer' as const,
                            crashStateToken: input.crashStateToken,
                        }
                        : {
                            artifactOwnerKind: 'voiceProvider' as const,
                        }),
                    appExact: dependencies.appExact,
                    persistent,
                    ...(input.daemon
                        ? {
                            daemon: {
                                origin: input.daemon.origin,
                                serverId: input.daemon.serverId,
                                fetchArtifactBytes: dependencies.fetchDaemonArtifactBytes,
                            },
                        }
                        : {}),
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
    fetchDaemonArtifactBytes: fetchReactNativeExactArtifactBytesViaMachineRpc,
});

/** Production renderer entry point; hosts receive only an opaque cache capability. */
export function acquirePluginReactNativeArtifactAvailability(
    input: PluginReactNativeArtifactAvailabilityInput,
): Promise<PluginReactNativeArtifactAvailability> {
    return installedReactNativeArtifactAvailabilityProducer.acquire(input);
}
