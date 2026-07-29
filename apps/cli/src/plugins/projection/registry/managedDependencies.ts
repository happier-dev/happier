import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { resolveExecutableManagedDependenciesRegistry } from './managedDependencyExecutables';

export const managedDependenciesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'managedDependencies',
    project({ registry }) {
        const dependencies = [...(registry.managedDependencies ?? [])];
        const sourceEntries = dependencies.map((dependency) => ({
            dependency,
            projectionId: 'key' in dependency.definition || !dependency.pluginId
                ? dependency.definition.id
                : `${dependency.pluginId}/${dependency.definition.id}`,
        }));
        const installableEntries = resolveExecutableManagedDependenciesRegistry(dependencies).descriptors.map((entry) => ({
            dependency: {
                pluginId: entry.owner.pluginId,
                definition: entry.descriptor,
            },
            projectionId: entry.descriptor.key,
        }));
        return {
            family: 'managedDependencies',
            entriesById: Object.fromEntries(
                [...sourceEntries, ...installableEntries]
                    .sort((left, right) => left.projectionId.localeCompare(right.projectionId))
                    .map((dependency) => {
                        const definition = dependency.dependency.definition;
                        if ('key' in definition) {
                            return [
                                dependency.projectionId,
                                {
                                    id: definition.id,
                                    pluginId: dependency.dependency.pluginId,
                                    key: definition.key,
                                    capabilityId: definition.capabilityId,
                                    sourceKind: definition.source.kind,
                                    display: definition.display,
                                    defaultPolicy: definition.defaultPolicy,
                                    experimental: definition.stability.experimental,
                                },
                            ];
                        }
                        const { title: _legacyTitle, ...projectedDefinition } = definition;
                        return [
                            dependency.projectionId,
                            {
                                ...projectedDefinition,
                                pluginId: dependency.dependency.pluginId,
                            },
                        ];
                    }),
            ),
        };
    },
});
