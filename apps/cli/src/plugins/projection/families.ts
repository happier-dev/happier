import {
    assertPluginProjectionFamilyIdsV2,
    listPluginProjectionFamilyIdsV2,
    type PluginContributionCatalogEntryV2,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedFamilyV2,
} from '@happier-dev/protocol';

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
     * Exact per-plugin source materializations for this projection lease. The
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
    scmRuntimeAvailability?: Readonly<{
        backendIds: ReadonlySet<string>;
        hostingProviderIds: ReadonlySet<string>;
    }>;
}>;

export type PluginProjectionFamilyDescriptorV2 = Readonly<{
    family: string;
    project: (context: PluginProjectionFamilyContextV2) => PluginProjectedFamilyV2;
}>;

export function definePluginProjectionFamilyV2(
    descriptor: PluginProjectionFamilyDescriptorV2,
): PluginProjectionFamilyDescriptorV2 {
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

function freezeProjectedFamilyV2<Family extends PluginProjectedFamilyV2>(projected: Family): Family {
    return Object.freeze({
        ...projected,
        entriesById: Object.freeze({ ...projected.entriesById }),
    }) as Family;
}

export function buildPluginProjectionFamiliesByIdV2(
    context: PluginProjectionFamilyContextV2,
    descriptors: readonly PluginProjectionFamilyDescriptorV2[],
): Readonly<Record<string, PluginProjectedFamilyV2>> {
    const familiesById: Record<string, PluginProjectedFamilyV2> = {};
    for (const descriptor of definePluginProjectionFamilyCatalogV2(descriptors)) {
        const projected = descriptor.project(context);
        if (projected.family !== descriptor.family) {
            throw new Error(
                `Plugin projection family descriptor '${descriptor.family}' returned '${projected.family}'`,
            );
        }
        familiesById[descriptor.family] = freezeProjectedFamilyV2(projected);
    }
    return Object.freeze(familiesById);
}
