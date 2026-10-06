import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedContributionRegistry } from './types';

/** Definitions belong to the current admitted plugin occurrence. */
export function readPluginWorkflowSources(registry: ResolvedContributionRegistry): readonly WorkflowPluginSourceV1[] {
    return (registry.workflows ?? []).flatMap((entry) => {
        if (!registry.occurrenceIdsByPluginId?.[entry.pluginId] || !entry.pluginVersion) return [];
        return [projectWorkflowPluginSourceV1({ pluginId: entry.pluginId, pluginVersion: entry.pluginVersion, definition: entry.definition })];
    });
}

export const workflowsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'workflows',
    project: ({ registry }) => ({
        family: 'workflows',
        entriesById: Object.freeze(Object.fromEntries((registry.workflows ?? []).flatMap((entry) => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition })]];
        }))),
    }),
});
