import type { PluginProjectedFamilyV2 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

export type PluginProjectionFamilyContextV2 = Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    pluginUiHostRuntime?: unknown;
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

export function buildPluginProjectionFamiliesByIdV2(
    context: PluginProjectionFamilyContextV2,
    descriptors: readonly PluginProjectionFamilyDescriptorV2[],
): Readonly<Record<string, PluginProjectedFamilyV2>> {
    const familiesById: Record<string, PluginProjectedFamilyV2> = {};
    for (const descriptor of descriptors) {
        const projected = descriptor.project(context);
        familiesById[descriptor.family] = Object.freeze({
            family: projected.family,
            entriesById: Object.freeze({ ...projected.entriesById }),
        });
    }
    return Object.freeze(familiesById);
}
