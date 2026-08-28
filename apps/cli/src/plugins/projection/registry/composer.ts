import {
    buildQualifiedPluginContributionKey,
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type DaemonPluginUiTargetedSurfaceSelectedRendererV1,
    type DaemonPluginReactNativeCrashMountV1,
    DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectionV2,
    type PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';
import {
    selectPluginUiRendererChainMemberV1,
    type PluginUiRendererChainBindingV1,
    type PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import {
    createReactNativeCrashStateBindingKey,
    type ReactNativeCrashStateBinding,
} from '@/plugins/runtime/ui/reactNativeCrashDisableState';

import type {
    ResolvedComposerAttachmentContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedContributionRegistry,
    ResolvedUiRendererV2Contribution,
} from './types';
import {
    projectPluginUiRendererAvailability,
    projectPluginUiRendererCrashState,
    projectPluginUiRendererRef,
    resolvePluginUiRendererProjectionEntry,
    type PluginUiProjectionHostRuntimeContext,
} from './ui/projection';
import {
    buildPluginUiRendererContributionKey,
    resolvePluginUiRendererChain,
} from './rendererChain';

type StaticComposerContribution = Readonly<{
    pluginId: string;
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: Readonly<{ id: string }>;
}>;

type ComposerSurfaceRole = DaemonPluginUiComposerSurfaceCatalogEntryV1['role'];

export type ComposerSurfaceDeclaration = Readonly<{
    contribution: StaticComposerContribution;
    role: ComposerSurfaceRole;
    renderer: PluginUiRendererChainBindingV1;
}>;

function projectStaticComposerEntries<T extends StaticComposerContribution>(
    entries: readonly T[],
    immutableGenerationIdsByPluginId: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, Readonly<{
    id: string;
    pluginId: string;
    identity: T['identity'];
    immutableGenerationId: string;
    definition: T['definition'];
}>>> {
    const entriesById: Record<string, Readonly<{
        id: string;
        pluginId: string;
        identity: T['identity'];
        immutableGenerationId: string;
        definition: T['definition'];
    }>> = {};
    for (const entry of entries) {
        const immutableGenerationId = immutableGenerationIdsByPluginId?.[entry.pluginId]?.trim();
        if (!immutableGenerationId) continue;
        const id = buildQualifiedPluginContributionKey(entry.identity);
        entriesById[id] = Object.freeze({
            id,
            pluginId: entry.pluginId,
            identity: entry.identity,
            immutableGenerationId,
            definition: entry.definition,
        });
    }
    return Object.freeze(entriesById);
}

function appendComposerSurfaceDeclaration(
    declarations: ComposerSurfaceDeclaration[],
    contribution: StaticComposerContribution,
    role: ComposerSurfaceRole,
    renderer: PluginUiRendererChainBindingV1 | undefined,
): void {
    if (!renderer) return;
    declarations.push(Object.freeze({ contribution, role, renderer }));
}

/**
 * The composer catalog is the daemon's one renderer-selection projection. It
 * receives the normalized static declarations, the current broad UI projection,
 * and exact lifecycle/origin facts; UI consumers only rematch its selected
 * output to their live Composer mount and never choose a fallback themselves.
 */
export function listComposerSurfaceDeclarations(
    registry: ResolvedContributionRegistry,
): readonly ComposerSurfaceDeclaration[] {
    const declarations: ComposerSurfaceDeclaration[] = [];
    for (const attachment of registry.composerAttachments ?? []) {
        appendComposerSurfaceDeclaration(declarations, attachment, 'attachmentPicker', attachment.definition.picker);
        appendComposerSurfaceDeclaration(
            declarations,
            attachment,
            'attachmentDisplay',
            attachment.definition.display?.kind === 'surface'
                ? attachment.definition.display.renderer
                : undefined,
        );
        appendComposerSurfaceDeclaration(
            declarations,
            attachment,
            'attachmentPreview',
            attachment.definition.preview?.kind === 'surface'
                ? attachment.definition.preview.renderer
                : undefined,
        );
    }
    for (const control of registry.composerControls ?? []) {
        appendComposerSurfaceDeclaration(
            declarations,
            control,
            'controlCompact',
            control.definition.compactRenderer,
        );
        appendComposerSurfaceDeclaration(
            declarations,
            control,
            'controlInteraction',
            control.definition.interaction.kind === 'surface'
                ? control.definition.interaction.renderer
                : undefined,
        );
    }
    for (const region of registry.composerRegions ?? []) {
        appendComposerSurfaceDeclaration(declarations, region, 'region', region.definition.renderer);
    }
    return Object.freeze(declarations.sort((left, right) => (
        left.contribution.pluginId.localeCompare(right.contribution.pluginId)
        || left.contribution.identity.localId.localeCompare(right.contribution.identity.localId)
        || left.role.localeCompare(right.role)
    )));
}

function createComposerRenderersByQualifiedId(
    registry: ResolvedContributionRegistry,
): ReadonlyMap<string, ResolvedUiRendererV2Contribution> {
    const renderersByKey = new Map<string, ResolvedUiRendererV2Contribution>();
    for (const renderer of registry.uiRenderersV2 ?? []) {
        renderersByKey.set(
            buildPluginUiRendererContributionKey(renderer.pluginId, renderer.definition.id),
            renderer,
        );
    }
    return renderersByKey;
}

/**
 * The one physical embedded-renderer selector shared by Composer and optional
 * Automation Event setup surfaces. Semantic owners provide only a same-plugin
 * renderer chain and mount identity; artifact availability and fallback
 * selection stay here.
 */
export function projectDaemonEmbeddedPluginUiRenderer(input: Readonly<{
    registry: ResolvedContributionRegistry;
    projection: PluginProjectionV2;
    pluginUiHostRuntime: PluginUiProjectionHostRuntimeContext;
    modelsByRendererKey: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
    contributor: Readonly<{ pluginId: string; localId: string }>;
    immutableGenerationId: string;
    renderer: PluginUiRendererChainBindingV1;
    crashMount?: DaemonPluginReactNativeCrashMountV1;
}>): Readonly<{
    rendererChain: readonly Readonly<{ pluginId: string; localId: string }>[];
    selectedRenderer: DaemonPluginUiTargetedSurfaceSelectedRendererV1;
}> | null {
    if (
        input.registry.immutableGenerationIdsByPluginId?.[input.contributor.pluginId]?.trim()
        !== input.immutableGenerationId
    ) return null;
    const renderersByKey = createComposerRenderersByQualifiedId(input.registry);
    const entriesById = input.projection.familiesById.pluginUi?.entriesById ?? {};
    const rendererChainResolution = resolvePluginUiRendererChain({
        binding: input.renderer,
        contributorPluginId: input.contributor.pluginId,
        renderersByQualifiedId: renderersByKey,
    });
    if (!rendererChainResolution.ok) return null;
    const rendererChain = rendererChainResolution.rendererChain;
    const candidates = rendererChain.map((renderer) => {
        const declarativeModel = renderer.definition.kind === 'declarative'
            ? input.modelsByRendererKey[`${renderer.pluginId}\u0000${renderer.definition.id}`]
            : undefined;
        const rendererProjection = projectPluginUiRendererRef(renderer, declarativeModel);
        const availability = projectPluginUiRendererAvailability({
            pluginId: input.contributor.pluginId,
            renderer,
            declarativeModel,
            registryRendererRef: rendererProjection.registryRendererRef,
            entriesById,
        });
        const crashStateProjection = input.crashMount
            ? projectPluginUiRendererCrashState({
                mount: input.crashMount,
                renderer,
                availability,
                hostRuntime: input.pluginUiHostRuntime,
            })
            : Object.freeze({ availability });
        const artifactProjection = resolvePluginUiRendererProjectionEntry({
            pluginId: input.contributor.pluginId,
            renderer: rendererProjection.registryRendererRef,
            entriesById,
        });
        return Object.freeze({
            renderer,
            rendererRef: rendererProjection.rendererRef,
            availability: crashStateProjection.availability,
            ...(artifactProjection ? { artifactProjection } : {}),
            ...('crashState' in crashStateProjection && crashStateProjection.crashState
                ? { crashState: crashStateProjection.crashState }
                : {}),
        });
    });
    const selectedIdentity = selectPluginUiRendererChainMemberV1(
        rendererChain.map((renderer) => renderer.identity),
        candidates
            .filter((candidate) => candidate.availability.state === 'available')
            .map((candidate) => candidate.renderer.definition.id),
    ) ?? rendererChain[0]?.identity;
    const selected = selectedIdentity
        ? candidates.find((candidate) => (
            candidate.renderer.identity.pluginId === selectedIdentity.pluginId
            && candidate.renderer.identity.localId === selectedIdentity.localId
        ))
        : undefined;
    if (!selected) return null;
    const parsed = DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema.safeParse({
        identity: Object.freeze({ ...selected.renderer.identity }),
        renderer: selected.rendererRef,
        availability: selected.availability,
        ...(selected.artifactProjection ? { artifactProjection: selected.artifactProjection } : {}),
        ...(selected.crashState ? { crashState: selected.crashState } : {}),
    });
    if (!parsed.success) return null;
    return Object.freeze({
        rendererChain: Object.freeze(rendererChain.map((renderer) => Object.freeze({ ...renderer.identity }))),
        selectedRenderer: parsed.data,
    });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/**
 * Enumerates the current Composer-owned React Native crash bindings from the
 * same normalized declarations consumed by the catalog. This does not select
 * a renderer or retain a Composer scope: the crash owner keys only the static
 * contributor/generation/role fact that every live mount must later match.
 */
export function readCurrentComposerReactNativeCrashStateBindings(input: Readonly<{
    registry: ResolvedContributionRegistry;
    projection: PluginProjectionV2;
}>): readonly ReactNativeCrashStateBinding[] {
    const renderersByKey = createComposerRenderersByQualifiedId(input.registry);
    const entriesById = input.projection.familiesById.pluginUi?.entriesById ?? {};
    const bindingsByKey = new Map<string, ReactNativeCrashStateBinding>();
    for (const declaration of listComposerSurfaceDeclarations(input.registry)) {
        const immutableGenerationId = input.registry.immutableGenerationIdsByPluginId?.[
            declaration.contribution.pluginId
        ]?.trim();
        if (!immutableGenerationId) continue;

        const rendererChainResolution = resolvePluginUiRendererChain({
            binding: declaration.renderer,
            contributorPluginId: declaration.contribution.pluginId,
            renderersByQualifiedId: renderersByKey,
        });
        if (!rendererChainResolution.ok) continue;

        for (const renderer of rendererChainResolution.rendererChain) {
            if (renderer.definition.kind !== 'reactNative') continue;
            const rendererProjection = projectPluginUiRendererRef(renderer, undefined);
            const rendererEntry = resolvePluginUiRendererProjectionEntry({
                pluginId: declaration.contribution.pluginId,
                renderer: rendererProjection.registryRendererRef,
                entriesById,
            });
            const rendererRuntime = readRecord(readRecord(rendererEntry)?.runtime);
            const cacheIdentity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(
                rendererRuntime?.cacheIdentity,
            );
            if (
                !cacheIdentity.success
                || cacheIdentity.data.pluginId !== declaration.contribution.pluginId
                || cacheIdentity.data.contributionId !== renderer.definition.id
                || renderer.identity.pluginId !== declaration.contribution.pluginId
                || renderer.identity.localId !== renderer.definition.id
            ) {
                continue;
            }

            const binding: ReactNativeCrashStateBinding = Object.freeze({
                mount: Object.freeze({
                    kind: 'composer' as const,
                    contribution: Object.freeze({ ...declaration.contribution.identity }),
                    immutableGenerationId,
                    role: declaration.role,
                }),
                renderer: Object.freeze({
                    pluginId: cacheIdentity.data.pluginId,
                    localId: cacheIdentity.data.contributionId,
                }),
                artifactDigest: cacheIdentity.data.artifactDigest,
            });
            const key = createReactNativeCrashStateBindingKey(binding);
            const previous = bindingsByKey.get(key);
            if (previous && previous.artifactDigest !== binding.artifactDigest) {
                throw new Error('Projected Composer React Native binding has conflicting current artifact digests');
            }
            bindingsByKey.set(key, binding);
        }
    }
    return Object.freeze([...bindingsByKey.values()]);
}

/**
 * Reads the Automation Event setup-surface RN bindings from the same cold
 * registry and projected artifact identities used by the embedded renderer
 * selector. Automation remains an embedded placement; it never impersonates
 * a destination merely to reuse crash containment.
 */
export function readCurrentAutomationEventSetupReactNativeCrashStateBindings(input: Readonly<{
    registry: ResolvedContributionRegistry;
    projection: PluginProjectionV2;
}>): readonly ReactNativeCrashStateBinding[] {
    const renderersByKey = createComposerRenderersByQualifiedId(input.registry);
    const entriesById = input.projection.familiesById.pluginUi?.entriesById ?? {};
    const bindingsByKey = new Map<string, ReactNativeCrashStateBinding>();
    for (const entry of input.registry.automationEligibleEvents ?? []) {
        const declaration = entry.event.automation.source.setupSurface;
        if (!declaration) continue;
        const contribution = entry.event.identity;
        const immutableGenerationId = entry.event.immutableGenerationId;
        const rendererChainResolution = resolvePluginUiRendererChain({
            binding: declaration,
            contributorPluginId: contribution.pluginId,
            renderersByQualifiedId: renderersByKey,
        });
        if (!rendererChainResolution.ok) continue;

        for (const renderer of rendererChainResolution.rendererChain) {
            if (renderer.definition.kind !== 'reactNative') continue;
            const rendererProjection = projectPluginUiRendererRef(renderer, undefined);
            const rendererEntry = resolvePluginUiRendererProjectionEntry({
                pluginId: contribution.pluginId,
                renderer: rendererProjection.registryRendererRef,
                entriesById,
            });
            const rendererRuntime = readRecord(readRecord(rendererEntry)?.runtime);
            const cacheIdentity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(
                rendererRuntime?.cacheIdentity,
            );
            if (
                !cacheIdentity.success
                || cacheIdentity.data.pluginId !== contribution.pluginId
                || cacheIdentity.data.contributionId !== renderer.definition.id
                || renderer.identity.pluginId !== contribution.pluginId
                || renderer.identity.localId !== renderer.definition.id
            ) continue;

            const binding: ReactNativeCrashStateBinding = Object.freeze({
                mount: Object.freeze({
                    kind: 'automationEventSetupSurface' as const,
                    contribution: Object.freeze({ ...contribution }),
                    immutableGenerationId,
                }),
                renderer: Object.freeze({
                    pluginId: cacheIdentity.data.pluginId,
                    localId: cacheIdentity.data.contributionId,
                }),
                artifactDigest: cacheIdentity.data.artifactDigest,
            });
            const key = createReactNativeCrashStateBindingKey(binding);
            const previous = bindingsByKey.get(key);
            if (previous && previous.artifactDigest !== binding.artifactDigest) {
                throw new Error('Projected Automation Event setup React Native binding has conflicting current artifact digests');
            }
            bindingsByKey.set(key, binding);
        }
    }
    return Object.freeze([...bindingsByKey.values()]);
}

/**
 * Builds the static half of Composer mounts. This does not create a Composer
 * scope, instance key, or launch input: those are host-private live UI facts.
 */
export function projectDaemonComposerSurfaceCatalog(input: Readonly<{
    registry: ResolvedContributionRegistry;
    projection: PluginProjectionV2;
    pluginUiHostRuntime: PluginUiProjectionHostRuntimeContext;
    modelsByRendererKey: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
    pluginExecutionOriginsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    resourceCapabilityForPlugin: (pluginId: string) => PluginUiResourceBindingCapabilityV1;
    readContributorTargetedContributions: (target: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
    }>) => PluginUiTargetedContributionsV1;
}>): readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[] {
    const catalog: DaemonPluginUiComposerSurfaceCatalogEntryV1[] = [];
    for (const declaration of listComposerSurfaceDeclarations(input.registry)) {
        const immutableGenerationId = input.registry.immutableGenerationIdsByPluginId?.[
            declaration.contribution.pluginId
        ]?.trim();
        const executionOrigin = input.pluginExecutionOriginsByPluginId[declaration.contribution.pluginId];
        if (!immutableGenerationId || !executionOrigin) continue;

        const rendered = projectDaemonEmbeddedPluginUiRenderer({
            registry: input.registry,
            projection: input.projection,
            pluginUiHostRuntime: input.pluginUiHostRuntime,
            modelsByRendererKey: input.modelsByRendererKey,
            contributor: declaration.contribution.identity,
            immutableGenerationId,
            renderer: declaration.renderer,
            crashMount: Object.freeze({
                kind: 'composer' as const,
                contribution: Object.freeze({ ...declaration.contribution.identity }),
                immutableGenerationId,
                role: declaration.role,
            }),
        });
        if (!rendered) continue;

        let contributorTargetedContributions: PluginUiTargetedContributionsV1;
        let resourceCapability: PluginUiResourceBindingCapabilityV1;
        try {
            contributorTargetedContributions = input.readContributorTargetedContributions({
                pluginId: declaration.contribution.pluginId,
                immutableGenerationId,
            });
            resourceCapability = input.resourceCapabilityForPlugin(declaration.contribution.pluginId);
        } catch {
            // Currentness/resource facts are producer-owned and must fail closed;
            // no static declaration is enough to authorize a live surface mount.
            continue;
        }

        catalog.push(Object.freeze({
            contribution: Object.freeze({ ...declaration.contribution.identity }),
            immutableGenerationId,
            projectionGeneration: input.projection.generation,
            role: declaration.role,
            // The protocol parser owns the public array immutability boundary;
            // keep the source value assignable to its mutable Zod-inferred shape.
            rendererChain: rendered.rendererChain.map((renderer) => ({ ...renderer })),
            selectedRenderer: rendered.selectedRenderer,
            executionOrigin: Object.freeze({
                serverIdentityId: executionOrigin.serverIdentityId,
                materializationRef: Object.freeze({ ...executionOrigin.materializationRef }),
            }),
            resourceCapability,
            contributorTargetedContributions,
        }));
    }
    return Object.freeze(catalog);
}

export const composerAttachmentsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'composerAttachments',
    project: ({ registry }) => ({
        family: 'composerAttachments',
        entriesById: projectStaticComposerEntries(
            registry.composerAttachments ?? [],
            registry.immutableGenerationIdsByPluginId,
        ),
    }),
});

export const composerControlsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'composerControls',
    project: ({ registry }) => ({
        family: 'composerControls',
        entriesById: projectStaticComposerEntries(
            registry.composerControls ?? [],
            registry.immutableGenerationIdsByPluginId,
        ),
    }),
});

export const composerRegionsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'composerRegions',
    project: ({ registry }) => ({
        family: 'composerRegions',
        entriesById: projectStaticComposerEntries(
            registry.composerRegions ?? [],
            registry.immutableGenerationIdsByPluginId,
        ),
    }),
});
