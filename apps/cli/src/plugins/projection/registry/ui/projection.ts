import { projectPluginHostedWebArtifactEntryV1, projectPluginReactNativeArtifactEntryV1, projectPluginUiPresentationEntriesV1, projectPluginUiTranslationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
export {
    projectPluginUiRendererRef,
    projectPluginUiRendererAvailability,
    resolvePluginUiRendererProjectionEntry,
} from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { getPluginMachineExecutionOriginRef, PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import {
    PluginUiResourceBindingCapabilityV1Schema,
    DaemonHostedWebFrameCapabilityV1Schema,
    PluginDeclaredUiEntriesV1Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    DaemonHostedWebFrameCapabilityV1,
    DaemonPluginHostedWebArtifactCacheIdentityV1,
    DaemonPluginUiArtifactByteIdentityV1 as ReactNativeBundleCacheIdentity,
    PluginMachineExecutionOriginV1,
    PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/contributions/ui/surfaceRegistry';
import { normalizePluginSessionHeaderActionDescriptorV1 } from '@happier-dev/protocol/plugins/contributions/ui/sessionHeaderActions';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui/hostApiDefinition';
import { deriveGeneratedHostedWebAssetPolicyV1 } from '@happier-dev/protocol/plugins/ui/hostedWebAssetPolicy';
import type { PluginUiArtifactsManifestEntryV2, PluginUiChannelV1, PluginUiPlatformV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginSessionInfoSectionRendererIdV1 } from '@happier-dev/protocol/plugins/contributions/ui/sessionInfoSections';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type {
    ResolvedContributionRegistry,
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
import { resolveDeclarativeProjectionModels } from './declarativeModels';

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
 * The exact execution-origin stamp is applied once after every UI entry has
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
        if (!parsedOrigin.success || getPluginMachineExecutionOriginRef(parsedOrigin.data).pluginId !== pluginId) continue;
        entriesById[entryId] = Object.freeze({
            ...entry,
            executionOrigin: Object.freeze(parsedOrigin.data),
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
        addEntry(entriesById, projectPluginHostedWebArtifactEntryV1({
            pluginId,
            pluginVersion: owner.pluginVersion ?? '0.0.0',
            contributionId,
            artifactSelectionOwner: artifactSelectionOwnerForPluginSource(owner.pluginSource),
            requiredHostMethods: owner.requiredHostMethods,
            source: owner.source,
            hostedWebPolicy,
            ...(artifact ? { artifact } : {}),
            runtime,
        }));
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

        addEntry(entriesById, projectPluginReactNativeArtifactEntryV1({
            pluginId, contributionId, artifactId: owner.artifactId,
            pluginVersion: owner.pluginVersion ?? '0.0.0',
            artifactSelectionOwner: artifactSelectionOwnerForPluginSource(owner.pluginSource),
            generatedOwnerKind: owner.kind,
            requiredHostMethods,
            exportName: owner.expectedExecutable?.exportName ?? 'renderSurface',
            ...(entry ? { artifact: entry } : {}),
            runtime,
        }));
    }
    return ownedContributionKeys;
}

function projectPluginUiEntries(input: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    hostRuntime?: PluginUiProjectionHostRuntimeContext;
    requestedLocale?: string;
}>) {
        const { registry, generation, hostRuntime, requestedLocale } = input;
        const entriesById: Record<string, PluginUiProjectedEntryCandidate> = {};
        projectPluginUiTranslationsV1(registry, entriesById, requestedLocale);
        projectSessionHeaderActions(registry, entriesById);
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
        projectPluginUiPresentationEntriesV1({
            registry, entriesById,
            modelsByRendererKey: hostRuntime?.declarative?.modelsByRendererKey,
            resourceCapabilityForPlugin: (pluginId) => projectPluginUiResourceCapability(pluginId, hostRuntime),
        });
        return entriesById;
}

/** The same normalized presentation declarations, without a process occurrence or live origin. */
export function projectPluginUiDeclarationEntries(registry: ResolvedContributionRegistry) {
    const modelsByRendererKey = resolveDeclarativeProjectionModels({
        registry, readPluginOccurrenceId: () => null,
    });
    const entries = projectPluginUiEntries({ registry, generation: 0, hostRuntime: {
        declarative: { modelsByRendererKey },
    } });
    // Descriptive Search identities are portable; their query Action owns execution.
    // Transcript and Session header/info execution remain Session/runtime-owned.
    const descriptive = Object.fromEntries(Object.entries(entries).filter(([, entry]) => (
        entry.contributionKind !== 'transcriptActivity'
        && entry.contributionKind !== 'sessionHeaderAction'
        && entry.contributionKind !== 'sessionInfoSection'
    )));
    return PluginDeclaredUiEntriesV1Schema.parse(descriptive);
}

export const pluginUiProjectionFamily = definePluginProjectionFamilyV2({
    family: 'pluginUi',
    project({ registry, generation, pluginExecutionOriginsByPluginId, pluginUiHostRuntime, requestedLocale }) {
        const entriesById = projectPluginUiEntries({
            registry, generation, requestedLocale,
            hostRuntime: pluginUiHostRuntime as PluginUiProjectionHostRuntimeContext | undefined,
        });
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
