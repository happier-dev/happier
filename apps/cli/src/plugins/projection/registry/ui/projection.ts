import {
    PluginMachineExecutionOriginV1Schema,
    PluginUiResourceBindingCapabilityV1Schema,
    DaemonHostedWebFrameCapabilityV1Schema,
    type DaemonHostedWebFrameCapabilityV1,
    type DaemonPluginHostedWebArtifactCacheIdentityV1,
    type DaemonPluginReactNativeCrashMountV1,
    type DaemonPluginReactNativeCrashStateV1,
    type PluginMachineExecutionOriginV1,
    type PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';
import {
    normalizePluginUiDestinationBindingV1,
    isPluginUiDestinationBindingPotentiallySupportedOnPlatformV1,
    normalizePluginSessionHeaderActionDescriptorV1,
    normalizePluginUiSemanticCommandV1,
    normalizePluginUiSettingsPageBindingV1,
    PLUGIN_UI_HOST_API_VERSION_V1,
    deriveGeneratedHostedWebAssetPolicyV1,
    PluginUiDestinationBindingV1Schema,
    PluginUiPlatformV1Schema,
    selectPluginUiDestinationBindingRendererV1,
    type PluginUiArtifactsManifestEntryV1,
    type PluginUiDestinationBindingV1,
} from '@happier-dev/protocol/plugins/ui';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { createReactNativeCrashStateBindingKey } from '@/plugins/runtime/ui/reactNativeCrashDisableState';
import {
    deriveReactNativeBundleRuntimeCacheKey,
    deriveReactNativeNativeCapabilitiesDigest,
    type ReactNativeBundleCacheIdentity,
    type ReactNativeBundleHostRuntime,
} from '@/plugins/install/ui/reactNativeBundles';
import type {
    ResolvedContributionRegistry,
    ResolvedUiRendererV2Contribution,
    ResolvedUiSettingsGroupV2Contribution,
    ResolvedUiSettingsPageV2Contribution,
    ResolvedUiTranslationBundleV2Contribution,
    ResolvedUiViewV2Contribution,
} from '../types';
import {
    collectResolvedGeneratedHostedWebArtifactOwners,
    findGeneratedHostedWebArtifactEntry,
    collectResolvedGeneratedReactNativeArtifactOwners,
    findResolvedGeneratedReactNativeClientContributionArtifactOwner,
    findGeneratedReactNativeArtifactEntry,
} from './generatedUiArtifactOwners';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import { generatedUiArtifactCompatibilityFailure } from './artifactCompatibility';

export type PluginUiProjectedEntry = Readonly<Record<string, unknown> & {
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
    /** Present only on daemon-produced live projections; an absent binding fails closed. */
    crashStatesByBindingKey?: Readonly<Record<string, DaemonPluginReactNativeCrashStateV1 | undefined>>;
    hostRuntime?: Partial<ReactNativeBundleHostRuntime>;
}>;

export type HostedWebProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
    /** Exact physical hosted-frame fact, reported by the UI host probe. */
    frameCapability?: DaemonHostedWebFrameCapabilityV1;
}>;

export type DeclarativeProjectionHostRuntimeContext = Readonly<{
    modelsByRendererKey?: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
}>;

export type PluginUiProjectionHostRuntimeContext = Readonly<{
    hostedWeb?: HostedWebProjectionHostRuntimeContext;
    declarative?: DeclarativeProjectionHostRuntimeContext;
    reactNativeBundles?: ReactNativeBundleProjectionHostRuntimeContext;
    /** The canonical admitted Resource owner, injected only by daemon projection. */
    resourceCapabilityForPlugin?: (pluginId: string) => PluginUiResourceBindingCapabilityV1;
}>;

const NO_PLUGIN_UI_RESOURCE_CAPABILITY = Object.freeze({
    readable: false,
    dynamic: false,
} satisfies PluginUiResourceBindingCapabilityV1);

function projectPluginUiResourceCapability(
    pluginId: string,
    hostRuntime: PluginUiProjectionHostRuntimeContext | undefined,
): PluginUiResourceBindingCapabilityV1 {
    try {
        const capability = hostRuntime?.resourceCapabilityForPlugin?.(pluginId);
        const parsed = PluginUiResourceBindingCapabilityV1Schema.safeParse(capability);
        return parsed.success
            ? Object.freeze({ ...parsed.data })
            : NO_PLUGIN_UI_RESOURCE_CAPABILITY;
    } catch {
        return NO_PLUGIN_UI_RESOURCE_CAPABILITY;
    }
}

function projectSurfaceResourceRuntime(
    pluginId: string,
    hostRuntime: PluginUiProjectionHostRuntimeContext | undefined,
    crashState?: DaemonPluginReactNativeCrashStateV1,
): Readonly<{
    resourceCapability: PluginUiResourceBindingCapabilityV1;
    reactNativeCrashState?: DaemonPluginReactNativeCrashStateV1;
}> {
    return Object.freeze({
        resourceCapability: projectPluginUiResourceCapability(pluginId, hostRuntime),
        ...(crashState ? { reactNativeCrashState: crashState } : {}),
    });
}

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

function addEntry(
    entriesById: Record<string, PluginUiProjectedEntry>,
    entry: PluginUiProjectedEntry,
): void {
    // The resolved registry rejects live duplicate bindings before projection. Keep
    // this direct-input guard so an invalid synthetic registry cannot silently choose
    // a projection-order survivor.
    if (Object.prototype.hasOwnProperty.call(entriesById, entry.id)) {
        throw new Error(`Duplicate projected plugin UI contribution '${entry.id}'`);
    }
    entriesById[entry.id] = Object.freeze(entry);
}

/**
 * F7's exact materialization stamp is applied once after every UI entry has
 * been projected. The projection lease owns the map; this family neither
 * rebuilds it from paths nor substitutes a machine-level identity when it is
 * unavailable.
 */
function stampEntriesWithExecutionOrigins(
    entriesById: Record<string, PluginUiProjectedEntry>,
    originsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>> | undefined,
): void {
    if (!originsByPluginId) return;
    for (const [entryId, entry] of Object.entries(entriesById)) {
        const pluginId = readPluginId(entry);
        if (!pluginId) continue;
        const parsedOrigin = PluginMachineExecutionOriginV1Schema.safeParse(originsByPluginId[pluginId]);
        if (!parsedOrigin.success || parsedOrigin.data.materializationRef.pluginId !== pluginId) continue;
        entriesById[entryId] = Object.freeze({
            ...entry,
            serverIdentityId: parsedOrigin.data.serverIdentityId,
            materializationRef: Object.freeze({ ...parsedOrigin.data.materializationRef }),
        });
    }
}

function projectTranslations(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const v2ByPluginId = new Map<string, ResolvedUiTranslationBundleV2Contribution[]>();
    const sortedV2 = [...(registry.uiTranslationsV2 ?? [])].sort((left, right) => {
        const leftPluginId = readPluginId(left) ?? '';
        const rightPluginId = readPluginId(right) ?? '';
        if (leftPluginId !== rightPluginId) return leftPluginId.localeCompare(rightPluginId);
        if (left.definition.locale !== right.definition.locale) {
            return left.definition.locale.localeCompare(right.definition.locale);
        }
        const leftOwner = `${left.manifestPath ?? ''}\0${JSON.stringify(left.definition)}`;
        const rightOwner = `${right.manifestPath ?? ''}\0${JSON.stringify(right.definition)}`;
        return leftOwner.localeCompare(rightOwner);
    });
    for (const contribution of sortedV2) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) continue;
        const contributions = v2ByPluginId.get(pluginId) ?? [];
        contributions.push(contribution);
        v2ByPluginId.set(pluginId, contributions);
    }
    for (const [pluginId, contributions] of [...v2ByPluginId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const bundles: Record<string, Readonly<Record<string, string>>> = {};
        const duplicateLocales = new Set<string>();
        for (const contribution of contributions) {
            const locale = contribution.definition.locale;
            if (Object.hasOwn(bundles, locale)) duplicateLocales.add(locale);
            bundles[locale] = Object.freeze(Object.fromEntries(
                Object.entries(contribution.definition.messages).sort(([left], [right]) => left.localeCompare(right)),
            ));
        }
        addEntry(entriesById, {
            id: `translations:${pluginId}`,
            pluginId,
            contributionKind: 'translations',
            locales: Object.freeze(Object.keys(bundles).sort()),
            bundles: Object.freeze(bundles),
            ...(duplicateLocales.size > 0
                ? { diagnostics: Object.freeze(['duplicate_translation_locale']) }
                : {}),
        });
    }

    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId || v2ByPluginId.has(pluginId)) {
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
        const normalized = normalizePluginSessionHeaderActionDescriptorV1({
            pluginId,
            descriptor: contribution.definition,
        });
        if (!normalized) {
            continue;
        }
        const id = `sessionHeaderAction:${pluginId}:${normalized.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'sessionHeaderAction',
            descriptorId: normalized.id,
            title: normalized.title,
            description: normalized.description,
            icon: normalized.icon,
            order: normalized.order,
            action: normalized.action,
            availability: normalized.availability,
        });
    }
}

/**
 * Projects the declared, same-plugin transcript-tail Resource binding. The
 * generic UI Resource consumer retains snapshot validation and lifecycle;
 * this cold projection only preserves the manifest-qualified descriptor.
 */
function projectTranscriptActivities(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.transcriptActivities ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId
            || contribution.identity.pluginId !== pluginId
            || contribution.identity.localId !== contribution.definition.id) {
            continue;
        }
        const definition = contribution.definition;
        addEntry(entriesById, {
            id: `transcriptActivity:${pluginId}:${definition.id}`,
            pluginId,
            contributionKind: 'transcriptActivity',
            descriptorId: definition.id,
            resource: Object.freeze({ pluginId, localId: definition.resourceId }),
            actions: Object.freeze(definition.actions.map((localId) => Object.freeze({ pluginId, localId }))),
        });
    }
}

function hostedWebRuntimeResult(params: Readonly<{
    state: 'available' | 'fallback';
    reason:
        | 'available'
        | 'feature_disabled'
        | 'hosted_web_static_artifact_missing'
        | 'hosted_web_frame_adapter_unavailable';
    diagnostics: readonly string[];
    artifactReadIdentity?: DaemonPluginHostedWebArtifactCacheIdentityV1;
}>): Readonly<Record<string, unknown>> {
    return Object.freeze({
        state: params.state,
        diagnostics: Object.freeze([...params.diagnostics]),
        decision: Object.freeze({
            state: params.state === 'available' ? 'render' : 'fallback',
            reason: params.reason,
            diagnostics: Object.freeze([...params.diagnostics]),
        }),
        ...(params.artifactReadIdentity ? { artifactReadIdentity: params.artifactReadIdentity } : {}),
    });
}

/**
 * A reported physical-frame capability admits only that local frame transport.
 * It does not stand in for Artifact hosting, an endpoint, Account eligibility,
 * or a browser origin; those remain separate downstream owners.
 */
function hasHostedWebFrameAdapter(
    hostRuntimeContext: HostedWebProjectionHostRuntimeContext | undefined,
): boolean {
    return DaemonHostedWebFrameCapabilityV1Schema.safeParse(
        hostRuntimeContext?.frameCapability,
    ).success;
}
function projectGeneratedHostedWebRenderers(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    generation: number,
    hostRuntimeContext?: HostedWebProjectionHostRuntimeContext,
): ReadonlySet<string> {
    const ownedContributionKeys = new Set<string>();
    for (const owner of collectResolvedGeneratedHostedWebArtifactOwners(registry)) {
        const pluginId = owner.pluginId;
        const contributionId = owner.contributionId;
        ownedContributionKeys.add(`${pluginId}\0${contributionId}`);
        const resolved = findGeneratedHostedWebArtifactEntry({ owner });
        const artifact = resolved.entry;
        const hostedWebPolicy = artifact
            ? deriveGeneratedHostedWebAssetPolicyV1(artifact)
            : null;
        const featureEnabled = hostRuntimeContext?.featureEnabled === true;
        const graphValid = Boolean(
            artifact
            && hostedWebPolicy
            && artifact.hostUiApiVersion === PLUGIN_UI_HOST_API_VERSION_V1,
        );
        const failure = !graphValid
            ? 'hosted_web_static_artifact_missing'
            : !featureEnabled
                ? 'feature_disabled'
                : null;
        const artifactReadIdentity: DaemonPluginHostedWebArtifactCacheIdentityV1 | undefined =
            graphValid && featureEnabled && artifact
                ? Object.freeze({
                    pluginId,
                    contributionId,
                    artifactDigest: artifact.digest,
                    platform: 'web',
                    projectionGeneration: generation,
                })
                : undefined;
        const runtime = failure
            ? hostedWebRuntimeResult({ state: 'fallback', reason: failure, diagnostics: [failure] })
            : !hasHostedWebFrameAdapter(hostRuntimeContext)
                ? hostedWebRuntimeResult({
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                    diagnostics: ['hosted_web_frame_adapter_unavailable'],
                    ...(artifactReadIdentity ? { artifactReadIdentity } : {}),
                })
                : hostedWebRuntimeResult({
                    state: 'available',
                    reason: 'available',
                    diagnostics: [],
                    ...(artifactReadIdentity ? { artifactReadIdentity } : {}),
                });
        // Generated V2 hosted web carries every Host API call in the one
        // canonical `hostApi` wire wrapper.
        const allowedMessages = Object.freeze(['ready' as const, 'hostApi' as const]);
        addEntry(entriesById, {
            id: `hostedWeb:${pluginId}:${contributionId}`,
            pluginId,
            pluginVersion: owner.pluginVersion ?? '0.0.0',
            contributionKind: 'hostedWeb',
            contributionId,
            generatedV2: true,
            requiredHostMethods: owner.requiredHostMethods,
            source: owner.source,
            ...(hostedWebPolicy
                ? {
                    service: Object.freeze({
                        kind: 'staticAssets' as const,
                        assetRootId: hostedWebPolicy.assetRootId,
                    }),
                    entry: Object.freeze({ routeMode: hostedWebPolicy.routeMode, path: '/' }),
                    security: hostedWebPolicy.security,
                }
                : {}),
            bridge: Object.freeze({ allowedMessages }),
            sandbox: Object.freeze({
                scripts: true,
                sameOrigin: false,
                popups: false,
                topNavigation: false,
                mixedContent: false,
            }),
            runtimeDiagnostics: runtime.diagnostics,
            ...(artifact ? { artifactGraph: artifact } : {}),
            runtime,
        });
    }
    return ownedContributionKeys;
}

function generatedReactNativeRuntimeResult(params: Readonly<{
    state: 'loadable' | 'fallback' | 'blocked';
    reason: string;
    diagnostics: readonly string[];
    cacheIdentity?: ReactNativeBundleCacheIdentity;
}>): Readonly<Record<string, unknown>> {
    return Object.freeze({
        state: params.state,
        diagnostics: Object.freeze([...params.diagnostics]),
        decision: Object.freeze({
            state: params.state === 'loadable' ? 'load' : params.state,
            reason: params.reason,
            diagnostics: Object.freeze([...params.diagnostics]),
        }),
        ...(params.cacheIdentity
            ? {
                cacheKey: deriveReactNativeBundleRuntimeCacheKey(params.cacheIdentity),
                cacheIdentity: params.cacheIdentity,
                loadPolicy: Object.freeze({ source: 'installedArtifact' as const }),
            }
            : {}),
    });
}

function generatedReactNativeCompatibilityFailure(params: Readonly<{
    entry: PluginUiArtifactsManifestEntryV1;
    hostRuntime: Partial<ReactNativeBundleHostRuntime> | undefined;
}>): string | null {
    const host = params.hostRuntime;
    if (!host) return 'generated_react_native_host_runtime_unavailable';
    return generatedUiArtifactCompatibilityFailure({
        entry: params.entry,
        hostRuntime: {
            hostUiApiVersion: host.hostUiApiVersion ?? '',
            reactVersion: host.reactVersion ?? '',
            ...(host.reactNativeVersion !== undefined
                ? { reactNativeVersion: host.reactNativeVersion }
                : {}),
            ...(host.expoRuntimeVersion !== undefined
                ? { expoRuntimeVersion: host.expoRuntimeVersion }
                : {}),
            ...(host.hermesVersion !== undefined
                ? { hermesVersion: host.hermesVersion }
                : {}),
        },
    });
}

function projectGeneratedReactNativeBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    generation: number,
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext,
): ReadonlySet<string> {
    const ownedContributionKeys = new Set<string>();
    const clientActionOwners = (registry.actions ?? []).flatMap((action) => {
        if (!action.pluginId || !action.identity) return [];
        const owner = findResolvedGeneratedReactNativeClientContributionArtifactOwner({
            registry,
            action: action.identity,
        });
        return owner ? [owner] : [];
    });
    for (const owner of [
        ...collectResolvedGeneratedReactNativeArtifactOwners(registry),
        ...clientActionOwners,
    ]) {
        const pluginId = owner.pluginId;
        const contributionId = owner.contributionId;
        const requiredHostMethods = owner.kind === 'clientContribution'
            ? Object.freeze([])
            : owner.requiredHostMethods;
        ownedContributionKeys.add(`${pluginId}\0${contributionId}`);

        const resolved = findGeneratedReactNativeArtifactEntry({
            owner,
            platform: hostRuntimeContext?.hostRuntime?.platform,
        });
        const compatibilityFailure = resolved.entry
            ? generatedReactNativeCompatibilityFailure({
                entry: resolved.entry,
                hostRuntime: hostRuntimeContext?.hostRuntime,
            })
            : null;
        const failure = resolved.failure ?? compatibilityFailure;
        const entry = resolved.entry;
        const featureEnabled = hostRuntimeContext?.featureEnabled === true;
        const loaderBackendAvailable = hostRuntimeContext?.loaderBackendAvailable === true;
        const hostRuntime = hostRuntimeContext?.hostRuntime;
        const cacheIdentity: ReactNativeBundleCacheIdentity | undefined =
            entry && entry.platform && !failure && featureEnabled && loaderBackendAvailable && hostRuntime
            ? Object.freeze({
                pluginId,
                contributionId,
                artifactDigest: entry.digest,
                hostAppVersion: hostRuntime.hostAppVersion ?? '0.0.0',
                hostUiApiVersion: entry.hostUiApiVersion,
                reactVersion: entry.compat.react ?? '',
                reactNativeVersion: entry.compat.reactNative ?? '',
                ...(entry.compat.expoRuntime ? { expoRuntimeVersion: entry.compat.expoRuntime } : {}),
                ...(entry.compat.hermes ? { hermesVersion: entry.compat.hermes } : {}),
                platform: entry.platform,
                channel: hostRuntime.channel ?? 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                projectionGeneration: hostRuntime.projectionGeneration ?? generation,
            })
            : undefined;
        const runtime = failure
            ? generatedReactNativeRuntimeResult({
                state: 'blocked',
                reason: failure,
                diagnostics: [failure],
            })
            : !featureEnabled
                ? generatedReactNativeRuntimeResult({
                    state: 'fallback',
                    reason: 'feature_disabled',
                    diagnostics: ['feature_disabled'],
                })
                : !loaderBackendAvailable
                    ? generatedReactNativeRuntimeResult({
                        state: 'fallback',
                        reason: 'loader_backend_unavailable',
                        diagnostics: hostRuntimeContext?.loaderBackendDiagnostics?.length
                            ? hostRuntimeContext.loaderBackendDiagnostics
                            : ['loader_backend_unavailable'],
                    })
                    : generatedReactNativeRuntimeResult({
                        state: 'loadable',
                        reason: 'compatible',
                        diagnostics: [],
                        cacheIdentity,
                    });

        addEntry(entriesById, {
            id: `reactNativeBundle:${pluginId}:${contributionId}`,
            pluginId,
            pluginVersion: owner.pluginVersion ?? '0.0.0',
            contributionKind: 'reactNativeBundle',
            contributionId,
            generatedV2: true,
            generatedOwnerKind: owner.kind,
            requiredHostMethods,
            entry: entry?.repack
                ? Object.freeze({
                    containerName: entry.repack.containerName,
                    modulePath: entry.repack.modulePath,
                    exportName: entry.repack.exportName,
                })
                : Object.freeze({ exportName: 'renderSurface' as const }),
            compatibility: entry
                ? Object.freeze({
                    hostUiApiVersion: entry.hostUiApiVersion,
                    reactVersion: entry.compat.react,
                    reactNativeVersion: entry.compat.reactNative,
                    ...(entry.compat.expoRuntime ? { expoRuntimeVersion: entry.compat.expoRuntime } : {}),
                    ...(entry.compat.hermes ? { hermesVersion: entry.compat.hermes } : {}),
                    supportedPlatforms: Object.freeze([entry.platform]),
                    supportedChannels: Object.freeze([hostRuntimeContext?.hostRuntime?.channel ?? 'internal']),
                    requiredNativeCapabilities: Object.freeze([]),
                })
                : undefined,
            hostApi: Object.freeze({
                minVersion: entry?.hostUiApiVersion ?? PLUGIN_UI_HOST_API_VERSION_V1,
                methods: Object.freeze([...requiredHostMethods]),
            }),
            fallback: Object.freeze({ kind: 'unavailable' as const }),
            ...(entry ? { artifactGraph: entry } : {}),
            runtime,
        });
    }
    return ownedContributionKeys;
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

/** Existing canonical lookup for a renderer's normalized artifact projection. */
export function resolvePluginUiRendererProjectionEntry<
    TEntry extends Readonly<Record<string, unknown>>,
>(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, TEntry>>;
}>): TEntry | null {
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
    if (params.renderer.kind === 'reactNative') {
        return params.entriesById[contributionId]
            ?? params.entriesById[`reactNativeBundle:${params.pluginId}:${contributionId}`]
            ?? null;
    }
    return null;
}

function projectSurfaceAvailability<TEntry extends Readonly<Record<string, unknown>>>(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, TEntry>>;
}>): Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}> {
    const entry = resolvePluginUiRendererProjectionEntry(params);
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

function generatedViewDisplay(view: ResolvedUiViewV2Contribution): Readonly<Record<string, unknown>> {
    const title = view.definition.title;
    const badge = view.definition.badge;
    const projectedBadge = badge === undefined
        ? undefined
        : Object.freeze(typeof badge.label === 'string'
            ? {
                developerFallback: badge.label,
                ...(badge.tone === undefined ? {} : { tone: badge.tone }),
            }
            : {
                labelKey: badge.label.key,
                developerFallback: badge.label.fallback,
                ...(badge.tone === undefined ? {} : { tone: badge.tone }),
            });
    const presentationDefaults = {
        ...(view.definition.icon === undefined ? {} : { iconToken: view.definition.icon }),
        ...(projectedBadge === undefined ? {} : { badge: projectedBadge }),
        ...(view.definition.groupHint === undefined ? {} : { groupHint: view.definition.groupHint }),
        ...(view.definition.rankHint === undefined ? {} : { rankHint: view.definition.rankHint }),
    };
    if (typeof title === 'string') {
        return Object.freeze({
            titleKey: view.definition.id,
            developerFallback: title,
            ...presentationDefaults,
        });
    }
    if (title) {
        return Object.freeze({
            titleKey: title.key,
            developerFallback: title.fallback,
            ...presentationDefaults,
        });
    }
    return Object.freeze({
        titleKey: view.definition.id,
        developerFallback: view.definition.id,
        ...presentationDefaults,
    });
}

function projectGeneratedPageHeaderActions(
    pluginId: string,
    headerActions: ResolvedUiViewV2Contribution['definition']['headerActions'],
): readonly Readonly<Record<string, unknown>>[] {
    const projected: Readonly<Record<string, unknown>>[] = [];
    for (const headerAction of headerActions ?? []) {
        const action = normalizePluginUiSemanticCommandV1({
            pluginId,
            command: headerAction.action,
        });
        if (!action) continue;
        projected.push(Object.freeze({
            id: headerAction.id,
            title: headerAction.title,
            ...(headerAction.description === undefined ? {} : { description: headerAction.description }),
            ...(headerAction.icon === undefined ? {} : { icon: headerAction.icon }),
            ...(headerAction.order === undefined ? {} : { order: headerAction.order }),
            action,
        }));
    }
    return Object.freeze(projected);
}

function generatedRightSidebarMetadata(params: Readonly<{
    rightSidebarScope?: 'session' | 'project' | 'app';
}>): Readonly<Record<string, unknown>> | undefined {
    const scope = params.rightSidebarScope;
    if (!scope) return undefined;
    return Object.freeze({
        scope,
        section: 'plugin' as const,
        lifecycle: Object.freeze({
            retention: 'unmountOnDisable' as const,
            unmountOnGenerationChange: true,
        }),
        disabledPolicy: 'hide' as const,
        collisionPolicy: 'reject' as const,
    });
}

/** Canonical normalized renderer projection reused by destination and targeted mounts. */
export function projectPluginUiRendererRef(
    renderer: ResolvedUiRendererV2Contribution,
    declarativeModel: StablePluginDeclarativeModel | undefined,
): Readonly<{
    rendererRef: Readonly<Record<string, unknown>>;
    registryRendererRef: Readonly<Record<string, unknown>>;
}> {
    const requiredHostMethods = Object.freeze(renderer.definition.kind === 'declarative'
        ? []
        : [...(renderer.definition.requiredHostMethods ?? [])]);
    const rendererRef: Readonly<Record<string, unknown>> = renderer.definition.kind === 'reactNative'
        ? Object.freeze({
            kind: 'reactNative' as const,
            contributionId: renderer.definition.id,
        })
        : renderer.definition.kind === 'hostedWeb'
            ? Object.freeze({
                kind: 'hostedWeb' as const,
                contributionId: renderer.definition.id,
                source: renderer.definition.source,
                requiredHostMethods,
            })
            : Object.freeze({
                kind: 'declarative' as const,
                contributionId: renderer.definition.id,
                ...(declarativeModel ? { model: declarativeModel } : {}),
                ...(renderer.definition.documentSource
                    ? { documentSource: renderer.definition.documentSource }
                    : {}),
            });
    return Object.freeze({
        rendererRef,
        registryRendererRef: renderer.definition.kind === 'hostedWeb'
            ? Object.freeze({
                kind: 'hostedWeb' as const,
                contributionId: renderer.definition.id,
            })
            : rendererRef,
    });
}

/** Canonical renderer availability fact; callers supply no fallback choice. */
export function projectPluginUiRendererAvailability<
    TEntry extends Readonly<Record<string, unknown>>,
>(params: Readonly<{
    pluginId: string;
    renderer: ResolvedUiRendererV2Contribution;
    declarativeModel: StablePluginDeclarativeModel | undefined;
    registryRendererRef: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, TEntry>>;
}>): Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}> {
    if (params.renderer.definition.kind === 'declarative') {
        return params.declarativeModel?.visible === true
            ? Object.freeze({
                state: 'available' as const,
                reason: 'available',
                diagnostics: Object.freeze([]),
            })
            : Object.freeze({
                state: 'fallback' as const,
                reason: params.declarativeModel?.visible === false
                    ? 'declarative_model_hidden'
                    : 'declarative_model_unavailable',
                diagnostics: Object.freeze([
                    params.declarativeModel?.visible === false
                        ? 'declarative_model_hidden'
                        : 'declarative_model_unavailable',
                ]),
            });
    }
    return projectSurfaceAvailability({
        pluginId: params.pluginId,
        renderer: params.registryRendererRef,
        entriesById: params.entriesById,
    });
}

/**
 * A React Native renderer's executable bytes are shared, but crash containment
 * is not: it belongs to this exact projected mount/renderer binding. The
 * daemon supplies the already-reconciled state map; projection only attaches
 * that fact and declines a live RN mount when it is missing.
 */
/**
 * Attaches one exact pre-reconciled crash state to a generated renderer. The
 * mount identity is supplied by the producer; this projection never derives a
 * broader destination or target from a renderer alone.
 */
export function projectPluginUiRendererCrashState(params: Readonly<{
    mount: DaemonPluginReactNativeCrashMountV1;
    renderer: ResolvedUiRendererV2Contribution;
    availability: Readonly<{
        state: 'available' | 'fallback' | 'blocked' | 'disabled';
        reason: string;
        diagnostics: readonly string[];
    }>;
    hostRuntime?: PluginUiProjectionHostRuntimeContext;
}>): Readonly<{
    availability: Readonly<{
        state: 'available' | 'fallback' | 'blocked' | 'disabled';
        reason: string;
        diagnostics: readonly string[];
    }>;
    crashState?: DaemonPluginReactNativeCrashStateV1;
}> {
    if (params.renderer.definition.kind !== 'reactNative') {
        return Object.freeze({ availability: params.availability });
    }
    const statesByBindingKey = params.hostRuntime?.reactNativeBundles?.crashStatesByBindingKey;
    // Projection unit callers that do not represent a daemon live path retain
    // their existing runtime-only assertions. Every daemon projection supplies
    // this map, where a missing exact binding is fail-closed below.
    if (statesByBindingKey === undefined) {
        return Object.freeze({ availability: params.availability });
    }
    const state = statesByBindingKey[createReactNativeCrashStateBindingKey({
        mount: params.mount,
        renderer: params.renderer.identity,
    })];
    if (!state) {
        return Object.freeze({
            availability: params.availability.state === 'available'
                ? Object.freeze({
                    state: 'fallback' as const,
                    reason: 'crash_state_unavailable',
                    diagnostics: Object.freeze(['crash_state_unavailable']),
                })
                : params.availability,
        });
    }
    if (!state.disabled || params.availability.state !== 'available') {
        return Object.freeze({ availability: params.availability, crashState: state });
    }
    return Object.freeze({
        availability: Object.freeze({
            state: 'disabled' as const,
            reason: 'crash_disabled',
            diagnostics: Object.freeze(['crash_threshold_reached']),
        }),
        crashState: state,
    });
}

function projectGeneratedUiSettingsGroups(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const group of registry.uiSettingsGroupsV2 ?? []) {
        const pluginId = readPluginId(group);
        if (!pluginId) continue;
        addEntry(entriesById, {
            id: `settingsGroup:${pluginId}:${group.definition.id}`,
            pluginId,
            pluginVersion: group.pluginVersion ?? '0.0.0',
            contributionKind: 'settingsGroup',
            group: Object.freeze({
                id: Object.freeze({ ...group.identity }),
                title: group.definition.title,
                ...(group.definition.icon ? { icon: group.definition.icon } : {}),
                ...(group.definition.defaultRank === undefined
                    ? {}
                    : { defaultRank: group.definition.defaultRank }),
            }),
        });
    }
}

function projectGeneratedUiSettingsPages(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    declarativeHostRuntime?: DeclarativeProjectionHostRuntimeContext,
    hostRuntime?: PluginUiProjectionHostRuntimeContext,
): void {
    const renderersByKey = new Map<string, ResolvedUiRendererV2Contribution>();
    for (const renderer of registry.uiRenderersV2 ?? []) {
        renderersByKey.set(`${renderer.pluginId}\0${renderer.definition.id}`, renderer);
    }
    for (const page of registry.uiSettingsPagesV2 ?? []) {
        const pluginId = readPluginId(page);
        if (!pluginId) continue;
        const renderer = renderersByKey.get(`${pluginId}\0${page.definition.renderer}`);
        if (!renderer) continue;
        const binding = normalizePluginUiSettingsPageBindingV1({
            pluginId,
            pageId: page.definition.id,
            rendererId: renderer.definition.id,
        });
        if (!binding) continue;
        const declarativeModel = renderer.definition.kind === 'declarative'
            ? declarativeHostRuntime?.modelsByRendererKey?.[`${pluginId}\0${renderer.definition.id}`]
            : undefined;
        const rendererProjection = projectPluginUiRendererRef(renderer, declarativeModel);
        const rendererAvailability = projectPluginUiRendererAvailability({
            pluginId,
            renderer,
            declarativeModel,
            registryRendererRef: rendererProjection.registryRendererRef,
            entriesById,
        });
        const group = page.definition.group.kind === 'host'
            ? Object.freeze({ kind: 'host' as const, id: page.definition.group.id })
            : Object.freeze({
                kind: 'plugin' as const,
                id: Object.freeze({ pluginId, localId: page.definition.group.localId }),
            });
        const crashStateProjection = projectPluginUiRendererCrashState({
            mount: Object.freeze({ kind: 'destination' as const, destination: binding.destination }),
            renderer,
            availability: rendererAvailability,
            hostRuntime,
        });
        addEntry(entriesById, {
            id: `settingsPage:${pluginId}:${page.definition.id}`,
            pluginId,
            pluginVersion: page.pluginVersion ?? renderer.pluginVersion ?? '0.0.0',
            contributionKind: 'settingsPage',
            descriptorId: page.definition.id,
            generatedV2: true,
            page: Object.freeze({
                id: Object.freeze({ ...page.identity }),
                group,
                title: page.definition.title,
                ...(page.definition.subtitle ? { subtitle: page.definition.subtitle } : {}),
                ...(page.definition.keywords ? { keywords: Object.freeze([...page.definition.keywords]) } : {}),
                ...(page.definition.icon ? { icon: page.definition.icon } : {}),
                ...(page.definition.defaultRank === undefined
                    ? {}
                    : { defaultRank: page.definition.defaultRank }),
            }),
            binding,
            renderer: rendererProjection.rendererRef,
            ...(crashStateProjection.crashState
                ? { runtime: Object.freeze({ reactNativeCrashState: crashStateProjection.crashState }) }
                : {}),
            availability: crashStateProjection.availability,
        });
    }
}

function projectGeneratedUiViews(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    declarativeHostRuntime?: DeclarativeProjectionHostRuntimeContext,
    hostRuntime?: PluginUiProjectionHostRuntimeContext,
): void {
    const renderersByKey = new Map<string, ResolvedUiRendererV2Contribution>();
    for (const renderer of registry.uiRenderersV2 ?? []) {
        renderersByKey.set(`${renderer.pluginId}\0${renderer.definition.id}`, renderer);
    }
    for (const view of registry.uiViewsV2 ?? []) {
        const pluginId = view.pluginId;
        const descriptorId = view.definition.id;
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId,
            destinationId: descriptorId,
            rendererId: view.definition.renderer,
            fallbackRendererIds: view.definition.fallbackRenderers,
            availableRendererIds: (registry.uiRenderersV2 ?? [])
                .filter((renderer) => renderer.pluginId === pluginId)
                .map((renderer) => renderer.definition.id),
            container: view.definition.container,
            target: view.definition.target,
            instancePolicy: view.definition.instancePolicy,
        });
        if (!binding) continue;
        const destinationPlatformCandidate = hostRuntime?.reactNativeBundles?.hostRuntime?.platform;
        const destinationPlatform = PluginUiPlatformV1Schema.safeParse(destinationPlatformCandidate);
        const candidateRenderers = binding.rendererChain.flatMap((rendererIdentity) => {
            const renderer = renderersByKey.get(`${pluginId}\0${rendererIdentity.localId}`);
            if (!renderer) return [];
            const declarativeModel = renderer.definition.kind === 'declarative'
                ? declarativeHostRuntime?.modelsByRendererKey?.[`${pluginId}\0${renderer.definition.id}`]
                : undefined;
            const projectedRenderer = projectPluginUiRendererRef(renderer, declarativeModel);
            const rendererAvailability = destinationPlatformCandidate !== undefined
                && (!destinationPlatform.success
                    || !isPluginUiDestinationBindingPotentiallySupportedOnPlatformV1(
                        binding,
                        destinationPlatform.data,
                    ))
                ? Object.freeze({
                    state: 'fallback' as const,
                    reason: 'destination_platform_unavailable',
                    diagnostics: Object.freeze(['destination_platform_unavailable']),
                })
                : projectPluginUiRendererAvailability({
                    pluginId,
                    renderer,
                    declarativeModel,
                    registryRendererRef: projectedRenderer.registryRendererRef,
                    entriesById,
                });
            const crashStateProjection = projectPluginUiRendererCrashState({
                mount: Object.freeze({ kind: 'destination' as const, destination: binding.destination }),
                renderer,
                availability: rendererAvailability,
                hostRuntime,
            });
            return [{
                renderer,
                projectedRenderer,
                availability: crashStateProjection.availability,
                ...(crashStateProjection.crashState
                    ? { crashState: crashStateProjection.crashState }
                    : {}),
            }];
        });
        const primaryCandidate = candidateRenderers[0];
        if (!primaryCandidate) continue;
        // Technical availability belongs to this projection, while declaration
        // order belongs to the Protocol registry. Do not independently choose
        // the first available candidate here: that would turn a projection
        // traversal into a second fallback-chain owner.
        const selectedBinding = selectPluginUiDestinationBindingRendererV1(
            binding,
            candidateRenderers
                .filter((candidate) => candidate.availability.state === 'available')
                .map((candidate) => candidate.renderer.definition.id),
        ) ?? binding;
        const effectiveCandidate = candidateRenderers.find((candidate) => (
            candidate.renderer.definition.id === selectedBinding.renderer.localId
        )) ?? primaryCandidate;
        const display = generatedViewDisplay(view);
        const headerActions = projectGeneratedPageHeaderActions(pluginId, view.definition.headerActions);
        const rightSidebar = generatedRightSidebarMetadata(selectedBinding);
        addEntry(entriesById, {
            id: `surfacePlacement:${pluginId}:${descriptorId}`,
            pluginId,
            pluginVersion: view.pluginVersion ?? effectiveCandidate.renderer.pluginVersion ?? '0.0.0',
            contributionKind: 'surfacePlacement',
            descriptorId,
            generatedV2: true,
            container: selectedBinding.container,
            target: selectedBinding.target,
            binding: selectedBinding,
            renderer: effectiveCandidate.projectedRenderer.rendererRef,
            display,
            actions: Object.freeze([]),
            ...(headerActions.length === 0 ? {} : { headerActions }),
            ...(rightSidebar ? { rightSidebar } : {}),
            runtime: projectSurfaceResourceRuntime(
                pluginId,
                hostRuntime,
                effectiveCandidate.crashState,
            ),
            availability: effectiveCandidate.availability,
        });
    }
}

function isProjectedOpenableContentDestination(
    entry: PluginUiProjectedEntry | undefined,
    pluginId: string,
    destinationId: string,
): boolean {
    if (!entry || entry.pluginId !== pluginId || entry.contributionKind !== 'surfacePlacement') {
        return false;
    }
    const binding = PluginUiDestinationBindingV1Schema.safeParse(entry.binding);
    if (!binding.success) return false;
    return binding.data.destination.pluginId === pluginId
        && binding.data.destination.localId === destinationId
        && binding.data.container === 'detailsTab'
        && (binding.data.target.kind === 'session' || binding.data.target.kind === 'project');
}

function projectOpenableContentViewers(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const viewers = [...(registry.openableContentViewers ?? [])].sort((left, right) => (
        `${left.identity.pluginId}\0${left.identity.localId}`.localeCompare(
            `${right.identity.pluginId}\0${right.identity.localId}`,
        )
    ));
    for (const contribution of viewers) {
        const pluginId = readPluginId(contribution);
        const definition = contribution.definition;
        if (
            !pluginId
            || contribution.identity.pluginId !== pluginId
            || contribution.identity.localId !== definition.id
        ) {
            continue;
        }
        const destinationEntry = entriesById[`surfacePlacement:${pluginId}:${definition.destination}`];
        if (!isProjectedOpenableContentDestination(destinationEntry, pluginId, definition.destination)) {
            continue;
        }
        addEntry(entriesById, {
            id: `openableContentViewer:${pluginId}:${definition.id}`,
            pluginId,
            pluginVersion: contribution.pluginVersion ?? '0.0.0',
            contributionKind: 'openableContentViewer',
            descriptorId: definition.id,
            identity: Object.freeze({ ...contribution.identity }),
            viewer: Object.freeze({
                contentClasses: Object.freeze([...definition.contentClasses]),
                ...(definition.mimeTypes === undefined ? {} : { mimeTypes: Object.freeze([...definition.mimeTypes]) }),
                ...(definition.extensions === undefined ? {} : { extensions: Object.freeze([...definition.extensions]) }),
            }),
            destination: Object.freeze({ pluginId, localId: definition.destination }),
        });
    }
}
export const pluginUiProjectionFamily = definePluginProjectionFamilyV2({
    family: 'pluginUi',
    project({ registry, generation, pluginExecutionOriginsByPluginId, pluginUiHostRuntime }) {
        const hostRuntime = pluginUiHostRuntime as PluginUiProjectionHostRuntimeContext | undefined;
        const entriesById: Record<string, PluginUiProjectedEntry> = {};
        projectTranslations(registry, entriesById);
        projectSessionHeaderActions(registry, entriesById);
        projectTranscriptActivities(registry, entriesById);
        projectGeneratedHostedWebRenderers(
            registry,
            entriesById,
            generation,
            hostRuntime?.hostedWeb,
        );
        projectGeneratedReactNativeBundles(
            registry,
            entriesById,
            generation,
            hostRuntime?.reactNativeBundles,
        );
        projectGeneratedUiViews(
            registry,
            entriesById,
            hostRuntime?.declarative,
            hostRuntime,
        );
        projectOpenableContentViewers(registry, entriesById);
        projectGeneratedUiSettingsGroups(registry, entriesById);
        projectGeneratedUiSettingsPages(
            registry,
            entriesById,
            hostRuntime?.declarative,
            hostRuntime,
        );
        stampEntriesWithExecutionOrigins(entriesById, pluginExecutionOriginsByPluginId);

        return {
            family: 'pluginUi',
            entriesById,
        };
    },
});
