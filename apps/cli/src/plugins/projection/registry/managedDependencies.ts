import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const managedDependenciesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'managedDependencies',
    project({ registry }) {
        return {
            family: 'managedDependencies',
            entriesById: Object.fromEntries(
                [...(registry.managedDependencies ?? [])]
                    .sort((left, right) => left.definition.key.localeCompare(right.definition.key))
                    .map((dependency) => [
                        dependency.definition.key,
                        {
                            id: dependency.definition.key,
                            pluginId: dependency.pluginId,
                            key: dependency.definition.key,
                            capabilityId: dependency.definition.capabilityId,
                            sourceKind: dependency.definition.source.kind,
                            display: dependency.definition.display,
                            defaultPolicy: dependency.definition.defaultPolicy,
                            experimental: dependency.definition.stability.experimental,
                        },
                    ]),
            ),
        };
    },
});
