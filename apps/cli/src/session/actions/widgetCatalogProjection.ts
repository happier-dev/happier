import { z } from 'zod/mini';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { InputHintsSchema } from '@happier-dev/protocol/inputs/inputFields';
import { InputPathSchema } from '@happier-dev/protocol/inputs/inputPredicates';
import { defineProtocolArray } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginUiSurfaceBindingV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/surfaceRegistry';
import { selectPluginUiWidgetEntriesV1 } from '@happier-dev/protocol/plugins/contributions/ui/widgetInventory';
import { PluginUiWidgetHomeV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, isSameWidgetDefinitionV1, readBuiltinWidgetDescriptorV1, readUsageBreakdownsInstanceTitleV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { WidgetConnectedAccountPurposeBindingV1Schema } from '@happier-dev/protocol/widgets/widgetConnectedAccountPurposeBindingV1';
import { WidgetSizeDeclarationV1Schema } from '@happier-dev/protocol/widgets/widgetPresentationV1';
import type { WidgetCatalogSourceEntryV1, WidgetInstanceV1, WidgetDefinitionArtifactPortV1, WidgetCandidateIdentityV1 } from '@happier-dev/protocol/widgets';
import { WidgetPublicSnapshotPresentationV1Schema } from '@happier-dev/protocol/widgets/widgetPublicSnapshotV1';

const display = z.looseObject({ title: z.optional(z.string().check(z.trim(), z.minLength(1))), developerFallback: z.optional(z.string().check(z.trim(), z.minLength(1))) });

/** The daemon has admitted these rows; role/identity selection shares the Gallery selector. */
export function readCliWidgetCatalogProjectionV1(projection: PluginProjectionV2) {
    const rows = Object.values(projection.familiesById.pluginUi?.entriesById ?? {}).flatMap(entry => {
        if (entry.contributionKind !== 'surfacePlacement') return [];
        const binding = PluginUiSurfaceBindingV1Schema.safeParse(entry.binding);
        return binding.success ? [{ ...entry, binding: binding.data }] : [];
    });
    const installed = selectPluginUiWidgetEntriesV1(rows).flatMap(entry => {
        const title = display.safeParse(entry.display);
        const inputs = InputHintsSchema.safeParse(entry.inputs);
        const inputSchema = PluginJsonSchemaV2Schema.safeParse(entry.inputSchema);
        const sessionInputPath = InputPathSchema.safeParse(entry.sessionInputPath);
        const defaultHome = PluginUiWidgetHomeV1Schema.safeParse(entry.home);
        const purposeBindings = Array.isArray(entry.connectedAccountPurposeBindings)
            ? entry.connectedAccountPurposeBindings.map(value => WidgetConnectedAccountPurposeBindingV1Schema.safeParse(value)) : [];
        const resources = defineProtocolArray(PluginContributionIdentityV1Schema).safeParse(entry.resources ?? []);
        const sizeDeclaration = WidgetSizeDeclarationV1Schema.safeParse(entry.sizeDeclaration);
        const publicPresentation = WidgetPublicSnapshotPresentationV1Schema.safeParse(entry.publicPresentation);
        if (!sizeDeclaration.success) return [];
        if (!title.success || entry.inputs !== undefined && !inputs.success || entry.inputSchema !== undefined && !inputSchema.success) return [];
        if (entry.connectedAccountPurposeBindings !== undefined && !Array.isArray(entry.connectedAccountPurposeBindings)
            || purposeBindings.some(value => !value.success)) return [];
        const technical = entry.availability;
        const available = technical === undefined || technical !== null && typeof technical === 'object' && !Array.isArray(technical)
            && Reflect.get(technical, 'state') === 'available' && Reflect.get(technical, 'when') === undefined && Reflect.get(technical, 'disabledWhen') === undefined;
        return [{ surface: entry.binding.surface, key: buildQualifiedPluginContributionKey(entry.binding.surface),
            sizeDeclaration: sizeDeclaration.data,
            ...(publicPresentation.success ? { publicPresentation: publicPresentation.data } : {}),
            title: title.data.title ?? title.data.developerFallback ?? entry.binding.surface.localId,
            fields: inputs.success ? inputs.data.fields : [],
            ...(inputs.success ? { inputs: inputs.data } : {}),
            ...(inputSchema.success ? { inputSchema: inputSchema.data } : {}),
            ...(sessionInputPath.success ? { sessionInputPath: sessionInputPath.data } : {}),
            connectedAccountPurposeBindings: purposeBindings.flatMap(value => value.success ? [value.data] : []),
            connectedAccountDescriptors: Object.values(projection.familiesById.connectedAccounts?.entriesById ?? {}),
            ...(resources.success ? { resources: resources.data, resourceDeclarations: Object.values(projection.resourcesById).filter(resource =>
                resources.data.some(candidate => candidate.pluginId === resource.pluginId && candidate.localId === resource.id)) } : {}),
            homeDefault: defaultHome.success ? defaultHome.data.default : 'available' as const,
            target: entry.binding.targetKind,
            // Without mounted host facts a conditional row remains discoverable but unavailable.
            availability: available ? 'available' as const : 'unavailable' as const,
        }];
    });
    return [...BUILTIN_WIDGET_DESCRIPTORS_V1.map(descriptor => ({ ...descriptor, fields: descriptor.inputs?.fields ?? [], connectedAccountPurposeBindings: [] })), ...installed];
}

export function cliWidgetCatalogEntryV1(candidate: ReturnType<typeof readCliWidgetCatalogProjectionV1>[number], instanceCount: number): WidgetCatalogSourceEntryV1 {
    return { definition: widgetCandidateDefinitionV1(candidate), title: candidate.title,
        target: candidate.target,
        sizeDeclaration: candidate.sizeDeclaration, fields: [...candidate.fields],
        ...('publicPresentation' in candidate && candidate.publicPresentation ? { publicPresentation: candidate.publicPresentation } : {}),
        ...(candidate.inputSchema ? { inputSchema: candidate.inputSchema } : {}), availability: candidate.availability, instanceCount };
}

/** The Project writer supplies unnamed instances; unavailable metadata never becomes a persisted fallback. */
export async function readCliWidgetInstanceTitlesV1(input: Readonly<{
    instances: readonly WidgetInstanceV1[];
    readSummaries: WidgetDefinitionArtifactPortV1['summaries'];
    readCandidates(signal?: AbortSignal, requiredPluginId?: string): Promise<readonly (WidgetCandidateIdentityV1 & Readonly<{ title: string }>)[]>;
    signal?: AbortSignal;
}>): Promise<ReadonlyMap<string, string>> {
    const artifactIds = [...new Set(input.instances.flatMap(instance => instance.definition.kind === 'artifact' ? [instance.definition.artifactId] : []))];
    const pluginIds = [...new Set(input.instances.flatMap(instance => instance.definition.kind === 'installed' ? [instance.definition.surface.pluginId] : []))];
    const [summaries, projections] = await Promise.all([
        artifactIds.length ? input.readSummaries(artifactIds, input.signal) : [],
        Promise.all(pluginIds.map(pluginId => input.readCandidates(input.signal, pluginId))),
    ]);
    input.signal?.throwIfAborted();
    const names = new Map(summaries.map(summary => [summary.artifactId, summary.name]));
    const candidates = projections.flat();
    const titles = new Map<string, string>();
    for (const instance of input.instances) {
        const definition = instance.definition;
        const title = definition.kind === 'artifact' ? names.get(definition.artifactId)
            : definition.kind === 'inline' ? definition.definition.name
                : definition.kind === 'builtin' ? (readUsageBreakdownsInstanceTitleV1(instance) ?? readBuiltinWidgetDescriptorV1(definition))?.title
                    : candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition))?.title;
        if (title !== undefined) titles.set(instance.id, title);
    }
    return titles;
}
