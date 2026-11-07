import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Cold declarations reuse their supplying occurrence; invocation remains Action-owned. */
export const healthCheckKindsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'healthCheckKinds',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'healthCheckKinds',
        entriesById: Object.freeze(Object.fromEntries((registry.healthCheckKinds ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition,
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
