import { listActionSpecs, type ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { resolveWorkflowActionTitle } from '@/sync/domains/workflows/workflowActionPresentation';
import { t } from '@/text';

export type WorkflowActionSpec = Readonly<Pick<ActionSpec, 'title' | 'description' | 'inputHints'> & {
    id: string;
    /** Admitted plugin identity for the host-then-plugins picker grouping. */
    plugin?: Readonly<{ id: string; title: string; icon?: string }>;
}>;

/** Resolve an authored id without replacing it when the current catalog lacks it. */
export function findWorkflowActionSpec(actionId: string, catalog: readonly WorkflowActionSpec[] = listWorkflowStepActionSpecs()): WorkflowActionSpec | null {
    return catalog.find((spec) => spec.id === actionId) ?? null;
}

/**
 * Presentation over the Protocol host catalog plus the selected daemon's admitted
 * Actions. Composition remains the Workflow leaf, not a `workflow.run.*` Action.
 */
export function listWorkflowStepActionSpecs(projection?: PluginProjectionV2 | null, presentation?: PluginUiProjectionModel | null): readonly WorkflowActionSpec[] {
    const host = listActionSpecs().filter((spec) => spec.surfaces.agent
        && spec.executionPlacement !== 'client' && !spec.id.startsWith('workflow.run.'))
        .map((spec): WorkflowActionSpec => ({ id: spec.id, title: resolveWorkflowActionTitle(spec.id, spec),
            ...(spec.description === undefined ? {} : { description: spec.description }),
            ...(spec.inputHints === undefined ? {} : { inputHints: spec.inputHints }) }));
    const contributed = Object.values(projection?.actionsById ?? {}).flatMap((action): WorkflowActionSpec[] => {
        const identity = parseQualifiedPluginContributionKey(action.id);
        // Workflows execute on the daemon, not inside a mounted client plugin surface.
        if (!identity || identity.pluginId !== action.pluginId || action.available === false
            || action.execution.target !== 'daemon' || !action.surfaces.includes('agent')) return [];
        const resolved = resolvePluginProjectedActionPresentation({ pluginId: action.pluginId, presentation: action, projection: presentation });
        return [{ id: formatQualifiedPluginActionId(identity), title: resolved.title,
            plugin: { id: action.pluginId, title: projection?.installedPackagesById?.[action.pluginId]?.displayName ?? t('workflows.plugins.fromPlugins'),
                ...(action.icon === undefined ? {} : { icon: action.icon }) },
            ...(resolved.description === null ? {} : { description: resolved.description }),
            ...(resolved.inputHints === null ? {} : { inputHints: resolved.inputHints }) }];
    });
    return [...host, ...contributed];
}
