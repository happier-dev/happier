import { t, type TranslationKeyNoParams } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';
import type { AgentInputControlId, AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';

export const EXECUTION_RUN_REPORT_CHIP_KEY = 'execution-run-start-report';

export function getExecutionRunReportChipPlacement(): AgentInputControlPlacement {
    return { id: `delivery:${EXECUTION_RUN_REPORT_CHIP_KEY}`, title: t('agentStart.reportToSession'), icon: 'arrow-elbow-down-right', defaultPlacement: 'overflow' };
}

const START_CONTROL_DEFINITIONS = {
    role: { key: 'execution-run-start-role', controlId: 'workflowRoles', icon: 'users', titleKey: 'roles.rail.title' },
    reviewersAdd: { key: 'execution-run-start-reviewers-add', controlId: 'reviewComments', icon: 'plus', titleKey: 'agentStart.chips.addReviewer', placementTitleKey: 'runPage.review.reviewers' },
    permissions: { key: 'execution-run-start-permissions', controlId: 'permission', icon: 'shield', titleKey: 'executionRuns.newRun.sections.permissions' },
    route: { key: 'execution-run-start-route', controlId: 'connectedServices', icon: 'path', titleKey: 'agentInput.model.title', placementIcon: 'sparkle' },
    scope: { key: 'execution-run-start-scope', controlId: 'reviewComments', icon: 'git-diff', titleKey: 'agentStart.chips.scope' },
    walkthrough: { key: 'execution-run-start-walkthrough', controlId: 'reviewComments', icon: 'play', titleKey: 'scmComparison.view.walkthrough' },
    advanced: { key: 'execution-run-start-advanced', controlId: 'providerOption', icon: 'sliders-horizontal', titleKey: 'agentStart.chips.advanced' },
} as const satisfies Readonly<Record<string, Readonly<{ key: string; controlId: AgentInputControlId; icon: IconName; titleKey: TranslationKeyNoParams; placementTitleKey?: TranslationKeyNoParams; placementIcon?: IconName }>>>;

export type ExecutionRunStartChipDefinition = Readonly<{
    key: string;
    controlId: AgentInputControlId;
    icon: IconName;
    title: string;
    placement: AgentInputControlPlacement;
}>;

function projectStartDefinition(definition: typeof START_CONTROL_DEFINITIONS[keyof typeof START_CONTROL_DEFINITIONS]): ExecutionRunStartChipDefinition {
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
        } satisfies AgentInputControlPlacement,
    };
}

export function getExecutionRunStartChipDefinition(id: keyof typeof START_CONTROL_DEFINITIONS): ExecutionRunStartChipDefinition {
    return projectStartDefinition(START_CONTROL_DEFINITIONS[id]);
}

export function getExecutionRunStartChipDefinitions(): readonly ExecutionRunStartChipDefinition[] {
    return Object.values(START_CONTROL_DEFINITIONS).map(projectStartDefinition);
}
