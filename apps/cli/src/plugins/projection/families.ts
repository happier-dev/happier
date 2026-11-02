import type { MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { PluginProjectionBrandAssetV2 } from '@happier-dev/protocol';
import { assertPluginProjectionFamilyIdsV2, listPluginProjectionFamilyIdsV2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginProjectedFamilyV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginContributionCatalogEntryV2, PluginMachineExecutionOriginV1, PluginProjectedFamilyEntryV2, PluginProjectedFamilyV2 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

export type PluginProjectionFamilyContextV2 = Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    /**
     * The RESOLVED per-plugin diagnostics for this projection, which include
     * runtime activation facts the static contribution registry cannot carry.
     * `buildPluginProjectionV2` already resolves this set for
     * `installedPackagesById` and the top-level `diagnostics`; families read the
     * same set so a plugin's health cannot be described two different ways
     * inside one projection.
     */
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    /**
     * Exact per-plugin execution origins for this projection lease. The
     * UI family consumes these verbatim; absent facts deliberately stay absent
     * rather than becoming a machine-level fallback.
     */
    pluginExecutionOriginsByPluginId?: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    pluginUiHostRuntime?: unknown;
    /**
     * The requesting client's display locale, when it named one. Only the
     * translations projection consumes it, to ship the locales that client can
     * actually read instead of every contributed one. Absent means "no
     * narrowing", which is the shape an older client receives.
     */
    requestedLocale?: string;
    /** Exact cold recipe demand; [] selects no declaration bodies. */
    machineRecipeRefs?: readonly MachineRecipeReferenceV1[];
    /** Existing Resource owner fact, read only for plugins in this family's demand. */
    readPluginBrandAsset?: (pluginId: string) => PluginProjectionBrandAssetV2 | undefined;
    /** Invalid wire entries are omitted; the describe owner publishes their attributed diagnostics. */
    onInvalidEntry?: (failure: Readonly<{
        family: string;
        entryId: string;
        entry: PluginProjectedFamilyEntryV2;
        issues: readonly Readonly<{ code: string; path: readonly string[]; message: string }>[];
    }>) => void;
}>;

export type PluginProjectionFamilyDescriptorV2<Family extends PluginProjectedFamilyV2 = PluginProjectedFamilyV2> = Readonly<{
    family: Family['family'];
    project: (context: PluginProjectionFamilyContextV2) => Family;
}>;

export function definePluginProjectionFamilyV2<Family extends PluginProjectedFamilyV2>(
    descriptor: PluginProjectionFamilyDescriptorV2<Family>,
): PluginProjectionFamilyDescriptorV2<Family> {
    return Object.freeze(descriptor);
}

export function definePluginProjectionFamilyCatalogV2(
    descriptors: readonly PluginProjectionFamilyDescriptorV2[],
    catalog?: readonly PluginContributionCatalogEntryV2[],
): readonly PluginProjectionFamilyDescriptorV2[] {
    const familyIds = listPluginProjectionFamilyIdsV2(catalog);
    assertPluginProjectionFamilyIdsV2(descriptors.map((descriptor) => descriptor.family), catalog);
    const descriptorsByFamily = new Map<string, PluginProjectionFamilyDescriptorV2>();
    for (const descriptor of descriptors) {
        descriptorsByFamily.set(descriptor.family, descriptor);
    }
    return Object.freeze(familyIds.map((family) => descriptorsByFamily.get(family)!));
}

function freezeProjectedFamilyV2<Family extends PluginProjectedFamilyV2>(
    projected: Family,
    occurrenceIdsByPluginId: ResolvedContributionRegistry['occurrenceIdsByPluginId'],
    onInvalidEntry: PluginProjectionFamilyContextV2['onInvalidEntry'],
): Family {
    const familySchema = PluginProjectedFamilyV2Schema._zod.def.options.find((schema) => (
        schema.shape.family._zod.def.values.some((family) => family === projected.family)
    ));
    if (!familySchema) throw new Error(`Missing canonical schema for projection family '${projected.family}'`);
    const entrySchema = familySchema.shape.entriesById._zod.def.innerType._zod.def.valueType;
    const entriesById = Object.fromEntries(Object.entries(projected.entriesById).flatMap(([entryId, entry]) => {
        const pluginId = typeof entry.pluginId === 'string' ? entry.pluginId : null;
        const occurrenceId = pluginId ? occurrenceIdsByPluginId?.[pluginId] : undefined;
        if (pluginId && !occurrenceId) return [];
        const stampedEntry = occurrenceId ? Object.freeze({ ...entry, occurrenceId }) : entry;
        const parsed = entrySchema.safeParse(stampedEntry);
        if (!parsed.success) {
            if (!onInvalidEntry) throw parsed.error;
            onInvalidEntry({
                family: projected.family,
                entryId,
                entry: stampedEntry,
                issues: parsed.error.issues.map((issue) => ({
                    code: issue.code, path: issue.path.map(String), message: issue.message,
                })),
            });
            return [];
        }
        return [[entryId, stampedEntry] as const];
    }));
    return Object.freeze({
        ...projected,
        entriesById: Object.freeze(entriesById),
    }) as Family;
}

export function buildPluginProjectionFamilyV2<Family extends PluginProjectedFamilyV2>(
    context: PluginProjectionFamilyContextV2,
    descriptor: PluginProjectionFamilyDescriptorV2<Family>,
): Family {
    const projected = descriptor.project(context);
    if (projected.family !== descriptor.family) {
        throw new Error(`Plugin projection family descriptor '${descriptor.family}' returned '${projected.family}'`);
    }
    return freezeProjectedFamilyV2(projected, context.registry.occurrenceIdsByPluginId, context.onInvalidEntry);
}

export function buildPluginProjectionFamiliesByIdV2(
    context: PluginProjectionFamilyContextV2,
    descriptors: readonly PluginProjectionFamilyDescriptorV2[],
): Readonly<Record<string, PluginProjectedFamilyV2>> {
    const familiesById: Record<string, PluginProjectedFamilyV2> = {};
    for (const descriptor of definePluginProjectionFamilyCatalogV2(descriptors)) {
        familiesById[descriptor.family] = buildPluginProjectionFamilyV2(context, descriptor);
    }
    return Object.freeze(familiesById);
}
