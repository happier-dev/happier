import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedContributionRegistry } from './types';

/** Definitions belong to the current admitted plugin occurrence. */
export function readPluginWorkflowSources(registry: ResolvedContributionRegistry, workflow?: string): readonly WorkflowPluginSourceV1[] {
    const target = workflow === undefined ? undefined : parseWorkflowDefinitionRefV1(workflow);
    if (target !== undefined && target?.kind !== 'plugin') return [];
    return (registry.workflows ?? []).flatMap((entry) => {
        if (target && (entry.identity.pluginId !== target.contribution.pluginId || entry.identity.localId !== target.contribution.localId)) return [];
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
