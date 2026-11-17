import { isWorkflowStepActionSpecV1, listActionSpecs, type ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionDiscoveryDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { WORKFLOW_STEP_PROMOTED_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ActionJsonSchemaProjectionError } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readPluginActionApprovalScopeSubjectKindV1 } from '@happier-dev/protocol/plugins/actions/approvalScope';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolvePluginProjectedActionPresentation, type ResolvedPluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { resolveWorkflowActionDescription, resolveWorkflowActionTitle } from '@/sync/domains/workflows/workflowActionPresentation';
import { t } from '@/text';
import { localizeBuiltinInputHints } from '@/text/builtinInputPrompts';
import type { IconName } from '@/components/ui/icons/Icon';

export type WorkflowActionSpec = Readonly<Pick<ActionSpec, 'title' | 'description' | 'inputHints'> & {
    id: string;
    icon?: IconName;
    sourceLabel?: string;
    /** One malformed declaration stays visible without taking down the editor. */
    projectionError?: ActionJsonSchemaProjectionError['code'];
    /** Admitted plugin identity for the host-then-plugins picker grouping. */
    plugin?: Readonly<{ id: string; title: string; icon?: string }>;
    /** Before/after selection consumes the invocation declaration's own subject metadata. */
    subjectKind?: ReturnType<typeof readPluginActionApprovalScopeSubjectKindV1>;
}>;

/** Resolve an authored id without replacing it when the current catalog lacks it. */
export function findWorkflowActionSpec(actionId: string, catalog: readonly WorkflowActionSpec[] = listWorkflowStepActionSpecs()): WorkflowActionSpec | null {
    return catalog.find((spec) => spec.id === actionId) ?? null;
}

/**
 * Presentation over the Protocol host catalog plus the selected daemon's admitted
 * Actions. Run summaries are reads; composition remains the Workflow leaf.
 */
function projectWorkflowAction(read: () => WorkflowActionSpec, unavailable: () => WorkflowActionSpec): WorkflowActionSpec {
    try { return read(); }
    catch (error) {
        if (!(error instanceof ActionJsonSchemaProjectionError)) throw error;
        return { ...unavailable(), projectionError: error.code };
    }
}

export function projectWorkflowHostActionSpecs(specs: readonly ActionSpec[], selected?: ReadonlySet<string>,
    purpose: WorkflowActionCatalogPurpose = 'workflowStep'): WorkflowActionSpec[] {
    // Without discovery, the host catalog's own projection decides before/after eligibility.
    const offered = selected ? (spec: ActionSpec) => selected.has(spec.id)
        : purpose === 'workflowStep' ? isWorkflowStepActionSpecV1
            : (spec: ActionSpec) => serializeActionSpec(spec, { includeOutputSchema: false }).automation?.[purpose] === true;
    return specs.filter(offered)
        .map(spec => {
            const presentation = { id: spec.id, title: resolveWorkflowActionTitle(spec.id, spec),
            ...resolveHostActionPickerPresentation(spec.id),
            ...(spec.description === undefined ? {} : { description: resolveWorkflowActionDescription(spec.id, spec) }) };
            return projectWorkflowAction(() => {
                const hints = spec.inputHints;
                return { ...presentation, ...(hints === undefined ? {} : { inputHints: localizeBuiltinInputHints(hints) }) };
            }, () => presentation);
        });
}

/** What an Action is offered for: a workflow step, or a trigger before or after it (the discovery owner's `automation` choices). */
export type WorkflowActionCatalogPurpose = 'workflowStep' | 'before' | 'after';

export function listWorkflowStepActionSpecs(projection?: PluginProjectionV2 | null, presentation?: PluginUiProjectionModel | null,
    localize?: PluginLocalizedTextResolver, discovery?: readonly ActionDiscoveryDefinitionSummaryV1[],
    purpose: WorkflowActionCatalogPurpose = 'workflowStep'): readonly WorkflowActionSpec[] {
    const selected = discovery === undefined ? undefined : new Set(discovery
        .filter(spec => spec.automation?.[purpose] === true).map(spec => spec.id));
    const host = projectWorkflowHostActionSpecs(listActionSpecs(), selected, purpose);
    const subjectKinds = purpose === 'workflowStep' ? [] : Object.values(presentation?.subjectKindsById ?? {});
    const contributed = Object.entries(projection?.actionsById ?? {}).flatMap(([key, action]): WorkflowActionSpec[] => {
        const identity = parseQualifiedPluginContributionKey(key);
        if (!identity || identity.pluginId !== action.pluginId) return [];
        const actionId = formatQualifiedPluginActionId(identity);
        // Offered choices consume discovery; omitted discovery is the existing
        // authored-ID lookup used outside a mounted picker.
        // Before/after eligibility of a contributed Action is known only from discovery.
        if (selected ? !selected.has(actionId) : purpose !== 'workflowStep' || action.available === false
            || action.execution.target !== 'daemon' || !action.surfaces.includes('agent')) return [];
        const present = (resolved: ResolvedPluginProjectedActionPresentation): WorkflowActionSpec => ({ id: actionId, title: resolved.title,
            ...(purpose === 'workflowStep' ? {} : { subjectKind: readPluginActionApprovalScopeSubjectKindV1({
                declaration: action.approvalScope, pluginId: action.pluginId, subjectKinds }) }),
            plugin: { id: action.pluginId, title: projection?.installedPackagesById?.[action.pluginId]?.displayName ?? t('workflows.plugins.fromPlugins'),
                ...(action.icon === undefined ? {} : { icon: action.icon }) },
            ...(resolved.description === null ? {} : { description: resolved.description }),
            ...(resolved.inputHints === null ? {} : { inputHints: resolved.inputHints }) });
        return [projectWorkflowAction(
            () => present(resolvePluginProjectedActionPresentation({ pluginId: action.pluginId, presentation: action, projection: presentation, localize })),
            () => present(resolvePluginProjectedActionPresentation({ pluginId: action.pluginId,
                presentation: { title: action.title, description: action.description }, projection: presentation, localize })),
        )];
    });
    const compareTitle = (a: WorkflowActionSpec, b: WorkflowActionSpec) => a.title.localeCompare(b.title);
    host.sort((a, b) => {
        const priority = (id: string) => { const index = WORKFLOW_STEP_PROMOTED_ACTION_IDS_V1.indexOf(id);
            return index < 0 ? WORKFLOW_STEP_PROMOTED_ACTION_IDS_V1.length : index; };
        return priority(a.id) - priority(b.id) || compareTitle(a, b);
    });
    contributed.sort((a, b) => (a.plugin?.title ?? '').localeCompare(b.plugin?.title ?? '') || compareTitle(a, b));
    return [...host, ...contributed];
}

function resolveHostActionPickerPresentation(id: string): Pick<WorkflowActionSpec, 'icon' | 'sourceLabel'> {
    if (id === 'notifications.notify_me') return { icon: 'bell', sourceLabel: t('workflows.page.blocks.actionSourcePhone') };
    if (id.startsWith('review.')) return { icon: 'shield-check', sourceLabel: t('workflows.page.blocks.actionSourceReview') };
    if (id.startsWith('session.') || id.startsWith('sessions.')) return { icon: 'chat-circle' };
    if (id.startsWith('project.') || id.startsWith('workspace.')) return { icon: 'folder' };
    if (id.startsWith('settings.')) return { icon: 'gear' };
    if (id.startsWith('artifacts.') || id.startsWith('prompt_doc.')) return { icon: 'file-text' };
    return { icon: 'lightning' };
}
