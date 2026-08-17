import {
    DaemonPluginHostedWebArtifactCacheIdentityV1Schema,
    isExactPluginMachineMaterializationRefV1,
    isPluginMachineMaterializationOnServerIdentityV1,
    type DaemonPluginHostedWebArtifactCacheIdentityV1,
    type DaemonPluginUiArtifactBytesReadResponse,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    type HostedWebAssetPolicyInput,
} from '@happier-dev/protocol/plugins/ui';

import { decodeBase64 } from '@/encryption/base64';
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
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginUiPersistentArtifactIdentity,
    PluginUiPersistentArtifactFile,
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';

import type {
    PluginArtifactSourceCandidate,
    PluginSelectedArtifactLease,
    PluginSelectedArtifactLeaseAcquireResult,
} from './artifactLease';
import { acquirePluginSelectedArtifactLease } from './artifactLease';
import type {
    PluginNativeArtifactResourceAcquireResult,
    PluginNativeArtifactResourceHandle,
    PluginNativeArtifactPersistentStore,
} from './nativeArtifactResource';
import type { PluginAccountAvailabilityReader } from './reader';
import { fetchHostedWebExactArtifactBytesViaMachineRpc } from './hostedWebArtifactDaemonTransport';
import { createBundledPluginUiAppExactArtifactSource } from './bundledAppExactArtifactSource';

export type PluginHostedWebExactArtifactByteFetcher = (input: Readonly<{
    origin: PluginMachineExecutionOriginV1;
    serverId: string;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
}>) => Promise<DaemonPluginUiArtifactBytesReadResponse>;

export type PluginHostedWebArtifactLeasePersistentScope = Readonly<{
    scope: ServerAccountScope;
    store: PluginUiPersistentArtifactStore;
    /** The active Account-realm lifetime owner; required for cache use. */
    isCurrent: () => boolean;
    /**
     * Cache-owner exact-entry cleanup for every persistent invalidation. This
     * preserves per-key delete/read/write ordering, Account quarantine, and
     * native-resource invalidation even after acquisition has drained.
     */
    removePersistentArtifact: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
}>;

/**
 * Artifact-owned input for one renderer's already-admitted hosted-web slot.
 * The renderer supplies only its technical renderer identity and an exact
 * Administration-stamped origin; this owner decides whether either may become
 * a candidate in the canonical Artifact source order.
 */
export type PluginHostedWebArtifactLeaseInput = Readonly<{
    reader: PluginAccountAvailabilityReader;
    artifactGraph: unknown;
    cacheIdentity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    persistent?: PluginHostedWebArtifactLeasePersistentScope;
    daemon?: Readonly<{
        origin: PluginMachineExecutionOriginV1;
        /** Active server route; absent routes do not fall back to a default server. */
        serverId: string;
        /** Artifact transport boundary supplied by the hosted-web platform adapter. */
        fetchArtifactBytes: PluginHostedWebExactArtifactByteFetcher;
    }>;
    appExact?: PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }>;
    accountHosted?: PluginArtifactSourceCandidate & Readonly<{ kind: 'accountHosted' }>;
}>;

function cacheIdentityMatches(
    left: DaemonPluginHostedWebArtifactCacheIdentityV1,
    right: DaemonPluginHostedWebArtifactCacheIdentityV1,
): boolean {
    return left.pluginId === right.pluginId
        && left.contributionId === right.contributionId
        && left.artifactDigest === right.artifactDigest
        && left.platform === right.platform
        && left.projectionGeneration === right.projectionGeneration;
}

function artifactMatchesCacheIdentity(input: Readonly<{
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
}>): boolean {
    return input.artifact.pluginId === input.identity.pluginId
        && input.artifact.tier === 'hostedWeb'
        && input.artifact.platform === 'web'
        && input.artifact.digest === input.identity.artifactDigest;
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

function persistentScopeIsCurrent(scope: PluginHostedWebArtifactLeasePersistentScope | undefined): boolean {
    return scope ? scope.isCurrent() : true;
}

function readPersistentFile(record: PluginUiPersistentArtifactRecord, relativePath: string): Uint8Array | null {
    const file = record.files?.find((candidate) => candidate.relativePath === relativePath);
    if (file) return new Uint8Array(file.bytes);
    if (record.entryRelativePath === relativePath) return new Uint8Array(record.bytes);
    return null;
}

function createPersistentSource(input: Readonly<{
    scope: PluginHostedWebArtifactLeasePersistentScope;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
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
            loadedIdentity = null;
            loadedRecord = null;
            pending = Promise.resolve(null);
            await input.scope.removePersistentArtifact(identity);
        },
        discardRevoked: async () => {
            // Availability withdrawal/replacement revokes only the exact
            // admitted persistent identity. Clear this source's lookup before
            // awaiting physical cleanup so a failed delete stays outside its
            // cache-adoption path while the incumbent cache owner quarantines
            // and retries storage cleanup.
            if (!loadedIdentity) return;
            const identity = loadedIdentity;
            loadedIdentity = null;
            loadedRecord = null;
            pending = Promise.resolve(null);
            // The source operation is intentionally released after admission;
            // a later Availability revocation re-enters the one cache owner
            // rather than treating the drained source-operation store as a
            // second deletion authority.
            await input.scope.removePersistentArtifact(identity);
        },
    });
}

function exactDaemonOriginIsCurrent(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    origin: PluginMachineExecutionOriginV1;
    artifact: PluginSelectedArtifactLease['artifact'];
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
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

function decodeDaemonFileSet(input: Readonly<{
    response: DaemonPluginUiArtifactBytesReadResponse;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    entryRelativePath: string;
}>): ReadonlyMap<string, Uint8Array> | null {
    const { response } = input;
    if (
        !response.ok
        || response.artifactFamily !== 'hostedWeb'
        || response.artifact.artifactKind !== 'hostedWebAsset'
    ) {
        return null;
    }
    const parsedIdentity = DaemonPluginHostedWebArtifactCacheIdentityV1Schema.safeParse(response.cacheIdentity);
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
        let bytes: Uint8Array;
        try {
            bytes = decodeBase64(file.bytesBase64, 'base64');
        } catch {
            return null;
        }
        if (bytes.byteLength !== file.byteSize) return null;
        files.set(file.relativePath, bytes);
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

function createDaemonSource(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    origin: PluginMachineExecutionOriginV1;
    serverId: string;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    entryRelativePath: string;
    fetchArtifactBytes: PluginHostedWebExactArtifactByteFetcher;
}>): PluginArtifactSourceCandidate {
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
                }).then((response) => decodeDaemonFileSet({
                    response,
                    identity: input.identity,
                    entryRelativePath: input.entryRelativePath,
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
    persistent: PluginHostedWebArtifactLeasePersistentScope;
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
        await input.persistent.removePersistentArtifact(persistentIdentity).catch(() => undefined);
    }
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
        }));
    }
    if (input.accountHosted) sources.push(input.accountHosted);

    const acquired = await acquirePluginSelectedArtifactLease({
        reader: input.reader,
        slot: Object.freeze({
            pluginId: input.cacheIdentity.pluginId,
            // The renderer identity is not necessarily the generated Account
            // slot contribution. The signed graph names that Artifact slot.
            contributionId: graph.success
                ? graph.data.contributionId
                : input.cacheIdentity.contributionId,
            tier: 'hostedWeb',
            platform: 'web',
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
    const lease = requiresExactDaemonCurrentness || requiresPersistentCurrentness
        ? wrapLeaseCurrentness({
            lease: acquired.lease,
            reader: input.reader,
            isAdditionalCurrent: () => (
                (!requiresPersistentCurrentness || persistentScopeIsCurrent(input.persistent))
                && (!requiresExactDaemonCurrentness || exactDaemonOriginIsCurrent({
                    reader: input.reader,
                    origin: input.daemon!.origin,
                    artifact: acquired.lease.artifact,
                    identity: input.cacheIdentity,
                }))
            ),
        })
        : acquired.lease;
    if (!lease.isCurrent()) {
        lease.dispose();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (input.persistent && (lease.sourceKind === 'daemon' || lease.sourceKind === 'accountHosted')) {
        await persistVerifiedLease({ lease, persistent: input.persistent });
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
    'persistent' | 'daemon' | 'appExact' | 'accountHosted'
> & Readonly<{
    /** Exact Administration-stamped daemon route, never a loose machine fallback. */
    daemon?: Readonly<{
        origin: PluginMachineExecutionOriginV1;
        serverId: string;
    }>;
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
                    ...(input.daemon
                        ? {
                            daemon: {
                                origin: input.daemon.origin,
                                serverId: input.daemon.serverId,
                                fetchArtifactBytes: fetchHostedWebExactArtifactBytesViaMachineRpc,
                            },
                        }
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
});

/** Production host entry point; consumer code receives only its typed result. */
export function acquirePluginHostedWebArtifactAvailability(
    input: PluginHostedWebArtifactAvailabilityInput,
): Promise<PluginHostedWebArtifactAvailability> {
    return installedHostedWebArtifactAvailabilityProducer.acquire(input);
}
