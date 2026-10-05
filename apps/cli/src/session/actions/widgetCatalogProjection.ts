import { z } from 'zod';
import { buildQualifiedPluginContributionKey, PluginJsonSchemaV2Schema, PluginContributionIdentityV1Schema, type PluginProjectionV2 } from '@happier-dev/protocol';
import { InputHintsSchema, InputPathSchema } from '@happier-dev/protocol/inputs';
import { defineProtocolArray } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginUiSurfaceBindingV1Schema, PluginUiWidgetHomeV1Schema, selectPluginUiWidgetEntriesV1 } from '@happier-dev/protocol/plugins/ui';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, WidgetConnectedAccountPurposeBindingV1Schema, widgetCandidateDefinitionV1, type WidgetCatalogEntryV1 } from '@happier-dev/protocol/widgets';

const display = z.object({ title: z.string().trim().min(1).optional(), developerFallback: z.string().trim().min(1).optional() }).passthrough();

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
        if (!title.success || entry.inputs !== undefined && !inputs.success || entry.inputSchema !== undefined && !inputSchema.success) return [];
        if (entry.connectedAccountPurposeBindings !== undefined && !Array.isArray(entry.connectedAccountPurposeBindings)
            || purposeBindings.some(value => !value.success)) return [];
        const technical = entry.availability;
        const available = technical === undefined || technical !== null && typeof technical === 'object' && !Array.isArray(technical)
            && Reflect.get(technical, 'state') === 'available' && Reflect.get(technical, 'when') === undefined && Reflect.get(technical, 'disabledWhen') === undefined;
        return [{ surface: entry.binding.surface, key: buildQualifiedPluginContributionKey(entry.binding.surface),
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

export function cliWidgetCatalogEntryV1(candidate: ReturnType<typeof readCliWidgetCatalogProjectionV1>[number], instanceCount: number): WidgetCatalogEntryV1 {
    return { definition: widgetCandidateDefinitionV1(candidate), title: candidate.title,
        fields: [...candidate.fields], availability: candidate.availability, instanceCount };
}
