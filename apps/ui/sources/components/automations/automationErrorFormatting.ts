import { AutomationApiError, isAutomationApiErrorCode } from '../../sync/api/automations/apiAutomationHttp';
import { t } from '@/text';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

export type AutomationErrorPresentation = Readonly<{
    message: string;
    action: string;
}>;

/** The same Session registration refusal may arrive directly or through a Workflow Action. */
export function formatExactTurnAutomationError(error: unknown): AutomationErrorPresentation | undefined {
    const cause = error instanceof WorkflowActionError && error.failure?.errorCode === 'ineligible_state'
        ? error.failure.failureCause : undefined;
    const reason = error instanceof AutomationApiError ? error.code
        : cause && 'nativeErrorReason' in cause ? cause.nativeErrorReason : undefined;
    if (reason === 'sourceTurnNotCurrent' || reason === 'sourceTurnNotInProgress') {
        return { message: t('automations.exactTurn.staleBody'), action: t('automations.exactTurn.useCurrentTurn') };
    }
    if (reason === 'sourceTurnUnavailable' || reason === 'sourceSessionUnavailable') {
        return { message: t('automations.exactTurn.unavailable'), action: t('errors.tryAgain') };
    }
    return undefined;
}

/** Converts automation failures to a bounded, non-server-controlled UI message. */
export function formatAutomationError(error: unknown, fallback: string): AutomationErrorPresentation {
    if (error instanceof WorkflowActionError && error.code === 'workflow_outcome_unresolved') {
        return { message: t('projects.scripts.run.unknown'), action: t('common.refresh') };
    }
    const exactTurn = formatExactTurnAutomationError(error);
    if (exactTurn) return exactTurn;
    if (isAutomationApiErrorCode(error, 'automation_template_version_conflict') || isAutomationApiErrorCode(error, 'automation_trigger_revision_conflict')) {
        return { message: t('automations.edit.updateFailed'), action: t('errors.tryAgain') };
    }
    return { message: fallback, action: t('errors.tryAgain') };
}

export function formatAutomationErrorMessage(error: unknown, fallback: string): string {
    const presentation = formatAutomationError(error, fallback);
    return `${presentation.message} ${presentation.action}`;
}
