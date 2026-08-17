import {
    PluginUiArtifactsManifestEntryV1Schema,
    verifyPluginUiArtifactBytesIntegrityV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginAccountAvailabilityArtifactAdmission,
    PluginAccountAvailabilityArtifactFact,
    PluginAccountAvailabilityArtifactSlot,
    PluginAccountAvailabilityReader,
} from './reader';

export type PluginArtifactSourceKind =
    | 'appExact'
    | 'persistentCache'
    | 'daemon'
    | 'accountHosted';

export type PluginSelectedArtifactIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
    digest: PluginUiArtifactDigestV1;
    releaseVersion: string;
    availabilityCursor: number;
}>;

/**
 * Source-local provenance carried beside the selected immutable Artifact
 * identity. Account hosting consumes this only to address its current link;
 * it must not affect selected-byte identity, lease currentness, or cache
 * custody.
 */
export type PluginArtifactSourceReadInput = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    relativePath: string;
    accountHostedArtifactId?: string;
}>;

/**
 * A concrete source adapter receives the current immutable Artifact identity,
 * one declared file path, and only Account-hosted source provenance when that
 * specific adapter needs it. It owns transport details privately; no renderer
 * receives a daemon RPC shape, URL, cache key, or source choice.
 */
export type PluginArtifactSourceCandidate = Readonly<{
    kind: PluginArtifactSourceKind;
    readFile: (input: PluginArtifactSourceReadInput) => Promise<Uint8Array | null>;
    /**
     * Persistent byte custody can atomically remove one verified-entry key
     * when the lease proves that its complete declared file graph is invalid.
     */
    discardInvalid?: () => Promise<void>;
    /**
     * Persistent byte custody can atomically remove the exact entry that this
     * lease had admitted when Availability later withdraws or replaces it.
     * This is never called for ordinary consumer disposal.
     */
    discardRevoked?: () => Promise<void>;
}>;

export type PluginSelectedArtifactLeaseFileResult =
    | Readonly<{
        kind: 'available';
        file: PluginUiArtifactFileV1;
        bytes: Uint8Array;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'artifact_file_not_declared' | 'artifact_lease_revoked';
    }>;

export type PluginSelectedArtifactLease = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    /** The one fully verified source that supplied this private handle. */
    sourceKind: PluginArtifactSourceKind;
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    files: readonly PluginUiArtifactFileV1[];
    readFile: (relativePath: string) => Promise<PluginSelectedArtifactLeaseFileResult>;
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
    dispose: () => void;
}>;

export type PluginSelectedArtifactLeaseAcquireResult =
    | Readonly<{ kind: 'available'; lease: PluginSelectedArtifactLease }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | Extract<PluginAccountAvailabilityArtifactAdmission, { kind: 'unavailable' }>['code']
            | 'artifact_graph_invalid'
            | 'artifact_graph_mismatch'
            | 'artifact_source_ambiguous'
            | 'artifact_source_integrity_invalid'
            | 'artifact_source_unavailable'
            | 'artifact_lease_revoked';
    }>;

const SOURCE_RANK: Readonly<Record<PluginArtifactSourceKind, number>> = Object.freeze({
    persistentCache: 0,
    appExact: 1,
    daemon: 2,
    accountHosted: 3,
});

function cloneArtifactFact(
    fact: PluginAccountAvailabilityArtifactFact,
    availabilityCursor: number,
): PluginSelectedArtifactIdentity {
    return Object.freeze({
        pluginId: fact.pluginId,
        contributionId: fact.contributionId,
        tier: fact.tier,
        platform: fact.platform,
        digest: fact.digest,
        releaseVersion: fact.releaseVersion,
        availabilityCursor,
    });
}

function sameArtifactIdentity(
    left: PluginSelectedArtifactIdentity,
    right: PluginAccountAvailabilityArtifactAdmission,
): boolean {
    return right.kind === 'available'
        && left.pluginId === right.artifact.pluginId
        && left.contributionId === right.artifact.contributionId
        && left.tier === right.artifact.tier
        && left.platform === right.artifact.platform
        && left.digest === right.artifact.digest
        && left.releaseVersion === right.artifact.releaseVersion;
}

function isGraphCompatible(
    graph: PluginUiArtifactsManifestEntryV1,
    artifact: PluginSelectedArtifactIdentity,
): boolean {
    return graph.contributionId === artifact.contributionId
        && graph.tier === artifact.tier
        && (graph.platform === undefined || graph.platform === artifact.platform)
        && graph.digest === artifact.digest;
}

function artifactKindFor(tier: PluginSelectedArtifactIdentity['tier']): string {
    return tier === 'reactNative' ? 'reactNativeBundle' : 'hostedWebAsset';
}

function orderedSources(
    sources: readonly PluginArtifactSourceCandidate[],
): readonly PluginArtifactSourceCandidate[] | null {
    const byKind = new Map<PluginArtifactSourceKind, PluginArtifactSourceCandidate>();
    for (const source of sources) {
        if (byKind.has(source.kind)) return null;
        byKind.set(source.kind, source);
    }
    return Object.freeze([...byKind.values()].sort((left, right) => (
        SOURCE_RANK[left.kind] - SOURCE_RANK[right.kind]
    )));
}

function cloneFile(file: PluginUiArtifactFileV1): PluginUiArtifactFileV1 {
    return Object.freeze({ ...file });
}

/**
 * Resolves one current Artifact through the only permitted source order, fully
 * verifies its declared file graph, and returns a revocable private lease. The
 * returned lease has no transport/cache/source authority; renderer consumers
 * can only read declared already-verified bytes while it remains current.
 */
export async function acquirePluginSelectedArtifactLease(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    slot: PluginAccountAvailabilityArtifactSlot;
    artifactGraph: unknown;
    sources: readonly PluginArtifactSourceCandidate[];
}>): Promise<PluginSelectedArtifactLeaseAcquireResult> {
    const admission = input.reader.readCurrentArtifact(input.slot);
    if (admission.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: admission.code });
    }
    const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
    if (!graph.success) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_invalid' });
    }
    const artifact = cloneArtifactFact(admission.artifact, admission.availabilityCursor);
    if (!isGraphCompatible(graph.data, artifact)) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }
    const sources = orderedSources(input.sources);
    if (!sources) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_source_ambiguous' });
    }
    if (sources.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_source_unavailable' });
    }

    const revokeListeners = new Set<() => void>();
    let unsubscribe: (() => void) | null = null;
    let revoked = false;
    let discardedRevokedPersistentSource = false;
    const discardRevokedPersistentArtifact = () => {
        if (discardedRevokedPersistentSource) return;
        discardedRevokedPersistentSource = true;
        for (const source of sources) {
            if (source.kind !== 'persistentCache') continue;
            // Cache cleanup is best effort, but a failure must never leave the
            // revoked lease current or prevent other subscribers from seeing it.
            const discardRevoked = source.discardRevoked;
            if (discardRevoked) {
                void discardRevoked().catch(() => undefined);
            }
        }
    };
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        unsubscribe?.();
        unsubscribe = null;
        for (const listener of revokeListeners) {
            try {
                listener();
            } catch {
                // Every subscriber must get an independent revocation signal.
            }
        }
        revokeListeners.clear();
    };
    const isCurrent = () => {
        if (revoked) return false;
        if (!sameArtifactIdentity(artifact, input.reader.readCurrentArtifact(input.slot))) {
            discardRevokedPersistentArtifact();
            revoke();
            return false;
        }
        return true;
    };
    unsubscribe = input.reader.subscribe(() => {
        isCurrent();
    });

    let sawIntegrityFailure = false;
    for (const source of sources) {
        const materialized: Array<Readonly<{ file: PluginUiArtifactFileV1; bytes: Uint8Array }>> = [];
        let sourceUsable = true;
        for (const declared of graph.data.files) {
            if (!isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            let bytes: Uint8Array | null;
            try {
                bytes = await source.readFile({
                    artifact,
                    relativePath: declared.relativePath,
                    ...(source.kind === 'accountHosted' && admission.artifact.accountArtifactId
                        ? { accountHostedArtifactId: admission.artifact.accountArtifactId }
                        : {}),
                });
            } catch {
                bytes = null;
            }
            if (!isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            if (!bytes) {
                sourceUsable = false;
                break;
            }
            if (bytes.byteLength !== declared.byteSize) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            const integrity = verifyPluginUiArtifactBytesIntegrityV1({
                bytes,
                integrity: {
                    digest: declared.digest,
                    pluginId: artifact.pluginId,
                    contributionId: artifact.contributionId,
                    artifactKind: artifactKindFor(artifact.tier),
                },
            });
            if (!integrity.ok) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            materialized.push(Object.freeze({ file: cloneFile(declared), bytes: new Uint8Array(bytes) }));
        }
        if (!sourceUsable) {
            if (source.kind === 'persistentCache') {
                const discardInvalid = source.discardInvalid;
                if (discardInvalid) {
                    await discardInvalid().catch(() => undefined);
                }
            }
            continue;
        }
        const setIntegrity = verifyPluginUiArtifactFileSetIntegrityV1({
            files: materialized.map(({ file, bytes }) => ({ relativePath: file.relativePath, bytes })),
            integrity: {
                digest: artifact.digest,
                pluginId: artifact.pluginId,
                contributionId: artifact.contributionId,
                artifactKind: artifactKindFor(artifact.tier),
            },
        });
        if (!setIntegrity.ok) {
            sawIntegrityFailure = true;
            if (source.kind === 'persistentCache') {
                const discardInvalid = source.discardInvalid;
                if (discardInvalid) {
                    await discardInvalid().catch(() => undefined);
                }
            }
            continue;
        }
        const files = new Map(materialized.map(({ file, bytes }) => [file.relativePath, { file, bytes }] as const));
        const readFile = async (relativePath: string): Promise<PluginSelectedArtifactLeaseFileResult> => {
            if (!isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
            }
            const record = files.get(relativePath);
            if (!record) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_file_not_declared' });
            }
            return Object.freeze({
                kind: 'available',
                file: record.file,
                bytes: new Uint8Array(record.bytes),
            });
        };
        return Object.freeze({
            kind: 'available',
            lease: Object.freeze({
                artifact,
                sourceKind: source.kind,
                artifactGraph: graph.data,
                files: Object.freeze(graph.data.files.map(cloneFile)),
                readFile,
                isCurrent,
                onRevoke: (listener: () => void) => {
                    if (revoked) {
                        listener();
                        return Object.freeze({ dispose: () => {} });
                    }
                    revokeListeners.add(listener);
                    return Object.freeze({
                        dispose: () => {
                            revokeListeners.delete(listener);
                        },
                    });
                },
                dispose: revoke,
            }),
        });
    }

    unsubscribe?.();
    unsubscribe = null;
    return Object.freeze({
        kind: 'unavailable',
        code: sawIntegrityFailure ? 'artifact_source_integrity_invalid' : 'artifact_source_unavailable',
    });
}
