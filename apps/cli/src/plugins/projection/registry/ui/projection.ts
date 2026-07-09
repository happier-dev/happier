import { createHash } from 'node:crypto';

import type { PluginUiArtifactTrustRootV1 } from '@happier-dev/protocol';
import {
    isRenderableHostRendererId,
    PLUGIN_SURFACE_REGISTRY,
    type PluginSurfaceRuntimeModeV1,
} from '@happier-dev/protocol/plugins/ui';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import {
    validateInstalledEmbeddedWebBundleArtifact,
    type EmbeddedWebBundleHostRuntime,
} from '@/plugins/install/ui/embeddedWebBundles';
import {
    resolvePluginUiArtifactVerifiedSignatureTrust,
    type PluginUiArtifactExecutionTrust,
} from '@/plugins/install/ui/artifactSigning';
import { resolveTrustedSourceReason } from '@/plugins/install/ui/trustedSource';
import type {
    ReactNativeBundleHostRuntime,
} from '@/plugins/install/ui/reactNativeBundles';
import {
    createPluginUiArtifactRevocationState,
    mergePluginUiArtifactRevocationStates,
} from '@/plugins/install/ui/revocation';
import type { PluginUiArtifactRevocationState } from '@/plugins/install/ui/revocation';
import type {
    ResolvedEmbeddedWebBundleContribution,
    ResolvedContributionRegistry,
    ResolvedHostedWebContribution,
    ResolvedReactNativeBundleContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedStructuredMessageContribution,
    ResolvedSurfacePlacementContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiTranslationsContribution,
} from '../types';
import { resolveHostedWebRuntimeBinding } from './hostedWebBuild';
import {
    resolveReactNativeBundleRuntimeProjection,
    type ReactNativeBundleRuntimeProjection,
} from './reactNativeRuntime';
import {
    projectStructuredMessages,
    type StructuredMessageProjectionHostRuntimeContext,
} from './structuredMessages';

type PluginUiProjectedEntry = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: string;
}>;

export type ReactNativeBundleProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
    // Phase 6.3: the `plugins.ui.reactNativeBundles.devHotReload` author gate. A
    // separate kill-switch from the family feature; only authorises the
    // dev-server source for a local plugin on the development channel.
    devHotReloadEnabled?: boolean;
    loaderBackendAvailable?: boolean;
    loaderBackendDiagnostics?: readonly string[];
    revocationState?: PluginUiArtifactRevocationState;
    trustRoots?: readonly PluginUiArtifactTrustRootV1[];
    trustState?: 'full' | 'limited' | 'denied' | 'unknown';
    executionTrustByArtifactDigest?: Readonly<Record<string, PluginUiArtifactExecutionTrust | undefined>>;
    crashDisabledContributionIds?: readonly string[];
    crashDisabledByContributionId?: Readonly<Record<string, boolean>>;
    hostRuntime?: Partial<ReactNativeBundleHostRuntime>;
}>;

export type HostedWebProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
}>;

export type EmbeddedWebBundleProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
    loaderBackendAvailable?: boolean;
    revocationState?: PluginUiArtifactRevocationState;
    trustState?: 'full' | 'limited' | 'denied' | 'unknown';
    trustRoots?: readonly PluginUiArtifactTrustRootV1[];
    crashDisabledContributionIds?: readonly string[];
    crashDisabledByContributionId?: Readonly<Record<string, boolean>>;
    csp?: Readonly<{
        supportsSameOriginModuleUrl: boolean;
        allowsBlobModuleImport: boolean;
    }>;
    hostRuntime?: Partial<EmbeddedWebBundleHostRuntime>;
}>;

export type PluginUiProjectionHostRuntimeContext = Readonly<{
    hostedWeb?: HostedWebProjectionHostRuntimeContext;
    reactNativeBundles?: ReactNativeBundleProjectionHostRuntimeContext;
    embeddedWebBundles?: EmbeddedWebBundleProjectionHostRuntimeContext;
    structuredMessages?: StructuredMessageProjectionHostRuntimeContext;
}>;

function digestJson(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

function addEntry(
    entriesById: Record<string, PluginUiProjectedEntry>,
    entry: PluginUiProjectedEntry,
): void {
    // §13.5.6 id-uniqueness / §10 "no silent drop": the projection is one id-keyed
    // model, so a second contribution sharing an already-projected id (same plugin +
    // kind + descriptorId) would otherwise be a silent last-write-wins overwrite that
    // hides a malformed plugin. Preserve last-write-wins (no behavior change to which
    // record survives) but tag the survivor with a `duplicate_contribution_id`
    // diagnostic so the collision is diagnosable instead of dropped.
    const collides = Object.prototype.hasOwnProperty.call(entriesById, entry.id);
    const projected: PluginUiProjectedEntry = collides
        ? {
            ...entry,
            diagnostics: Object.freeze([
                ...readStringArray(entry.diagnostics),
                'duplicate_contribution_id',
            ]),
        }
        : entry;
    entriesById[entry.id] = Object.freeze(projected);
}

function projectTranslations(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `translations:${pluginId}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'translations',
            defaultLocale: contribution.definition.defaultLocale,
            locales: Object.keys(contribution.definition.locales).sort(),
            bundles: contribution.definition.locales,
        });
    }
}

function projectSessionHeaderActions(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.sessionHeaderActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `sessionHeaderAction:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'sessionHeaderAction',
            descriptorId: contribution.definition.id,
            action: contribution.definition.action,
            display: contribution.definition.display,
            placement: contribution.definition.placement,
            visibility: contribution.definition.visibility,
            enabled: contribution.definition.enabled,
            badge: contribution.definition.badge,
            order: contribution.definition.order,
            compatibility: contribution.definition.compatibility,
        });
    }
}

function hostedWebRuntimeResult(params: Readonly<{
    state: 'available' | 'fallback';
    reason: 'available' | 'feature_disabled' | 'hosted_web_static_artifact_missing';
    diagnostics: readonly string[];
}>): Readonly<Record<string, unknown>> {
    return Object.freeze({
        state: params.state,
        diagnostics: Object.freeze([...params.diagnostics]),
        decision: Object.freeze({
            state: params.state === 'available' ? 'render' : 'fallback',
            reason: params.reason,
            diagnostics: Object.freeze([...params.diagnostics]),
        }),
    });
}

function projectHostedWeb(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    hostRuntimeContext?: HostedWebProjectionHostRuntimeContext,
): void {
    for (const contribution of registry.hostedWeb ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `hostedWeb:${pluginId}:${contribution.definition.id}`;
        const runtimeBinding = resolveHostedWebRuntimeBinding({
            contribution,
            uiArtifacts: registry.uiArtifacts ?? [],
        });
        const featureEnabled = hostRuntimeContext?.featureEnabled === true;
        const runtime = !featureEnabled
            ? hostedWebRuntimeResult({
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            })
            : runtimeBinding.ok
                ? hostedWebRuntimeResult({
                    state: 'available',
                    reason: 'available',
                    diagnostics: runtimeBinding.diagnostics,
                })
                : hostedWebRuntimeResult({
                    state: 'fallback',
                    reason: 'hosted_web_static_artifact_missing',
                    diagnostics: runtimeBinding.diagnostics,
                });
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'hostedWeb',
            contributionId: contribution.definition.id,
            service: contribution.definition.service,
            ...(featureEnabled && runtimeBinding.ok ? { runtimeMode: runtimeBinding.runtimeMode } : {}),
            runtimeDiagnostics: runtime.diagnostics,
            runtime,
            entry: contribution.definition.entry,
            bridge: contribution.definition.bridge,
            sandbox: contribution.definition.sandbox,
            security: contribution.definition.security,
            display: contribution.definition.display,
            compatibility: contribution.definition.compatibility,
            fallback: contribution.definition.fallback,
        });
    }
}

function findReactNativeBundleArtifact(params: Readonly<{
    contribution: ResolvedReactNativeBundleContribution;
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
}>): ResolvedUiArtifactContribution | null {
    const pluginId = readPluginId(params.contribution);
    if (!pluginId) {
        return null;
    }

    const bundle = params.contribution.definition.bundle;
    return params.uiArtifacts.find((artifact) => artifact.pluginId === pluginId
        && artifact.definition.contributionId === params.contribution.definition.id
        && artifact.definition.contributionFamily === 'reactNativeBundles'
        && artifact.definition.artifactKind === 'reactNativeBundle'
        && artifact.definition.platform === bundle.platform
        && artifact.definition.channel === bundle.channel
        && reactNativeArtifactIdentityMatchesBundle(artifact.definition, bundle)) ?? null;
}

function reactNativeArtifactIdentityMatchesBundle(
    artifact: ResolvedUiArtifactContribution['definition'],
    bundle: ResolvedReactNativeBundleContribution['definition']['bundle'],
): boolean {
    const artifactDigest = artifact.integrity?.digest;
    const bundleDigest = bundle.integrity?.digest;
    if (artifactDigest && bundleDigest) {
        return artifactDigest === bundleDigest;
    }
    return artifact.channel === 'development'
        && bundle.channel === 'development'
        && artifact.devUrl !== undefined
        && artifact.assetPath === undefined
        && artifact.url === undefined
        && artifactDigest === undefined
        && bundleDigest === undefined;
}

function toReactNativeExecutableArtifactManifest(
    artifact: ResolvedUiArtifactContribution | null,
): unknown {
    const pluginId = artifact ? readPluginId(artifact) : null;
    if (!artifact || !pluginId) {
        return undefined;
    }

    const { revokedAt: _revokedAt, ...definition } = artifact.definition;
    void _revokedAt;
    return Object.freeze({
        ...definition,
        pluginId,
    });
}

function resolveProjectionHostRuntime(params: Readonly<{
    contribution: ResolvedReactNativeBundleContribution;
    artifact: ResolvedUiArtifactContribution | null;
    generation: number;
    hostRuntime?: Partial<ReactNativeBundleHostRuntime>;
}>): ReactNativeBundleHostRuntime {
    const artifactCompatibility = params.artifact?.definition.compatibility;
    const bundleCompatibility = params.contribution.definition.compatibility;
    const hostRuntime = params.hostRuntime;
    return Object.freeze({
        hostAppVersion: hostRuntime?.hostAppVersion ?? artifactCompatibility?.hostAppVersion ?? '0.0.0',
        hostUiApiVersion: hostRuntime?.hostUiApiVersion ?? artifactCompatibility?.hostUiApiVersion ?? bundleCompatibility.hostUiApiVersion,
        reactVersion: hostRuntime?.reactVersion ?? artifactCompatibility?.reactVersion ?? bundleCompatibility.reactVersion,
        reactNativeVersion: hostRuntime?.reactNativeVersion ?? artifactCompatibility?.reactNativeVersion ?? bundleCompatibility.reactNativeVersion,
        ...(hostRuntime?.expoRuntimeVersion ?? artifactCompatibility?.expoRuntimeVersion
            ? { expoRuntimeVersion: hostRuntime?.expoRuntimeVersion ?? artifactCompatibility?.expoRuntimeVersion }
            : {}),
        ...(hostRuntime?.hermesVersion ?? artifactCompatibility?.hermesVersion
            ? { hermesVersion: hostRuntime?.hermesVersion ?? artifactCompatibility?.hermesVersion }
            : {}),
        platform: hostRuntime?.platform ?? params.artifact?.definition.platform ?? params.contribution.definition.bundle.platform,
        channel: hostRuntime?.channel ?? params.artifact?.definition.channel ?? params.contribution.definition.bundle.channel,
        availableNativeCapabilities: Object.freeze([
            ...(hostRuntime?.availableNativeCapabilities ?? artifactCompatibility?.nativeCapabilities ?? []),
        ]),
        projectionGeneration: hostRuntime?.projectionGeneration ?? params.generation,
    });
}

function collectRevokedReactNativeBundleDigests(
    uiArtifacts: readonly ResolvedUiArtifactContribution[],
): ReadonlySet<string> {
    const revokedDigests = new Set<string>();
    for (const artifact of uiArtifacts) {
        if (
            artifact.definition.contributionFamily === 'reactNativeBundles'
            && artifact.definition.artifactKind === 'reactNativeBundle'
            && artifact.definition.revokedAt
            && artifact.definition.integrity
        ) {
            revokedDigests.add(artifact.definition.integrity.digest);
        }
    }
    return revokedDigests;
}

function findEmbeddedWebBundleArtifact(params: Readonly<{
    contribution: ResolvedEmbeddedWebBundleContribution;
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
}>): ResolvedUiArtifactContribution | null {
    const pluginId = readPluginId(params.contribution);
    if (!pluginId) {
        return null;
    }

    const bundle = params.contribution.definition.bundle;
    const bundleDigest = bundle.integrity?.digest;
    if (!bundleDigest) {
        return null;
    }

    return params.uiArtifacts.find((artifact) => {
        const artifactDigest = artifact.definition.integrity?.digest;
        return artifact.pluginId === pluginId
            && artifact.definition.contributionId === params.contribution.definition.id
            && artifact.definition.contributionFamily === 'embeddedWebBundles'
            && artifact.definition.artifactKind === 'embeddedWebBundle'
            && artifact.definition.platform === bundle.platform
            && artifact.definition.channel === bundle.channel
            && artifactDigest !== undefined
            && artifactDigest === bundleDigest;
    }) ?? null;
}

function toEmbeddedWebExecutableArtifactManifest(
    artifact: ResolvedUiArtifactContribution | null,
): unknown {
    const pluginId = artifact ? readPluginId(artifact) : null;
    if (!artifact || !pluginId) {
        return undefined;
    }

    const { revokedAt: _revokedAt, ...definition } = artifact.definition;
    void _revokedAt;
    return Object.freeze({
        ...definition,
        pluginId,
    });
}

function collectRevokedEmbeddedWebBundleDigests(
    uiArtifacts: readonly ResolvedUiArtifactContribution[],
): ReadonlySet<string> {
    const revokedDigests = new Set<string>();
    for (const artifact of uiArtifacts) {
        if (
            artifact.definition.contributionFamily === 'embeddedWebBundles'
            && artifact.definition.artifactKind === 'embeddedWebBundle'
            && artifact.definition.revokedAt
            && artifact.definition.integrity
        ) {
            revokedDigests.add(artifact.definition.integrity.digest);
        }
    }
    return revokedDigests;
}

/**
 * Phase 6.3: classify the contribution's install provenance into the plugin
 * source bucket the dev-hot-reload scope checks against. First-party/bundled are
 * `internal`; a source the user pointed the CLI at locally carries the real
 * grant `trustPolicy:'local_trusted'` → `local`; remote `marketplace`/`package`
 * archives keep `trustPolicy:'prompt'` and classify as `marketplace`. Keying on
 * the granted trust policy (not `source.kind`) is what keeps a REMOTE archive
 * (`kind:'archive'`, `trustPolicy:'prompt'`) out of the `local` bucket.
 */
function resolveReactNativePluginSource(
    contribution: Readonly<{
        provenance?: string;
        source?: Readonly<{ kind?: string }>;
        sourceSpec?: Readonly<{ trustPolicy?: string }>;
    }>,
): 'local' | 'internal' | 'marketplace' | 'external' {
    if (contribution.provenance === 'first_party' || contribution.source?.kind === 'bundled') {
        return 'internal';
    }
    if (contribution.sourceSpec?.trustPolicy === 'local_trusted') {
        return 'local';
    }
    if (contribution.source?.kind === 'marketplace' || contribution.source?.kind === 'package') {
        return 'marketplace';
    }
    return 'external';
}

function resolveReactNativeArtifactExecutionTrust(params: Readonly<{
    artifact: ResolvedUiArtifactContribution | null;
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext;
    revocationState?: PluginUiArtifactRevocationState;
}>): PluginUiArtifactExecutionTrust | undefined {
    const artifact = params.artifact;
    if (!artifact) {
        return undefined;
    }
    if (!artifact.definition.integrity) {
        return undefined;
    }

    const explicitTrust =
        params.hostRuntimeContext?.executionTrustByArtifactDigest?.[artifact.definition.integrity.digest];
    if (explicitTrust?.kind === 'trustedSource') {
        return explicitTrust;
    }

    if (params.hostRuntimeContext?.trustRoots?.length) {
        const verifiedTrust = resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: toReactNativeExecutableArtifactManifest(artifact),
            trustRoots: params.hostRuntimeContext.trustRoots,
            revocationState: params.revocationState,
        });
        if (verifiedTrust.ok) {
            return verifiedTrust.executionTrust;
        }
    }

    const sourceReason = resolveTrustedSourceReason(artifact);
    const trustState = params.hostRuntimeContext?.trustState ?? (sourceReason ? 'full' : 'denied');
    if (trustState !== 'full') {
        return undefined;
    }

    return Object.freeze({
        kind: 'trustedSource',
        reason: sourceReason ?? 'host_runtime',
    });
}

function resolveEmbeddedWebTrustState(
    contribution: ResolvedEmbeddedWebBundleContribution,
): 'full' | 'denied' {
    // §2.2 / §5.1: install + enable = trust for LOCAL render. First-party,
    // bundled, explicitly-local-trusted, and local/user-installed (`path` /
    // `archive`) sources derive full trust without a signature. Remote
    // (`marketplace` / `package`) sources stay denied here unless the artifact
    // verifier resolves a signature-backed execution trust through host trust
    // roots. A host-asserted `trustState:'full'` alone is not executable proof.
    return resolveTrustedSourceReason(contribution) ? 'full' : 'denied';
}

function resolveEmbeddedWebArtifactExecutionTrust(params: Readonly<{
    artifact: ResolvedUiArtifactContribution | null;
    hostRuntimeContext?: EmbeddedWebBundleProjectionHostRuntimeContext;
    revocationState?: PluginUiArtifactRevocationState;
}>): PluginUiArtifactExecutionTrust | undefined {
    const artifact = params.artifact;
    if (!artifact?.definition.integrity) {
        return undefined;
    }
    if (params.hostRuntimeContext?.trustRoots?.length) {
        const verifiedTrust = resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: toEmbeddedWebExecutableArtifactManifest(artifact),
            trustRoots: params.hostRuntimeContext.trustRoots,
            revocationState: params.revocationState,
        });
        if (verifiedTrust.ok) {
            return verifiedTrust.executionTrust;
        }
    }

    const sourceReason = resolveTrustedSourceReason(artifact);
    if (!sourceReason) {
        return undefined;
    }
    return Object.freeze({
        kind: 'trustedSource',
        reason: sourceReason,
        sourceKind: artifact.source?.kind,
    });
}

function resolveEmbeddedWebProjectionHostRuntime(params: Readonly<{
    contribution: ResolvedEmbeddedWebBundleContribution;
    artifact: ResolvedUiArtifactContribution | null;
    generation: number;
    hostRuntime?: Partial<EmbeddedWebBundleHostRuntime>;
}>): EmbeddedWebBundleHostRuntime {
    const artifactCompatibility = params.artifact?.definition.compatibility;
    const bundleCompatibility = params.contribution.definition.compatibility;
    const hostRuntime = params.hostRuntime;
    return Object.freeze({
        hostAppVersion: hostRuntime?.hostAppVersion ?? artifactCompatibility?.hostAppVersion ?? bundleCompatibility.hostAppVersion,
        hostUiApiVersion: hostRuntime?.hostUiApiVersion ?? artifactCompatibility?.hostUiApiVersion ?? bundleCompatibility.hostUiApiVersion,
        reactVersion: hostRuntime?.reactVersion ?? artifactCompatibility?.reactVersion ?? bundleCompatibility.reactVersion,
        platform: 'web',
        channel: hostRuntime?.channel ?? params.artifact?.definition.channel ?? params.contribution.definition.bundle.channel,
        projectionGeneration: hostRuntime?.projectionGeneration ?? params.generation,
    });
}

function embeddedWebRuntimeResult(params: Readonly<{
    state: 'loadable' | 'fallback' | 'blocked' | 'disabled';
    reason: 'compatible' | 'fallback_required' | 'pinned_loader_mismatch' | 'artifact_revoked' | 'feature_disabled' | 'trust_denied' | 'crash_disabled' | 'channel_policy_denied' | 'runtime_mismatch' | 'csp_unsupported' | 'unknown';
    diagnostics: readonly string[];
    fallback?: unknown;
    cacheKey?: string;
    cacheIdentity?: unknown;
    csp?: Readonly<{ supportsSameOriginModuleUrl: boolean; allowsBlobModuleImport: boolean }>;
}>): Readonly<Record<string, unknown>> {
    return Object.freeze({
        state: params.state,
        diagnostics: Object.freeze([...params.diagnostics]),
        decision: Object.freeze({
            state: params.state === 'loadable' ? 'load' : params.state,
            reason: params.reason,
            diagnostics: Object.freeze([...params.diagnostics]),
            ...(params.fallback ? { fallback: params.fallback } : {}),
        }),
        ...(params.cacheKey ? { cacheKey: params.cacheKey } : {}),
        ...(params.cacheIdentity ? { cacheIdentity: params.cacheIdentity } : {}),
        ...(params.cacheIdentity && params.state === 'loadable'
            ? {
                loadPolicy: Object.freeze({
                    source: 'installedArtifact',
                    ...(params.csp ? { csp: params.csp } : {}),
                }),
            }
            : {}),
    });
}

function projectEmbeddedWebRuntime(params: Readonly<{
    contribution: ResolvedEmbeddedWebBundleContribution;
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
    revokedDigests: ReadonlySet<string>;
    revocationState: PluginUiArtifactRevocationState;
    generation: number;
    hostRuntimeContext?: EmbeddedWebBundleProjectionHostRuntimeContext;
}>): Readonly<Record<string, unknown>> {
    const pluginId = readPluginId(params.contribution);
    const contributionKey = `${pluginId ?? ''}:${params.contribution.definition.id}`;
    const crashDisabled = params.hostRuntimeContext?.crashDisabledByContributionId?.[contributionKey] === true
        || params.hostRuntimeContext?.crashDisabledByContributionId?.[params.contribution.definition.id] === true
        || params.hostRuntimeContext?.crashDisabledContributionIds?.includes(contributionKey) === true
        || params.hostRuntimeContext?.crashDisabledContributionIds?.includes(params.contribution.definition.id) === true;
    const fallback = params.contribution.definition.fallback;
    if (!fallback) {
        return embeddedWebRuntimeResult({
            state: 'blocked',
            reason: 'fallback_required',
            diagnostics: ['fallback_required'],
        });
    }
    if (params.contribution.definition.entry.mechanism !== 'hostRuntimeFactoryV1') {
        return embeddedWebRuntimeResult({
            state: 'blocked',
            reason: 'pinned_loader_mismatch',
            diagnostics: ['host_runtime_factory_v1_required'],
            fallback,
        });
    }
    if (params.hostRuntimeContext?.featureEnabled !== true) {
        return embeddedWebRuntimeResult({
            state: 'fallback',
            reason: 'feature_disabled',
            diagnostics: ['feature_disabled'],
            fallback,
        });
    }

    const artifact = findEmbeddedWebBundleArtifact({
        contribution: params.contribution,
        uiArtifacts: params.uiArtifacts,
    });
    const executionTrust = resolveEmbeddedWebArtifactExecutionTrust({
        artifact,
        hostRuntimeContext: params.hostRuntimeContext,
        revocationState: params.revocationState,
    });
    const trustState = params.hostRuntimeContext?.trustState ?? resolveEmbeddedWebTrustState(params.contribution);
    if (trustState !== 'full' && !executionTrust) {
        return embeddedWebRuntimeResult({
            state: 'fallback',
            reason: 'trust_denied',
            diagnostics: ['full_trust_plugin_required'],
            fallback,
        });
    }
    if (crashDisabled) {
        return embeddedWebRuntimeResult({
            state: 'disabled',
            reason: 'crash_disabled',
            diagnostics: ['crash_threshold_reached'],
            fallback,
        });
    }

    const csp = Object.freeze(params.hostRuntimeContext?.csp ?? {
        supportsSameOriginModuleUrl: false,
        allowsBlobModuleImport: false,
    });
    if (!csp.supportsSameOriginModuleUrl && !csp.allowsBlobModuleImport) {
        return embeddedWebRuntimeResult({
            state: 'fallback',
            reason: 'csp_unsupported',
            diagnostics: ['csp_unsupported'],
            fallback,
        });
    }

    const validation = validateInstalledEmbeddedWebBundleArtifact({
        artifact: toEmbeddedWebExecutableArtifactManifest(artifact),
        expectedPluginId: pluginId ?? '',
        expectedContributionId: params.contribution.definition.id,
        hostRuntime: resolveEmbeddedWebProjectionHostRuntime({
            contribution: params.contribution,
            artifact,
            generation: params.generation,
            hostRuntime: params.hostRuntimeContext?.hostRuntime,
        }),
        revokedDigests: params.revokedDigests,
        revocationState: params.revocationState,
        executionTrust,
        signatureTrustRoots: params.hostRuntimeContext?.trustRoots,
        sourceKind: artifact?.source?.kind,
    });
    if (!validation.ok) {
        const diagnostics = validation.diagnostics ?? [validation.code];
        return embeddedWebRuntimeResult({
            state: validation.code === 'artifact_revoked' ? 'blocked' : 'fallback',
            reason: validation.code === 'artifact_revoked'
                ? 'artifact_revoked'
                : validation.code === 'runtime_mismatch'
                    ? 'runtime_mismatch'
                    : diagnostics.some((diagnostic) => diagnostic.includes('trust='))
                        ? 'trust_denied'
                    : 'unknown',
            diagnostics,
            fallback,
        });
    }
    if (params.hostRuntimeContext?.loaderBackendAvailable === false) {
        return embeddedWebRuntimeResult({
            state: 'fallback',
            reason: 'unknown',
            diagnostics: ['embedded_web_loader_unavailable'],
            fallback,
        });
    }

    return embeddedWebRuntimeResult({
        state: 'loadable',
        reason: 'compatible',
        diagnostics: [],
        fallback,
        cacheKey: validation.cacheKey,
        cacheIdentity: validation.cacheIdentity,
        csp,
    });
}

// NATIVE-PIPELINE / LEDGER DEC-6 follow-up: a logical `reactNative` surface can
// now carry multiple platform-specific bundle sibling contributions sharing the
// same `id` (see `resolvePluginReactNativeBundleRegistryId` in
// `createResolvedContributionRegistry.ts`). When the connecting client's own
// reported platform (`hostRuntimeContext.hostRuntime.platform`) does not
// disambiguate to exactly one sibling — because it is unreported, or reported
// but matches none of the declared platforms — this diagnostic marks the
// projected entry as honestly unavailable instead of guessing a sibling. This
// is a real, distinct failure mode (ambiguous platform selection), not the
// same as a `runtime_mismatch` version/platform incompatibility on a SINGLE
// resolved artifact.
const REACT_NATIVE_BUNDLE_PLATFORM_UNRESOLVED_DIAGNOSTIC = 'react_native_bundle_platform_unresolved';

function mapReactNativeRuntimeDecisionReason(
    runtime: ReactNativeBundleRuntimeProjection,
): 'compatible' | 'feature_disabled' | 'runtime_mismatch' | 'missing_native_capability' | 'artifact_revoked' | 'crash_disabled' | 'trust_denied' | 'dev_hot_reload_denied' | 'platform_unavailable' | 'unknown' {
    if (runtime.state === 'loadable') {
        return 'compatible';
    }
    if (runtime.diagnostics.includes(REACT_NATIVE_BUNDLE_PLATFORM_UNRESOLVED_DIAGNOSTIC)) {
        return 'platform_unavailable';
    }
    if (runtime.diagnostics.includes('feature_disabled')) {
        return 'feature_disabled';
    }
    if (runtime.diagnostics.includes('dev_hot_reload_denied')) {
        return 'dev_hot_reload_denied';
    }
    if (runtime.diagnostics.includes('runtime_mismatch')) {
        return 'runtime_mismatch';
    }
    if (runtime.diagnostics.includes('missing_native_capability')) {
        return 'missing_native_capability';
    }
    if (runtime.diagnostics.includes('artifact_revoked')) {
        return 'artifact_revoked';
    }
    if (
        runtime.diagnostics.includes('execution_trust_unverified')
        || runtime.diagnostics.includes('signature_verification_unavailable')
        || runtime.diagnostics.includes('signature_required')
        || runtime.diagnostics.includes('signing_key_required')
        || runtime.diagnostics.includes('signature_mismatch')
        || runtime.diagnostics.includes('signing_key_mismatch')
    ) {
        return 'trust_denied';
    }
    if (runtime.diagnostics.includes('crash_threshold_reached')) {
        return 'crash_disabled';
    }
    return 'unknown';
}

function mapReactNativeRuntimeDecisionState(
    runtime: ReactNativeBundleRuntimeProjection,
): 'load' | 'fallback' | 'disabled' | 'blocked' {
    if (runtime.state === 'loadable') {
        return 'load';
    }
    return runtime.state;
}

function projectReactNativeRuntime(params: Readonly<{
    contribution: ResolvedReactNativeBundleContribution;
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
    revokedDigests: ReadonlySet<string>;
    revocationState: PluginUiArtifactRevocationState;
    generation: number;
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext;
    // NATIVE-PIPELINE: true when `params.contribution` is only a REPRESENTATIVE
    // pick among platform siblings sharing the same logical id — the connecting
    // client's platform did not disambiguate to exactly one. The runtime decision
    // must fail honestly-unavailable rather than validate the representative's
    // own platform against itself (which would always spuriously "match").
    platformUnresolved?: boolean;
}>): Readonly<Record<string, unknown>> {
    const pluginId = readPluginId(params.contribution);
    const contributionKey = `${pluginId ?? ''}:${params.contribution.definition.id}`;
    const crashDisabled = params.hostRuntimeContext?.crashDisabledByContributionId?.[contributionKey] === true
        || params.hostRuntimeContext?.crashDisabledByContributionId?.[params.contribution.definition.id] === true
        || params.hostRuntimeContext?.crashDisabledContributionIds?.includes(contributionKey) === true
        || params.hostRuntimeContext?.crashDisabledContributionIds?.includes(params.contribution.definition.id) === true;
    const artifact = params.platformUnresolved
        ? null
        : findReactNativeBundleArtifact({
            contribution: params.contribution,
            uiArtifacts: params.uiArtifacts,
        });
    const runtime: ReactNativeBundleRuntimeProjection = params.platformUnresolved
        ? Object.freeze({
            state: 'fallback',
            diagnostics: Object.freeze([REACT_NATIVE_BUNDLE_PLATFORM_UNRESOLVED_DIAGNOSTIC]),
        })
        : resolveReactNativeBundleRuntimeProjection({
            bundle: {
                pluginId: pluginId ?? '',
                contributionId: params.contribution.definition.id,
                fallback: params.contribution.definition.fallback,
            },
            artifact: toReactNativeExecutableArtifactManifest(artifact),
            hostRuntime: resolveProjectionHostRuntime({
                contribution: params.contribution,
                artifact,
                generation: params.generation,
                hostRuntime: params.hostRuntimeContext?.hostRuntime,
            }),
            featureEnabled: params.hostRuntimeContext?.featureEnabled === true,
            loaderBackendAvailable: params.hostRuntimeContext?.loaderBackendAvailable ?? false,
            loaderBackendDiagnostics: params.hostRuntimeContext?.loaderBackendDiagnostics,
            revokedDigests: params.revokedDigests,
            revocationState: params.revocationState,
            executionTrust: resolveReactNativeArtifactExecutionTrust({
                artifact,
                hostRuntimeContext: params.hostRuntimeContext,
                revocationState: params.revocationState,
            }),
            signatureTrustRoots: params.hostRuntimeContext?.trustRoots,
            crashDisabled,
            devHotReloadEnabled: params.hostRuntimeContext?.devHotReloadEnabled === true,
            pluginSource: resolveReactNativePluginSource(params.contribution),
        });
    const decision = Object.freeze({
        state: mapReactNativeRuntimeDecisionState(runtime),
        reason: mapReactNativeRuntimeDecisionReason(runtime),
        diagnostics: Object.freeze([...runtime.diagnostics]),
        ...(params.contribution.definition.fallback ? { fallback: params.contribution.definition.fallback } : {}),
    });

    const runtimeCacheKey = 'cacheKey' in runtime ? runtime.cacheKey : undefined;
    const runtimeCacheIdentity = 'cacheIdentity' in runtime ? runtime.cacheIdentity : undefined;
    return Object.freeze({
        state: runtime.state,
        diagnostics: Object.freeze([...runtime.diagnostics]),
        decision,
        ...(runtimeCacheKey ? { cacheKey: runtimeCacheKey } : {}),
        ...(runtimeCacheIdentity ? { cacheIdentity: runtimeCacheIdentity } : {}),
        ...(runtime.loadPolicy ? { loadPolicy: runtime.loadPolicy } : {}),
    });
}

type ReactNativeBundlePlatformFamily = Readonly<{
    pluginId: string;
    contributionId: string;
    contributions: readonly ResolvedReactNativeBundleContribution[];
}>;

/**
 * NATIVE-PIPELINE / LEDGER DEC-6 follow-up (item 1): group the registry's
 * `reactNativeBundles` array — which can now legally hold multiple entries
 * sharing the SAME logical `id` as long as each declares a different
 * `bundle.platform` (see `resolvePluginReactNativeBundleRegistryId`) — into one
 * family per `pluginId:id`. This is the ONE place a placement's `renderer`
 * (which references a bare `contributionId`, platform-agnostic by design) gets
 * resolved down to a concrete per-platform bundle.
 */
function groupReactNativeBundleContributionsByLogicalId(
    contributions: readonly ResolvedReactNativeBundleContribution[],
): readonly ReactNativeBundlePlatformFamily[] {
    const familiesByKey = new Map<string, {
        pluginId: string;
        contributionId: string;
        contributions: ResolvedReactNativeBundleContribution[];
    }>();
    const order: string[] = [];
    for (const contribution of contributions) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const key = `${pluginId}:${contribution.definition.id}`;
        let family = familiesByKey.get(key);
        if (!family) {
            family = { pluginId, contributionId: contribution.definition.id, contributions: [] };
            familiesByKey.set(key, family);
            order.push(key);
        }
        family.contributions.push(contribution);
    }
    return Object.freeze(order.map((key) => {
        const family = familiesByKey.get(key)!;
        return Object.freeze({
            pluginId: family.pluginId,
            contributionId: family.contributionId,
            contributions: Object.freeze([...family.contributions].sort(
                (left, right) => left.definition.bundle.platform.localeCompare(right.definition.bundle.platform),
            )),
        });
    }));
}

/**
 * Selects the sibling contribution matching the connecting client's own
 * reported runtime platform (`hostRuntimeContext.hostRuntime.platform` —
 * populated per-request from the client's `reactNativeHostRuntimeIdentity`,
 * see `apps/cli/src/plugins/projection/registry/ui/hostRuntime.ts`). A family
 * with exactly one declared platform resolves unambiguously regardless of
 * whether the client has reported its platform yet (unchanged, pre-existing
 * single-platform behavior — most plugins declare only one). A family with
 * MULTIPLE declared platforms can only resolve when the connecting platform is
 * known and matches one of them; otherwise selection is genuinely ambiguous
 * and `unresolved: true` signals the caller to fail the runtime decision
 * closed instead of guessing.
 */
function selectReactNativeBundleContributionForConnectingPlatform(
    family: ReactNativeBundlePlatformFamily,
    connectingPlatform: string | undefined,
): Readonly<{ contribution: ResolvedReactNativeBundleContribution; unresolved: boolean }> {
    if (family.contributions.length <= 1) {
        return Object.freeze({ contribution: family.contributions[0]!, unresolved: false });
    }
    const matching = connectingPlatform
        ? family.contributions.find((candidate) => candidate.definition.bundle.platform === connectingPlatform)
        : undefined;
    if (matching) {
        return Object.freeze({ contribution: matching, unresolved: false });
    }
    return Object.freeze({ contribution: family.contributions[0]!, unresolved: true });
}

function projectReactNativeBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    generation: number,
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext,
): void {
    const uiArtifacts = registry.uiArtifacts ?? [];
    const revokedDigests = collectRevokedReactNativeBundleDigests(uiArtifacts);
    const revocationState = mergePluginUiArtifactRevocationStates(
        createPluginUiArtifactRevocationState({ revokedDigests }),
        ...(hostRuntimeContext?.revocationState ? [hostRuntimeContext.revocationState] : []),
    );
    const connectingPlatform = hostRuntimeContext?.hostRuntime?.platform;
    const families = groupReactNativeBundleContributionsByLogicalId(registry.reactNativeBundles ?? []);
    for (const family of families) {
        const { contribution, unresolved } = selectReactNativeBundleContributionForConnectingPlatform(
            family,
            connectingPlatform,
        );
        const id = `reactNativeBundle:${family.pluginId}:${family.contributionId}`;
        addEntry(entriesById, {
            id,
            pluginId: family.pluginId,
            contributionKind: 'reactNativeBundle',
            contributionId: family.contributionId,
            bundle: contribution.definition.bundle,
            entry: contribution.definition.entry,
            compatibility: contribution.definition.compatibility,
            hostApi: contribution.definition.hostApi,
            nativeCapabilities: contribution.definition.nativeCapabilities,
            fallback: contribution.definition.fallback,
            display: contribution.definition.display,
            policy: contribution.definition.policy,
            // Diagnosable, not authoritative: the platforms this logical surface
            // declares a bundle for. `bundle.platform` above is the one actually
            // selected/evaluated for the connecting client.
            availablePlatforms: family.contributions.map((sibling) => sibling.definition.bundle.platform),
            runtime: projectReactNativeRuntime({
                contribution,
                uiArtifacts,
                revokedDigests,
                revocationState,
                generation,
                hostRuntimeContext,
                platformUnresolved: unresolved,
            }),
        });
    }
}

function projectEmbeddedWebBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    generation: number,
    hostRuntimeContext?: EmbeddedWebBundleProjectionHostRuntimeContext,
): void {
    const uiArtifacts = registry.uiArtifacts ?? [];
    const revokedDigests = collectRevokedEmbeddedWebBundleDigests(uiArtifacts);
    const revocationState = mergePluginUiArtifactRevocationStates(
        createPluginUiArtifactRevocationState({ revokedDigests }),
        ...(hostRuntimeContext?.revocationState ? [hostRuntimeContext.revocationState] : []),
    );
    for (const contribution of registry.embeddedWebBundles ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `embeddedWebBundle:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'embeddedWebBundle',
            contributionId: contribution.definition.id,
            bundle: contribution.definition.bundle,
            entry: contribution.definition.entry,
            compatibility: contribution.definition.compatibility,
            hostApi: contribution.definition.hostApi,
            fallback: contribution.definition.fallback,
            display: contribution.definition.display,
            policy: contribution.definition.policy,
            runtime: projectEmbeddedWebRuntime({
                contribution,
                uiArtifacts,
                revokedDigests,
                revocationState,
                generation,
                hostRuntimeContext,
            }),
        });
    }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? Object.freeze(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))
        : Object.freeze([]);
}

function resolveRendererProjectionEntry(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, PluginUiProjectedEntry>>;
}>): PluginUiProjectedEntry | null {
    const contributionId = typeof params.renderer.contributionId === 'string'
        ? params.renderer.contributionId.trim()
        : '';
    if (contributionId.length === 0) {
        return null;
    }
    if (params.renderer.kind === 'hostedWeb') {
        return params.entriesById[contributionId]
            ?? params.entriesById[`hostedWeb:${params.pluginId}:${contributionId}`]
            ?? null;
    }
    if (params.renderer.kind === 'embeddedWeb') {
        return params.entriesById[contributionId]
            ?? params.entriesById[`embeddedWebBundle:${params.pluginId}:${contributionId}`]
            ?? null;
    }
    if (params.renderer.kind === 'reactNative') {
        return params.entriesById[contributionId]
            ?? params.entriesById[`reactNativeBundle:${params.pluginId}:${contributionId}`]
            ?? null;
    }
    return null;
}

function projectSurfaceAvailability(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, PluginUiProjectedEntry>>;
}>): Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}> {
    if (params.renderer.kind === 'host') {
        // PR-12: a `{kind:'host'}` renderer reports `available` only when its
        // renderer id is in the pure protocol set the UI host can actually render
        // through its renderer-id dispatch table. Otherwise it falls back, so
        // projection-availability and the real render path cannot disagree.
        const rendererId = typeof params.renderer.rendererId === 'string'
            ? params.renderer.rendererId
            : null;
        if (isRenderableHostRendererId(rendererId)) {
            return Object.freeze({
                state: 'available',
                reason: 'available',
                diagnostics: Object.freeze([]),
            });
        }
        return Object.freeze({
            state: 'fallback',
            reason: 'host_renderer_unavailable',
            diagnostics: Object.freeze(['host_renderer_unavailable']),
        });
    }

    const entry = resolveRendererProjectionEntry(params);
    if (!entry) {
        return Object.freeze({
            state: 'fallback',
            reason: 'renderer_unavailable',
            diagnostics: Object.freeze(['renderer_unavailable']),
        });
    }

    const runtime = readRecord(entry.runtime);
    const decision = readRecord(runtime?.decision);
    const decisionState = typeof decision?.state === 'string' ? decision.state : '';
    const decisionReason = typeof decision?.reason === 'string' && decision.reason.trim().length > 0
        ? decision.reason
        : 'unknown';
    const diagnostics = readStringArray(decision?.diagnostics);
    if (decisionState === 'render' || decisionState === 'load') {
        return Object.freeze({
            state: 'available',
            reason: 'available',
            diagnostics,
        });
    }
    if (decisionState === 'blocked' || decisionState === 'disabled') {
        return Object.freeze({
            state: decisionState,
            reason: decisionReason,
            diagnostics,
        });
    }
    return Object.freeze({
        state: 'fallback',
        reason: decisionReason,
        diagnostics,
    });
}

const RIGHT_SIDEBAR_RESERVED_TAB_IDS = new Set([
    'git',
    'files',
    'agents',
    'terminal',
    'browser',
    'services',
]);

/**
 * Supported-placement gate (#2.4 / §10 "no silent placeholder"), derived from the
 * Surface Registry (FINALIZATION-PLAN §16 / §10 "no surface knowledge outside the
 * registry"). The registry is the SINGLE SOURCE OF TRUTH: a placement KIND is only
 * honestly mounted when `PLUGIN_SURFACE_REGISTRY` holds a descriptor for it whose
 * `rendererSet` binds at least one live runtime host. There is no parallel
 * hand-maintained placement list — adding/removing a mounted placement is a registry
 * edit, and the projection gate follows automatically.
 *
 * Any schema-accepted-but-UNMOUNTED kind (a future placement enum value with no
 * registry descriptor, or a descriptor whose modes are all excluded so its
 * `rendererSet` is empty) still gates `disabled` + `placement_unmounted` (no silent
 * drop).
 *
 * The gate only ever receives `surfacePlacement` placement kinds (schema-bounded to
 * `PluginSurfacePlacementKindV1`); the registry's two non-placement surface types
 * (`session.headerAction`, `session.structuredMessage`) are projected by their own
 * families and never reach this gate, so deriving from the full registry is
 * behaviorally identical to the prior hand-maintained 16-kind set.
 */
export function isUiMountedSurfacePlacementKind(placement: string): boolean {
    const descriptor = PLUGIN_SURFACE_REGISTRY.get(placement);
    return descriptor !== undefined && Object.keys(descriptor.rendererSet).length > 0;
}

function isRightSidebarPlacement(placement: string): boolean {
    return placement === 'session.rightSidebarTab'
        || placement === 'project.rightSidebarTab'
        || placement === 'app.rightSidebarTab';
}

function rightSidebarScopeForPlacement(placement: string): 'session' | 'project' | 'app' | null {
    if (placement === 'session.rightSidebarTab') return 'session';
    if (placement === 'project.rightSidebarTab') return 'project';
    if (placement === 'app.rightSidebarTab') return 'app';
    return null;
}

function normalizeRightSidebarTabSlug(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
}

function readRightSidebarTabId(value: unknown, fallback: string): string | null {
    const metadata = readRecord(value);
    const tabId = typeof metadata?.tabId === 'string'
        ? normalizeRightSidebarTabSlug(metadata.tabId)
        : null;
    return tabId ?? normalizeRightSidebarTabSlug(fallback);
}

function rightSidebarTabCollisionKey(
    contribution: ResolvedSurfacePlacementContribution,
): string | null {
    const pluginId = readPluginId(contribution);
    const scope = rightSidebarScopeForPlacement(contribution.definition.placement);
    const tabId = readRightSidebarTabId(
        contribution.definition.rightSidebar,
        contribution.definition.id,
    );
    return pluginId && scope && tabId ? `${scope}:${pluginId}:${tabId}` : null;
}

function collectDuplicateRightSidebarTabKeys(
    contributions: readonly ResolvedSurfacePlacementContribution[],
): ReadonlySet<string> {
    const counts = new Map<string, number>();
    for (const contribution of contributions) {
        const key = rightSidebarTabCollisionKey(contribution);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key));
}

/**
 * REG-1: the renderer KIND a surface placement declares maps 1:1 to a Surface
 * Registry runtime MODE. This is the bridge that lets reject-at-projection check
 * the declared render mode against the surface descriptor's `supportedRuntimeModes`.
 */
function resolveRendererProvidedMode(renderer: Readonly<Record<string, unknown>>): PluginSurfaceRuntimeModeV1 | null {
    switch (renderer.kind) {
        case 'host':
            return 'host';
        case 'hostedWeb':
            return 'hostedWeb';
        case 'reactNative':
            return 'reactNative';
        case 'embeddedWeb':
            return 'embeddedWeb';
        default:
            return null;
    }
}

function projectSurfacePlacementAvailability(params: Readonly<{
    pluginId: string;
    placement: string;
    descriptorId: string;
    definition: Readonly<Record<string, unknown>>;
    rightSidebar: unknown;
    rightSidebarCollisionKey: string | null;
    duplicateRightSidebarCollisionKeys: ReadonlySet<string>;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, PluginUiProjectedEntry>>;
}>): Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}> {
    // Supported-placement gate (#2.4): reject accepted-but-unmounted placement
    // kinds before any renderer evaluation so a declared placement the UI does
    // not mount surfaces a diagnostic instead of being silently dropped.
    if (!isUiMountedSurfacePlacementKind(params.placement)) {
        return Object.freeze({
            state: 'disabled',
            reason: 'placement_unmounted',
            diagnostics: Object.freeze(['placement_unmounted']),
        });
    }

    // REG-1: reject-at-projection through the Surface Registry SSOT. The placement
    // contribution is re-validated against the descriptor's `contributionSchema`
    // AND its declared renderer mode against `supportedRuntimeModes`. A schema or
    // mode mismatch surfaces a `surface_contribution_rejected` diagnostic instead
    // of mounting an illegal surface — the registry is the single reject chokepoint
    // (no per-family ad-hoc validation).
    const providedMode = resolveRendererProvidedMode(params.renderer);
    const registryProjection = PLUGIN_SURFACE_REGISTRY.projectContribution(
        params.placement,
        params.definition,
        providedMode ? { providedModes: [providedMode] } : undefined,
    );
    if (registryProjection.status === 'rejected') {
        return Object.freeze({
            state: 'disabled',
            reason: 'surface_contribution_rejected',
            diagnostics: Object.freeze([
                registryProjection.reason,
                ...registryProjection.diagnostics,
            ]),
        });
    }

    if (isRightSidebarPlacement(params.placement)) {
        const tabId = readRightSidebarTabId(params.rightSidebar, params.descriptorId);
        if (tabId && RIGHT_SIDEBAR_RESERVED_TAB_IDS.has(tabId)) {
            return Object.freeze({
                state: 'disabled',
                reason: 'right_sidebar_tab_id_reserved',
                diagnostics: Object.freeze(['right_sidebar_tab_id_reserved']),
            });
        }
        if (
            params.rightSidebarCollisionKey
            && params.duplicateRightSidebarCollisionKeys.has(params.rightSidebarCollisionKey)
        ) {
            return Object.freeze({
                state: 'disabled',
                reason: 'right_sidebar_tab_id_duplicate',
                diagnostics: Object.freeze(['right_sidebar_tab_id_duplicate']),
            });
        }
    }

    return projectSurfaceAvailability({
        pluginId: params.pluginId,
        renderer: params.renderer,
        entriesById: params.entriesById,
    });
}

function projectSurfacePlacements(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const surfacePlacements = registry.surfacePlacements ?? [];
    const duplicateRightSidebarCollisionKeys = collectDuplicateRightSidebarTabKeys(surfacePlacements);
    for (const contribution of surfacePlacements) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const rightSidebarCollisionKey = rightSidebarTabCollisionKey(contribution);
        const id = `surfacePlacement:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'surfacePlacement',
            descriptorId: contribution.definition.id,
            placement: contribution.definition.placement,
            target: contribution.definition.target,
            renderer: contribution.definition.renderer,
            display: contribution.definition.display,
            visibility: contribution.definition.visibility,
            enabled: contribution.definition.enabled,
            featureGate: contribution.definition.featureGate,
            order: contribution.definition.order,
            badge: contribution.definition.badge,
            actions: contribution.definition.actions,
            hostActions: contribution.definition.hostActions,
            fallback: contribution.definition.fallback,
            compatibility: contribution.definition.compatibility,
            rightSidebar: contribution.definition.rightSidebar,
            availability: projectSurfacePlacementAvailability({
                pluginId,
                placement: contribution.definition.placement,
                descriptorId: contribution.definition.id,
                definition: contribution.definition as Readonly<Record<string, unknown>>,
                rightSidebar: contribution.definition.rightSidebar,
                rightSidebarCollisionKey,
                duplicateRightSidebarCollisionKeys,
                renderer: contribution.definition.renderer as Readonly<Record<string, unknown>>,
                entriesById,
            }),
        });
    }
}

function projectUiArtifacts(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.uiArtifacts ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `uiArtifact:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'uiArtifact',
            artifactId: contribution.definition.id,
            contributionId: contribution.definition.contributionId,
            contributionFamily: contribution.definition.contributionFamily,
            artifactKind: contribution.definition.artifactKind,
            platform: contribution.definition.platform,
            channel: contribution.definition.channel,
            integrity: contribution.definition.integrity,
            compatibility: contribution.definition.compatibility,
            byteSize: contribution.definition.byteSize,
            contentType: contribution.definition.contentType,
            assetPath: contribution.definition.assetPath,
            url: contribution.definition.url,
            cacheKey: contribution.definition.cacheKey,
            revokedAt: contribution.definition.revokedAt,
        });
    }
}

function addDigestEntries(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const byPluginId = new Map<string, {
        translations: ResolvedUiTranslationsContribution[];
        structuredMessages: ResolvedStructuredMessageContribution[];
        sessionHeaderActions: ResolvedSessionHeaderActionContribution[];
        surfacePlacements: ResolvedSurfacePlacementContribution[];
        hostedWeb: ResolvedHostedWebContribution[];
        embeddedWebBundles: ResolvedEmbeddedWebBundleContribution[];
        reactNativeBundles: ResolvedReactNativeBundleContribution[];
        uiArtifacts: ResolvedUiArtifactContribution[];
    }>();

    function bucket(pluginId: string) {
        const existing = byPluginId.get(pluginId);
        if (existing) {
            return existing;
        }
        const created = {
            translations: [],
            structuredMessages: [],
            sessionHeaderActions: [],
            surfacePlacements: [],
            hostedWeb: [],
            embeddedWebBundles: [],
            reactNativeBundles: [],
            uiArtifacts: [],
        };
        byPluginId.set(pluginId, created);
        return created;
    }

    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).translations.push(contribution);
    }
    for (const contribution of registry.structuredMessages ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).structuredMessages.push(contribution);
    }
    for (const contribution of registry.sessionHeaderActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).sessionHeaderActions.push(contribution);
    }
    for (const contribution of registry.surfacePlacements ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).surfacePlacements.push(contribution);
    }
    for (const contribution of registry.hostedWeb ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).hostedWeb.push(contribution);
    }
    for (const contribution of registry.embeddedWebBundles ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).embeddedWebBundles.push(contribution);
    }
    for (const contribution of registry.reactNativeBundles ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).reactNativeBundles.push(contribution);
    }
    for (const contribution of registry.uiArtifacts ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).uiArtifacts.push(contribution);
    }

    for (const [pluginId, contributions] of [...byPluginId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const id = `digest:${pluginId}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'digest',
            digest: digestJson(contributions),
            families: Object.fromEntries(
                Object.entries(contributions).map(([family, familyContributions]) => [
                    family,
                    digestJson(familyContributions),
                ]),
            ),
        });
    }
}

export const pluginUiProjectionFamily = definePluginProjectionFamilyV2({
    family: 'pluginUi',
    project({ registry, generation, pluginUiHostRuntime }) {
        const hostRuntime = pluginUiHostRuntime as PluginUiProjectionHostRuntimeContext | undefined;
        const entriesById: Record<string, PluginUiProjectedEntry> = {};
        projectTranslations(registry, entriesById);
        projectStructuredMessages(registry, entriesById, hostRuntime?.structuredMessages);
        projectSessionHeaderActions(registry, entriesById);
        projectHostedWeb(registry, entriesById, hostRuntime?.hostedWeb);
        projectEmbeddedWebBundles(registry, entriesById, generation, hostRuntime?.embeddedWebBundles);
        projectReactNativeBundles(registry, entriesById, generation, hostRuntime?.reactNativeBundles);
        projectSurfacePlacements(registry, entriesById);
        projectUiArtifacts(registry, entriesById);
        addDigestEntries(registry, entriesById);

        return {
            family: 'pluginUi',
            entriesById,
        };
    },
});
