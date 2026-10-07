import {
    DaemonPluginUiArtifactByteIdentityV1Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    deriveGeneratedHostedWebAssetPolicyV1,
    PluginUiArtifactsManifestEntryV2Schema,
    type HostedWebAssetPolicyInput,
    type PluginUiArtifactsManifestEntryV2,
    type PluginUiChannelV1,
    type PluginUiHostMethodV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    getInstalledPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    loadPluginReactNativeBundleModule,
    type PluginReactNativeLoaderBackend,
    type PluginReactNativeExecutableModuleReference,
} from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeSurfaceModule } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import {
    acquirePluginHostedWebArtifactAvailability,
    type PluginHostedWebArtifactIdentity,
    type PluginHostedWebArtifactAvailabilityInput,
} from '@/sync/domains/plugins/availability/hostedWebArtifactLease';
import {
    acquirePluginReactNativeArtifactAvailability,
    type PluginReactNativeArtifactAvailabilityInput,
} from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type {
    PluginArtifactDaemonProjectionSelectionInput,
    PluginArtifactDaemonTransport,
} from '@/sync/domains/plugins/availability/artifactLease';
import { readPluginUiContributionOrigin } from './projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from './reactNativeRuntime';

type PluginUiArtifactDisposableHandle = Readonly<{
    isCurrent: () => boolean;
    dispose: () => void;
}>;

type PluginUiArtifactAvailabilityResult<Handle extends PluginUiArtifactDisposableHandle> =
    | Readonly<{ kind: 'available'; handle: Handle }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

export type PluginUiArtifactAdoptionKind = 'hostedWebNative' | 'reactNative';

export type PluginUiArtifactRetirementReason = 'disabled' | 'revoked' | 'uninstalled' | 'withdrawn' | 'accountRetired' | 'ownerDisposed';

export type PluginUiArtifactAdoptionDisposition =
    | Readonly<{ kind: 'empty' }>
    | Readonly<{ kind: 'preparing'; desiredArtifactKey: string }>
    | Readonly<{ kind: 'applied'; appliedArtifactKey: string }>
    | Readonly<{ kind: 'updating'; appliedArtifactKey: string; desiredArtifactKey: string }>
    | Readonly<{
        kind: 'retainedLastKnownGood';
        appliedArtifactKey: string;
        desiredArtifactKey: string;
        failureCode: string;
    }>
    | Readonly<{ kind: 'failed'; desiredArtifactKey: string; failureCode: string }>
    | Readonly<{ kind: 'retired'; reason: PluginUiArtifactRetirementReason }>;

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
    /** Atomically promotes this prepared candidate and retires its incumbent. */
    commit: () => boolean;
    /** Retires only this candidate and records the retained/initial failure. */
    fail: (failureCode: string) => void;
}>;

export type PluginUiArtifactAdoptionResult<
    Kind extends PluginUiArtifactAdoptionKind,
    Handle extends PluginUiArtifactDisposableHandle,
> =
    | Readonly<{ kind: 'available'; adoption: PluginUiArtifactAdoption<Kind, Handle> }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

export type PluginUiArtifactDaemonSource = PluginArtifactDaemonTransport;

export type PluginUiHostedWebArtifactTechnicalAdmission = Readonly<{
    artifactGraph: PluginUiArtifactsManifestEntryV2;
    cacheIdentity: PluginHostedWebArtifactIdentity;
    hostedWebPolicy: HostedWebAssetPolicyInput;
    daemonProjectionSelection?: PluginUiDaemonProjectionSelection;
}>;

export type PluginUiHostedWebNativeArtifactAdoptionInput = Omit<
    PluginHostedWebArtifactAvailabilityInput,
    'daemon' | 'isCurrent'
> & Readonly<{
    daemon?: PluginUiArtifactDaemonSource;
    daemonProjectionSelection?: PluginArtifactDaemonProjectionSelectionInput;
}>;

export type PluginUiReactNativeArtifactAdoptionInput = Omit<
    PluginReactNativeArtifactAvailabilityInput,
    'daemon' | 'isCurrent'
> & Readonly<{
    daemon?: PluginUiArtifactDaemonSource;
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
    private currentConsumer: Readonly<{ artifactKey: string; dispose: () => void }> | null = null;
    private disposition: PluginUiArtifactAdoptionDisposition = Object.freeze({ kind: 'empty' });
    private pendingAdoption: { desiredArtifactKey: string; dispose?: () => void } | null = null;

    public constructor(private readonly input: Readonly<{
        isCurrent: () => boolean;
    }>) {}

    public dispose(): void {
        this.retire('ownerDisposed');
    }

    public retire(reason: PluginUiArtifactRetirementReason): void {
        if (this.disposed) return;
        this.disposed = true;
        this.pendingAdoption = null;
        for (const disposeConsumer of [...this.disposeConsumers]) {
            disposeConsumer();
        }
        this.currentConsumer = null;
        this.disposition = Object.freeze({ kind: 'retired', reason });
    }

    public readDisposition(): PluginUiArtifactAdoptionDisposition {
        return this.disposition;
    }

    public async adopt<
        Kind extends PluginUiArtifactAdoptionKind,
        Handle extends PluginUiArtifactDisposableHandle,
    >(input: Readonly<{
        kind: Kind;
        desiredArtifactKey?: string;
        acquire: () => Promise<PluginUiArtifactAvailabilityResult<Handle>>;
    }>): Promise<PluginUiArtifactAdoptionResult<Kind, Handle>> {
        if (!this.isActive()) return unavailableBecauseRetired();

        const desiredArtifactKey = input.desiredArtifactKey ?? input.kind;
        this.pendingAdoption?.dispose?.();
        const pendingAdoption: { desiredArtifactKey: string; dispose?: () => void } = { desiredArtifactKey };
        this.pendingAdoption = pendingAdoption;
        const incumbent = this.currentConsumer;
        this.disposition = incumbent
            ? Object.freeze({
                kind: 'updating',
                appliedArtifactKey: incumbent.artifactKey,
                desiredArtifactKey,
            })
            : Object.freeze({ kind: 'preparing', desiredArtifactKey });

        const acquired = await input.acquire();
        if (pendingAdoption !== this.pendingAdoption) {
            if (acquired.kind === 'available') acquired.handle.dispose();
            return unavailableBecauseRetired();
        }
        if (acquired.kind !== 'available') {
            if (!this.isActive()) return unavailableBecauseRetired();
            this.pendingAdoption = null;
            this.disposition = incumbent
                ? Object.freeze({
                    kind: 'retainedLastKnownGood',
                    appliedArtifactKey: incumbent.artifactKey,
                    desiredArtifactKey,
                    failureCode: acquired.code,
                })
                : Object.freeze({
                    kind: 'failed',
                    desiredArtifactKey,
                    failureCode: acquired.code,
                });
            return acquired;
        }

        const handle = acquired.handle;
        let consumerDisposed = false;
        let committed = false;
        const disposeConsumer = () => {
            if (consumerDisposed) return;
            consumerDisposed = true;
            this.disposeConsumers.delete(disposeConsumer);
            if (this.currentConsumer?.dispose === disposeConsumer) {
                this.currentConsumer = null;
                if (!this.disposed) this.disposition = Object.freeze({ kind: 'empty' });
            }
            if (this.pendingAdoption === pendingAdoption) this.pendingAdoption = null;
            handle.dispose();
        };
        pendingAdoption.dispose = disposeConsumer;

        if (!this.isActive() || !handleIsCurrent(handle)) {
            disposeConsumer();
            return unavailableBecauseRetired();
        }

        this.disposeConsumers.add(disposeConsumer);
        const { dispose: sourceDispose, ...readonlyHandle } = handle;
        // The source disposer remains in this closure; consumers receive only
        // the revocable adoption method below.
        void sourceDispose;
        const commit = (): boolean => {
            if (consumerDisposed || committed || this.pendingAdoption !== pendingAdoption
                || !this.isActive() || !handleIsCurrent(handle)) return false;
            committed = true;
            const previous = this.currentConsumer;
            this.pendingAdoption = null;
            this.currentConsumer = Object.freeze({ artifactKey: desiredArtifactKey, dispose: disposeConsumer });
            this.disposition = Object.freeze({ kind: 'applied', appliedArtifactKey: desiredArtifactKey });
            if (previous?.dispose !== disposeConsumer) previous?.dispose();
            return true;
        };
        const fail = (failureCode: string): void => {
            if (consumerDisposed || committed || this.pendingAdoption !== pendingAdoption) return;
            this.pendingAdoption = null;
            this.disposition = incumbent
                ? Object.freeze({
                    kind: 'retainedLastKnownGood',
                    appliedArtifactKey: incumbent.artifactKey,
                    desiredArtifactKey,
                    failureCode,
                })
                : Object.freeze({ kind: 'failed', desiredArtifactKey, failureCode });
            disposeConsumer();
        };
        const adoption = Object.freeze({
            kind: input.kind,
            handle: Object.freeze(readonlyHandle),
            isCurrent: () => this.isActive()
                && handleIsCurrent(handle)
                && (committed
                    ? this.currentConsumer?.dispose === disposeConsumer
                    : this.pendingAdoption === pendingAdoption),
            dispose: disposeConsumer,
            commit,
            fail,
        });
        return Object.freeze({ kind: 'available', adoption });
    }

    public async adoptHostedWebNative(
        input: PluginUiHostedWebNativeArtifactAdoptionInput,
    ) {
        const { daemon, ...availabilityInput } = input;
        return await this.adopt({
            kind: 'hostedWebNative' as const,
            desiredArtifactKey: input.cacheIdentity.artifactDigest,
            acquire: () => acquirePluginHostedWebArtifactAvailability({
                ...availabilityInput,
                ...(daemon
                    ? {
                        daemon,
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
            desiredArtifactKey: input.cacheIdentity.artifactDigest,
            acquire: async () => {
                const acquired = await acquirePluginReactNativeArtifactAvailability({
                    ...availabilityInput,
                    ...(daemon
                        ? {
                            daemon,
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
    graph: PluginUiArtifactsManifestEntryV2;
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
    channel: PluginUiChannelV1;
}>): PluginUiHostedWebArtifactTechnicalAdmission | null {
    if (input.contribution?.generatedV2 !== true) {
        return null;
    }
    const graph = readPluginUiGeneratedArtifactGraph(input.contribution);
    const contributionId = readOptionalString(input.contribution.contributionId);
    const cacheIdentity = graph && contributionId
        ? readPluginUiHostedWebArtifactReadIdentity(input.contribution, {
            pluginId: input.pluginId,
            contributionId,
            artifactId: graph.artifactId,
        })
        : null;
    if (
        !graph
        || !cacheIdentity
        || !contributionId
        || cacheIdentity.pluginId !== input.pluginId
        || cacheIdentity.contributionId !== contributionId
        || cacheIdentity.artifactDigest !== graph.digest
        || graph.tier !== 'hostedWeb'
    ) {
        return null;
    }
    const hostedWebPolicy = readHostedWebAssetPolicy({
        contribution: input.contribution,
        graph,
        channel: input.channel,
    });
    if (!hostedWebPolicy) return null;
    const daemonProjectionSelection = readPluginUiDaemonProjectionSelection(input.contribution);
    return Object.freeze({
        artifactGraph: graph,
        cacheIdentity,
        hostedWebPolicy,
        ...(daemonProjectionSelection ? { daemonProjectionSelection } : {}),
    });
}

export type PluginUiDaemonProjectionSelection = Omit<PluginArtifactDaemonProjectionSelectionInput, 'isCurrent'>;

/**
 * Reads the daemon projection's semantic-selection stamp, carrying the
 * projecting daemon (the app-union origin stamp) as its byte route. A direct
 * single-machine projection has no stamp; its mount machine is that daemon.
 * Account-selected artifacts return null and continue through Availability.
 */
export function readPluginUiDaemonProjectionSelection(
    contribution: Readonly<Record<string, unknown>> | null,
): PluginUiDaemonProjectionSelection | null {
    if (contribution?.artifactSelectionOwner !== 'daemonProjection') return null;
    const occurrenceId = readOptionalString(contribution.occurrenceId);
    const contributionId = readOptionalString(contribution.contributionId);
    const releaseVersion = readOptionalString(contribution.pluginVersion);
    if (!occurrenceId || !contributionId || !releaseVersion) return null;
    const origin = readPluginUiContributionOrigin(contribution);
    return Object.freeze({
        occurrenceId,
        contributionId,
        releaseVersion,
        ...(origin?.serverId
            ? { transport: Object.freeze({ machineId: origin.machineId, serverId: origin.serverId }) }
            : {}),
    });
}

/** React dependency facts only; never a cache or persistence identity. */
export function createPluginUiHostedWebArtifactRequestFactsKey(input: Readonly<{
    platform: string | undefined;
    source: PluginUiArtifactDaemonSource | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
}>): string {
    const sourceMaps = input.admission?.hostedWebPolicy.sourceMaps;
    return JSON.stringify({
        platform: input.platform ?? null,
        source: input.source ?? null,
        graph: input.admission
            ? {
                artifactId: input.admission.artifactGraph.artifactId,
                tier: input.admission.artifactGraph.tier,
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
): PluginUiArtifactsManifestEntryV2 | null {
    if (contribution?.generatedV2 !== true) return null;
    const parsed = PluginUiArtifactsManifestEntryV2Schema.safeParse(contribution.artifactGraph);
    return parsed.success ? parsed.data : null;
}

export function readPluginUiHostedWebArtifactReadIdentity(
    contribution: Readonly<Record<string, unknown>> | null,
    context: Readonly<{
        pluginId: string;
        contributionId: string;
        artifactId: string;
    }>,
): PluginHostedWebArtifactIdentity | null {
    const parsed = DaemonPluginUiArtifactByteIdentityV1Schema.safeParse(
        readRecord(contribution?.runtime)?.artifactReadIdentity,
    );
    return parsed.success
        ? Object.freeze({ ...context, artifactDigest: parsed.data.artifactDigest, platform: 'web' })
        : null;
}

/**
 * Reads the daemon-projected React Native cache identity through the canonical
 * Protocol schema. The producer validates the same wire member with the same
 * strict schema, so this reader must not admit a shape that producer cannot
 * emit — a looser copy here derives a different cache key for it.
 */
export function readPluginUiReactNativeBundleCacheIdentity(
    value: unknown,
    context: Readonly<{
        pluginId: string;
        contributionId: string;
        artifactId: string;
        platform: 'web' | 'ios' | 'android';
    }>,
): PluginReactNativeBundleCacheIdentity | null {
    const parsed = DaemonPluginUiArtifactByteIdentityV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({ ...context, artifactDigest: parsed.data.artifactDigest }) : null;
}

export function readPluginUiGeneratedReactNativeModuleReference(
    graph: PluginUiArtifactsManifestEntryV2 | null,
    exportName = 'renderSurface',
): PluginReactNativeExecutableModuleReference | undefined {
    if (!graph || graph.tier !== 'reactNative' || !graph.executable.exports.includes(exportName)) return undefined;
    return Object.freeze({ exportName });
}

export function isPluginUiReactNativeArtifactTechnicallyAdmitted(input: Readonly<{
    artifactGraph: PluginUiArtifactsManifestEntryV2 | null;
    cacheIdentity: PluginReactNativeBundleCacheIdentity | null;
    moduleReference: PluginReactNativeExecutableModuleReference | undefined;
}>): boolean {
    return input.artifactGraph !== null
        && input.cacheIdentity !== null
        && input.cacheIdentity.artifactDigest === input.artifactGraph.digest
        && input.cacheIdentity.artifactId === input.artifactGraph.artifactId
        && input.artifactGraph.tier === 'reactNative'
        && input.moduleReference !== undefined;
}

export type PluginUiRendererTechnicalAdmission<SourceAdmission> =
    | Readonly<{
        kind: 'available';
        sourceAdmission: SourceAdmission;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'artifact_technical_admission_unavailable' | 'required_host_methods_unavailable';
    }>;

/**
 * The one pure renderer-admission composition for the platform-specific
 * source facts and the mount's structural host-method contract. Live served
 * methods remain transport facts: a transient daemon outage must not cause one
 * renderer family to de-admit while the other remains mounted.
 */
export function resolvePluginUiRendererTechnicalAdmission<SourceAdmission>(input: Readonly<{
    requiredHostMethods: readonly PluginUiHostMethodV1[] | null;
    structuralHostMethods: readonly PluginUiHostMethodV1[];
    /** Evaluated only after the shared structural contract is satisfied. */
    resolveSourceAdmission: () => SourceAdmission | null;
}>): PluginUiRendererTechnicalAdmission<SourceAdmission> {
    const requiredHostMethods = input.requiredHostMethods ?? [];
    if (!requiredHostMethods.every((method) => input.structuralHostMethods.includes(method))) {
        return Object.freeze({ kind: 'unavailable', code: 'required_host_methods_unavailable' });
    }
    const sourceAdmission = input.resolveSourceAdmission();
    if (sourceAdmission === null) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_technical_admission_unavailable' });
    }
    return Object.freeze({ kind: 'available', sourceAdmission });
}

export type PluginUiReactNativeInstalledArtifactLoadInput = Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    artifactGraph: PluginUiArtifactsManifestEntryV2;
    reader: PluginAccountAvailabilityReader;
    accountLifetime: ActiveServerAccountScopeLifetime;
    daemon?: PluginUiArtifactDaemonSource;
    daemonProjectionSelection?: PluginArtifactDaemonProjectionSelectionInput;
    moduleReference: PluginReactNativeExecutableModuleReference | undefined;
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
            ...(input.daemon ? { daemon: input.daemon } : {}),
            ...(input.daemonProjectionSelection
                ? { daemonProjectionSelection: input.daemonProjectionSelection }
                : {}),
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
            if (result.ok) {
                if (!acquired.adoption.commit()) {
                    return throwReactNativeArtifactLoadFailure('artifact_lease_revoked');
                }
                return result.module;
            }
            acquired.adoption.fail(result.code);
            return throwReactNativeArtifactLoadFailure(result.code, result.diagnostics);
        } finally {
            owner.dispose();
        }
    };
}
