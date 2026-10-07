import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginUiResourceBindingCapabilityV1Schema, DaemonHostedWebFrameCapabilityV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonHostedWebFrameCapabilityV1, DaemonPluginHostedWebArtifactCacheIdentityV1, DaemonPluginUiArtifactByteIdentityV1 as ReactNativeBundleCacheIdentity, PluginMachineExecutionOriginV1, PluginUiResourceBindingCapabilityV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1, normalizePluginUiInlineSurfaceBindingV1, isPluginUiAuthoredViewInlineSurfaceRoleV1, normalizePluginUiSettingsPageBindingV1, PluginUiDestinationBindingV1Schema, selectPluginUiDestinationBindingRendererV1, selectPluginUiInlineSurfaceBindingRendererV1 } from '@happier-dev/protocol/plugins/contributions/ui/surfaceRegistry';
import { normalizePluginSessionHeaderActionDescriptorV1 } from '@happier-dev/protocol/plugins/contributions/ui/sessionHeaderActions';
import { normalizePluginUiSemanticCommandV1 } from '@happier-dev/protocol/plugins/ui/semanticCommands';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui/hostApiDefinition';
import { deriveGeneratedHostedWebAssetPolicyV1 } from '@happier-dev/protocol/plugins/ui/hostedWebAssetPolicy';
import type { PluginUiArtifactsManifestEntryV2, PluginUiChannelV1, PluginUiDestinationBindingV1, PluginUiPlatformV1, PluginUiSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginSessionInfoSectionRendererIdV1 } from '@happier-dev/protocol/plugins/contributions/ui/sessionInfoSections';
import type { PluginUiViewDestinationBindingV2 } from '@happier-dev/protocol/plugins/contributions/ui';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
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
    collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners,
    findGeneratedHostedWebArtifactEntry,
    collectResolvedGeneratedReactNativeArtifactOwners,
    collectResolvedGeneratedReactNativeClientContributionArtifactOwners,
    findGeneratedReactNativeArtifactEntry,
} from './generatedUiArtifactOwners';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import { generatedUiArtifactCompatibilityFailure } from './artifactCompatibility';

type PluginUiProjectedEntryCandidate = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: string;
}>;

function artifactSelectionOwnerForPluginSource(
    source: Readonly<{ kind: string }>,
): 'accountRelease' | 'daemonProjection' {
    return source.kind === 'bundled' || source.kind === 'path'
        ? 'daemonProjection'
        : 'accountRelease';
}

export type PluginUiProjectedEntry = PluginUiProjectedEntryCandidate & Readonly<{
    occurrenceId: string;
}>;

export type ReactNativeBundleProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
    hostRuntime?: Readonly<{
        hostAppVersion?: string;
        hostUiApiVersion?: string;
        platform?: PluginUiPlatformV1;
        channel?: PluginUiChannelV1;
    }>;
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
): Readonly<{
    resourceCapability: PluginUiResourceBindingCapabilityV1;
}> {
    return Object.freeze({
        resourceCapability: projectPluginUiResourceCapability(pluginId, hostRuntime),
    });
}

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

function addEntry(
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    entry: PluginUiProjectedEntryCandidate,
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
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    originsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>> | undefined,
): void {
    if (!originsByPluginId) return;
    for (const [entryId, entry] of Object.entries(entriesById)) {
        const pluginId = readPluginId(entry);
        if (!pluginId) continue;
        // A search provider is identity plus its query Action reference; the
        // Action carries its own execution origin, and the closed Protocol arm
        // admits no second copy.
        if (entry.contributionKind === 'searchProvider') continue;
        const parsedOrigin = PluginMachineExecutionOriginV1Schema.safeParse(originsByPluginId[pluginId]);
        if (!parsedOrigin.success || parsedOrigin.data.materializationRef.pluginId !== pluginId) continue;
        entriesById[entryId] = Object.freeze({
            ...entry,
            serverIdentityId: parsedOrigin.data.serverIdentityId,
            materializationRef: Object.freeze({ ...parsedOrigin.data.materializationRef }),
        });
    }
}

/**
 * Stamps every public UI contribution with the exact admitted plugin slot.
 * A contribution without a current occurrence is omitted, matching Action
 * projection admission rather than substituting installed-package identity.
 */
function stampEntriesWithOccurrenceIds(
    entriesById: Readonly<Record<string, PluginUiProjectedEntryCandidate>>,
    occurrenceIdsByPluginId: ResolvedContributionRegistry['occurrenceIdsByPluginId'],
): Record<string, PluginUiProjectedEntry> {
    const stamped: Record<string, PluginUiProjectedEntry> = {};
    for (const [entryId, entry] of Object.entries(entriesById)) {
        const pluginId = readPluginId(entry);
        const occurrenceId = pluginId
            ? occurrenceIdsByPluginId?.[pluginId]
            : undefined;
        if (!pluginId || !occurrenceId) continue;
        stamped[entryId] = Object.freeze({ ...entry, occurrenceId });
    }
    return stamped;
}

/**
 * English is the projected fallback bundle every client merges under its
 * preferred locale (`apps/ui/sources/sync/domains/plugins/ui/i18n.ts`
 * `resolvePluginUiTranslationBundle`). It is the one locale that is always read.
 */
const TRANSLATION_FALLBACK_LOCALE = 'en';

/**
 * The single rule for which contributed bundles reach the wire.
 *
 * A client reads exactly two: its preferred locale merged over English. Shipping
 * the rest is pure transfer — measured at 629,256 B across the bundled plugin set
 * for 11 locales, of which a client can use at most 125,531 B. A request that
 * names no locale is an older client (or an older-shaped call), and still
 * receives everything.
 *
 * This narrows only `bundles`. `locales` remains the complete availability fact,
 * and duplicate-locale diagnostics are still derived from the full contributed
 * set, so no fact is lost — only bytes no reader consumes.
 */
function narrowProjectedTranslationBundles(
    bundles: Readonly<Record<string, Readonly<Record<string, string>>>>,
    requestedLocale: string | undefined,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
    if (requestedLocale === undefined) return bundles;
    const retained: Record<string, Readonly<Record<string, string>>> = {};
    for (const locale of [TRANSLATION_FALLBACK_LOCALE, requestedLocale]) {
        const bundle = bundles[locale];
        if (bundle !== undefined && !Object.hasOwn(retained, locale)) {
            retained[locale] = bundle;
        }
    }
    return retained;
}

function projectTranslations(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    requestedLocale: string | undefined,
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
            bundles: Object.freeze(narrowProjectedTranslationBundles(bundles, requestedLocale)),
            ...(duplicateLocales.size > 0
                ? { diagnostics: Object.freeze(['duplicate_translation_locale']) }
                : {}),
        });
    }

}

function projectSessionHeaderActions(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
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
            command: normalized.command,
            availability: normalized.availability,
        });
    }
}

/**
 * Projects the one declarative Universal Search provider descriptor.
 *
 * It carries identity and the resolved qualified query Action, and nothing
 * else. Title, icon, availability, execution target and currentness are the
 * referenced Action's own projected facts, which the host already holds — a
 * second copy here would be a second answer to the same question.
 */
function projectSearchProviders(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
): void {
    for (const contribution of registry.searchProviders ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId
            || contribution.identity.pluginId !== pluginId
            || contribution.identity.localId !== contribution.definition.id) {
            continue;
        }
        const definition = contribution.definition;
        addEntry(entriesById, {
            id: `searchProvider:${pluginId}:${definition.id}`,
            pluginId,
            contributionKind: 'searchProvider',
            descriptorId: definition.id,
            identity: Object.freeze({
                pluginId: contribution.identity.pluginId,
                localId: contribution.identity.localId,
            }),
            // The descriptor spells a same-plugin local id; the qualified
            // identity is resolved here, once, so no consumer re-qualifies it.
            action: Object.freeze({ pluginId, localId: definition.action }),
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
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
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

function projectSessionInfoSections(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    declarativeHostRuntime: DeclarativeProjectionHostRuntimeContext | undefined,
    hostRuntime: PluginUiProjectionHostRuntimeContext | undefined,
): void {
    for (const contribution of registry.sessionInfoSections ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId
            || contribution.identity.pluginId !== pluginId
            || contribution.identity.localId !== contribution.definition.id) continue;
        const definition = contribution.definition;
        const rendererId = createPluginSessionInfoSectionRendererIdV1(definition.id);
        const model = declarativeHostRuntime?.modelsByRendererKey?.[`${pluginId}\0${rendererId}`];
        if (!model?.visible) continue;
        const binding = normalizePluginUiInlineSurfaceBindingV1({
            pluginId,
            surfaceId: definition.id,
            rendererId,
            fallbackRendererIds: [],
            availableRendererIds: [rendererId],
            role: 'sessionInfoSection',
            target: { kind: 'session' },
        });
        if (!binding) continue;
        const runtime = projectSurfaceResourceRuntime(pluginId, hostRuntime);
        const renderer = Object.freeze({
            kind: 'declarative' as const,
            contributionId: rendererId,
            model,
            documentSource: Object.freeze({ kind: 'resource' as const, resourceId: definition.resourceId }),
        });
        const placement = Object.freeze({
            id: `sessionInfoSectionPlacement:${pluginId}:${definition.id}`,
            pluginId,
            pluginVersion: contribution.pluginVersion ?? '0.0.0',
            contributionKind: 'surfacePlacement' as const,
            descriptorId: definition.id,
            binding,
            target: binding.target,
            renderer,
            display: Object.freeze({}),
            availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            headerActions: Object.freeze([]),
            runtime,
        });
        addEntry(entriesById, {
            id: `sessionInfoSection:${pluginId}:${definition.id}`,
            pluginId,
            pluginVersion: contribution.pluginVersion ?? '0.0.0',
            contributionKind: 'sessionInfoSection',
            descriptorId: definition.id,
            order: definition.order,
            availability: definition.availability,
            resource: Object.freeze({ pluginId, localId: definition.resourceId }),
            actions: Object.freeze(definition.actions.map((localId) => Object.freeze({ pluginId, localId }))),
            renderer,
            runtime,
            placement,
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
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
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
            && generatedUiArtifactCompatibilityFailure({
                entry: artifact,
                hostRuntime: { hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION_V1 },
            }) === null,
        );
        const failure = !graphValid
            ? 'hosted_web_static_artifact_missing'
            : !featureEnabled
                ? 'feature_disabled'
                : null;
        const artifactReadIdentity: DaemonPluginHostedWebArtifactCacheIdentityV1 | undefined =
            graphValid && featureEnabled && artifact
                ? Object.freeze({
                    artifactDigest: artifact.digest,
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
            artifactSelectionOwner: artifactSelectionOwnerForPluginSource(owner.pluginSource),
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
                cacheKey: params.cacheIdentity.artifactDigest,
                cacheIdentity: params.cacheIdentity,
                loadPolicy: Object.freeze({ source: 'installedArtifact' as const }),
            }
            : {}),
    });
}

function generatedReactNativeCompatibilityFailure(params: Readonly<{
    entry: PluginUiArtifactsManifestEntryV2;
    hostRuntime: Readonly<{ hostUiApiVersion?: string }> | undefined;
}>): string | null {
    const host = params.hostRuntime;
    if (!host) return 'generated_react_native_host_runtime_unavailable';
    return generatedUiArtifactCompatibilityFailure({
        entry: params.entry,
        hostRuntime: {
            hostUiApiVersion: host.hostUiApiVersion ?? '',
        },
    });
}

function projectGeneratedReactNativeBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    _generation: number,
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext,
): ReadonlySet<string> {
    const ownedContributionKeys = new Set<string>();
    for (const owner of [
        ...collectResolvedGeneratedReactNativeArtifactOwners(registry),
        ...collectResolvedGeneratedReactNativeClientContributionArtifactOwners(registry),
        ...collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners(registry),
    ]) {
        const pluginId = owner.pluginId;
        const contributionId = owner.contributionId;
        const requiredHostMethods = owner.kind === 'clientContribution'
            ? Object.freeze([])
            : owner.requiredHostMethods;
        ownedContributionKeys.add(`${pluginId}\0${contributionId}`);

        const resolved = findGeneratedReactNativeArtifactEntry({ owner, platform: undefined });
        const compatibilityFailure = resolved.entry
            ? generatedReactNativeCompatibilityFailure({
                entry: resolved.entry,
                hostRuntime: hostRuntimeContext?.hostRuntime,
            })
            : null;
        const failure = resolved.failure ?? compatibilityFailure;
        const entry = resolved.entry;
        const hostRuntime = hostRuntimeContext?.hostRuntime;
        const cacheIdentity: ReactNativeBundleCacheIdentity | undefined =
            entry && !failure && hostRuntime
            ? Object.freeze({ artifactDigest: entry.digest })
            : undefined;
        const runtime = failure
            ? generatedReactNativeRuntimeResult({
                state: 'blocked',
                reason: failure,
                diagnostics: [failure],
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
            artifactSelectionOwner: artifactSelectionOwnerForPluginSource(owner.pluginSource),
            generatedV2: true,
            generatedOwnerKind: owner.kind,
            requiredHostMethods,
            entry: Object.freeze({
                artifactId: entry?.artifactId ?? owner.artifactId,
                exportName: owner.expectedExecutable?.exportName ?? 'renderSurface',
            }),
            compatibility: entry
                ? Object.freeze({
                    hostUiApiRange: entry.hostUiApiRange,
                })
                : undefined,
            hostApi: Object.freeze({
                minVersion: entry?.hostUiApiRange ?? PLUGIN_UI_HOST_API_VERSION_V1,
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

/**
 * Destination versus inline is a property of the one Surface Registry row, not
 * of a role list maintained here. Asking the Registry keeps this projection
 * from becoming a second role authority when a row is added.
 */
function isDestinationUiViewDefinition(
    definition: ResolvedUiViewV2Contribution['definition'],
): definition is PluginUiViewDestinationBindingV2 {
    return !isPluginUiAuthoredViewInlineSurfaceRoleV1(definition.container);
}

function generatedViewDisplay(view: ResolvedUiViewV2Contribution): Readonly<Record<string, unknown>> {
    const definition = view.definition;
    const destinationDefinition = isDestinationUiViewDefinition(definition) ? definition : null;
    const title = definition.title;
    const badge = destinationDefinition?.badge;
    const projectedBadge = badge === undefined
        ? undefined
        : Object.freeze(typeof badge.label === 'string'
            ? {
                label: badge.label,
                ...(badge.tone === undefined ? {} : { tone: badge.tone }),
            }
            : {
                labelKey: badge.label.key,
                developerFallback: badge.label.fallback,
                ...(badge.tone === undefined ? {} : { tone: badge.tone }),
            });
    const presentationDefaults = {
        ...(definition.icon === undefined ? {} : { iconToken: definition.icon }),
        ...(projectedBadge === undefined ? {} : { badge: projectedBadge }),
        ...(destinationDefinition && 'placement' in destinationDefinition && destinationDefinition.placement !== undefined
            ? { placement: destinationDefinition.placement }
            : {}),
        ...(destinationDefinition?.rankHint !== undefined
            ? { rankHint: destinationDefinition.rankHint }
            : {}),
    };
    if (typeof title === 'string') {
        return Object.freeze({
            title,
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
        title: view.definition.id,
        ...presentationDefaults,
    });
}

function projectGeneratedPageHeaderActions(
    pluginId: string,
    headerActions: PluginUiViewDestinationBindingV2['headerActions'],
): readonly Readonly<Record<string, unknown>>[] {
    const projected: Readonly<Record<string, unknown>>[] = [];
    for (const headerAction of headerActions ?? []) {
        const command = normalizePluginUiSemanticCommandV1({
            pluginId,
            command: headerAction.command,
        });
        if (!command) continue;
        projected.push(Object.freeze({
            id: headerAction.id,
            title: headerAction.title,
            ...(headerAction.description === undefined ? {} : { description: headerAction.description }),
            ...(headerAction.icon === undefined ? {} : { icon: headerAction.icon }),
            ...(headerAction.order === undefined ? {} : { order: headerAction.order }),
            command,
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
        : renderer.definition.kind === 'hostedWeb' || renderer.definition.kind === 'hostedHtml'
            ? Object.freeze({
                kind: renderer.definition.kind,
                contributionId: renderer.definition.id,
                source: renderer.definition.source,
                requiredHostMethods,
                // Only a by-value document declares requested capabilities, and
                // the mount alone enforces them. Carrying the declaration here
                // keeps one owner: the projection never resolves or narrows it.
                ...(renderer.definition.kind === 'hostedHtml' && renderer.definition.requestedCapabilities !== undefined
                    ? { requestedCapabilities: renderer.definition.requestedCapabilities }
                    : {}),
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
        registryRendererRef: renderer.definition.kind === 'hostedWeb' || renderer.definition.kind === 'hostedHtml'
            ? Object.freeze({
                kind: renderer.definition.kind,
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
    if (params.renderer.definition.kind === 'hostedHtml') {
        // The admitted source is carried by value. Platform/frame support is
        // decided by the mounted UI runtime, not an invented Artifact entry.
        return Object.freeze({ state: 'available', reason: 'available', diagnostics: Object.freeze([]) });
    }
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

function projectGeneratedUiSettingsGroups(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
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
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    declarativeHostRuntime?: DeclarativeProjectionHostRuntimeContext,
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
            availability: rendererAvailability,
        });
    }
}

function projectGeneratedUiViews(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
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
        const availableRendererIds = (registry.uiRenderersV2 ?? [])
            .filter((renderer) => renderer.pluginId === pluginId)
            .map((renderer) => renderer.definition.id);
        const binding = isPluginUiAuthoredViewInlineSurfaceRoleV1(view.definition.container)
            ? normalizePluginUiInlineSurfaceBindingV1({
                pluginId,
                surfaceId: descriptorId,
                rendererId: view.definition.renderer,
                fallbackRendererIds: view.definition.fallbackRenderers,
                availableRendererIds,
                role: view.definition.container,
                target: view.definition.target,
            })
            : normalizePluginUiDestinationBindingV1({
                pluginId,
                destinationId: descriptorId,
                rendererId: view.definition.renderer,
                fallbackRendererIds: view.definition.fallbackRenderers,
                availableRendererIds,
                container: view.definition.container,
                target: view.definition.target,
                // Parsed destination declarations carry this field. A few
                // host-owned registry fixtures construct the same accepted
                // input shape before parsing, where omission means the
                // canonical singleton default rather than an invalid view.
                instancePolicy: 'instancePolicy' in view.definition
                    ? view.definition.instancePolicy
                    : 'singleton',
            });
        if (!binding) continue;
        const candidateRenderers = binding.rendererChain.flatMap((rendererIdentity) => {
            const renderer = renderersByKey.get(`${pluginId}\0${rendererIdentity.localId}`);
            if (!renderer) return [];
            const declarativeModel = renderer.definition.kind === 'declarative'
                ? declarativeHostRuntime?.modelsByRendererKey?.[`${pluginId}\0${renderer.definition.id}`]
                : undefined;
            const projectedRenderer = projectPluginUiRendererRef(renderer, declarativeModel);
            const rendererAvailability = projectPluginUiRendererAvailability({
                pluginId,
                renderer,
                declarativeModel,
                registryRendererRef: projectedRenderer.registryRendererRef,
                entriesById,
            });
            return [{
                renderer,
                projectedRenderer,
                availability: rendererAvailability,
            }];
        });
        const primaryCandidate = candidateRenderers[0];
        if (!primaryCandidate) continue;
        // Technical availability belongs to this projection, while declaration
        // order belongs to the Protocol registry. Do not independently choose
        // the first available candidate here: that would turn a projection
        // traversal into a second fallback-chain owner.
        const eligibleRendererIds = candidateRenderers
            .filter((candidate) => candidate.availability.state === 'available')
            .map((candidate) => candidate.renderer.definition.id);
        const selectedBinding = binding.kind === 'destination'
            ? selectPluginUiDestinationBindingRendererV1(binding, eligibleRendererIds) ?? binding
            : selectPluginUiInlineSurfaceBindingRendererV1(binding, eligibleRendererIds) ?? binding;
        const effectiveCandidate = candidateRenderers.find((candidate) => (
            candidate.renderer.definition.id === selectedBinding.renderer.localId
        )) ?? primaryCandidate;
        const display = generatedViewDisplay(view);
        const headerActions = isDestinationUiViewDefinition(view.definition)
            ? projectGeneratedPageHeaderActions(pluginId, view.definition.headerActions)
            : Object.freeze([]);
        const rightSidebar = selectedBinding.kind === 'destination'
            ? generatedRightSidebarMetadata(selectedBinding)
            : null;
        const pageColumn = view.definition.container === 'appPage'
            && 'column' in view.definition && view.definition.column
            ? view.definition.column as Pick<typeof view.definition, 'renderer'>
            : undefined;
        const columnRenderer = pageColumn
            ? renderersByKey.get(`${pluginId}\0${pageColumn.renderer}`)
            : undefined;
        const columnDeclarativeModel = columnRenderer?.definition.kind === 'declarative'
            ? declarativeHostRuntime?.modelsByRendererKey?.[`${pluginId}\0${columnRenderer.definition.id}`]
            : undefined;
        const projectedColumnRenderer = columnRenderer
            ? projectPluginUiRendererRef(columnRenderer, columnDeclarativeModel)
            : undefined;
        const columnBinding = columnRenderer && selectedBinding.kind === 'destination'
            ? normalizePluginUiDestinationBindingV1({
                pluginId,
                destinationId: selectedBinding.destination.localId,
                rendererId: columnRenderer.definition.id,
                availableRendererIds,
                container: selectedBinding.container,
                target: selectedBinding.target,
                instancePolicy: selectedBinding.instancePolicy,
            })
            : null;
        const column = columnRenderer && projectedColumnRenderer && columnBinding
            ? Object.freeze({
                binding: columnBinding,
                renderer: projectedColumnRenderer.rendererRef,
                availability: projectPluginUiRendererAvailability({
                    pluginId,
                    renderer: columnRenderer,
                    declarativeModel: columnDeclarativeModel,
                    registryRendererRef: projectedColumnRenderer.registryRendererRef,
                    entriesById,
                }),
            })
            : undefined;
        addEntry(entriesById, {
            id: `surfacePlacement:${pluginId}:${descriptorId}`,
            pluginId,
            pluginVersion: view.pluginVersion ?? effectiveCandidate.renderer.pluginVersion ?? '0.0.0',
            contributionKind: 'surfacePlacement',
            descriptorId,
            generatedV2: true,
            ...(selectedBinding.kind === 'destination'
                ? { container: selectedBinding.container }
                : {}),
            target: selectedBinding.target,
            binding: selectedBinding,
            renderer: effectiveCandidate.projectedRenderer.rendererRef,
            display,
            ...(selectedBinding.kind === 'inline' && selectedBinding.role === 'widget'
                && 'sizeDeclaration' in view.definition
                ? { sizeDeclaration: view.definition.sizeDeclaration } : {}),
            ...(selectedBinding.kind === 'inline' && selectedBinding.role === 'widget'
                && 'resources' in view.definition && view.definition.resources !== undefined
                ? { resources: view.definition.resources } : {}),
            ...(selectedBinding.kind === 'inline'
                && selectedBinding.role === 'widget'
                && 'inputs' in view.definition
                && view.definition.inputs !== undefined
                ? { inputs: view.definition.inputs }
                : {}),
            ...(selectedBinding.kind === 'inline'
                && selectedBinding.role === 'widget'
                && 'inputSchema' in view.definition
                && view.definition.inputSchema !== undefined
                ? { inputSchema: view.definition.inputSchema }
                : {}),
            ...(selectedBinding.kind === 'inline'
                && selectedBinding.role === 'widget'
                && 'connectedAccountPurposeBindings' in view.definition
                && view.definition.connectedAccountPurposeBindings !== undefined
                ? { connectedAccountPurposeBindings: view.definition.connectedAccountPurposeBindings }
                : {}),
            ...(selectedBinding.kind === 'inline'
                && selectedBinding.role === 'widget'
                && 'sessionInputPath' in view.definition
                && view.definition.sessionInputPath !== undefined
                ? { sessionInputPath: view.definition.sessionInputPath }
                : {}),
            ...(selectedBinding.kind === 'inline'
                && selectedBinding.role === 'widget'
                ? { home: 'home' in view.definition && view.definition.home !== undefined
                    ? view.definition.home
                    : Object.freeze({ default: 'available' as const }) }
                : {}),
            ...(column ? { column } : {}),
            ...('widgetAreas' in view.definition && view.definition.widgetAreas ? { widgetAreas: view.definition.widgetAreas } : {}),
            actions: Object.freeze([]),
            ...(headerActions.length === 0 ? {} : { headerActions }),
            ...(rightSidebar ? { rightSidebar } : {}),
            runtime: projectSurfaceResourceRuntime(
                pluginId,
                hostRuntime,
            ),
            availability: effectiveCandidate.availability,
        });
    }
}

function isProjectedOpenableContentDestination(
    entry: PluginUiProjectedEntryCandidate | undefined,
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
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
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
    project({ registry, generation, pluginExecutionOriginsByPluginId, pluginUiHostRuntime, requestedLocale }) {
        const hostRuntime = pluginUiHostRuntime as PluginUiProjectionHostRuntimeContext | undefined;
        const entriesById: Record<string, PluginUiProjectedEntryCandidate> = {};
        projectTranslations(registry, entriesById, requestedLocale);
        projectSessionHeaderActions(registry, entriesById);
        projectSearchProviders(registry, entriesById);
        projectTranscriptActivities(registry, entriesById);
        projectSessionInfoSections(registry, entriesById, hostRuntime?.declarative, hostRuntime);
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
        );
        stampEntriesWithExecutionOrigins(entriesById, pluginExecutionOriginsByPluginId);

        return {
            family: 'pluginUi',
            entriesById: stampEntriesWithOccurrenceIds(
                entriesById,
                registry.occurrenceIdsByPluginId,
            ),
        };
    },
});
