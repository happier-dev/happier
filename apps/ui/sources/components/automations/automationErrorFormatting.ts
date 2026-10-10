import { isAutomationApiErrorCode } from '../../sync/api/automations/apiAutomations';
import { t } from '@/text';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

export type AutomationErrorPresentation = Readonly<{
    message: string;
    action: string;
}>;

/** Converts automation failures to a bounded, non-server-controlled UI message. */
export function formatAutomationError(error: unknown, fallback: string): AutomationErrorPresentation {
    if (error instanceof WorkflowActionError && error.code === 'workflow_outcome_unresolved') {
        return { message: t('projects.scripts.run.unknown'), action: t('common.refresh') };
    }
    if (isAutomationApiErrorCode(error, 'sourceTurnNotCurrent')) {
        return { message: t('automations.exactTurn.staleBody'), action: t('automations.exactTurn.useCurrentTurn') };
    }
    if (isAutomationApiErrorCode(error, 'sourceTurnNotInProgress')) {
        return { message: t('automations.exactTurn.staleBody'), action: t('automations.exactTurn.useCurrentTurn') };
    }
    if (isAutomationApiErrorCode(error, 'sourceTurnUnavailable') || isAutomationApiErrorCode(error, 'sourceSessionUnavailable')) {
        return { message: t('automations.exactTurn.unavailable'), action: t('errors.tryAgain') };
    }
    if (isAutomationApiErrorCode(error, 'automation_template_version_conflict') || isAutomationApiErrorCode(error, 'automation_trigger_revision_conflict')) {
        return { message: t('automations.edit.updateFailed'), action: t('errors.tryAgain') };
    }
    return { message: fallback, action: t('errors.tryAgain') };
}

export function formatAutomationErrorMessage(error: unknown, fallback: string): string {
    const presentation = formatAutomationError(error, fallback);
    return `${presentation.message} ${presentation.action}`;
}
