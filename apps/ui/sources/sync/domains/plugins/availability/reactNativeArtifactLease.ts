import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';

import {
    createActivePluginAccountHostedArtifactSourceCandidate,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import type {
    PluginUiPersistentArtifactFile,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type {
    PluginAccountAvailabilityReader,
} from './reader';
import {
    acquirePluginSelectedArtifactLease,
    createPluginArtifactPersistentSource,
    persistVerifiedPluginArtifactLease,
} from './artifactLease';
import {
    publishVerifiedPluginArtifactToAccountHosting,
} from './accountHostedArtifactPublication';
import {
    createPluginArtifactDaemonSource,
    type PluginArtifactDaemonByteFetcher,
} from './artifactDaemonSource';
import type {
    PluginArtifactDaemonProjectionSelectionInput,
    PluginArtifactDaemonTransport,
    PluginArtifactLeasePersistentScope,
    PluginArtifactSourceCandidate,
    PluginDaemonProjectionArtifactSelection,
    PluginSelectedArtifactLeaseAcquireResult,
    PluginSelectedArtifactLease,
} from './artifactLease';

export type PluginReactNativeArtifactLeasePersistentScope = PluginArtifactLeasePersistentScope;

/**
 * The renderer cache is a terminal byte-materialization sink. It receives
 * already verified declared files and has no Artifact source or admission
 * authority.
 */
export type PluginReactNativeArtifactLeaseCacheSink = Readonly<{
    writeVerifiedArtifact: (entry: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        accountScope: ServerAccountScope;
        bytes: Uint8Array;
        entryRelativePath: string;
        files: readonly PluginUiPersistentArtifactFile[];
    }>) =>
        | Readonly<{ ok: true; cacheKey: string }>
        | Readonly<{
            ok: false;
            code: 'artifact_cache_write_invalidated' | 'hermes_bytecode_unsupported';
            diagnostics: readonly string[];
        }>;
}>;

export type PluginReactNativeArtifactLeaseCacheMaterializationResult =
    | Readonly<{
        kind: 'available';
        cacheKey: string;
        /** Caller-owned currentness composed with the revocable Artifact lease. */
        isCurrent: () => boolean;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'artifact_lease_revoked'
            | 'artifact_graph_mismatch'
            | 'artifact_cache_write_invalidated'
            | 'hermes_bytecode_unsupported';
    }>;

/**
 * Artifact-owned input for one already-admitted React Native consumer slot:
 * its technical cache identity plus the daemon byte route, if any.
 */
export type PluginReactNativeArtifactLeaseInput = Readonly<{
    reader: PluginAccountAvailabilityReader;
    artifactGraph: unknown;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    /** The active Account lifetime is the sole authority for qualified hosted reads. */
    accountLifetime: ActiveServerAccountScopeLifetime;
    persistent?: PluginReactNativeArtifactLeasePersistentScope;
    signal?: AbortSignal;
    /** Daemon route for an Account-release selection (the mount's machine). */
    daemon?: PluginArtifactDaemonTransport;
    /** Daemon RPC boundary; production uses the canonical machine-RPC transport. */
    fetchDaemonArtifactBytes?: PluginArtifactDaemonByteFetcher;
    appExact?: PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }>;
    daemonProjectionSelection?: PluginArtifactDaemonProjectionSelectionInput;
}>;

function artifactMatchesCacheIdentity(input: Readonly<{
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: PluginReactNativeBundleCacheIdentity;
}>): boolean {
    return input.artifact.pluginId === input.identity.pluginId
        && input.artifact.contributionId === input.identity.contributionId
        && input.artifact.artifactId === input.identity.artifactId
        && input.artifact.tier === 'reactNative'
        && input.artifact.digest === input.identity.artifactDigest;
}

function artifactPlatformFromCacheIdentity(
    platform: string,
): 'web' | 'ios' | 'android' | null {
    return platform === 'web' || platform === 'ios' || platform === 'android'
        ? platform
        : null;
}

function isCacheHandoffCurrent(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    isCurrent: () => boolean;
}>): boolean {
    try {
        return input.lease.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

/**
 * Materializes a current, fully verified Artifact lease into the renderer's
 * private executable cache. The lease remains the source/currentness owner;
 * callers retain the returned predicate and must check it around any
 * non-cancellable module load.
 */
export async function materializePluginReactNativeArtifactLeaseInCache(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    accountScope: ServerAccountScope;
    cacheSink: PluginReactNativeArtifactLeaseCacheSink;
    /** The consumer's mount/controller currentness; it never becomes cache authority. */
    isCurrent: () => boolean;
}>): Promise<PluginReactNativeArtifactLeaseCacheMaterializationResult> {
    const current = () => isCacheHandoffCurrent({
        lease: input.lease,
        isCurrent: input.isCurrent,
    });
    if (!current()) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (!artifactMatchesCacheIdentity({ artifact: input.lease.artifact, identity: input.cacheIdentity })) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }

    const files: PluginUiPersistentArtifactFile[] = [];
    for (const declared of input.lease.files) {
        if (!current()) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        }
        const read = await input.lease.readFile(declared.relativePath);
        if (!current()) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        }
        if (
            read.kind !== 'available'
            || read.file.relativePath !== declared.relativePath
            || read.file.digest !== declared.digest
            || read.file.byteSize !== declared.byteSize
        ) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
        }
        // The lease already detached these bytes for this reader, and the cache
        // sink below takes its own custody copy synchronously. A third copy
        // here would establish no additional owner.
        files.push(Object.freeze({
            relativePath: read.file.relativePath,
            digest: read.file.digest,
            byteSize: read.file.byteSize,
            bytes: read.bytes,
        }));
    }
    const entry = files.find((file) => file.relativePath === input.lease.artifactGraph.entry);
    if (!entry) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }
    if (!current()) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    const written = input.cacheSink.writeVerifiedArtifact(Object.freeze({
        identity: input.cacheIdentity,
        accountScope: input.accountScope,
        bytes: entry.bytes,
        entryRelativePath: input.lease.artifactGraph.entry,
        files: Object.freeze(files),
    }));
    if (!current()) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (!written.ok) {
        return Object.freeze({ kind: 'unavailable', code: written.code });
    }
    return Object.freeze({
        kind: 'available',
        cacheKey: written.cacheKey,
        isCurrent: current,
    });
}

export async function acquirePluginReactNativeArtifactLease(
    input: PluginReactNativeArtifactLeaseInput,
): Promise<PluginSelectedArtifactLeaseAcquireResult> {
    if (!input.accountLifetime.isCurrent()) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    const platform = artifactPlatformFromCacheIdentity(input.cacheIdentity.platform);
    if (!platform) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }
    const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(input.artifactGraph);
    const sources: PluginArtifactSourceCandidate[] = [];
    if (input.appExact) sources.push(input.appExact);
    if (input.persistent?.isCurrent()) {
        sources.push(createPluginArtifactPersistentSource({ scope: input.persistent }));
    }
    const daemonTransport = input.daemonProjectionSelection?.transport ?? input.daemon;
    if (daemonTransport) {
        sources.push(createPluginArtifactDaemonSource({
            transport: daemonTransport,
            family: 'reactNative',
            ...(input.fetchDaemonArtifactBytes ? { fetchArtifactBytes: input.fetchDaemonArtifactBytes } : {}),
        }));
    }
    sources.push(createActivePluginAccountHostedArtifactSourceCandidate({
        accountLifetime: input.accountLifetime,
    }));

    const daemonProjectionSelection: PluginDaemonProjectionArtifactSelection | undefined =
        input.daemonProjectionSelection && graph.success
            ? Object.freeze({
                occurrenceId: input.daemonProjectionSelection.occurrenceId,
                artifact: Object.freeze({
                    pluginId: input.cacheIdentity.pluginId,
                    contributionId: input.daemonProjectionSelection.contributionId,
                    artifactId: graph.data.artifactId,
                    tier: 'reactNative' as const,
                    platform,
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
            // The cache identity identifies the renderer runtime. The signed
            // graph identifies the Account Artifact slot, which can be a
            // generated owner distinct from that renderer contribution.
            contributionId: input.cacheIdentity.contributionId,
            tier: 'reactNative',
            platform,
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
    // Account hosting is the only source a new uncached client can reach while
    // every daemon is offline, and these verified bytes are the only copy this
    // process will ever hold beside a current Account authority.
    await publishVerifiedPluginArtifactToAccountHosting({
        reader: input.reader,
        accountLifetime: input.accountLifetime,
        lease,
    });
    return Object.freeze({ kind: 'available', lease });
}
