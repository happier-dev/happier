import { projectInstallableContribution } from '@happier-dev/protocol/installables/projection';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { resolveExecutableManagedDependenciesRegistry } from './managedDependencyExecutables';

export const managedDependenciesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'managedDependencies',
    project({ registry }) {
        const dependencies = [...(registry.managedDependencies ?? [])];
        const sourceEntries = dependencies.flatMap((dependency) => {
            const definition = dependency.definition;
            if ('key' in definition) return [];
            const { title: _legacyTitle, ...projectedDefinition } = definition;
            const projectionId = dependency.pluginId ? `${dependency.pluginId}/${definition.id}` : definition.id;
            return [[projectionId, { ...projectedDefinition, pluginId: dependency.pluginId }] as const];
        });
        const installableEntries = resolveExecutableManagedDependenciesRegistry(dependencies).descriptors.map((entry) => [
            entry.descriptor.key,
            projectInstallableContribution(entry),
        ] as const);
        return {
            family: 'managedDependencies',
            entriesById: Object.fromEntries(
                [...sourceEntries, ...installableEntries].sort(([left], [right]) => left.localeCompare(right)),
            ),
        };
    },
});
