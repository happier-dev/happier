import { t, type TranslationKeyNoParams } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';
import type { AgentInputControlId, AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import { AGENT_INPUT_CONTROL_REGISTRY } from '@/components/sessions/agentInput/controls/agentInputControlRegistry';

/** A start's Machine chip; its id predates the folder split, so saved placements keep applying. */
export function getWorkflowStartWhereChipPlacement(): AgentInputControlPlacement {
    return { id: 'machine:workflow-start-where', title: t('newSession.wizardSection.machine'), icon: 'desktop', defaultPlacement: 'pinned' };
}

/** A start's folder chip, beside its Machine chip (owner 2026-11-12: two chips, as in New Session). */
export function getWorkflowStartFolderChipPlacement(): AgentInputControlPlacement {
    return { id: 'path:workflow-start-folder', title: t('newSession.wizardSection.folder'), icon: 'folder', defaultPlacement: 'pinned' };
}

export function getWorkflowStepOptionsChipPlacement(): AgentInputControlPlacement {
    return { id: 'shortcuts:workflow-step-options', title: t('workflows.page.inspector.stepOptions'), icon: 'sliders-horizontal', defaultPlacement: 'pinned' };
}

export function getWorkflowStartVisibilityChipPlacement(): AgentInputControlPlacement {
    return { id: 'sessionAccess:workflow-start-visibility', title: t('workflows.start.visibility.title'), icon: 'users', defaultPlacement: 'overflow' };
}

export function getWorkflowStepTargetsChipPlacement(): AgentInputControlPlacement {
    const definition = AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'workflowTargets')!;
    return { id: definition.id, title: t(definition.titleKey), icon: definition.icon, defaultPlacement: definition.defaultPlacement };
}

const CONTEXT_CONTROL_DEFINITIONS = {
    runAs: { key: 'workflow-start-run-as', controlId: 'workflowTargets', icon: 'stack', titleKey: 'workflows.start.targetsTitle', placementTitleKey: 'navigationPlacement.workflowRunTarget' },
    planReport: { key: 'workflow-plan-report', controlId: 'delivery', icon: 'arrow-elbow-down-right', titleKey: 'agentStart.reportToSession' },
    agentOverride: { key: 'workflow-run-another-agent', controlId: 'engine', icon: 'users', titleKey: 'agentInput.model.title', placementIcon: 'sparkle' },
    discussionWhere: { key: 'discussion-run-where', controlId: 'machine', icon: 'folder', titleKey: 'workflows.page.where.label' },
} as const satisfies Readonly<Record<string, Readonly<{ key: string; controlId: AgentInputControlId; icon: IconName; titleKey: TranslationKeyNoParams; placementTitleKey?: TranslationKeyNoParams; placementIcon?: IconName }>>>;

type WorkflowContextChipDefinition = Readonly<{
    key: string;
    controlId: AgentInputControlId;
    icon: IconName;
    title: string;
    placement: AgentInputControlPlacement;
}>;

function projectContextDefinition(definition: typeof CONTEXT_CONTROL_DEFINITIONS[keyof typeof CONTEXT_CONTROL_DEFINITIONS]): WorkflowContextChipDefinition {
    const title = t(definition.titleKey);
    return {
        key: definition.key,
        controlId: definition.controlId,
        icon: definition.icon,
        title,
        placement: {
            id: `${definition.controlId}:${definition.key}`,
            title: 'placementTitleKey' in definition ? t(definition.placementTitleKey) : title,
            icon: 'placementIcon' in definition ? definition.placementIcon : definition.icon,
            defaultPlacement: 'overflow',
        },
    };
}

export function getWorkflowContextChipDefinition(id: keyof typeof CONTEXT_CONTROL_DEFINITIONS): WorkflowContextChipDefinition {
    return projectContextDefinition(CONTEXT_CONTROL_DEFINITIONS[id]);
}

export function getWorkflowContextChipDefinitions(): readonly WorkflowContextChipDefinition[] {
    return Object.values(CONTEXT_CONTROL_DEFINITIONS).map(projectContextDefinition);
}
