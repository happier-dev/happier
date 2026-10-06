import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { DaemonPluginUiComposerSurfaceCatalogEntryV1, DaemonPluginUiTargetedSurfaceSelectedRendererV1, PluginMachineExecutionOriginV1, PluginProjectionV2, PluginUiResourceBindingCapabilityV1 } from '@happier-dev/protocol';
import { DaemonPluginUiTargetedSurfaceSelectedRendererV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { selectPluginUiRendererChainMemberV1 } from '@happier-dev/protocol/plugins/contributions/ui/surfaceRegistry';
import type { PluginUiRendererChainBindingV1, PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import type {
    ResolvedComposerAttachmentContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedContributionRegistry,
    ResolvedUiRendererV2Contribution,
} from './types';
import {
    projectPluginUiRendererAvailability,
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
    occurrenceIdsByPluginId: ResolvedContributionRegistry['occurrenceIdsByPluginId'],
): Readonly<Record<string, Readonly<{
    id: string;
    pluginId: string;
    identity: T['identity'];
    occurrenceId: string;
    definition: T['definition'];
}>>> {
    const entriesById: Record<string, Readonly<{
        id: string;
        pluginId: string;
        identity: T['identity'];
        occurrenceId: string;
        definition: T['definition'];
    }>> = {};
    for (const entry of entries) {
        const occurrenceId = occurrenceIdsByPluginId?.[entry.pluginId];
        if (!occurrenceId) continue;
        const id = buildQualifiedPluginContributionKey(entry.identity);
        entriesById[id] = Object.freeze({
            id,
            pluginId: entry.pluginId,
            identity: entry.identity,
            occurrenceId,
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
    occurrenceId: string;
    renderer: PluginUiRendererChainBindingV1;
}>): Readonly<{
    rendererChain: readonly Readonly<{ pluginId: string; localId: string }>[];
    selectedRenderer: DaemonPluginUiTargetedSurfaceSelectedRendererV1;
}> | null {
    if (
        input.registry.occurrenceIdsByPluginId?.[input.contributor.pluginId]
        !== input.occurrenceId
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
        const artifactProjection = resolvePluginUiRendererProjectionEntry({
            pluginId: input.contributor.pluginId,
            renderer: rendererProjection.registryRendererRef,
            entriesById,
        });
        return Object.freeze({
            renderer,
            rendererRef: rendererProjection.rendererRef,
            availability,
            ...(artifactProjection ? { artifactProjection } : {}),
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
        occurrenceId: string;
    }>) => PluginUiTargetedContributionsV1;
}>): readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[] {
    const catalog: DaemonPluginUiComposerSurfaceCatalogEntryV1[] = [];
    for (const declaration of listComposerSurfaceDeclarations(input.registry)) {
        const occurrenceId = input.registry.occurrenceIdsByPluginId?.[
            declaration.contribution.pluginId
        ];
        const executionOrigin = input.pluginExecutionOriginsByPluginId[declaration.contribution.pluginId];
        if (!occurrenceId || !executionOrigin) continue;

        const rendered = projectDaemonEmbeddedPluginUiRenderer({
            registry: input.registry,
            projection: input.projection,
            pluginUiHostRuntime: input.pluginUiHostRuntime,
            modelsByRendererKey: input.modelsByRendererKey,
            contributor: declaration.contribution.identity,
            occurrenceId,
            renderer: declaration.renderer,
        });
        if (!rendered) continue;

        let contributorTargetedContributions: PluginUiTargetedContributionsV1;
        let resourceCapability: PluginUiResourceBindingCapabilityV1;
        try {
            contributorTargetedContributions = input.readContributorTargetedContributions({
                pluginId: declaration.contribution.pluginId,
                occurrenceId,
            });
            resourceCapability = input.resourceCapabilityForPlugin(declaration.contribution.pluginId);
        } catch {
            // Currentness/resource facts are producer-owned and must fail closed;
            // no static declaration is enough to authorize a live surface mount.
            continue;
        }

        catalog.push(Object.freeze({
            contribution: Object.freeze({ ...declaration.contribution.identity }),
            occurrenceId,
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
            registry.occurrenceIdsByPluginId,
        ),
    }),
});

export const composerControlsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'composerControls',
    project: ({ registry }) => ({
        family: 'composerControls',
        entriesById: projectStaticComposerEntries(
            registry.composerControls ?? [],
            registry.occurrenceIdsByPluginId,
        ),
    }),
});

export const composerRegionsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'composerRegions',
    project: ({ registry }) => ({
        family: 'composerRegions',
        entriesById: projectStaticComposerEntries(
            registry.composerRegions ?? [],
            registry.occurrenceIdsByPluginId,
        ),
    }),
});
