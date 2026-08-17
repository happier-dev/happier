import {
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    isExactPluginMachineMaterializationRefV1,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    isPluginMachineMaterializationOnServerIdentityV1,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginUiArtifactBytesReadResponse,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import { decodeBase64 } from '@/encryption/base64';
import {
    createActivePluginAccountHostedArtifactSourceCandidate,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import type {
    PluginUiPersistentArtifactIdentity,
    PluginUiPersistentArtifactFile,
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type {
    PluginAccountAvailabilityReader,
} from './reader';
import { acquirePluginSelectedArtifactLease } from './artifactLease';
import type {
    PluginArtifactSourceCandidate,
    PluginSelectedArtifactLeaseAcquireResult,
    PluginSelectedArtifactLease,
} from './artifactLease';

/**
 * The Artifact consumer is a closed daemon contract. Renderers alone carry a
 * crash binding because Voice has a distinct activation lifecycle and must
 * never participate in renderer crash containment.
 */
export type PluginReactNativeArtifactOwner =
    | Readonly<{
        artifactOwnerKind: 'renderer';
        crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1;
    }>
    | Readonly<{
        artifactOwnerKind: 'voiceProvider';
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

export type PluginReactNativeArtifactLeasePersistentScope = Readonly<{
    scope: ServerAccountScope;
    store: PluginUiPersistentArtifactStore;
    /** The active Account-realm lifetime owner; required for cache use. */
    isCurrent: () => boolean;
}>;

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

function cacheIdentityMatches(
    left: PluginReactNativeBundleCacheIdentity,
    right: PluginReactNativeBundleCacheIdentity,
): boolean {
    return left.pluginId === right.pluginId
        && left.contributionId === right.contributionId
        && left.artifactDigest === right.artifactDigest
        && left.hostAppVersion === right.hostAppVersion
        && left.hostUiApiVersion === right.hostUiApiVersion
        && left.reactVersion === right.reactVersion
        && left.reactNativeVersion === right.reactNativeVersion
        && (left.expoRuntimeVersion ?? '') === (right.expoRuntimeVersion ?? '')
        && (left.hermesVersion ?? '') === (right.hermesVersion ?? '')
        && left.platform === right.platform
        && left.channel === right.channel
        && left.nativeCapabilitiesDigest === right.nativeCapabilitiesDigest
        && left.projectionGeneration === right.projectionGeneration;
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

function persistentIdentityFor(input: Readonly<{
    scope: ServerAccountScope;
    artifact: PluginSelectedArtifactLease['artifact'];
}>): PluginUiPersistentArtifactIdentity {
    return Object.freeze({
        accountScope: input.scope,
        releaseVersion: input.artifact.releaseVersion,
        pluginId: input.artifact.pluginId,
        contributionId: input.artifact.contributionId,
        tier: input.artifact.tier,
        platform: input.artifact.platform,
        artifactDigest: input.artifact.digest,
    });
}

function persistentScopeIsCurrent(scope: PluginReactNativeArtifactLeasePersistentScope | undefined): boolean {
    return scope ? scope.isCurrent() : true;
}

function readPersistentFile(record: PluginUiPersistentArtifactRecord, relativePath: string): Uint8Array | null {
    const file = record.files?.find((candidate) => candidate.relativePath === relativePath);
    if (file) return new Uint8Array(file.bytes);
    if (record.entryRelativePath === relativePath) return new Uint8Array(record.bytes);
    return null;
}

function createPersistentSource(input: Readonly<{
    scope: PluginReactNativeArtifactLeasePersistentScope;
    identity: PluginReactNativeBundleCacheIdentity;
}>): PluginArtifactSourceCandidate {
    let pending: Promise<PluginUiPersistentArtifactRecord | null> | null = null;
    let persistentIdentityKey = '';
    let loadedIdentity: PluginUiPersistentArtifactIdentity | null = null;
    let loadedRecord: PluginUiPersistentArtifactRecord | null = null;
    return Object.freeze({
        kind: 'persistentCache',
        readFile: async ({ artifact, relativePath }) => {
            if (!persistentScopeIsCurrent(input.scope)) return null;
            if (!artifactMatchesCacheIdentity({ artifact, identity: input.identity })) return null;
            const persistentIdentity = persistentIdentityFor({ scope: input.scope.scope, artifact });
            const currentKey = [
                persistentIdentity.releaseVersion,
                persistentIdentity.pluginId,
                persistentIdentity.contributionId,
                persistentIdentity.tier,
                persistentIdentity.platform,
                persistentIdentity.artifactDigest,
            ].join('\u0000');
            if (currentKey !== persistentIdentityKey) {
                persistentIdentityKey = currentKey;
                loadedIdentity = persistentIdentity;
                loadedRecord = null;
                pending = input.scope.store.read(persistentIdentity)
                    .then((record) => {
                        loadedRecord = record;
                        return record;
                    })
                    .catch(() => null);
            }
            const record = await pending;
            if (!record || !persistentScopeIsCurrent(input.scope)) return null;
            return readPersistentFile(record, relativePath);
        },
        discardInvalid: async () => {
            if (!persistentScopeIsCurrent(input.scope) || !loadedIdentity || !loadedRecord) return;
            const identity = loadedIdentity;
            loadedRecord = null;
            pending = Promise.resolve(null);
            await input.scope.store.remove(identity);
        },
        discardRevoked: async () => {
            // An Availability withdrawal/replacement is only allowed to remove
            // the exact identity this source read. Account retirement owns
            // whole-account cleanup separately.
            if (!persistentScopeIsCurrent(input.scope) || !loadedIdentity) return;
            const identity = loadedIdentity;
            loadedIdentity = null;
            loadedRecord = null;
            pending = Promise.resolve(null);
            await input.scope.store.remove(identity);
        },
    });
}

function exactDaemonOriginIsCurrent(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    origin: PluginMachineExecutionOriginV1;
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: PluginReactNativeBundleCacheIdentity;
}>): boolean {
    if (!artifactMatchesCacheIdentity({ artifact: input.artifact, identity: input.identity })) return false;
    if (input.origin.materializationRef.pluginId !== input.artifact.pluginId) return false;
    const admission = input.reader.readMaterializations();
    if (admission.kind !== 'available') return false;
    const matching = admission.materializations.filter((materialization) => (
        isPluginMachineMaterializationOnServerIdentityV1(materialization, input.origin.serverIdentityId)
        && isExactPluginMachineMaterializationRefV1(materialization, input.origin.materializationRef)
    ));
    if (matching.length !== 1) return false;
    const materialization = matching[0]!;
    if (
        !materialization.portableRelease
        || !materialization.enabled
        || materialization.trustState !== 'trusted'
        || materialization.version !== input.artifact.releaseVersion
    ) {
        return false;
    }
    const release = input.reader.classifyRelease(materialization);
    if (
        release.serverIdentityId !== input.origin.serverIdentityId
        || release.materializationRef.machineId !== input.origin.materializationRef.machineId
        || release.materializationRef.materializationId !== input.origin.materializationRef.materializationId
        || release.materializationRef.pluginId !== input.origin.materializationRef.pluginId
        || release.releaseContent !== 'matched'
        || release.validation.kind !== 'admitted'
    ) {
        return false;
    }
    return materialization.uiArtifacts.some((slot) => (
        slot.contributionId === input.artifact.contributionId
        && slot.tier === input.artifact.tier
        && slot.platform === input.artifact.platform
        && slot.artifactDigest === input.artifact.digest
    ));
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

function wrapLeaseCurrentness(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    reader: PluginAccountAvailabilityReader;
    isAdditionalCurrent: () => boolean;
}>): PluginSelectedArtifactLease {
    const revokeListeners = new Set<() => void>();
    let revoked = false;
    let disposed = false;
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        for (const listener of revokeListeners) {
            try {
                listener();
            } catch {
                // A failed listener must not hide revocation from the rest.
            }
        }
        revokeListeners.clear();
    };
    const isCurrent = () => {
        if (revoked || !input.lease.isCurrent() || !input.isAdditionalCurrent()) {
            revoke();
            return false;
        }
        return true;
    };
    const accountSubscription = input.reader.subscribe(isCurrent);
    const leaseSubscription = input.lease.onRevoke(revoke);
    return Object.freeze({
        ...input.lease,
        isCurrent,
        readFile: async (relativePath) => {
            if (!isCurrent()) return Object.freeze({ kind: 'unavailable' as const, code: 'artifact_lease_revoked' as const });
            const result = await input.lease.readFile(relativePath);
            return isCurrent()
                ? result
                : Object.freeze({ kind: 'unavailable' as const, code: 'artifact_lease_revoked' as const });
        },
        onRevoke: (listener) => {
            if (revoked) {
                listener();
                return Object.freeze({ dispose: () => {} });
            }
            revokeListeners.add(listener);
            return Object.freeze({ dispose: () => revokeListeners.delete(listener) });
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            accountSubscription();
            leaseSubscription.dispose();
            input.lease.dispose();
            revoke();
        },
    });
}

async function persistVerifiedLease(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    persistent: PluginReactNativeArtifactLeasePersistentScope;
}>): Promise<void> {
    if (!persistentScopeIsCurrent(input.persistent) || !input.lease.isCurrent()) return;
    const files: PluginUiPersistentArtifactFile[] = [];
    for (const declared of input.lease.files) {
        const result = await input.lease.readFile(declared.relativePath);
        if (result.kind !== 'available' || !persistentScopeIsCurrent(input.persistent) || !input.lease.isCurrent()) {
            return;
        }
        files.push(Object.freeze({
            relativePath: result.file.relativePath,
            digest: result.file.digest,
            byteSize: result.file.byteSize,
            bytes: new Uint8Array(result.bytes),
        }));
    }
    const entry = files.find((file) => file.relativePath === input.lease.artifactGraph.entry);
    if (!entry || !persistentScopeIsCurrent(input.persistent) || !input.lease.isCurrent()) return;
    const persistentIdentity = persistentIdentityFor({
        scope: input.persistent.scope,
        artifact: input.lease.artifact,
    });
    const record: PluginUiPersistentArtifactRecord = Object.freeze({
        persistentIdentity,
        bytes: new Uint8Array(entry.bytes),
        entryRelativePath: input.lease.artifactGraph.entry,
        files: Object.freeze(files),
    });
    try {
        await input.persistent.store.write(record);
    } catch {
        // Cache loss must not discard a previously verified in-memory lease.
        return;
    }
    if (!persistentScopeIsCurrent(input.persistent) || !input.lease.isCurrent()) {
        await input.persistent.store.remove(persistentIdentity).catch(() => undefined);
    }
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
        files.push(Object.freeze({
            relativePath: read.file.relativePath,
            digest: read.file.digest,
            byteSize: read.file.byteSize,
            bytes: new Uint8Array(read.bytes),
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
        bytes: new Uint8Array(entry.bytes),
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
    const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
    const sources: PluginArtifactSourceCandidate[] = [];
    if (input.appExact) sources.push(input.appExact);
    if (input.persistent && persistentScopeIsCurrent(input.persistent)) {
        sources.push(createPersistentSource({ scope: input.persistent, identity: input.cacheIdentity }));
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
        }),
        artifactGraph: input.artifactGraph,
        sources,
    });
    if (acquired.kind !== 'available') return acquired;
    if (!artifactMatchesCacheIdentity({ artifact: acquired.lease.artifact, identity: input.cacheIdentity })) {
        acquired.lease.dispose();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }

    const requiresExactDaemonCurrentness = acquired.lease.sourceKind === 'daemon' && input.daemon !== undefined;
    const requiresPersistentCurrentness = input.persistent !== undefined;
    const lease = wrapLeaseCurrentness({
        lease: acquired.lease,
        reader: input.reader,
        isAdditionalCurrent: () => (
            input.accountLifetime.isCurrent()
            && (!requiresPersistentCurrentness || persistentScopeIsCurrent(input.persistent))
            && (!requiresExactDaemonCurrentness || exactDaemonOriginIsCurrent({
                reader: input.reader,
                origin: input.daemon!.origin,
                artifact: acquired.lease.artifact,
                identity: input.cacheIdentity,
            }))
        ),
    });
    if (!lease.isCurrent()) {
        lease.dispose();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (input.persistent && (lease.sourceKind === 'daemon' || lease.sourceKind === 'accountHosted')) {
        await persistVerifiedLease({ lease, persistent: input.persistent });
    }
    return Object.freeze({ kind: 'available', lease });
}
