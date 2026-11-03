import { PluginDeclaredUiEntriesV1Schema, type PluginDeclaredUiEntriesV1 } from '../../../daemon/contributionRegistryProjection.js';
import {
  normalizePluginUiDestinationBindingV1,
  normalizePluginUiInlineSurfaceBindingV1,
  isPluginUiAuthoredViewInlineSurfaceRoleV1,
  normalizePluginUiSettingsPageBindingV1,
  PluginUiDestinationBindingV1Schema,
  selectPluginUiDestinationBindingRendererV1,
  selectPluginUiInlineSurfaceBindingRendererV1,
} from './surfaceRegistry.js';
import { normalizePluginUiSemanticCommandV1 } from '../../ui/semanticCommands.js';
import type {
  PluginUiViewDestinationBindingV2,
  PluginUiViewV2,
  PluginUiRendererV2,
  PluginUiSettingsPageV1,
  PluginUiSettingsGroupV1,
  PluginUiTranslationBundleV2,
} from './v2.js';
import type { PluginContributionIdentityV1 } from '../../contributionIdentity.js';
import type { PluginOpenableContentViewerContributionV1 } from '../../openableContentViewerV1.js';
import type { PluginUiResourceBindingCapabilityV1 } from '../../../daemon/contributionRegistryProjection.js';
import type { StablePluginDeclarativeModel } from './declarativeModel.js';
import { createStablePluginDeclarativeModel } from './declarativeModel.js';
import { createStablePluginSettingsModels } from './settingsDescriptors.js';
import type { PluginPortableReleaseManifestV1 } from '../../availability/v1.js';
import { createPluginContributionIdentity } from '../../contributionIdentity.js';
import type { PluginUiArtifactsManifestEntryV2 } from '../../ui/uiArtifactsManifest.js';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '../../ui/hostApiDefinition.js';
import { isPluginUiHostApiVersionCompatibleWithVersionV1 } from '../../ui/hostApi.js';

type DescriptiveContribution<T> = Readonly<{
    pluginId: string;
    pluginVersion?: string;
    identity: PluginContributionIdentityV1;
    definition: T;
    manifestPath?: string;
}>;
type ResolvedUiRendererV2Contribution = DescriptiveContribution<PluginUiRendererV2>;
type ResolvedUiViewV2Contribution = DescriptiveContribution<PluginUiViewV2>;
type ResolvedUiSettingsPageV2Contribution = DescriptiveContribution<PluginUiSettingsPageV1>;
type ResolvedUiSettingsGroupV2Contribution = DescriptiveContribution<PluginUiSettingsGroupV1>;
type ResolvedUiTranslationBundleV2Contribution = Readonly<Omit<DescriptiveContribution<PluginUiTranslationBundleV2>, 'identity'>>;
export type PluginUiPresentationRegistryV1 = Readonly<{
    uiRenderersV2?: readonly ResolvedUiRendererV2Contribution[];
    uiViewsV2?: readonly ResolvedUiViewV2Contribution[];
    uiSettingsPagesV2?: readonly ResolvedUiSettingsPageV2Contribution[];
    uiSettingsGroupsV2?: readonly ResolvedUiSettingsGroupV2Contribution[];
    uiTranslationsV2?: readonly ResolvedUiTranslationBundleV2Contribution[];
    openableContentViewers?: readonly DescriptiveContribution<PluginOpenableContentViewerContributionV1>[];
}>;
export type PluginUiProjectedEntryCandidate = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: string;
}>;

/** Shared executable presentation facts; the caller retains selection and compatibility authority. */
export function projectPluginReactNativeArtifactEntryV1(input: Readonly<{
    pluginId: string;
    pluginVersion: string;
    contributionId: string;
    artifactId: string;
    artifact?: PluginUiArtifactsManifestEntryV2;
    artifactSelectionOwner?: 'accountRelease' | 'daemonProjection';
    generatedOwnerKind: string;
    requiredHostMethods: readonly string[];
    exportName?: string;
    runtime: Readonly<Record<string, unknown>>;
}>): PluginUiProjectedEntryCandidate {
    return Object.freeze({
        id: `reactNativeBundle:${input.pluginId}:${input.contributionId}`,
        pluginId: input.pluginId, pluginVersion: input.pluginVersion,
        contributionKind: 'reactNativeBundle', contributionId: input.contributionId,
        ...(input.artifactSelectionOwner ? { artifactSelectionOwner: input.artifactSelectionOwner } : {}), generatedV2: true,
        generatedOwnerKind: input.generatedOwnerKind, requiredHostMethods: input.requiredHostMethods,
        entry: Object.freeze({ artifactId: input.artifact?.artifactId ?? input.artifactId, exportName: input.exportName ?? 'renderSurface' }),
        compatibility: input.artifact ? Object.freeze({ hostUiApiRange: input.artifact.hostUiApiRange }) : undefined,
        hostApi: Object.freeze({ minVersion: input.artifact?.hostUiApiRange ?? PLUGIN_UI_HOST_API_VERSION_V1,
            methods: Object.freeze([...input.requiredHostMethods]) }),
        fallback: Object.freeze({ kind: 'unavailable' }),
        ...(input.artifact ? { artifactGraph: input.artifact } : {}), runtime: input.runtime,
    });
}
type DeclarativeProjectionHostRuntimeContext = Readonly<{
    modelsByRendererKey?: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
}>;
export type PluginUiPresentationResourceContextV1 = Readonly<{
    resourceCapabilityForPlugin?: (pluginId: string) => PluginUiResourceBindingCapabilityV1;
}>;
function projectSurfaceResourceRuntime(pluginId: string, context: PluginUiPresentationResourceContextV1 | undefined) {
    return Object.freeze({
        resourceCapability: context?.resourceCapabilityForPlugin?.(pluginId)
            ?? Object.freeze({ readable: false, dynamic: false }),
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


export function projectPluginUiTranslationsV1(
    registry: PluginUiPresentationRegistryV1,
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
        const resourceIdsByLocale: Record<string, string> = {};
        // I18NRES step 4 removes inline bundles with the last inline producer.
        const bundles: Record<string, Readonly<Record<string, string>>> = {};
        const locales = new Set<string>();
        const duplicateLocales = new Set<string>();
        for (const contribution of contributions) {
            const locale = contribution.definition.locale;
            if (locales.has(locale)) duplicateLocales.add(locale);
            locales.add(locale);
            delete resourceIdsByLocale[locale];
            delete bundles[locale];
            if ('resourceId' in contribution.definition) {
                resourceIdsByLocale[locale] = contribution.definition.resourceId;
            } else {
                bundles[locale] = Object.freeze(Object.fromEntries(
                    Object.entries(contribution.definition.messages).sort(([left], [right]) => left.localeCompare(right)),
                ));
            }
        }
        addEntry(entriesById, {
            id: `translations:${pluginId}`,
            pluginId,
            contributionKind: 'translations',
            locales: Object.freeze([...locales].sort()),
            ...(Object.keys(resourceIdsByLocale).length > 0 ? { resourceIdsByLocale: Object.freeze(resourceIdsByLocale) } : {}),
            ...(Object.keys(bundles).length > 0 ? { bundles: Object.freeze(requestedLocale === undefined ? bundles : Object.fromEntries(
                Object.entries(bundles).filter(([locale]) => locale === 'en' || locale === requestedLocale),
            )) } : {}),
            ...(duplicateLocales.size > 0
                ? { diagnostics: Object.freeze(['duplicate_translation_locale']) }
                : {}),
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
        ...(destinationDefinition?.container === 'rightSidebarTab' && destinationDefinition.defaultPlacement !== undefined
            ? { defaultPlacement: destinationDefinition.defaultPlacement } : {}),
        ...(destinationDefinition?.container === 'rightSidebarTab' && destinationDefinition.countResourceId !== undefined
            ? { countResourceId: destinationDefinition.countResourceId } : {}),
        ...(destinationDefinition?.container === 'appPage' && destinationDefinition.description !== undefined
            ? { description: destinationDefinition.description }
            : {}),
        ...(destinationDefinition?.container === 'appPage' && destinationDefinition.headerStyle !== undefined
            ? { headerStyle: destinationDefinition.headerStyle }
            : {}),
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
    registry: PluginUiPresentationRegistryV1,
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
    registry: PluginUiPresentationRegistryV1,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    declarativeHostRuntime?: DeclarativeProjectionHostRuntimeContext,
    hostRuntime?: PluginUiPresentationResourceContextV1,
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
            runtime: projectSurfaceResourceRuntime(pluginId, hostRuntime),
        });
    }
}

function projectGeneratedUiViews(
    registry: PluginUiPresentationRegistryV1,
    entriesById: Record<string, PluginUiProjectedEntryCandidate>,
    declarativeHostRuntime?: DeclarativeProjectionHostRuntimeContext,
    hostRuntime?: PluginUiPresentationResourceContextV1,
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
                && 'publicPresentation' in view.definition && view.definition.publicPresentation !== undefined
                ? { publicPresentation: view.definition.publicPresentation } : {}),
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
    registry: PluginUiPresentationRegistryV1,
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

/** Presentation only: executable Artifact admission and origin stamping stay with the host. */
export function projectPluginUiPresentationEntriesV1(params: Readonly<{
    registry: PluginUiPresentationRegistryV1;
    entriesById: Record<string, PluginUiProjectedEntryCandidate>;
    modelsByRendererKey?: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
    resourceCapabilityForPlugin?: (pluginId: string) => PluginUiResourceBindingCapabilityV1;
}>): void {
    const { registry, entriesById } = params;
    const declarative = { modelsByRendererKey: params.modelsByRendererKey };
    projectGeneratedUiViews(registry, entriesById, declarative, params);
    projectOpenableContentViewers(registry, entriesById);
    projectGeneratedUiSettingsGroups(registry, entriesById);
    projectGeneratedUiSettingsPages(registry, entriesById, declarative, params);
}
export function projectPluginUiDeclarationEntriesV1(params: Readonly<{
    registry: PluginUiPresentationRegistryV1;
    modelsByRendererKey?: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
    artifactEntries?: readonly PluginUiProjectedEntryCandidate[];
}>): PluginDeclaredUiEntriesV1 {
    const entriesById: Record<string, PluginUiProjectedEntryCandidate> = {};
    for (const entry of params.artifactEntries ?? []) addEntry(entriesById, entry);
    // Targeted-only renderers have no View or Settings placement to retain
    // their normalized model. Keep their presentation in this same projection
    // so mounted targets consume the canonical renderer and availability facts.
    for (const renderer of params.registry.uiRenderersV2 ?? []) {
        const pluginId = renderer.pluginId;
        const declarativeModel = params.modelsByRendererKey?.[`${pluginId}\0${renderer.definition.id}`];
        const projected = projectPluginUiRendererRef(renderer, declarativeModel);
        addEntry(entriesById, {
            id: `uiRenderer:${pluginId}:${renderer.definition.id}`,
            pluginId,
            contributionKind: 'uiRenderer',
            contributionId: renderer.definition.id,
            renderer: projected.rendererRef,
            availability: projectPluginUiRendererAvailability({
                pluginId, renderer, declarativeModel,
                registryRendererRef: projected.registryRendererRef, entriesById,
            }),
        });
    }
    projectPluginUiTranslationsV1(params.registry, entriesById, undefined);
    projectPluginUiPresentationEntriesV1({ ...params, entriesById });
    return PluginDeclaredUiEntriesV1Schema.parse(entriesById);
}

/** Adapts already-admitted immutable declarations, never machine execution facts. */
export function projectPluginPortableUiDeclarationsV1(
    manifest: PluginPortableReleaseManifestV1,
    hostBundledArtifacts?: readonly PluginUiArtifactsManifestEntryV2[],
): PluginDeclaredUiEntriesV1 {
    const pluginId = manifest.id;
    const ui = manifest.contributes.ui;
    const contributions = <T extends Readonly<{ id: string }>>(definitions: readonly T[]) => definitions.map(definition => ({
        pluginId, pluginVersion: manifest.version, definition,
        identity: createPluginContributionIdentity({ pluginId, localId: definition.id }),
    }));
    const registry = {
        uiRenderersV2: contributions(ui.renderers),
        uiViewsV2: contributions(hostBundledArtifacts ? ui.views.filter(view => view.target.kind === 'app') : ui.views),
        uiSettingsPagesV2: contributions(ui.settingsPages),
        uiSettingsGroupsV2: contributions(ui.settingsGroups),
        uiTranslationsV2: ui.translations.map(definition => ({ pluginId, pluginVersion: manifest.version, definition })),
        openableContentViewers: contributions(manifest.contributes.openableContentViewers ?? []),
    } satisfies PluginUiPresentationRegistryV1;
    const actions = contributions(manifest.contributes.actions ?? []);
    const destinations = [...registry.uiViewsV2, ...registry.uiSettingsPagesV2].map(entry => entry.identity);
    const modelsByRendererKey: Record<string, StablePluginDeclarativeModel> = {};
    for (const renderer of registry.uiRenderersV2) {
        if (renderer.definition.kind !== 'declarative') continue;
        try {
            modelsByRendererKey[`${pluginId}\0${renderer.definition.id}`] = createStablePluginDeclarativeModel({
                pluginId, renderer: renderer.definition,
                settings: [...createStablePluginSettingsModels({ pluginId, contributions: manifest.contributes.settings ?? [] }).values()],
                actions: actions.map(entry => entry.identity),
                dragSources: contributions(manifest.contributes.dragSources ?? []).map(entry => ({
                    identity: entry.identity, referenceSchema: entry.definition.referenceSchema,
                })),
                dropTargets: contributions(manifest.contributes.dropTargets ?? []).map(entry => entry.identity),
                actionPresentations: actions.map(entry => ({
                    identity: entry.identity,
                    title: typeof entry.definition.title === 'string'
                        ? entry.definition.title
                        : entry.definition.title.fallback,
                    ...(entry.definition.icon ? { icon: entry.definition.icon } : {}),
                })),
                destinations,
                // Collection query authority requires Data's normalized host projection;
                // a portable collection declaration cannot manufacture it.
            });
        } catch {
            // Match the host projector: unresolved static inputs leave this renderer
            // unavailable while preserving other admitted presentation declarations.
        }
    }
    const artifactEntries = registry.uiRenderersV2.flatMap(renderer => {
        const definition = renderer.definition;
        if (definition.kind !== 'reactNative') return [];
        const candidates = hostBundledArtifacts?.filter(artifact => artifact.tier === 'reactNative'
            && artifact.artifactId === definition.artifact) ?? [];
        if (candidates.length !== 1) return [];
        const artifact = candidates[0]!;
        const compatible = isPluginUiHostApiVersionCompatibleWithVersionV1(PLUGIN_UI_HOST_API_VERSION_V1, artifact.hostUiApiRange);
        return [projectPluginReactNativeArtifactEntryV1({
            pluginId, pluginVersion: manifest.version, contributionId: definition.id,
            artifactId: artifact.artifactId, artifact, generatedOwnerKind: 'renderer',
            requiredHostMethods: definition.requiredHostMethods ?? [],
            runtime: Object.freeze({ state: compatible ? 'loadable' : 'blocked', diagnostics: compatible ? [] : ['generated_ui_host_api_mismatch'],
                decision: { state: compatible ? 'load' : 'blocked', reason: compatible ? 'compatible' : 'generated_ui_host_api_mismatch',
                    diagnostics: compatible ? [] : ['generated_ui_host_api_mismatch'] },
                ...(compatible ? { cacheKey: artifact.digest, cacheIdentity: { artifactDigest: artifact.digest },
                    loadPolicy: { source: 'installedArtifact' } } : {}) }),
        })];
    });
    return projectPluginUiDeclarationEntriesV1({ registry, modelsByRendererKey, artifactEntries });
}
