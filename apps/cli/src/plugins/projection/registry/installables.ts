import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const installablesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'installables',
    project({ registry }) {
        return {
            family: 'installables',
            entriesById: Object.fromEntries(
                [...(registry.installables ?? [])]
                    .sort((left, right) => left.definition.key.localeCompare(right.definition.key))
                    .map((installable) => [
                        installable.definition.key,
                        {
                            id: installable.definition.key,
                            pluginId: installable.pluginId,
                            key: installable.definition.key,
                            capabilityId: installable.definition.capabilityId,
                            sourceKind: installable.definition.source.kind,
                            display: installable.definition.display,
                            defaultPolicy: installable.definition.defaultPolicy,
                            experimental: installable.definition.stability.experimental,
                        },
                    ]),
            ),
        };
    },
});
