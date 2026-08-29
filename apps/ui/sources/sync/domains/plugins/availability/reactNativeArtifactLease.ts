import {
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    isSameDaemonPluginReactNativeBundleCacheIdentityV1,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginUiArtifactBytesReadResponse,
    type PluginContributionIdentityV1,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    derivePluginUiNativeCapabilitiesDigestV1,
    PluginUiArtifactCompatibilityKeyV1Schema,
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginUiArtifactCompatibilityKeyV1,
} from '@happier-dev/protocol/plugins/ui';

import { decodeBase64 } from '@/encryption/base64';
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
    isExactDaemonPluginArtifactOriginCurrent,
    isPluginArtifactPersistentScopeCurrent,
    persistVerifiedPluginArtifactLease,
    wrapPluginArtifactLeaseCurrentness,
} from './artifactLease';
import {
    publishVerifiedPluginArtifactToAccountHosting,
} from './accountHostedArtifactPublication';
import type {
    PluginArtifactLeasePersistentScope,
    PluginArtifactSourceCandidate,
    PluginSelectedArtifactLeaseAcquireResult,
    PluginSelectedArtifactLease,
} from './artifactLease';

/**
 * The Artifact consumer is a closed daemon contract. Renderers alone carry a
 * crash binding; Voice and generic client contributions have distinct
 * activation lifecycles and never participate in renderer crash containment.
 */
export type PluginReactNativeArtifactOwner =
    | Readonly<{
        artifactOwnerKind: 'renderer';
        crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1;
    }>
    | Readonly<{
        artifactOwnerKind: 'voiceProvider';
    }>
    | Readonly<{
        /**
         * A generic client executable is anchored to the exact Action that
         * selected it. It never borrows Voice or renderer lifecycle authority.
         */
        artifactOwnerKind: 'clientContribution';
        clientContribution: Readonly<{
            family: 'actions';
            action: PluginContributionIdentityV1;
        }>;
    }>;

/**
 * Candidate migration callbacks execute from the same exact bundle graph as a
 * renderer, but are not a mounted renderer and must never require or report a
 * renderer crash token.
 */
export type PluginReactNativeCollectionMigrationsArtifactOwner = Readonly<{
    artifactOwnerKind: 'collectionMigrations';
}>;

export type PluginReactNativeArtifactByteReadOwner =
    | PluginReactNativeArtifactOwner
    | PluginReactNativeCollectionMigrationsArtifactOwner;

export type PluginReactNativeExactArtifactByteFetcher = (input: Readonly<{
    origin: PluginMachineExecutionOriginV1;
    serverId: string;
    identity: PluginReactNativeBundleCacheIdentity;
}> & PluginReactNativeArtifactByteReadOwner) => Promise<DaemonPluginUiArtifactBytesReadResponse>;

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
 * Artifact-owned input for one already-admitted React Native consumer slot.
 * The consumer supplies only its technical cache identity and an exact
 * Administration-stamped origin; this owner decides whether either can be
 * used against current Account Availability.
 */
export type PluginReactNativeArtifactLeaseCommonInput = Readonly<{
    reader: PluginAccountAvailabilityReader;
    artifactGraph: unknown;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    /** The active Account lifetime is the sole authority for qualified hosted reads. */
    accountLifetime: ActiveServerAccountScopeLifetime;
    persistent?: PluginReactNativeArtifactLeasePersistentScope;
    daemon?: Readonly<{
        origin: PluginMachineExecutionOriginV1;
        /** Active server route; absent routes do not fall back to a default server. */
        serverId: string;
        /** Artifact transport boundary supplied by the platform adapter. */
        fetchArtifactBytes: PluginReactNativeExactArtifactByteFetcher;
    }>;
    appExact?: PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }>;
}>;

export type PluginReactNativeArtifactLeaseInput =
    PluginReactNativeArtifactLeaseCommonInput & PluginReactNativeArtifactOwner;

/**
 * The canonical strict Protocol schema owns this identity's exact field set, so
 * both sides are parsed through it and compared by canonical serialization. A
 * hand-expanded field list would silently stop covering a new schema field, and
 * a locally lenient expansion would let a non-conforming projection identity
 * match a daemon identity that omits the field.
 */
function cacheIdentityMatches(
    left: PluginReactNativeBundleCacheIdentity,
    right: PluginReactNativeBundleCacheIdentity,
): boolean {
    return isSameDaemonPluginReactNativeBundleCacheIdentityV1(left, right);
}

function artifactMatchesCacheIdentity(input: Readonly<{
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: PluginReactNativeBundleCacheIdentity;
}>): boolean {
    return input.artifact.pluginId === input.identity.pluginId
        && input.artifact.tier === 'reactNative'
        && input.artifact.platform === input.identity.platform
        && input.artifact.digest === input.identity.artifactDigest;
}

function artifactPlatformFromCacheIdentity(
    platform: string,
): 'web' | 'ios' | 'android' | null {
    return platform === 'web' || platform === 'ios' || platform === 'android'
        ? platform
        : null;
}

function isSameClientContribution(
    left: Extract<PluginReactNativeArtifactOwner, { artifactOwnerKind: 'clientContribution' }>['clientContribution'],
    right: Extract<PluginReactNativeArtifactOwner, { artifactOwnerKind: 'clientContribution' }>['clientContribution'],
): boolean {
    return left.family === right.family
        && left.action.pluginId === right.action.pluginId
        && left.action.localId === right.action.localId;
}

function exactDaemonOriginIsCurrent(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    origin: PluginMachineExecutionOriginV1;
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: PluginReactNativeBundleCacheIdentity;
}>): boolean {
    if (!artifactMatchesCacheIdentity({ artifact: input.artifact, identity: input.identity })) return false;
    return isExactDaemonPluginArtifactOriginCurrent({
        reader: input.reader,
        origin: input.origin,
        artifact: input.artifact,
    });
}

/**
 * Decodes one exact daemon-issued React Native file graph. The caller supplies
 * the closed owner arm it requested so a candidate migration read cannot be
 * reinterpreted as renderer or Voice bytes.
 */
export function decodePluginReactNativeExactArtifactFileSet(input: Readonly<{
    response: DaemonPluginUiArtifactBytesReadResponse;
    identity: PluginReactNativeBundleCacheIdentity;
    entryRelativePath: string;
}> & PluginReactNativeArtifactByteReadOwner): ReadonlyMap<string, Uint8Array> | null {
    const { response } = input;
    if (
        !response.ok
        || response.artifactFamily !== 'reactNative'
        || response.artifact.artifactKind !== 'reactNativeBundle'
    ) return null;
    if (input.artifactOwnerKind === 'renderer') {
        if (
            response.artifactOwnerKind !== 'renderer'
            || !isSameDaemonPluginReactNativeCrashBindingTokenV1(
                response.crashStateToken,
                input.crashStateToken,
            )
        ) {
            return null;
        }
    } else if (response.artifactOwnerKind !== input.artifactOwnerKind) {
        return null;
    } else if (
        input.artifactOwnerKind === 'clientContribution'
        && (
            response.artifactOwnerKind !== 'clientContribution'
            || !isSameClientContribution(response.clientContribution, input.clientContribution)
        )
    ) {
        return null;
    }
    const parsedIdentity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(response.cacheIdentity);
    if (!parsedIdentity.success || !cacheIdentityMatches(parsedIdentity.data, input.identity)) return null;
    if (
        response.artifact.pluginId !== input.identity.pluginId
        || response.artifact.contributionId !== input.identity.contributionId
        || response.artifact.digest !== input.identity.artifactDigest
    ) {
        return null;
    }
    let entryBytes: Uint8Array;
    try {
        entryBytes = decodeBase64(response.bytesBase64, 'base64');
    } catch {
        return null;
    }
    if (entryBytes.byteLength !== response.artifact.byteSize || !response.files?.length) return null;
    const files = new Map<string, Uint8Array>();
    for (const file of response.files) {
        if (files.has(file.relativePath)) return null;
        try {
            files.set(file.relativePath, decodeBase64(file.bytesBase64, 'base64'));
        } catch {
            return null;
        }
    }
    const entry = files.get(input.entryRelativePath);
    if (
        !entry
        || entry.byteLength !== entryBytes.byteLength
        || entry.some((value, index) => value !== entryBytes[index])
    ) {
        return null;
    }
    return files;
}

function daemonArtifactByteReadOwner(
    input: PluginReactNativeArtifactByteReadOwner,
): PluginReactNativeArtifactByteReadOwner {
    if (input.artifactOwnerKind === 'renderer') {
        return Object.freeze({
            artifactOwnerKind: 'renderer',
            crashStateToken: input.crashStateToken,
        });
    }
    if (input.artifactOwnerKind === 'voiceProvider') {
        return Object.freeze({ artifactOwnerKind: 'voiceProvider' });
    }
    if (input.artifactOwnerKind === 'clientContribution') {
        return Object.freeze({
            artifactOwnerKind: 'clientContribution',
            clientContribution: Object.freeze({
                family: 'actions',
                action: Object.freeze({ ...input.clientContribution.action }),
            }),
        });
    }
    return Object.freeze({ artifactOwnerKind: 'collectionMigrations' });
}

function createDaemonSource(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    origin: PluginMachineExecutionOriginV1;
    serverId: string;
    identity: PluginReactNativeBundleCacheIdentity;
    entryRelativePath: string;
    fetchArtifactBytes: PluginReactNativeExactArtifactByteFetcher;
}> & PluginReactNativeArtifactByteReadOwner): PluginArtifactSourceCandidate {
    let pending: Promise<ReadonlyMap<string, Uint8Array> | null> | null = null;
    return Object.freeze({
        kind: 'daemon',
        readFile: async ({ artifact, relativePath }) => {
            const current = () => exactDaemonOriginIsCurrent({
                reader: input.reader,
                origin: input.origin,
                artifact,
                identity: input.identity,
            });
            if (!current()) return null;
            if (!pending) {
                pending = input.fetchArtifactBytes({
                    origin: input.origin,
                    serverId: input.serverId,
                    identity: input.identity,
                    ...daemonArtifactByteReadOwner(input),
                }).then((response) => decodePluginReactNativeExactArtifactFileSet({
                    response,
                    identity: input.identity,
                    entryRelativePath: input.entryRelativePath,
                    ...daemonArtifactByteReadOwner(input),
                })).catch(() => null);
            }
            const files = await pending;
            if (!files || !current()) return null;
            const bytes = files.get(relativePath);
            return bytes ? new Uint8Array(bytes) : null;
        },
    });
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

/**
 * The daemon admits this cache identity only after it has proved the exact
 * Artifact graph against the reported host runtime, so it is the canonical
 * adoption fact for these bytes. Deriving a second host-compatibility key in
 * the UI would let the published link disagree with the identity that selected
 * the bundle.
 *
 * The identity carries the host's native capability set only as a digest.
 * Recording the empty set is truthful exactly when that digest proves the host
 * reported no capabilities; otherwise this host cannot describe its own
 * adoption facts and must not publish them.
 */
function reactNativeHostCompatibilityFromCacheIdentity(input: Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    platform: 'web' | 'ios' | 'android';
}>): PluginUiArtifactCompatibilityKeyV1 | null {
    if (
        derivePluginUiNativeCapabilitiesDigestV1([])
        !== input.identity.nativeCapabilitiesDigest
    ) {
        return null;
    }
    const parsed = PluginUiArtifactCompatibilityKeyV1Schema.safeParse({
        hostAppVersion: input.identity.hostAppVersion,
        hostUiApiVersion: input.identity.hostUiApiVersion,
        reactVersion: input.identity.reactVersion,
        reactNativeVersion: input.identity.reactNativeVersion,
        ...(input.identity.expoRuntimeVersion
            ? { expoRuntimeVersion: input.identity.expoRuntimeVersion }
            : {}),
        ...(input.identity.hermesVersion
            ? { hermesVersion: input.identity.hermesVersion }
            : {}),
        platform: input.platform,
        channel: input.identity.channel,
        nativeCapabilities: [],
    });
    return parsed.success ? parsed.data : null;
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
    const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
    const sources: PluginArtifactSourceCandidate[] = [];
    if (input.appExact) sources.push(input.appExact);
    if (input.persistent && isPluginArtifactPersistentScopeCurrent(input.persistent)) {
        sources.push(createPluginArtifactPersistentSource({
            scope: input.persistent,
            identity: input.cacheIdentity,
            artifactMatchesIdentity: (artifact, identity) => artifactMatchesCacheIdentity({ artifact, identity }),
        }));
    }
    if (input.daemon && graph.success) {
        sources.push(createDaemonSource({
            reader: input.reader,
            origin: input.daemon.origin,
            serverId: input.daemon.serverId,
            identity: input.cacheIdentity,
            entryRelativePath: graph.data.entry,
            fetchArtifactBytes: input.daemon.fetchArtifactBytes,
            ...daemonArtifactByteReadOwner(input),
        }));
    }
    sources.push(createActivePluginAccountHostedArtifactSourceCandidate({
        accountLifetime: input.accountLifetime,
    }));

    const acquired = await acquirePluginSelectedArtifactLease({
        reader: input.reader,
        slot: Object.freeze({
            pluginId: input.cacheIdentity.pluginId,
            // The cache identity identifies the renderer runtime. The signed
            // graph identifies the Account Artifact slot, which can be a
            // generated owner distinct from that renderer contribution.
            contributionId: graph.success
                ? graph.data.contributionId
                : input.cacheIdentity.contributionId,
            tier: 'reactNative',
            platform,
            ...(input.daemon
                ? {
                    materializationOrigin: Object.freeze({
                        serverIdentityId: input.daemon.origin.serverIdentityId,
                        materializationRef: input.daemon.origin.materializationRef,
                    }),
                }
                : {}),
        }),
        artifactGraph: input.artifactGraph,
        sources,
    });
    if (acquired.kind !== 'available') return acquired;
    if (!artifactMatchesCacheIdentity({ artifact: acquired.lease.artifact, identity: input.cacheIdentity })) {
        acquired.lease.dispose();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }

    // Daemon provenance gates ACQUISITION only: `createDaemonSource` proves the
    // exact origin before every byte it hands over. Once those bytes are copied
    // and integrity-verified into host custody, the Account lifetime, the
    // Account's current Artifact admission, and Account cache custody are the
    // authorities. A daemon blip must not blank verified content.
    const requiresPersistentCurrentness = input.persistent !== undefined;
    const lease = wrapPluginArtifactLeaseCurrentness({
        lease: acquired.lease,
        reader: input.reader,
        isAdditionalCurrent: () => (
            input.accountLifetime.isCurrent()
            && (!requiresPersistentCurrentness || isPluginArtifactPersistentScopeCurrent(input.persistent))
        ),
    });
    if (!lease.isCurrent()) {
        lease.dispose();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (input.persistent && (lease.sourceKind === 'daemon' || lease.sourceKind === 'accountHosted')) {
        await persistVerifiedPluginArtifactLease({ lease, persistent: input.persistent });
    }
    // Account hosting is the only source a new uncached client can reach while
    // every daemon is offline, and these verified bytes are the only copy this
    // process will ever hold beside a current Account authority.
    const hostCompatibility = reactNativeHostCompatibilityFromCacheIdentity({
        identity: input.cacheIdentity,
        platform,
    });
    if (hostCompatibility) {
        await publishVerifiedPluginArtifactToAccountHosting({
            reader: input.reader,
            accountLifetime: input.accountLifetime,
            lease,
            hostCompatibility,
        });
    }
    return Object.freeze({ kind: 'available', lease });
}
