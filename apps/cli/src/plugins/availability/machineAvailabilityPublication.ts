import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { PluginRegistryAvailabilityInventory } from '@/plugins/store/registry/currentState';

import { projectPluginInstalledAvailabilityInventory } from './releaseLessDeclarations';

type ServingRegistry = Pick<PluginRuntimeRegistryLease, 'registry' | 'durableRevision'>;
type ReadInventory = () => Promise<PluginRegistryAvailabilityInventory>;

export function createPluginMachineAvailabilityPublication(
    report: (inventory: PluginRegistryAvailabilityInventory) => Promise<void>,
) {
    let latest: Readonly<{
        registry: ServingRegistry['registry'];
        pending: Promise<PluginRegistryAvailabilityInventory>;
    }> | undefined;

    function publish(serving: ServingRegistry, readInventory: ReadInventory) {
        const pending = readInventory().then(async inventory => {
            const complete = projectPluginInstalledAvailabilityInventory({
                inventory,
                registry: serving.registry.contributes,
                registryRevision: serving.durableRevision,
                runtimeMaterializations: serving.registry.readReleaseLessMaterializations?.() ?? [],
            });
            await report(complete);
            return complete;
        }).catch((error: unknown) => {
            if (latest?.pending === pending) latest = undefined;
            throw error;
        });
        latest = { registry: serving.registry, pending };
        return pending;
    }

    return {
        publish,
        settle(serving: ServingRegistry, readInventory: ReadInventory) {
            return latest?.registry === serving.registry ? latest.pending : publish(serving, readInventory);
        },
    };
}
