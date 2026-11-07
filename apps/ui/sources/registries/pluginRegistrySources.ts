import { createPluginRegistrySourceDescriptorV1, RegistryFetchErrorV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';

/** Preserve every proven supplier, including its retained offline declaration. */
export function projectPluginRegistrySources(projection: Pick<PluginUiProjectionModel, 'registrySourcesById'> | null): readonly RegistrySourceDescriptorV1[] {
    return Object.values(projection?.registrySourcesById ?? {}).flatMap(entry => {
        const origin = readPluginUiContributionOrigin(entry);
        const supplies = readPluginUiContributionSupplies(entry);
        if (Reflect.get(entry, 'hostCompatibility') === 'conflict' && !origin) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        if ('packageContent' in entry.definition && !entry.occurrenceId) return [];
        const matchingSupplies = 'packageContent' in entry.definition
            ? supplies.filter(supply => supply.occurrenceId === entry.occurrenceId) : supplies;
        return [createPluginRegistrySourceDescriptorV1({ pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
            occurrenceId: entry.occurrenceId, definition: entry.definition,
            suppliers: matchingSupplies.length > 0 ? matchingSupplies.map(supply => supply.machineId) : origin ? [origin.machineId] : [] })];
    });
}
