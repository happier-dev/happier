import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const dragSourcesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'dragSources',
    project: ({ registry }) => ({
        family: 'dragSources',
        entriesById: Object.freeze(Object.fromEntries((registry.dragSources ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition })]];
        }))),
    }),
});

export const dropTargetsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'dropTargets',
    project: ({ registry }) => ({
        family: 'dropTargets',
        entriesById: Object.freeze(Object.fromEntries((registry.dropTargets ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition })]];
        }))),
    }),
});
