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
import type { PluginAccountHostedArtifactPublicationResult } from './accountHostedArtifactPublication';
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
    accountHosting?: Promise<PluginAccountHostedArtifactPublicationResult>;
}>;

type ArtifactPreparationRefusal = Extract<PluginSelectedArtifactLeaseAcquireResult, { kind: 'unavailable' }>
    | Extract<PluginReactNativeArtifactLeaseCacheMaterializationResult, { kind: 'unavailable' }>;

export type PluginReactNativeArtifactAvailability =
    | (Readonly<{ kind: 'available' }> & PluginReactNativeArtifactAvailabilityHandle)
    | (ArtifactPreparationRefusal & Readonly<{ layer: 'artifact'; phase: 'preparation'; retryable: boolean }>);

function refusePreparation(failure: ArtifactPreparationRefusal): Extract<PluginReactNativeArtifactAvailability, { kind: 'unavailable' }> {
    // This owner has not entered an Action. Only a failed byte transport is
    // transient here; selection, graph and integrity refusals require changed facts.
    return Object.freeze({ ...failure, layer: 'artifact', phase: 'preparation', retryable:
        failure.code === 'artifact_bytes_rpc_unavailable' || failure.code === 'artifact_bytes_fetch_failed'
        || failure.code === 'transport_unavailable' });
}

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
                return refusePreparation({ kind: 'unavailable', code: 'artifact_lease_revoked' });
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
                    return refusePreparation({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                }

                const selected = await acquirePluginReactNativeArtifactLease({
                    reader: input.reader,
                    executionOrigin: input.executionOrigin,
                    artifactGraph: input.artifactGraph,
                    cacheIdentity: input.cacheIdentity,
                    accountLifetime: input.accountLifetime,
                    ...(input.signal ? { signal: input.signal } : {}),
                    ...(input.accountHostingSignal ? { accountHostingSignal: input.accountHostingSignal } : {}),
                    appExact: dependencies.appExact,
                    persistent,
                    fetchDaemonArtifactBytes: dependencies.fetchDaemonArtifactBytes,
                    ...(input.daemonProjectionSelection
                        ? { daemonProjectionSelection: input.daemonProjectionSelection }
                        : {}),
                    ...(input.daemon ? { daemon: input.daemon } : {}),
                    ...(input.daemons ? { daemons: input.daemons } : {}),
                });
                if (selected.kind !== 'available') return refusePreparation(selected);
                if (!isCurrent(input)) {
                    selected.lease.dispose();
                    return refusePreparation({ kind: 'unavailable', code: 'artifact_lease_revoked' });
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
                    return refusePreparation(materialized);
                }
                return Object.freeze({
                    kind: 'available' as const,
                    cacheKey: materialized.cacheKey,
                    isCurrent: materialized.isCurrent,
                    onRevoke: selected.lease.onRevoke,
                    dispose: selected.lease.dispose,
                    ...(selected.accountHosting ? { accountHosting: selected.accountHosting } : {}),
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
