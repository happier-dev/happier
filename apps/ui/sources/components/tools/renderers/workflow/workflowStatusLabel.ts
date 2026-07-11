import { t } from '@/text';
import type { SessionWorkflowRunStatusReasonV1, SessionWorkflowRunStatusV1 } from '@happier-dev/protocol';

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
