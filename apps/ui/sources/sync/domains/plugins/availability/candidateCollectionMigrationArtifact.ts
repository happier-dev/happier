import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { normalizePluginAccountCollectionContractsV1, type NormalizedPluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { resolvePluginCollectionMigrationArtifactOwnerV1 } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV2,
} from '@happier-dev/protocol/plugins/ui';
import {
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    type PluginAccountPluginUiArtifactLinkV1,
    type PluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    type PluginAccountCollectionMigrationRuntimeProjection,
} from '@happier-dev/plugin-sdk';
import { normalizePluginAccountCollectionMigrationRuntimeProjection } from '@happier-dev/plugin-sdk/host/registration';

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
    createActivePluginAccountHostedArtifactTargetSourceCandidate,
    type ActivePluginAccountHostedArtifactReader,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import {
    materializeVerifiedPluginArtifactSource,
    type PluginArtifactSourceCandidate,
    type PluginSelectedArtifactIdentity,
    type PluginSelectedArtifactLease,
} from './artifactLease';
import {
    materializePluginReactNativeArtifactLeaseInCache,
    type PluginReactNativeArtifactLeaseCacheSink,
} from './reactNativeArtifactLease';

/** Immutable target facts selected before any candidate code is loaded. */
export type CandidatePluginCollectionMigrationArtifactTarget = Readonly<{
    release: Readonly<{
        pluginId: string;
        version: string;
    }>;
    artifact: Readonly<{
        contributionId: string;
        artifactId: string;
        platform: 'web' | 'ios' | 'android';
        digest: PluginUiArtifactDigestV1;
        hostUiApiRange: string;
    }>;
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
    /**
     * The target's exact Account release slot, resolved lazily after the CAS
     * refusal. It never falls back to the current intent's artifact link.
     */
    accountHosted?: Readonly<{
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

function matchesTargetGraph(input: Readonly<{
    graph: PluginUiArtifactsManifestEntryV2;
    target: CandidatePluginCollectionMigrationArtifactTarget;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
}>): boolean {
    return input.graph.tier === 'reactNative'
        && input.graph.artifactId === input.target.artifact.artifactId
        && input.graph.digest === input.target.artifact.digest
        && input.graph.hostUiApiRange === input.target.artifact.hostUiApiRange
        && input.graph.executable.exports.includes('collectionMigrations')
        && input.cacheIdentity.pluginId === input.target.release.pluginId
        && input.cacheIdentity.contributionId === input.target.artifact.contributionId
        && input.cacheIdentity.artifactDigest === input.target.artifact.digest
        && input.cacheIdentity.platform === input.target.artifact.platform;
}

function matchesAccountHostedTargetGraph(input: Readonly<{
    facts: PluginReleaseFactsV1;
    graph: PluginUiArtifactsManifestEntryV2;
    link: PluginAccountPluginUiArtifactLinkV1;
}>): boolean {
    const { graph, link } = input;
    const owner = resolvePluginCollectionMigrationArtifactOwnerV1(
        input.facts.normalizedManifest.contributes.accountCollections,
    );
    if (!owner) return false;
    const slot = input.facts.uiSlots.find((candidate) => (
        candidate.contributionId === owner.contributionId
        && candidate.artifactId === graph.artifactId
        && candidate.tier === graph.tier
        && candidate.artifactDigest === graph.digest
        && candidate.hostUiApiRange === graph.hostUiApiRange
    ));
    return link.release.pluginId === input.facts.ref.pluginId
        && link.release.version === input.facts.ref.version
        && graph.tier === 'reactNative'
        && graph.artifactId === owner.reference.artifactId
        && graph.executable.exports.includes(owner.reference.exportName)
        && graph.artifactId === link.artifactId
        && graph.tier === link.tier
        && graph.digest === link.artifactDigest
        && graph.hostUiApiRange === link.hostUiApiRange
        && slot !== undefined
        && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(slot, link);
}

/**
 * Resolves one Account-hosted prospective target lazily from exact Availability
 * facts. The Account read supplies the authoritative link and archive graph.
 */
export async function resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
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
    const owner = resolvePluginCollectionMigrationArtifactOwnerV1(
        input.facts.normalizedManifest.contributes.accountCollections,
    );
    if (!owner) return Object.freeze({ kind: 'unavailable' as const });
    const reader = input.reader ?? createActivePluginAccountHostedArtifactReader();
    const candidates: Array<Extract<
        CandidatePluginCollectionMigrationArtifactAccountHostedTargetResult,
        { kind: 'available' }
    >> = [];
    for (const slot of input.facts.uiSlots) {
        if (
            slot.tier !== 'reactNative'
            || slot.contributionId !== owner.contributionId
            || slot.artifactId !== owner.reference.artifactId
        ) continue;
        const result = await reader.readTarget({
            accountLifetime: input.accountLifetime,
            release: input.facts.ref,
            slot: {
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
            expectedArtifactDigest: slot.artifactDigest,
        });
        if (!isCurrent()) return Object.freeze({ kind: 'unavailable' as const });
        if (result.kind !== 'available') continue;
        const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(result.value.archive.artifactGraph);
        if (
            !graph.success
            || graph.data.tier !== 'reactNative'
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
                    contributionId: slot.contributionId,
                    artifactId: slot.artifactId,
                    platform: slot.platform,
                    digest: graph.data.digest,
                    hostUiApiRange: graph.data.hostUiApiRange,
                }),
            }),
            artifact: Object.freeze({
                artifactGraph: graph.data,
                cacheIdentity: Object.freeze({
                    pluginId: input.facts.ref.pluginId,
                    contributionId: slot.contributionId,
                    artifactId: graph.data.artifactId,
                    artifactDigest: graph.data.digest,
                    platform: slot.platform,
                }),
                accountHosted: Object.freeze({ reader }),
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

function createExactCandidateAccountHostedSource(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    createTargetSource: typeof createActivePluginAccountHostedArtifactTargetSourceCandidate;
}>): PluginArtifactSourceCandidate | null {
    const hosted = input.candidate.accountHosted;
    if (!hosted) return null;
    return input.createTargetSource({
        accountLifetime: input.candidate.accountLifetime,
        ...(hosted.reader ? { reader: hosted.reader } : {}),
    });
}

type CandidateLease = Readonly<{
    lease: PluginSelectedArtifactLease;
    dispose: () => void;
}>;

function createCandidateLease(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    artifact: PluginSelectedArtifactIdentity;
    artifactGraph: PluginUiArtifactsManifestEntryV2;
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

/**
 * Candidate acquisition keeps its own currentness owner and typed codes; the
 * verified-source walk itself is the one shared Artifact materializer, so
 * candidate and live admission cannot drift on integrity.
 */
async function materializeExactCandidateSource(input: Readonly<{
    candidate: CandidatePluginCollectionMigrationArtifactLoadInput;
    artifact: PluginSelectedArtifactIdentity;
    graph: PluginUiArtifactsManifestEntryV2;
    sources: readonly PluginArtifactSourceCandidate[];
}>): Promise<
    | Readonly<{ kind: 'available'; candidateLease: CandidateLease }>
    | Readonly<{ kind: 'unavailable'; code: 'candidate_currentness_changed' | 'candidate_source_unavailable' | 'candidate_source_integrity_invalid' }>
> {
    const materialized = await materializeVerifiedPluginArtifactSource({
        artifact: input.artifact,
        graph: input.graph,
        sources: input.sources,
        isCurrent: () => callCurrent(input.candidate),
    });
    if (materialized.kind === 'notCurrent') {
        return Object.freeze({ kind: 'unavailable', code: 'candidate_currentness_changed' });
    }
    if (materialized.kind === 'unavailable') {
        return Object.freeze({
            kind: 'unavailable',
            code: materialized.integrityFailed
                ? 'candidate_source_integrity_invalid'
                : 'candidate_source_unavailable',
        });
    }
    return Object.freeze({
        kind: 'available',
        candidateLease: createCandidateLease({
            candidate: input.candidate,
            artifact: input.artifact,
            artifactGraph: input.graph,
            source: materialized.source,
            files: new Map(materialized.files.map(
                ({ file, bytes }) => [file.relativePath, { file, bytes }] as const,
            )),
        }),
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
 * Its source is an exact app Artifact or a qualified target Account-hosted
 * slot; it never uses an incumbent intent Artifact. A daemon-owned candidate
 * runs its migrations on the daemon instead (`daemonCandidateCollectionPreparation`).
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
            const parsedGraph = PluginUiArtifactsManifestEntryV2Schema.safeParse(input.artifactGraph);
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
                artifactId: input.target.artifact.artifactId,
                tier: 'reactNative',
                platform: input.target.artifact.platform,
                digest: input.target.artifact.digest,
                hostUiApiRange: input.target.artifact.hostUiApiRange,
                releaseVersion: input.target.release.version,
            });
            const sources: PluginArtifactSourceCandidate[] = [];
            if (input.appExact) sources.push(input.appExact);
            const accountHosted = createExactCandidateAccountHostedSource({
                candidate: input,
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
                    moduleReference: Object.freeze({ exportName: 'collectionMigrations' }),
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
            const migrationOwner = resolvePluginCollectionMigrationArtifactOwnerV1(
                parsedManifest.data.contributes.accountCollections,
            );
            if (
                !migrationOwner
                || migrationOwner.contributionId !== input.target.artifact.contributionId
                || migrationOwner.reference.artifactId !== input.target.artifact.artifactId
                || migrationOwner.reference.exportName !== 'collectionMigrations'
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
