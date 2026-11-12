import {
    deriveGeneratedHostedWebAssetPolicyV1,
    type HostedWebAssetPolicyInput,
    type PluginUiArtifactsManifestEntryV2,
    type PluginUiChannelV1,
    type PluginUiHostMethodV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    derivePluginReactNativeBundleCacheKey,
    getInstalledPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import { getInstalledPluginReactNativeModuleRegistry } from '@/components/plugins/reactNative/moduleRegistry';
import {
    loadPluginReactNativeBundleModule,
    type PluginReactNativeLoaderBackend,
    type PluginReactNativeExecutableModuleReference,
} from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeSurfaceModule } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import {
    acquirePluginHostedWebArtifactAvailability,
    acquirePluginHostedWebBrowserArtifactAvailability,
    type PluginHostedWebArtifactIdentity,
    type PluginHostedWebArtifactAvailabilityInput,
} from '@/sync/domains/plugins/availability/hostedWebArtifactLease';
import {
    acquirePluginReactNativeArtifactAvailability,
    type PluginReactNativeArtifactAvailabilityInput,
} from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type {
    PluginArtifactDaemonProjectionSelectionInput,
    PluginArtifactDaemonTransport,
} from '@/sync/domains/plugins/availability/artifactLease';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies } from './projectionUnion';
import { readDaemonPluginUiArtifactByteIdentity, readPluginUiArtifactGraph } from './artifactIdentityRead';
import type { PluginReactNativeBundleCacheIdentity } from './reactNativeRuntime';
import type { PluginAccountHostedArtifactPublicationResult } from '@/sync/domains/plugins/availability/accountHostedArtifactPublication';

type PluginUiArtifactDisposableHandle = Readonly<{
    isCurrent: () => boolean;
    dispose: () => void;
}>;

type PluginUiArtifactAvailabilityResult<Handle extends PluginUiArtifactDisposableHandle> =
    | Readonly<{ kind: 'available'; handle: Handle }>
    | Readonly<{ kind: 'unavailable'; code: string }>;

export type PluginUiArtifactAdoptionKind = 'hostedWebNative' | 'hostedWebBrowser' | 'reactNative';

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

/** Byte routes from the selected renderer; none of these suppliers selects execution. */
export function readPluginUiArtifactDaemonSources(
    contribution: Readonly<Record<string, unknown>> | null,
): readonly PluginUiArtifactDaemonSource[] {
    const sources: PluginUiArtifactDaemonSource[] = [];
    const origin = readPluginUiContributionOrigin(contribution);
    for (const supply of [...(origin ? [origin] : []), ...readPluginUiContributionSupplies(contribution)]) {
        if (!supply.serverId || sources.some(source => source.machineId === supply.machineId && source.serverId === supply.serverId)) continue;
        sources.push(Object.freeze({ machineId: supply.machineId, serverId: supply.serverId }));
    }
    return Object.freeze(sources);
}

export type PluginUiHostedWebArtifactTechnicalAdmission = Readonly<{
    artifactGraph: PluginUiArtifactsManifestEntryV2;
    cacheIdentity: PluginHostedWebArtifactIdentity;
    hostedWebPolicy: HostedWebAssetPolicyInput;
    daemonProjectionSelection?: PluginUiDaemonProjectionSelection;
}>;

export type PluginUiHostedWebNativeArtifactAdoptionInput = Omit<
    PluginHostedWebArtifactAvailabilityInput,
    'daemon' | 'isCurrent' | 'signal'
> & Readonly<{
    daemon?: PluginUiArtifactDaemonSource;
    daemons?: readonly PluginUiArtifactDaemonSource[];
    daemonProjectionSelection?: PluginArtifactDaemonProjectionSelectionInput;
}>;

export type PluginUiReactNativeArtifactAdoptionInput = Omit<
    PluginReactNativeArtifactAvailabilityInput,
    'daemon' | 'isCurrent' | 'signal'
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
        this.pendingAdoption?.dispose?.();
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
        acquire: (signal: AbortSignal) => Promise<PluginUiArtifactAvailabilityResult<Handle>>;
    }>): Promise<PluginUiArtifactAdoptionResult<Kind, Handle>> {
        if (!this.isActive()) return unavailableBecauseRetired();

        const desiredArtifactKey = input.desiredArtifactKey ?? input.kind;
        this.pendingAdoption?.dispose?.();
        const cancellation = new AbortController();
        const pendingAdoption = { desiredArtifactKey, dispose: () => cancellation.abort() };
        this.pendingAdoption = pendingAdoption;
        const incumbent = this.currentConsumer;
        this.disposition = incumbent
            ? Object.freeze({
                kind: 'updating',
                appliedArtifactKey: incumbent.artifactKey,
                desiredArtifactKey,
            })
            : Object.freeze({ kind: 'preparing', desiredArtifactKey });

        const acquired = await input.acquire(cancellation.signal);
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
            cancellation.abort();
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
            acquire: (signal) => acquirePluginHostedWebArtifactAvailability({
                ...availabilityInput,
                ...(daemon
                    ? {
                        daemon,
                    }
                    : {}),
                signal,
                isCurrent: () => !signal.aborted && this.isActive(),
            }),
        });
    }

    public async adoptHostedWebBrowser(
        input: PluginUiHostedWebNativeArtifactAdoptionInput,
    ) {
        return await this.adopt({
            kind: 'hostedWebBrowser' as const,
            desiredArtifactKey: input.cacheIdentity.artifactDigest,
            acquire: (signal) => acquirePluginHostedWebBrowserArtifactAvailability({
                ...input,
                signal,
                isCurrent: () => !signal.aborted && this.isActive(),
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
            acquire: async (signal) => {
                const acquired = await acquirePluginReactNativeArtifactAvailability({
                    ...availabilityInput,
                    ...(daemon
                        ? {
                            daemon,
                        }
                        : {}),
                    signal,
                    isCurrent: () => !signal.aborted && this.isActive(),
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
 * projecting daemon as its byte route. Compatible app-union replicas retain
 * these facts in their renderer supplies without binding machine execution.
 * A direct single-machine projection uses its mount machine as that daemon.
 * Account-selected artifacts return null and continue through Availability.
 */
export function readPluginUiDaemonProjectionSelection(
    contribution: Readonly<Record<string, unknown>> | null,
): PluginUiDaemonProjectionSelection | null {
    if (contribution?.artifactSelectionOwner !== 'daemonProjection') return null;
    const contributionId = readOptionalString(contribution.contributionId);
    if (!contributionId) return null;
    const directOccurrenceId = readOptionalString(contribution.occurrenceId);
    const directReleaseVersion = readOptionalString(contribution.pluginVersion);
    const supply = (!directOccurrenceId || !directReleaseVersion) && contribution.hostCompatibility === 'compatible'
        ? readPluginUiContributionSupplies(contribution).find((candidate) => (
            candidate.phase === 'current'
            && candidate.interactionEnabled
            && candidate.serverId
            && candidate.occurrenceId
            && candidate.pluginVersion
        ))
        : undefined;
    const occurrenceId = supply?.occurrenceId ?? directOccurrenceId;
    const releaseVersion = supply?.pluginVersion ?? directReleaseVersion;
    if (!occurrenceId || !releaseVersion) return null;
    const origin = supply ?? readPluginUiContributionOrigin(contribution);
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
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    source: PluginUiArtifactDaemonSource | null;
    sources?: readonly PluginUiArtifactDaemonSource[];
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
}>): string {
    const sourceMaps = input.admission?.hostedWebPolicy.sourceMaps;
    return JSON.stringify({
        platform: input.platform ?? null,
        executionOrigin: input.executionOrigin ?? null,
        source: input.source ?? null,
        sources: input.sources ?? [],
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
    return readPluginUiArtifactGraph(contribution.artifactGraph);
}

export function readPluginUiHostedWebArtifactReadIdentity(
    contribution: Readonly<Record<string, unknown>> | null,
    context: Readonly<{
        pluginId: string;
        contributionId: string;
        artifactId: string;
    }>,
): PluginHostedWebArtifactIdentity | null {
    const parsed = readDaemonPluginUiArtifactByteIdentity(
        readRecord(contribution?.runtime)?.artifactReadIdentity,
    );
    return parsed
        ? Object.freeze({ ...context, artifactDigest: parsed.artifactDigest, platform: 'web' })
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
    const parsed = readDaemonPluginUiArtifactByteIdentity(value);
    return parsed ? Object.freeze({ ...context, artifactDigest: parsed.artifactDigest }) : null;
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
        code: 'artifact_technical_admission_unavailable';
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'required_host_methods_unavailable';
        missingHostMethods: readonly PluginUiHostMethodV1[];
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
    const missingHostMethods = requiredHostMethods.filter((method) => !input.structuralHostMethods.includes(method));
    if (missingHostMethods.length > 0) {
        return Object.freeze({ kind: 'unavailable', code: 'required_host_methods_unavailable',
            missingHostMethods: Object.freeze(missingHostMethods) });
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
    daemons?: readonly PluginUiArtifactDaemonSource[];
    onAccountHosting?: (completion: Promise<PluginAccountHostedArtifactPublicationResult>) => void;
    daemonProjectionSelection?: PluginArtifactDaemonProjectionSelectionInput;
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
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
): (signal?: AbortSignal) => Promise<PluginReactNativeSurfaceModule> {
    return async (signal) => {
        // Surface renderers of one active digest share an evaluated module; executable
        // exports keep their per-activation namespace in the executable host.
        const moduleRegistry = getInstalledPluginReactNativeModuleRegistry();
        const sharedModuleFence = (input.moduleReference?.exportName ?? 'renderSurface') === 'renderSurface'
            ? moduleRegistry.captureWriteFence(derivePluginReactNativeBundleCacheKey(input.identity))
            : null;
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent: input.isCurrent });
        const retire = () => owner.dispose();
        signal?.addEventListener('abort', retire, { once: true });
        if (signal?.aborted) retire();
        try {
            const acquired = await owner.adoptReactNative({
                reader: input.reader,
                executionOrigin: input.executionOrigin,
                artifactGraph: input.artifactGraph,
                cacheIdentity: input.identity,
                accountLifetime: input.accountLifetime,
                ...(input.daemon ? { daemon: input.daemon } : {}),
                ...(input.daemons ? { daemons: input.daemons } : {}),
                // The short acquisition owner retires after evaluation; hosting
                // belongs to the renderer's actual load/mount cancellation.
                ...(signal ? { accountHostingSignal: signal } : {}),
                ...(input.daemonProjectionSelection
                    ? { daemonProjectionSelection: input.daemonProjectionSelection }
                    : {}),
            });
            if (acquired.kind !== 'available') {
                return throwReactNativeArtifactLoadFailure(acquired.code);
            }
            if (acquired.adoption.handle.accountHosting) input.onAccountHosting?.(acquired.adoption.handle.accountHosting);
            // The module loader cannot be cancelled. Artifact and the bound
            // surface must therefore still be current on both sides of it.
            if (!acquired.adoption.isCurrent()) {
                return throwReactNativeArtifactLoadFailure('artifact_lease_revoked');
            }
            const sharedModule = sharedModuleFence ? moduleRegistry.read(sharedModuleFence.cacheKey) : null;
            const result = sharedModule
                ? Object.freeze({ ok: true as const, module: sharedModule })
                : await moduleRegistry.shareEvaluation(sharedModuleFence, () => loadPluginReactNativeBundleModule({
                    cache: getInstalledPluginReactNativeBundleCache(),
                    identity: input.identity,
                    hostPlatform: input.hostPlatform,
                    ...(input.moduleReference ? { moduleReference: input.moduleReference } : {}),
                    ...(input.backend ? { backend: input.backend } : {}),
                }));
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
            signal?.removeEventListener('abort', retire);
            owner.dispose();
        }
    };
}
