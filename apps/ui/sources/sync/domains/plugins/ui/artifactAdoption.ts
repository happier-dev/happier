import {
    DaemonPluginHostedWebArtifactCacheIdentityV1Schema,
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginHostedWebArtifactCacheIdentityV1,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    deriveGeneratedHostedWebAssetPolicyV1,
    PluginUiArtifactsManifestEntryV1Schema,
    type HostedWebAssetPolicyInput,
    type PluginUiArtifactsManifestEntryV1,
    type PluginUiChannelV1,
    type PluginUiHostMethodV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    getInstalledPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    loadPluginReactNativeBundleModule,
    type PluginReactNativeLoaderBackend,
    type RepackInstalledArtifactModuleReference,
} from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeSurfaceModule } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import {
    acquirePluginHostedWebArtifactAvailability,
    type PluginHostedWebArtifactAvailabilityInput,
} from '@/sync/domains/plugins/availability/hostedWebArtifactLease';
import {
    acquirePluginReactNativeArtifactAvailability,
    type PluginReactNativeArtifactAvailabilityInput,
} from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { PluginReactNativeBundleCacheIdentity } from './reactNativeRuntime';

type PluginUiArtifactDisposableHandle = Readonly<{
    isCurrent: () => boolean;
    dispose: () => void;
}>;

type PluginUiArtifactAvailabilityResult<Handle extends PluginUiArtifactDisposableHandle> =
    | Readonly<{ kind: 'available'; handle: Handle }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

export type PluginUiArtifactAdoptionKind = 'hostedWebNative' | 'reactNative';

/**
 * A renderer-facing, revocable view of an Artifact-owned handle. The view
 * omits source-handle disposal so renderer consumers can retire only their
 * adoption through this owner.
 */
export type PluginUiArtifactAdoption<
    Kind extends PluginUiArtifactAdoptionKind,
    Handle extends PluginUiArtifactDisposableHandle,
> = Readonly<{
    kind: Kind;
    handle: Omit<Handle, 'dispose'>;
    /** Delegates to the bound surface and Artifact handle; it owns neither. */
    isCurrent: () => boolean;
    /** Idempotently retires this renderer consumer. */
    dispose: () => void;
}>;

export type PluginUiArtifactAdoptionResult<
    Kind extends PluginUiArtifactAdoptionKind,
    Handle extends PluginUiArtifactDisposableHandle,
> =
    | Readonly<{ kind: 'available'; adoption: PluginUiArtifactAdoption<Kind, Handle> }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

export type PluginUiArtifactDaemonOrigin = Readonly<{
    executionOrigin: PluginMachineExecutionOriginV1;
    serverId: string;
}>;

export type PluginUiHostedWebArtifactTechnicalAdmission = Readonly<{
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    cacheIdentity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    hostedWebPolicy: HostedWebAssetPolicyInput;
}>;

export type PluginUiHostedWebNativeArtifactAdoptionInput = Omit<
    PluginHostedWebArtifactAvailabilityInput,
    'daemon' | 'isCurrent'
> & Readonly<{
    daemon?: PluginUiArtifactDaemonOrigin;
}>;

export type PluginUiReactNativeArtifactAdoptionInput = Omit<
    PluginReactNativeArtifactAvailabilityInput,
    'daemon' | 'isCurrent'
> & Readonly<{
    artifactOwnerKind: 'renderer';
    crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1;
    daemon?: PluginUiArtifactDaemonOrigin;
}>;

function unavailableBecauseRetired(): Readonly<{
    kind: 'unavailable';
    code: 'artifact_lease_revoked';
}> {
    return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
}

function handleIsCurrent(handle: PluginUiArtifactDisposableHandle): boolean {
    try {
        return handle.isCurrent();
    } catch {
        return false;
    }
}

/**
 * The one UI consumer owner for Artifact's already-selected opaque handles.
 * Artifact remains responsible for source selection, cache materialization,
 * identity, Account retirement, and revocation; the bound surface remains the
 * currentness authority. This owner only composes invocation and consumer
 * retirement for one renderer adoption.
 */
export class PluginUiArtifactAdoptionOwner {
    private disposed = false;
    private readonly disposeConsumers = new Set<() => void>();

    public constructor(private readonly input: Readonly<{
        isCurrent: () => boolean;
    }>) {}

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const disposeConsumer of [...this.disposeConsumers]) {
            disposeConsumer();
        }
    }

    public async adopt<
        Kind extends PluginUiArtifactAdoptionKind,
        Handle extends PluginUiArtifactDisposableHandle,
    >(input: Readonly<{
        kind: Kind;
        acquire: () => Promise<PluginUiArtifactAvailabilityResult<Handle>>;
    }>): Promise<PluginUiArtifactAdoptionResult<Kind, Handle>> {
        if (!this.isActive()) return unavailableBecauseRetired();

        const acquired = await input.acquire();
        if (acquired.kind !== 'available') {
            return this.isActive() ? acquired : unavailableBecauseRetired();
        }

        const handle = acquired.handle;
        let consumerDisposed = false;
        const disposeConsumer = () => {
            if (consumerDisposed) return;
            consumerDisposed = true;
            this.disposeConsumers.delete(disposeConsumer);
            handle.dispose();
        };

        if (!this.isActive() || !handleIsCurrent(handle)) {
            disposeConsumer();
            return unavailableBecauseRetired();
        }

        this.disposeConsumers.add(disposeConsumer);
        const { dispose: sourceDispose, ...readonlyHandle } = handle;
        // The source disposer remains in this closure; consumers receive only
        // the revocable adoption method below.
        void sourceDispose;
        const adoption = Object.freeze({
            kind: input.kind,
            handle: Object.freeze(readonlyHandle),
            isCurrent: () => this.isActive() && handleIsCurrent(handle),
            dispose: disposeConsumer,
        });
        return Object.freeze({ kind: 'available', adoption });
    }

    public async adoptHostedWebNative(
        input: PluginUiHostedWebNativeArtifactAdoptionInput,
    ) {
        const { daemon, ...availabilityInput } = input;
        return await this.adopt({
            kind: 'hostedWebNative' as const,
            acquire: () => acquirePluginHostedWebArtifactAvailability({
                ...availabilityInput,
                ...(daemon
                    ? {
                        daemon: {
                            origin: daemon.executionOrigin,
                            serverId: daemon.serverId,
                        },
                    }
                    : {}),
                isCurrent: () => this.isActive(),
            }),
        });
    }

    public async adoptReactNative(
        input: PluginUiReactNativeArtifactAdoptionInput,
    ) {
        const { daemon, ...availabilityInput } = input;
        return await this.adopt({
            kind: 'reactNative' as const,
            acquire: async () => {
                const acquired = await acquirePluginReactNativeArtifactAvailability({
                    ...availabilityInput,
                    ...(daemon
                        ? {
                            daemon: {
                                origin: daemon.executionOrigin,
                                serverId: daemon.serverId,
                            },
                        }
                        : {}),
                    isCurrent: () => this.isActive(),
                });
                if (acquired.kind !== 'available') return acquired;
                return Object.freeze({ kind: 'available' as const, handle: acquired });
            },
        });
    }

    private isActive(): boolean {
        if (this.disposed) return false;
        try {
            return this.input.isCurrent();
        } catch {
            return false;
        }
    }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readHostedWebAssetPolicy(input: Readonly<{
    contribution: Readonly<Record<string, unknown>> | null;
    graph: PluginUiArtifactsManifestEntryV1;
    channel: PluginUiChannelV1;
}>): HostedWebAssetPolicyInput | null {
    if (input.contribution?.generatedV2 !== true) return null;
    const policy = deriveGeneratedHostedWebAssetPolicyV1(input.graph);
    if (!policy) return null;
    return Object.freeze({
        assetRootId: policy.assetRootId,
        entryPath: policy.entryPath,
        files: policy.files,
        digest: policy.digest,
        routeMode: policy.routeMode,
        requestPath: '/',
        security: policy.security,
        sourceMaps: policy.sourceMaps,
    });
}

/**
 * Composes the existing generated Artifact facts into one hosted renderer
 * technical-admission result. Manifest policy, registry fallback, Artifact
 * source selection, and surface currentness continue to be owned elsewhere.
 */
export function resolvePluginUiHostedWebArtifactTechnicalAdmission(input: Readonly<{
    contribution: Readonly<Record<string, unknown>> | null;
    pluginId: string;
    projectionGeneration: number | null | undefined;
    channel: PluginUiChannelV1;
}>): PluginUiHostedWebArtifactTechnicalAdmission | null {
    if (input.contribution?.generatedV2 !== true || input.projectionGeneration === null || input.projectionGeneration === undefined) {
        return null;
    }
    const graph = readPluginUiGeneratedArtifactGraph(input.contribution);
    const cacheIdentity = readPluginUiHostedWebArtifactReadIdentity(input.contribution);
    const contributionId = readOptionalString(input.contribution.contributionId);
    if (
        !graph
        || !cacheIdentity
        || !contributionId
        || cacheIdentity.pluginId !== input.pluginId
        || graph.contributionId !== contributionId
        || cacheIdentity.contributionId !== contributionId
        || cacheIdentity.artifactDigest !== graph.digest
        || cacheIdentity.platform !== graph.platform
        || cacheIdentity.projectionGeneration !== input.projectionGeneration
    ) {
        return null;
    }
    const hostedWebPolicy = readHostedWebAssetPolicy({
        contribution: input.contribution,
        graph,
        channel: input.channel,
    });
    if (!hostedWebPolicy) return null;
    return Object.freeze({ artifactGraph: graph, cacheIdentity, hostedWebPolicy });
}

/** React dependency facts only; never a cache or persistence identity. */
export function createPluginUiHostedWebArtifactRequestFactsKey(input: Readonly<{
    platform: string | undefined;
    origin: PluginUiArtifactDaemonOrigin | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
}>): string {
    const sourceMaps = input.admission?.hostedWebPolicy.sourceMaps;
    return JSON.stringify({
        platform: input.platform ?? null,
        origin: input.origin
            ? {
                serverId: input.origin.serverId,
                serverIdentityId: input.origin.executionOrigin.serverIdentityId,
                materialization: input.origin.executionOrigin.materializationRef,
            }
            : null,
        graph: input.admission
            ? {
                contributionId: input.admission.artifactGraph.contributionId,
                tier: input.admission.artifactGraph.tier,
                platform: input.admission.artifactGraph.platform,
                entry: input.admission.artifactGraph.entry,
                digest: input.admission.artifactGraph.digest,
                files: input.admission.artifactGraph.files.map((file) => ({
                    relativePath: file.relativePath,
                    digest: file.digest,
                    byteSize: file.byteSize,
                })),
            }
            : null,
        identity: input.admission?.cacheIdentity ?? null,
        policy: input.admission
            ? {
                assetRootId: input.admission.hostedWebPolicy.assetRootId,
                entryPath: input.admission.hostedWebPolicy.entryPath,
                files: input.admission.hostedWebPolicy.files,
                digest: input.admission.hostedWebPolicy.digest,
                routeMode: input.admission.hostedWebPolicy.routeMode,
                requestPath: input.admission.hostedWebPolicy.requestPath,
                security: input.admission.hostedWebPolicy.security,
                sourceMaps: sourceMaps
                    ? {
                        enabled: sourceMaps.enabled,
                        allowedDigests: [...(sourceMaps.allowedDigests ?? [])].sort(),
                    }
                    : null,
            }
            : null,
    });
}

export function readPluginUiGeneratedArtifactGraph(
    contribution: Readonly<Record<string, unknown>> | null,
): PluginUiArtifactsManifestEntryV1 | null {
    if (contribution?.generatedV2 !== true) return null;
    const parsed = PluginUiArtifactsManifestEntryV1Schema.safeParse(contribution.artifactGraph);
    return parsed.success ? parsed.data : null;
}

export function readPluginUiHostedWebArtifactReadIdentity(
    contribution: Readonly<Record<string, unknown>> | null,
): DaemonPluginHostedWebArtifactCacheIdentityV1 | null {
    const parsed = DaemonPluginHostedWebArtifactCacheIdentityV1Schema.safeParse(
        readRecord(contribution?.runtime)?.artifactReadIdentity,
    );
    return parsed.success ? parsed.data : null;
}

/**
 * Reads the daemon-projected React Native cache identity through the canonical
 * Protocol schema. The producer validates the same wire member with the same
 * strict schema, so this reader must not admit a shape that producer cannot
 * emit — a looser copy here derives a different cache key for it.
 */
export function readPluginUiReactNativeBundleCacheIdentity(
    value: unknown,
): PluginReactNativeBundleCacheIdentity | null {
    const parsed = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(value);
    return parsed.success ? Object.freeze(parsed.data) : null;
}

export function readPluginUiGeneratedReactNativeModuleReference(
    graph: PluginUiArtifactsManifestEntryV1 | null,
): RepackInstalledArtifactModuleReference | undefined {
    if (!graph || graph.platform === 'web' || !graph.repack) return undefined;
    return Object.freeze({
        containerName: graph.repack.containerName,
        modulePath: graph.repack.modulePath,
        exportName: graph.repack.exportName,
    });
}

export function isPluginUiReactNativeArtifactTechnicallyAdmitted(input: Readonly<{
    artifactGraph: PluginUiArtifactsManifestEntryV1 | null;
    cacheIdentity: PluginReactNativeBundleCacheIdentity | null;
    projectionGeneration: number | null | undefined;
    moduleReference: RepackInstalledArtifactModuleReference | undefined;
}>): boolean {
    return input.artifactGraph !== null
        && input.cacheIdentity !== null
        && input.projectionGeneration !== null
        && input.projectionGeneration !== undefined
        && input.cacheIdentity.projectionGeneration === input.projectionGeneration
        && input.cacheIdentity.artifactDigest === input.artifactGraph.digest
        && input.cacheIdentity.platform === input.artifactGraph.platform
        && (input.artifactGraph.platform === 'web' || input.moduleReference !== undefined);
}

export type PluginUiRendererTechnicalAdmission<ArtifactAdmission> =
    | Readonly<{
        kind: 'available';
        artifactAdmission: ArtifactAdmission;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'artifact_technical_admission_unavailable' | 'required_host_methods_unavailable';
    }>;

/**
 * The one pure renderer-admission composition for the platform-specific
 * artifact facts and the mount's structural host-method contract. Live served
 * methods remain transport facts: a transient daemon outage must not cause one
 * renderer family to de-admit while the other remains mounted.
 */
export function resolvePluginUiRendererTechnicalAdmission<ArtifactAdmission>(input: Readonly<{
    requiredHostMethods: readonly PluginUiHostMethodV1[] | null;
    structuralHostMethods: readonly PluginUiHostMethodV1[];
    /** Evaluated only after the shared structural contract is satisfied. */
    resolveArtifactAdmission: () => ArtifactAdmission | null;
}>): PluginUiRendererTechnicalAdmission<ArtifactAdmission> {
    const requiredHostMethods = input.requiredHostMethods ?? [];
    if (!requiredHostMethods.every((method) => input.structuralHostMethods.includes(method))) {
        return Object.freeze({ kind: 'unavailable', code: 'required_host_methods_unavailable' });
    }
    const artifactAdmission = input.resolveArtifactAdmission();
    if (artifactAdmission === null) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_technical_admission_unavailable' });
    }
    return Object.freeze({ kind: 'available', artifactAdmission });
}

export type PluginUiReactNativeInstalledArtifactLoadInput = Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    reader: PluginAccountAvailabilityReader;
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** Exact daemon-issued renderer crash binding; Artifact rejects every other token. */
    crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1;
    daemon?: PluginUiArtifactDaemonOrigin;
    moduleReference: RepackInstalledArtifactModuleReference | undefined;
    hostPlatform: string;
    backend?: PluginReactNativeLoaderBackend;
    /** The one mount/controller lifetime, never a renderer-local epoch. */
    isCurrent: () => boolean;
}>;

function throwReactNativeArtifactLoadFailure(
    code: string,
    diagnostics: readonly string[] = [code],
): never {
    throw Object.assign(new Error(code), { code, diagnostics });
}

/**
 * The thin RN adoption path: it consumes Artifact's opaque cache capability,
 * delegates evaluation to the incumbent loader, and retires the one consumer
 * adoption after each load attempt.
 */
export function createPluginUiReactNativeInstalledArtifactLoad(
    input: PluginUiReactNativeInstalledArtifactLoadInput,
): () => Promise<PluginReactNativeSurfaceModule> {
    return async () => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: input.isCurrent });
        const acquired = await owner.adoptReactNative({
            reader: input.reader,
            artifactGraph: input.artifactGraph,
            cacheIdentity: input.identity,
            accountLifetime: input.accountLifetime,
            artifactOwnerKind: 'renderer',
            crashStateToken: input.crashStateToken,
            ...(input.daemon ? { daemon: input.daemon } : {}),
        });
        if (acquired.kind !== 'available') {
            return throwReactNativeArtifactLoadFailure(acquired.code);
        }
        try {
            // The module loader cannot be cancelled. Artifact and the bound
            // surface must therefore still be current on both sides of it.
            if (!acquired.adoption.isCurrent()) {
                return throwReactNativeArtifactLoadFailure('artifact_lease_revoked');
            }
            const result = await loadPluginReactNativeBundleModule({
                cache: getInstalledPluginReactNativeBundleCache(),
                identity: input.identity,
                hostPlatform: input.hostPlatform,
                ...(input.moduleReference ? { moduleReference: input.moduleReference } : {}),
                ...(input.backend ? { backend: input.backend } : {}),
            });
            if (!acquired.adoption.isCurrent()) {
                return throwReactNativeArtifactLoadFailure('artifact_lease_revoked');
            }
            if (result.ok) return result.module;
            return throwReactNativeArtifactLoadFailure(result.code, result.diagnostics);
        } finally {
            owner.dispose();
        }
    };
}
