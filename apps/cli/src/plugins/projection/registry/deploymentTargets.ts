import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Cold target declarations carry the existing supplying occurrence, never invocation authority. */
export const deploymentTargetsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'deploymentTargets',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'deploymentTargets',
        entriesById: Object.freeze(Object.fromEntries((registry.deploymentTargets ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition,
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
