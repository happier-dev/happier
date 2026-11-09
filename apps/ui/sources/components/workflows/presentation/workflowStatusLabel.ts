import { t } from '@/text';
import type {
    SessionWorkflowAgentStatusV1,
    SessionWorkflowRunStatusReasonV1,
    SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';

/** i18n status label for observed native-agent activity. */
export function formatWorkflowAgentStatusLabel(status: SessionWorkflowAgentStatusV1): string {
    switch (status) {
        case 'active':
            return t('tools.workflowActivityView.statusActive');
        case 'complete':
            return t('tools.workflowActivityView.statusComplete');
        case 'failed':
            return t('tools.workflowActivityView.statusFailed');
        case 'blocked':
            return t('tools.workflowActivityView.statusBlocked');
        case 'cancelled':
            return t('tools.workflowActivityView.statusCancelled');
        case 'pending':
            return t('workflows.invocationState.pending');
        default:
            return t('tools.workflowActivityView.statusUnknown');
    }
}

/** i18n run-status label for the workflow card/popover header. */
export function formatWorkflowRunStatusLabel(
    status: SessionWorkflowRunStatusV1,
    statusReason?: SessionWorkflowRunStatusReasonV1,
): string {
    if (statusReason === 'interrupted' && (status === 'stopped' || status === 'active')) {
        return t('tools.workflowActivityView.statusInterrupted');
    }
    switch (status) {
        case 'active':
            return t('tools.workflowActivityView.statusActive');
        case 'complete':
            return t('tools.workflowActivityView.statusComplete');
        case 'failed':
            return t('tools.workflowActivityView.statusFailed');
        case 'stopped':
            return t('tools.workflowActivityView.statusStopped');
        case 'blocked':
            return t('tools.workflowActivityView.statusBlocked');
        case 'cancelled':
            return t('tools.workflowActivityView.statusCancelled');
        default:
            return t('tools.workflowActivityView.statusUnknown');
    }
}
