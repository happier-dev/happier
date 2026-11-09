import { t } from '@/text';
import type {
    ExecutionRunDeliveryState,
    ExecutionRunTurnState,
} from '@/sync/domains/session/executionRunLinkPresentation';

export function formatExecutionRunTurnState(
    state: ExecutionRunTurnState,
    existingStateLabel: string,
): string {
    return state === 'finished' ? t('executionRunDelivery.turnFinished') : existingStateLabel;
}

export function formatExecutionRunDeliveryState(state: ExecutionRunDeliveryState): string {
    switch (state) {
        case 'sent':
            return t('executionRunDelivery.sent');
        case 'queued':
            return t('executionRunDelivery.queued');
        case 'reported':
            return t('executionRunDelivery.reported');
        case 'report_pending':
            return t('executionRunDelivery.reportPending');
        case 'report_failed':
            return t('executionRunDelivery.reportFailed');
        case 'relay_failed':
            return t('executionRunDelivery.relayFailed');
        case 'not_sent':
            return t('executionRunDelivery.notSent');
    }
}
