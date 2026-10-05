import { listActionSpecs, type ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { formatQualifiedPluginActionId, parseQualifiedPluginContributionKey, type PluginProjectionV2 } from '@happier-dev/protocol';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

export type WorkflowActionSpec = Readonly<Pick<ActionSpec, 'title' | 'description' | 'inputHints'> & { id: string }>;

/** Resolve an authored id without replacing it when the current catalog lacks it. */
export function findWorkflowActionSpec(actionId: string, catalog: readonly WorkflowActionSpec[] = listWorkflowStepActionSpecs()): WorkflowActionSpec | null {
    return catalog.find((spec) => spec.id === actionId) ?? null;
}

/**
 * Presentation over the Protocol host catalog plus the selected daemon's admitted
 * Actions. Composition remains the Workflow leaf, not a `workflow.run.*` Action.
 */
export function listWorkflowStepActionSpecs(projection?: PluginProjectionV2 | null, presentation?: PluginUiProjectionModel | null): readonly WorkflowActionSpec[] {
    const host = listActionSpecs().filter((spec) => spec.surfaces.agent && !spec.id.startsWith('workflow.run.'));
    const contributed = Object.values(projection?.actionsById ?? {}).flatMap((action): WorkflowActionSpec[] => {
        const identity = parseQualifiedPluginContributionKey(action.id);
        // Workflows execute on the daemon, not inside a mounted client plugin surface.
        if (!identity || identity.pluginId !== action.pluginId || action.available === false
            || action.execution.target !== 'daemon' || !action.surfaces.includes('agent')) return [];
        const resolved = resolvePluginProjectedActionPresentation({ pluginId: action.pluginId, presentation: action, projection: presentation });
        return [{ id: formatQualifiedPluginActionId(identity), title: resolved.title,
            ...(resolved.description === null ? {} : { description: resolved.description }),
            ...(resolved.inputHints === null ? {} : { inputHints: resolved.inputHints }) }];
    });
    return [...host, ...contributed];
}
