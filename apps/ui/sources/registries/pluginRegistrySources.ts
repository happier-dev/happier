import { createPluginRegistrySourceDescriptorV1, registrySourceSupportsKindV1, RegistryFetchErrorV1,
    type RegistryKindV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';
import {
    readCurrentAppShellPluginUiProjection,
    readCurrentAppShellRegistrySourcesPending,
    subscribeCommittedAppShellPluginUiProjection,
} from '@/components/appShell/plugins/committedPluginUiProjection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

/** Preserve every proven supplier, including its retained offline declaration. */
export function projectPluginRegistrySources(projection: Pick<PluginUiProjectionModel, 'registrySourcesById'> | null): readonly RegistrySourceDescriptorV1[] {
    return Object.values(projection?.registrySourcesById ?? {}).flatMap(entry => {
        const origin = readPluginUiContributionOrigin(entry);
        const supplies = readPluginUiContributionSupplies(entry);
        if (Reflect.get(entry, 'hostCompatibility') === 'conflict' && !origin) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        if ('packageContent' in entry.definition && !entry.occurrenceId) return [];
        return [createPluginRegistrySourceDescriptorV1({ pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
            occurrenceId: entry.occurrenceId, definition: entry.definition,
            // The union admits equivalent declarations; each Machine resolves its own package occurrence.
            suppliers: supplies.length > 0 ? supplies.map(supply => supply.machineId) : origin ? [origin.machineId] : [] })];
    });
}

/**
 * Settles once a plugin source of `kind` is known or no Machine may still bring one, or on abort: the registry
 * selection's rule (`useRegistrySourceRevision`: only an empty selection waits), for readers outside React.
 * A Machine still owing its sources can only add more of a known kind, so it holds nothing up. No timer.
 */
export function waitForPluginRegistrySourcesOfKind(kind: RegistryKindV1, signal?: AbortSignal): Promise<void> {
    const settled = () => {
        if (signal?.aborted || !readCurrentAppShellRegistrySourcesPending()) return true;
        try {
            // Declarations, as the registry host lists them, also while the union is still establishing.
            const scope = getActiveServerAccountScope();
            return projectPluginRegistrySources(readCurrentAppShellPluginUiProjection(scope ? { scope, declarationsOnly: true } : undefined))
                .some(source => registrySourceSupportsKindV1(source, kind));
        } catch {
            // A conflicting declaration is the registry read's own failure to report; it decides nothing here.
            return false;
        }
    };
    if (settled()) return Promise.resolve();
    return new Promise(resolve => {
        const settle = () => {
            if (!settled()) return;
            unsubscribe();
            signal?.removeEventListener('abort', settle);
            resolve();
        };
        const unsubscribe = subscribeCommittedAppShellPluginUiProjection(settle);
        signal?.addEventListener('abort', settle);
    });
}
