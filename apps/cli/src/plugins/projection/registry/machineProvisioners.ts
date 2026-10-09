import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Cold descriptors share their Action leaves' canonical serving occurrence. */
export const machineProvisionersProjectionFamily = definePluginProjectionFamilyV2({
    family: 'machineProvisioners',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'machineProvisioners',
        entriesById: Object.freeze(Object.fromEntries((registry.machineProvisioners ?? []).flatMap((entry) => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({
                id: key, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition,
                ...(origin ? { serverIdentityId: origin.serverIdentityId, materializationRef: origin.materializationRef } : {}),
            })]];
        }))),
    }),
});
