import { type DaemonReactNativeHostRuntimeIdentityV1 } from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    type HostedWebAssetPolicyInput,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createActivePluginAccountHostedArtifactSourceCandidate,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import {
    createPluginReactNativePersistentAccountOperationStore,
    getInstalledPluginNativeArtifactResources,
    getInstalledPluginReactNativeBundleCache,
    type InstalledPluginNativeArtifactResources,
    type PluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    resolveNativeReactNativeHostRuntimeIdentity,
} from '@/components/plugins/reactNative/hostRuntimeIdentity';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginArtifactDaemonProjectionSelectionInput,
    PluginArtifactDaemonTransport,
    PluginArtifactLeasePersistentScope,
    PluginArtifactSourceCandidate,
    PluginDaemonProjectionArtifactSelection,
    PluginSelectedArtifactLease,
    PluginSelectedArtifactLeaseAcquireResult,
} from './artifactLease';
import {
    acquirePluginSelectedArtifactLease,
    createPluginArtifactPersistentSource,
    persistVerifiedPluginArtifactLease,
} from './artifactLease';
import {
    createPluginArtifactDaemonSource,
    type PluginArtifactDaemonByteFetcher,
} from './artifactDaemonSource';
import {
    publishVerifiedPluginArtifactToAccountHosting,
} from './accountHostedArtifactPublication';
import type {
    PluginNativeArtifactResourceAcquireResult,
    PluginNativeArtifactResourceHandle,
    PluginNativeArtifactPersistentStore,
} from './nativeArtifactResource';
import type { PluginAccountAvailabilityReader } from './reader';
import { createBundledPluginUiAppExactArtifactSource } from './bundledAppExactArtifactSource';

/** Semantic selected slot context around digest-only executable byte identity. */
export type PluginHostedWebArtifactIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactId: string;
    artifactDigest: PluginUiArtifactDigestV1;
    platform: 'web';
}>;

export type PluginHostedWebArtifactLeasePersistentScope = PluginArtifactLeasePersistentScope;

/**
 * Artifact-owned input for one renderer's already-admitted hosted-web slot:
 * its technical renderer identity plus the daemon byte route, if any.
 */
export type PluginHostedWebArtifactLeaseInput = Readonly<{
    reader: PluginAccountAvailabilityReader;
    artifactGraph: unknown;
    cacheIdentity: PluginHostedWebArtifactIdentity;
    accountLifetime: ActiveServerAccountScopeLifetime;
    persistent?: PluginHostedWebArtifactLeasePersistentScope;
    signal?: AbortSignal;
    /** Daemon route for an Account-release selection (the mount's machine). */
    daemon?: PluginArtifactDaemonTransport;
    /** Daemon RPC boundary; production uses the canonical machine-RPC transport. */
    fetchDaemonArtifactBytes?: PluginArtifactDaemonByteFetcher;
    appExact?: PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }>;
    accountHosted?: PluginArtifactSourceCandidate & Readonly<{ kind: 'accountHosted' }>;
    daemonProjectionSelection?: PluginArtifactDaemonProjectionSelectionInput;
}>;

function artifactMatchesCacheIdentity(input: Readonly<{
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: PluginHostedWebArtifactIdentity;
}>): boolean {
    return input.artifact.pluginId === input.identity.pluginId
        && input.artifact.contributionId === input.identity.contributionId
        && input.artifact.artifactId === input.identity.artifactId
        && input.artifact.tier === 'hostedWeb'
        && input.artifact.platform === 'web'
        && input.artifact.digest === input.identity.artifactDigest;
}

/**
 * Resolves one hosted-web Artifact through the canonical source order. It is
 * deliberately renderer-specific: the exact daemon cache identity and family
 * are hosted-web facts, while source selection, integrity, and lease lifetime
 * remain with the generic Artifact owner.
 */
export async function acquirePluginHostedWebArtifactLease(
    input: PluginHostedWebArtifactLeaseInput,
): Promise<PluginSelectedArtifactLeaseAcquireResult> {
    const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(input.artifactGraph);
    if (
        !graph.success
        || graph.data.tier !== 'hostedWeb'
        || graph.data.artifactId !== input.cacheIdentity.artifactId
        || graph.data.digest !== input.cacheIdentity.artifactDigest
    ) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }
    const sources: PluginArtifactSourceCandidate[] = [];
    if (input.appExact) sources.push(input.appExact);
    if (input.persistent?.isCurrent()) {
        sources.push(createPluginArtifactPersistentSource({ scope: input.persistent }));
    }
    const daemonTransport = input.daemonProjectionSelection?.transport ?? input.daemon;
    if (daemonTransport) {
        sources.push(createPluginArtifactDaemonSource({
            transport: daemonTransport,
            family: 'hostedWeb',
            ...(input.fetchDaemonArtifactBytes ? { fetchArtifactBytes: input.fetchDaemonArtifactBytes } : {}),
        }));
    }
    if (input.accountHosted) sources.push(input.accountHosted);

    const daemonProjectionSelection: PluginDaemonProjectionArtifactSelection | undefined =
        input.daemonProjectionSelection
            ? Object.freeze({
                occurrenceId: input.daemonProjectionSelection.occurrenceId,
                artifact: Object.freeze({
                    pluginId: input.cacheIdentity.pluginId,
                    contributionId: input.daemonProjectionSelection.contributionId,
                    artifactId: graph.data.artifactId,
                    tier: 'hostedWeb' as const,
                    platform: 'web' as const,
                    digest: graph.data.digest,
                    hostUiApiRange: graph.data.hostUiApiRange,
                    releaseVersion: input.daemonProjectionSelection.releaseVersion,
                }),
                isCurrent: input.daemonProjectionSelection.isCurrent,
            })
            : undefined;

    const acquired = await acquirePluginSelectedArtifactLease({
        reader: input.reader,
        accountLifetime: input.accountLifetime,
        ...(input.signal ? { signal: input.signal } : {}),
        slot: Object.freeze({
            pluginId: input.cacheIdentity.pluginId,
            // The renderer identity is not necessarily the generated Account
            // slot contribution. The signed graph names that Artifact slot.
            contributionId: input.cacheIdentity.contributionId,
            tier: 'hostedWeb',
            platform: 'web',
        }),
        ...(daemonProjectionSelection ? { daemonProjectionSelection } : {}),
        artifactGraph: input.artifactGraph,
        sources,
    });
    if (acquired.kind !== 'available') return acquired;
    const lease = acquired.lease;
    if (!artifactMatchesCacheIdentity({ artifact: lease.artifact, identity: input.cacheIdentity })) {
        lease.dispose();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }
    if (input.persistent && (lease.sourceKind === 'daemon' || lease.sourceKind === 'accountHosted')) {
        await persistVerifiedPluginArtifactLease({ lease, persistent: input.persistent });
    }
    return Object.freeze({ kind: 'available', lease });
}

/**
 * The only Artifact-to-hosted-frame injection input. Availability selects and
 * verifies `lease` before this boundary; UI consumes that selected lease and
 * never fetches, races, or chooses another Artifact source.
 */
export type PluginSelectedHostedWebArtifactInput = Readonly<{
    lease: PluginSelectedArtifactLease;
    persistent: Readonly<{
        scope: ServerAccountScope;
        /** Existing Account/cache currentness, never a new lifetime owner. */
        isCurrent: () => boolean;
    }>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** Target-scoped bound host/frame currentness; it has no Artifact authority. */
    isCurrent: () => boolean;
    /** Canonical policy facts for Protocol's sole response-table owner. */
    hostedWebPolicy: HostedWebAssetPolicyInput;
}>;

/** The host receives only the opaque native handle or a typed unavailable state. */
export type PluginSelectedHostedWebArtifactAvailability =
    | PluginNativeArtifactResourceAcquireResult
    | Readonly<{
        kind: 'unavailable';
        code: 'hosted_web_artifact_tier_invalid';
    }>;

type PluginHostedWebArtifactAvailabilityUnavailable =
    | Extract<PluginSelectedArtifactLeaseAcquireResult, { kind: 'unavailable' }>
    | Extract<PluginNativeArtifactResourceAcquireResult, { kind: 'unavailable' }>
    | Readonly<{
        kind: 'unavailable';
        code: 'hosted_web_artifact_tier_invalid';
    }>;

/**
 * The complete Artifact-owned production input. Host callers supply only
 * already-admitted renderer facts. Persistent-cache selection, exact daemon
 * transport, qualified Account Artifact reads, and native registration remain
 * private here.
 */
export type PluginHostedWebArtifactAvailabilityInput = Omit<
    PluginHostedWebArtifactLeaseInput,
    'persistent' | 'appExact' | 'accountHosted' | 'fetchDaemonArtifactBytes'
> & Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** Bound surface currentness; it never becomes Artifact/cache authority. */
    isCurrent: () => boolean;
    hostedWebPolicy: HostedWebAssetPolicyInput;
}>;

/** A host consumer can receive only this opaque handle or a typed unavailable state. */
export type PluginHostedWebArtifactAvailability =
    | Readonly<{ kind: 'available'; handle: PluginNativeArtifactResourceHandle }>
    | PluginHostedWebArtifactAvailabilityUnavailable;

export type PluginHostedWebArtifactAvailabilityProducer = Readonly<{
    acquire: (
        input: PluginHostedWebArtifactAvailabilityInput,
    ) => Promise<PluginHostedWebArtifactAvailability>;
}>;

export type PluginHostedWebArtifactAvailabilityProducerDependencies = Readonly<{
    /** Native-only composed Artifact resources; a web caller gets typed unavailable. */
    getNativeResources: () => InstalledPluginNativeArtifactResources | null;
    /**
     * This host's own runtime identity — the SAME probe the daemon projection is
     * given, so the adoption facts a published link records cannot disagree with
     * the ones this host reports anywhere else. It is required rather than
     * defaulted: a caller that cannot name its identity source would otherwise
     * silently publish under whatever the ambient native probe happened to
     * answer.
     */
    getHostRuntimeIdentity: () => DaemonReactNativeHostRuntimeIdentityV1 | null;
    /** Existing Artifact-cache lifecycle/currentness owner; never a hosted-web-local fence. */
    getCache: () => Pick<
        PluginReactNativeBundleCache,
        | 'bindAccountLifetime'
        | 'capturePersistentAccountOperation'
        | 'removePersistentArtifact'
    >;
}>;

/**
 * A native registration only remains meaningful while the selected source
 * lease remains alive. The returned wrapper has no independent currentness:
 * it joins the consumer's normal disposal to that one source lease.
 */
function bindSelectedLeaseToNativeHandle(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    handle: PluginNativeArtifactResourceHandle;
}>): PluginNativeArtifactResourceHandle {
    let disposed = false;
    const sourceRevocation = input.handle.onRevoke(() => {
        disposed = true;
        input.lease.dispose();
    });
    return Object.freeze({
        token: input.handle.token,
        storagePartitionId: input.handle.storagePartitionId,
        policyTable: input.handle.policyTable,
        isCurrent: () => input.handle.isCurrent(),
        onRevoke: input.handle.onRevoke,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            sourceRevocation.dispose();
            input.handle.dispose();
            input.lease.dispose();
        },
    });
}

async function materializeSelectedHostedWebArtifactAvailability(input: Readonly<{
    selected: PluginSelectedHostedWebArtifactInput;
    resources: InstalledPluginNativeArtifactResources;
    /** Cache-owned operation view; raw native storage is never used directly here. */
    persistentStore: PluginNativeArtifactPersistentStore;
}>): Promise<PluginSelectedHostedWebArtifactAvailability> {
    const materialized = await input.resources.registry.materialize({
        lease: input.selected.lease,
        persistent: Object.freeze({
            scope: input.selected.persistent.scope,
            store: input.persistentStore,
            isCurrent: input.selected.persistent.isCurrent,
        }),
        accountLifetime: input.selected.accountLifetime,
        isCurrent: input.selected.isCurrent,
        hostedWebPolicy: input.selected.hostedWebPolicy,
    });
    return materialized.kind === 'available'
        ? Object.freeze({
            kind: 'available' as const,
            handle: bindSelectedLeaseToNativeHandle({
                lease: input.selected.lease,
                handle: materialized.handle,
            }),
        })
        : materialized;
}

/**
 * Project one Artifact-selected hosted-web lease into the opaque native-frame
 * handle that a host may inject into its frame. This binds the same Account
 * lifetime to bundleCache before registration, so its Account-retirement
 * writer must pass the native token tombstone gate before it may remove bytes.
 */
export async function projectSelectedHostedWebArtifactAvailability(
    input: PluginSelectedHostedWebArtifactInput,
): Promise<PluginSelectedHostedWebArtifactAvailability> {
    if (input.lease.artifact.tier !== 'hostedWeb') {
        return Object.freeze({ kind: 'unavailable', code: 'hosted_web_artifact_tier_invalid' });
    }
    if (!areServerAccountScopesEqual(input.persistent.scope, input.accountLifetime.scope)) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    const resources = getInstalledPluginNativeArtifactResources();
    if (!resources) {
        return Object.freeze({ kind: 'unavailable', code: 'native_artifact_store_unavailable' });
    }
    const cache = getInstalledPluginReactNativeBundleCache();
    cache.bindAccountLifetime(input.accountLifetime);
    const operation = cache.capturePersistentAccountOperation({
        scope: input.persistent.scope,
        isCurrent: () => (
            input.persistent.isCurrent()
            && input.accountLifetime.isCurrent()
            && input.isCurrent()
        ),
    });
    if (!operation) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    try {
        const result = await materializeSelectedHostedWebArtifactAvailability({
            selected: {
                ...input,
                persistent: Object.freeze({
                    ...input.persistent,
                    isCurrent: operation.isCurrent,
                }),
            },
            resources,
            persistentStore: createPluginReactNativePersistentAccountOperationStore({
                store: resources.nativePersistentStore,
                operation,
            }),
        });
        if (result.kind !== 'available') input.lease.dispose();
        return result;
    } finally {
        operation.release();
    }
}

/**
 * The one production Artifact producer for a hosted native frame. It supplies
 * the shared native-token-gated persistent store to source selection, binds
 * the incumbent Account lifetime, and then projects the selected lease into
 * the opaque handle consumed by the host. Neither caller nor frame can bypass
 * cache ordering or retain the source lease independently.
 */
export function createPluginHostedWebArtifactAvailabilityProducer(
    dependencies: PluginHostedWebArtifactAvailabilityProducerDependencies,
): PluginHostedWebArtifactAvailabilityProducer {
    return Object.freeze({
        acquire: async (input) => {
            if (!input.accountLifetime.isCurrent() || !input.isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const resources = dependencies.getNativeResources();
            if (!resources) {
                return Object.freeze({ kind: 'unavailable', code: 'native_artifact_store_unavailable' });
            }
            const cache = dependencies.getCache();
            cache.bindAccountLifetime(input.accountLifetime);
            if (!input.accountLifetime.isCurrent() || !input.isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const operation = cache.capturePersistentAccountOperation({
                scope: input.accountLifetime.scope,
                isCurrent: () => input.accountLifetime.isCurrent() && input.isCurrent(),
            });
            if (!operation) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const persistentStore = createPluginReactNativePersistentAccountOperationStore({
                store: resources.nativePersistentStore,
                operation,
            });
            try {
                const selected = await acquirePluginHostedWebArtifactLease({
                    reader: input.reader,
                    artifactGraph: input.artifactGraph,
                    cacheIdentity: input.cacheIdentity,
                    accountLifetime: input.accountLifetime,
                    ...(input.signal ? { signal: input.signal } : {}),
                    appExact: createBundledPluginUiAppExactArtifactSource(),
                    persistent: Object.freeze({
                        scope: input.accountLifetime.scope,
                        store: persistentStore,
                        isCurrent: operation.isCurrent,
                        removePersistentArtifact: (identity) => cache.removePersistentArtifact(
                            identity,
                            operation.isCurrent,
                        ),
                    }),
                    ...(input.daemon ? { daemon: input.daemon } : {}),
                    ...(input.daemonProjectionSelection
                        ? { daemonProjectionSelection: input.daemonProjectionSelection }
                        : {}),
                    accountHosted: createActivePluginAccountHostedArtifactSourceCandidate({
                        accountLifetime: input.accountLifetime,
                    }),
                });
                if (selected.kind !== 'available') return selected;
                if (!operation.isCurrent()) {
                    selected.lease.dispose();
                    return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                }
                // Account hosting is the only source a new uncached client can
                // reach while every daemon is offline, and this frame's tier is
                // no exception: these verified bytes are the only copy this
                // process holds beside a current Account authority.
                await publishVerifiedPluginArtifactToAccountHosting({
                    reader: input.reader,
                    accountLifetime: input.accountLifetime,
                    lease: selected.lease,
                });
                if (!operation.isCurrent()) {
                    selected.lease.dispose();
                    return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
                }
                const result = await materializeSelectedHostedWebArtifactAvailability({
                    selected: {
                        lease: selected.lease,
                        persistent: Object.freeze({
                            scope: input.accountLifetime.scope,
                            isCurrent: operation.isCurrent,
                        }),
                        accountLifetime: input.accountLifetime,
                        isCurrent: input.isCurrent,
                        hostedWebPolicy: input.hostedWebPolicy,
                    },
                    resources,
                    persistentStore,
                });
                if (result.kind !== 'available') selected.lease.dispose();
                return result;
            } finally {
                operation.release();
            }
        },
    });
}

const installedHostedWebArtifactAvailabilityProducer = createPluginHostedWebArtifactAvailabilityProducer({
    getNativeResources: getInstalledPluginNativeArtifactResources,
    getCache: getInstalledPluginReactNativeBundleCache,
    getHostRuntimeIdentity: () => resolveNativeReactNativeHostRuntimeIdentity(),
});

/** Production host entry point; consumer code receives only its typed result. */
export function acquirePluginHostedWebArtifactAvailability(
    input: PluginHostedWebArtifactAvailabilityInput,
): Promise<PluginHostedWebArtifactAvailability> {
    return installedHostedWebArtifactAvailabilityProducer.acquire(input);
}
