import {
    PluginPortableReleaseManifestV1Schema,
    normalizePluginAccountCollectionContractsV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    derivePluginUiNativeCapabilitiesDigestV1,
    verifyPluginUiArtifactBytesIntegrityV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    type PluginAccountPluginUiArtifactLinkV1,
    type PluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    type PluginAccountCollectionMigrationRuntimeProjection,
} from '@happier-dev/plugin-sdk';

import {
    createPluginReactNativeArtifactLeaseCacheSink,
    getInstalledPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    loadPluginReactNativeBundleExport,
    type PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import {
    createActivePluginAccountHostedArtifactReader,
    createActivePluginAccountHostedArtifactSourceCandidate,
    createActivePluginAccountHostedArtifactTargetSourceCandidate,
    type ActivePluginAccountHostedArtifactReader,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import type {
    PluginArtifactSourceCandidate,
    PluginSelectedArtifactIdentity,
    PluginSelectedArtifactLease,
} from './artifactLease';
import {
    decodePluginReactNativeExactArtifactFileSet,
    materializePluginReactNativeArtifactLeaseInCache,
    type PluginReactNativeArtifactLeaseCacheSink,
    type PluginReactNativeExactArtifactByteFetcher,
} from './reactNativeArtifactLease';

/** Immutable target facts selected before any candidate code is loaded. */
export type CandidatePluginCollectionMigrationArtifactTarget = Readonly<{
    release: Readonly<{
        pluginId: string;
        version: string;
    }>;
    artifact: Readonly<{
        contributionId: string;
        platform: 'web' | 'ios' | 'android';
        digest: PluginUiArtifactDigestV1;
    }>;
    /** Candidate identity is explicit; it must not be inferred from Account intent. */
    availabilityCursor: number;
}>;

export type CandidatePluginCollectionMigrationArtifactLoadInput = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** Release/controller currentness supplied by the candidate-selection owner. */
    isCurrent: () => boolean;
    target: CandidatePluginCollectionMigrationArtifactTarget;
    /** Exact signed target graph, never a current Account-hosted graph. */
    artifactGraph: unknown;
    /** Dedicated target-bundle cache identity; it cannot name the incumbent renderer. */
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    appExact?: PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }>;
    daemon?: Readonly<{
        origin: PluginMachineExecutionOriginV1;
        serverId: string;
        fetchArtifactBytes: PluginReactNativeExactArtifactByteFetcher;
    }>;
    /**
     * An explicitly selected prospective Account-hosted Artifact link. This
     * never falls back to the current intent's artifact link.
     */
    accountHosted?:
        | Readonly<{
            /** A previously qualified exact prospective Artifact link. */
            kind: 'linked';
            artifactId: string;
            reader?: ActivePluginAccountHostedArtifactReader;
        }>
        | Readonly<{
            /** Resolve this target's exact release slot lazily after the CAS refusal. */
            kind: 'target';
            reader?: ActivePluginAccountHostedArtifactReader;
        }>;
}>;

export type CandidatePluginCollectionMigrationArtifactAccountHostedTargetResult =
    | Readonly<{
        kind: 'available';
        /** Exact source facts for the existing candidate Artifact loader. */
        candidateTarget: CandidatePluginCollectionMigrationArtifactTarget;
        artifact: Omit<
            CandidatePluginCollectionMigrationArtifactLoadInput,
            'accountLifetime' | 'isCurrent' | 'target'
        >;
    }>
    | Readonly<{ kind: 'unavailable' }>;

export type CandidatePluginCollectionMigrationArtifact = Readonly<{
    release: Readonly<{
        ref: Readonly<{ pluginId: string; version: string }>;
        normalizedManifest: ReturnType<typeof PluginPortableReleaseManifestV1Schema.parse>;
    }>;
    collectionContracts: readonly NormalizedPluginAccountCollectionContractV1[];
    collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
    isCurrent: () => boolean;
    dispose: () => void;
}>;

export type CandidatePluginCollectionMigrationArtifactLoadResult =
    | Readonly<{ kind: 'available'; candidate: CandidatePluginCollectionMigrationArtifact }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'candidate_artifact_invalid'
            | 'candidate_currentness_changed'
            | 'candidate_source_unavailable'
            | 'candidate_source_integrity_invalid'
            | 'candidate_module_unavailable'
            | 'candidate_module_invalid';
    }>;

export type CandidatePluginCollectionMigrationArtifactLoaderDependencies = Readonly<{
    getCache: () => PluginReactNativeBundleCache;
    createCacheSink: (lifetime: ActiveServerAccountScopeLifetime) => PluginReactNativeArtifactLeaseCacheSink;
    loadBundleExport: typeof loadPluginReactNativeBundleExport;
    createAccountHostedSource: typeof createActivePluginAccountHostedArtifactSourceCandidate;
    createAccountHostedTargetSource: typeof createActivePluginAccountHostedArtifactTargetSourceCandidate;
    loaderBackend?: PluginReactNativeLoaderBackend;
    hostPlatform?: string;
}>;

function defaultDependencies(): CandidatePluginCollectionMigrationArtifactLoaderDependencies {
    return {
        getCache: getInstalledPluginReactNativeBundleCache,
        createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({
            cache: getInstalledPluginReactNativeBundleCache(),
            lifetime,
        }),
        loadBundleExport: loadPluginReactNativeBundleExport,
        createAccountHostedSource: createActivePluginAccountHostedArtifactSourceCandidate,
        createAccountHostedTargetSource: createActivePluginAccountHostedArtifactTargetSourceCandidate,
    };
}

function unavailable(
    code: Extract<CandidatePluginCollectionMigrationArtifactLoadResult, { kind: 'unavailable' }>['code'],
): CandidatePluginCollectionMigrationArtifactLoadResult {
    return Object.freeze({ kind: 'unavailable', code });
}

function callCurrent(input: CandidatePluginCollectionMigrationArtifactLoadInput): boolean {
    try {
        return input.accountLifetime.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

function isCollectionMigrationArtifactPlatform(
    value: unknown,
): value is CandidatePluginCollectionMigrationArtifactTarget['artifact']['platform'] {
    return value === 'web' || value === 'ios' || value === 'android';
}

function matchesTargetGraph(input: Readonly<{
    graph: PluginUiArtifactsManifestEntryV1;
    target: CandidatePluginCollectionMigrationArtifactTarget;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
}>): boolean {
    return input.graph.tier === 'reactNative'
        && input.graph.contributionId === input.target.artifact.contributionId
        && input.graph.platform === input.target.artifact.platform
        && input.graph.digest === input.target.artifact.digest
        && input.graph.collectionMigrations !== undefined
        && input.cacheIdentity.pluginId === input.target.release.pluginId
        && input.cacheIdentity.contributionId === input.target.artifact.contributionId
        && input.cacheIdentity.artifactDigest === input.target.artifact.digest
        && input.cacheIdentity.platform === input.target.artifact.platform;
}

function matchesAccountHostedTargetGraph(input: Readonly<{
    facts: PluginReleaseFactsV1;
    graph: PluginUiArtifactsManifestEntryV1;
    link: PluginAccountPluginUiArtifactLinkV1;
}>): boolean {
    const { graph, link } = input;
    const slot = input.facts.uiSlots.find((candidate) => (
        candidate.contributionId === graph.contributionId
        && candidate.tier === graph.tier
        && candidate.platform === graph.platform
        && candidate.artifactDigest === graph.digest
    ));
    return link.release.pluginId === input.facts.ref.pluginId
        && link.release.version === input.facts.ref.version
        && graph.tier === 'reactNative'
        && graph.collectionMigrations !== undefined
        && graph.contributionId === link.contributionId
        && graph.tier === link.tier
        && graph.platform === link.platform
        && graph.digest === link.artifactDigest
        && graph.hostUiApiVersion === link.compatibility.hostUiApiVersion
        && graph.compat.react === link.compatibility.reactVersion
        && graph.compat.reactNative === link.compatibility.reactNativeVersion
        && (graph.compat.expoRuntime ?? '') === (link.compatibility.expoRuntimeVersion ?? '')
        && (graph.compat.hermes ?? '') === (link.compatibility.hermesVersion ?? '')
        && slot !== undefined
        && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(slot, link.compatibility);
}

/**
 * Resolves one Account-hosted prospective target lazily from exact Availability
 * facts. The Account read supplies the authoritative link and archive graph;
 * its cursor scopes only the UI cache entry, never a daemon generation.
 */
export async function resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
    availabilityCursor: number;
    facts: PluginReleaseFactsV1;
    reader?: ActivePluginAccountHostedArtifactReader;
}>): Promise<CandidatePluginCollectionMigrationArtifactAccountHostedTargetResult> {
    const isCurrent = () => {
        try {
            return input.accountLifetime.isCurrent() && input.isCurrent();
        } catch {
            return false;
        }
    };
    if (!isCurrent()) return Object.freeze({ kind: 'unavailable' as const });
    const reader = input.reader ?? createActivePluginAccountHostedArtifactReader();
    const candidates: Array<Extract<
        CandidatePluginCollectionMigrationArtifactAccountHostedTargetResult,
        { kind: 'available' }
    >> = [];
    for (const slot of input.facts.uiSlots) {
        if (slot.tier !== 'reactNative') continue;
        const result = await reader.readTarget({
            accountLifetime: input.accountLifetime,
            release: input.facts.ref,
            slot: {
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
            },
            expectedArtifactDigest: slot.artifactDigest,
        });
        if (!isCurrent()) return Object.freeze({ kind: 'unavailable' as const });
        if (result.kind !== 'available') continue;
        const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(result.value.archive.artifactGraph);
        const compatibility = result.value.link.compatibility;
        if (
            !graph.success
            || !isCollectionMigrationArtifactPlatform(graph.data.platform)
            || !compatibility.reactVersion
            || !compatibility.reactNativeVersion
            || !matchesAccountHostedTargetGraph({
                facts: input.facts,
                graph: graph.data,
                link: result.value.link,
            })
        ) {
            continue;
        }
        candidates.push(Object.freeze({
            kind: 'available' as const,
            candidateTarget: Object.freeze({
                release: input.facts.ref,
                artifact: Object.freeze({
                    contributionId: graph.data.contributionId,
                    platform: graph.data.platform,
                    digest: graph.data.digest,
                }),
                availabilityCursor: input.availabilityCursor,
            }),
            artifact: Object.freeze({
                artifactGraph: graph.data,
                cacheIdentity: Object.freeze({
                    pluginId: input.facts.ref.pluginId,
                    contributionId: graph.data.contributionId,
                    artifactDigest: graph.data.digest,
                    hostAppVersion: compatibility.hostAppVersion,
                    hostUiApiVersion: compatibility.hostUiApiVersion,
                    reactVersion: compatibility.reactVersion,
                    reactNativeVersion: compatibility.reactNativeVersion,
                    ...(compatibility.expoRuntimeVersion
                        ? { expoRuntimeVersion: compatibility.expoRuntimeVersion }
                        : {}),
                    ...(compatibility.hermesVersion
                        ? { hermesVersion: compatibility.hermesVersion }
                        : {}),
                    platform: graph.data.platform,
                    channel: compatibility.channel,
                    nativeCapabilitiesDigest: derivePluginUiNativeCapabilitiesDigestV1(
                        compatibility.nativeCapabilities,
                    ),
                    projectionGeneration: input.availabilityCursor,
                }),
                accountHosted: Object.freeze({ kind: 'target' as const, reader }),
            }),
        }));
    }
    return candidates.length === 1
        ? candidates[0]!
        : Object.freeze({ kind: 'unavailable' as const });
}

function cloneFile(file: PluginUiArtifactFileV1): PluginUiArtifactFileV1 {
    return Object.freeze({ ...file });
}

function createCandidateDaemonSource(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    entryRelativePath: string;
}>): PluginArtifactSourceCandidate | null {
    const daemon = input.candidate.daemon;
    if (!daemon || daemon.origin.materializationRef.pluginId !== input.candidate.target.release.pluginId) {
        return null;
    }
    let pending: Promise<ReadonlyMap<string, Uint8Array> | null> | null = null;
    return Object.freeze({
        kind: 'daemon' as const,
        readFile: async ({ relativePath }) => {
            if (!callCurrent(input.candidate)) return null;
            if (!pending) {
                pending = daemon.fetchArtifactBytes({
                    origin: daemon.origin,
                    serverId: daemon.serverId,
                    identity: input.candidate.cacheIdentity,
                    artifactOwnerKind: 'collectionMigrations',
                }).then((response) => decodePluginReactNativeExactArtifactFileSet({
                    response,
                    identity: input.candidate.cacheIdentity,
                    entryRelativePath: input.entryRelativePath,
                    artifactOwnerKind: 'collectionMigrations',
                })).catch(() => null);
            }
            const files = await pending;
            if (!files || !callCurrent(input.candidate)) return null;
            const bytes = files.get(relativePath);
            return bytes ? new Uint8Array(bytes) : null;
        },
    });
}

function createExactCandidateAccountHostedSource(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    createSource: typeof createActivePluginAccountHostedArtifactSourceCandidate;
    createTargetSource: typeof createActivePluginAccountHostedArtifactTargetSourceCandidate;
}>): PluginArtifactSourceCandidate | null {
    const hosted = input.candidate.accountHosted;
    if (!hosted) return null;
    if (hosted.kind === 'linked' && !hosted.artifactId.trim()) return null;
    const source = hosted.kind === 'linked'
        ? input.createSource({
            accountLifetime: input.candidate.accountLifetime,
            ...(hosted.reader ? { reader: hosted.reader } : {}),
        })
        : input.createTargetSource({
            accountLifetime: input.candidate.accountLifetime,
            ...(hosted.reader ? { reader: hosted.reader } : {}),
        });
    return Object.freeze({
        kind: 'accountHosted' as const,
        readFile: async ({ artifact, relativePath }) => {
            if (!callCurrent(input.candidate)) return null;
            return await source.readFile({
                artifact,
                relativePath,
                ...(hosted.kind === 'linked'
                    ? { accountHostedArtifactId: hosted.artifactId }
                    : {}),
            });
        },
    });
}

type CandidateLease = Readonly<{
    lease: PluginSelectedArtifactLease;
    dispose: () => void;
}>;

function createCandidateLease(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    artifact: PluginSelectedArtifactIdentity;
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    source: PluginArtifactSourceCandidate;
    files: ReadonlyMap<string, Readonly<{ file: PluginUiArtifactFileV1; bytes: Uint8Array }>>;
}>): CandidateLease {
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
                // Candidate cancellation must notify every independent holder.
            }
        }
        revokeListeners.clear();
    };
    const retirement = input.candidate.accountLifetime.onRetire(revoke);
    const isCurrent = () => {
        if (revoked || !callCurrent(input.candidate)) {
            revoke();
            return false;
        }
        return true;
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        retirement.dispose();
        revoke();
    };
    return Object.freeze({
        dispose,
        lease: Object.freeze({
            artifact: input.artifact,
            sourceKind: input.source.kind,
            artifactGraph: input.artifactGraph,
            files: Object.freeze(input.artifactGraph.files.map(cloneFile)),
            readFile: async (relativePath: string) => {
                if (!isCurrent()) {
                    return Object.freeze({ kind: 'unavailable' as const, code: 'artifact_lease_revoked' as const });
                }
                const record = input.files.get(relativePath);
                if (!record) {
                    return Object.freeze({ kind: 'unavailable' as const, code: 'artifact_file_not_declared' as const });
                }
                return Object.freeze({
                    kind: 'available' as const,
                    file: cloneFile(record.file),
                    bytes: new Uint8Array(record.bytes),
                });
            },
            isCurrent,
            onRevoke: (listener: () => void) => {
                if (revoked) {
                    listener();
                    return Object.freeze({ dispose: () => {} });
                }
                revokeListeners.add(listener);
                return Object.freeze({ dispose: () => revokeListeners.delete(listener) });
            },
            dispose,
        }),
    });
}

async function materializeExactCandidateSource(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    artifact: PluginSelectedArtifactIdentity;
    graph: PluginUiArtifactsManifestEntryV1;
    sources: readonly PluginArtifactSourceCandidate[];
}>): Promise<
    | Readonly<{ kind: 'available'; candidateLease: CandidateLease }>
    | Readonly<{ kind: 'unavailable'; code: 'candidate_currentness_changed' | 'candidate_source_unavailable' | 'candidate_source_integrity_invalid' }>
> {
    let sawIntegrityFailure = false;
    for (const source of input.sources) {
        const files = new Map<string, Readonly<{ file: PluginUiArtifactFileV1; bytes: Uint8Array }>>();
        let sourceUsable = true;
        for (const declared of input.graph.files) {
            if (!callCurrent(input.candidate)) {
                return Object.freeze({ kind: 'unavailable', code: 'candidate_currentness_changed' });
            }
            let bytes: Uint8Array | null;
            try {
                bytes = await source.readFile({
                    artifact: input.artifact,
                    relativePath: declared.relativePath,
                });
            } catch {
                bytes = null;
            }
            if (!callCurrent(input.candidate)) {
                return Object.freeze({ kind: 'unavailable', code: 'candidate_currentness_changed' });
            }
            if (!bytes) {
                sourceUsable = false;
                break;
            }
            const integrity = bytes.byteLength === declared.byteSize
                && verifyPluginUiArtifactBytesIntegrityV1({
                    bytes,
                    integrity: {
                        digest: declared.digest,
                        pluginId: input.artifact.pluginId,
                        contributionId: input.artifact.contributionId,
                        artifactKind: 'reactNativeBundle',
                    },
                }).ok;
            if (!integrity) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            files.set(declared.relativePath, Object.freeze({
                file: cloneFile(declared),
                bytes: new Uint8Array(bytes),
            }));
        }
        if (!sourceUsable) continue;
        const setIntegrity = verifyPluginUiArtifactFileSetIntegrityV1({
            files: [...files.values()].map(({ file, bytes }) => ({
                relativePath: file.relativePath,
                bytes,
            })),
            integrity: {
                digest: input.artifact.digest,
                pluginId: input.artifact.pluginId,
                contributionId: input.artifact.contributionId,
                artifactKind: 'reactNativeBundle',
            },
        });
        if (!setIntegrity.ok) {
            sawIntegrityFailure = true;
            continue;
        }
        return Object.freeze({
            kind: 'available',
            candidateLease: createCandidateLease({
                candidate: input.candidate,
                artifact: input.artifact,
                artifactGraph: input.graph,
                source,
                files,
            }),
        });
    }
    return Object.freeze({
        kind: 'unavailable',
        code: sawIntegrityFailure ? 'candidate_source_integrity_invalid' : 'candidate_source_unavailable',
    });
}

function readCandidateModulePayload(value: unknown): Readonly<{
    manifest: unknown;
    collectionMigrations: unknown;
}> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    if (!Object.prototype.hasOwnProperty.call(record, 'manifest')
        || !Object.prototype.hasOwnProperty.call(record, 'collectionMigrations')) {
        return null;
    }
    return Object.freeze({
        manifest: record.manifest,
        collectionMigrations: record.collectionMigrations,
    });
}

/**
 * Loads only an explicit target artifact's signed Collection-migration export.
 * Its source is an exact app Artifact, trusted daemon Artifact, or a qualified
 * target Account-hosted slot; it never uses an incumbent intent Artifact.
 */
export function createCandidatePluginCollectionMigrationArtifactLoader(
    overrides: Partial<CandidatePluginCollectionMigrationArtifactLoaderDependencies> = {},
): Readonly<{
    load: (
        input: CandidatePluginCollectionMigrationArtifactLoadInput,
    ) => Promise<CandidatePluginCollectionMigrationArtifactLoadResult>;
}> {
    const dependencies: CandidatePluginCollectionMigrationArtifactLoaderDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };
    return Object.freeze({
        load: async (input) => {
            if (!callCurrent(input)) return unavailable('candidate_currentness_changed');
            const parsedGraph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
            if (!parsedGraph.success || !matchesTargetGraph({
                graph: parsedGraph.data,
                target: input.target,
                cacheIdentity: input.cacheIdentity,
            })) {
                return unavailable('candidate_artifact_invalid');
            }
            const graph = parsedGraph.data;
            const candidateArtifact: PluginSelectedArtifactIdentity = Object.freeze({
                pluginId: input.target.release.pluginId,
                contributionId: input.target.artifact.contributionId,
                tier: 'reactNative',
                platform: input.target.artifact.platform,
                digest: input.target.artifact.digest,
                releaseVersion: input.target.release.version,
                availabilityCursor: input.target.availabilityCursor,
            });
            const sources: PluginArtifactSourceCandidate[] = [];
            if (input.appExact) sources.push(input.appExact);
            const daemon = createCandidateDaemonSource({ candidate: input, entryRelativePath: graph.entry });
            if (daemon) sources.push(daemon);
            const accountHosted = createExactCandidateAccountHostedSource({
                candidate: input,
                createSource: dependencies.createAccountHostedSource,
                createTargetSource: dependencies.createAccountHostedTargetSource,
            });
            if (accountHosted) sources.push(accountHosted);
            const materializedSource = await materializeExactCandidateSource({
                candidate: input,
                artifact: candidateArtifact,
                graph,
                sources,
            });
            if (materializedSource.kind !== 'available') return unavailable(materializedSource.code);
            const candidateLease = materializedSource.candidateLease;
            const cache = dependencies.getCache();
            const cached = await materializePluginReactNativeArtifactLeaseInCache({
                lease: candidateLease.lease,
                cacheIdentity: input.cacheIdentity,
                accountScope: input.accountLifetime.scope,
                cacheSink: dependencies.createCacheSink(input.accountLifetime),
                isCurrent: () => callCurrent(input),
            });
            if (cached.kind !== 'available') {
                candidateLease.dispose();
                return unavailable(cached.code === 'artifact_lease_revoked'
                    ? 'candidate_currentness_changed'
                    : 'candidate_source_unavailable');
            }
            if (!cached.isCurrent()) {
                candidateLease.dispose();
                return unavailable('candidate_currentness_changed');
            }
            let loaded: Awaited<ReturnType<typeof loadPluginReactNativeBundleExport>>;
            try {
                loaded = await dependencies.loadBundleExport({
                    cache,
                    identity: input.cacheIdentity,
                    moduleReference: graph.collectionMigrations,
                    ...(dependencies.loaderBackend ? { backend: dependencies.loaderBackend } : {}),
                    ...(dependencies.hostPlatform ? { hostPlatform: dependencies.hostPlatform } : {}),
                });
            } catch {
                candidateLease.dispose();
                return unavailable('candidate_module_unavailable');
            }
            if (!cached.isCurrent()) {
                candidateLease.dispose();
                return unavailable('candidate_currentness_changed');
            }
            if (!loaded.ok) {
                candidateLease.dispose();
                return unavailable('candidate_module_unavailable');
            }
            let moduleValue: unknown;
            try {
                moduleValue = loaded.exported();
            } catch {
                candidateLease.dispose();
                return unavailable('candidate_module_invalid');
            }
            if (!cached.isCurrent()) {
                candidateLease.dispose();
                return unavailable('candidate_currentness_changed');
            }
            const payload = readCandidateModulePayload(moduleValue);
            const parsedManifest = payload
                ? PluginPortableReleaseManifestV1Schema.safeParse(payload.manifest)
                : null;
            if (
                !payload
                || !parsedManifest?.success
                || parsedManifest.data.id !== input.target.release.pluginId
                || parsedManifest.data.version !== input.target.release.version
            ) {
                candidateLease.dispose();
                return unavailable('candidate_module_invalid');
            }
            let collectionContracts: readonly NormalizedPluginAccountCollectionContractV1[];
            let collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
            try {
                collectionContracts = normalizePluginAccountCollectionContractsV1({
                    pluginId: parsedManifest.data.id,
                    contributions: parsedManifest.data.contributes.accountCollections,
                });
                collectionMigrations = normalizePluginAccountCollectionMigrationRuntimeProjection(
                    payload.collectionMigrations,
                    parsedManifest.data.contributes.accountCollections,
                );
            } catch {
                candidateLease.dispose();
                return unavailable('candidate_module_invalid');
            }
            if (!cached.isCurrent()) {
                candidateLease.dispose();
                return unavailable('candidate_currentness_changed');
            }
            return Object.freeze({
                kind: 'available',
                candidate: Object.freeze({
                    release: Object.freeze({
                        ref: Object.freeze({
                            pluginId: input.target.release.pluginId,
                            version: input.target.release.version,
                        }),
                        normalizedManifest: parsedManifest.data,
                    }),
                    collectionContracts: Object.freeze([...collectionContracts]),
                    collectionMigrations,
                    isCurrent: cached.isCurrent,
                    dispose: candidateLease.dispose,
                }),
            });
        },
    });
}

const installedCandidatePluginCollectionMigrationArtifactLoader =
    createCandidatePluginCollectionMigrationArtifactLoader();

export function getCandidatePluginCollectionMigrationArtifactLoader(): Readonly<{
    load: (
        input: CandidatePluginCollectionMigrationArtifactLoadInput,
    ) => Promise<CandidatePluginCollectionMigrationArtifactLoadResult>;
}> {
    return installedCandidatePluginCollectionMigrationArtifactLoader;
}
