import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const scmBackendProjectionFamily = definePluginProjectionFamilyV2({
    family: 'scmBackends',
    project({ registry }) {
        return {
            family: 'scmBackends',
            entriesById: Object.fromEntries(
                [...(registry.scmBackends ?? [])]
                    .sort((left, right) => left.id.localeCompare(right.id))
                    .map((backend) => [
                        backend.id,
                        {
                            id: backend.id,
                            pluginId: backend.pluginId,
                            displayName: backend.definition.displayName,
                            repoModes: backend.definition.repoModes,
                            capabilities: backend.definition.capabilities,
                            installableDependencies: backend.definition.installableDependencies,
                            tooling: backend.definition.tooling,
                            safetyConstraints: backend.definition.safetyConstraints,
                        },
                    ]),
            ),
        };
    },
});
