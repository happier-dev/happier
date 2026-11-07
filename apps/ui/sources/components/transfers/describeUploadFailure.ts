import { t } from '@/text';
import type { TransferFailureReason } from '@/sync/domains/transfers/runtime/transferRuntime';

export function describeUploadFailureReason(reason: TransferFailureReason, machineName: string): string {
    switch (reason) {
        case 'carrierUnavailable': return t('files.transfers.failureReasons.carrierUnavailable');
        case 'carrierInterrupted': return t('files.transfers.failureReasons.carrierInterrupted');
        case 'unreachable': return t('projects.checkouts.notAnswering', { machine: machineName });
        case 'declined': return t('files.transfers.failureReasons.declined');
        case 'accessRefused': return t('files.transfers.failureReasons.accessRefused');
        case 'teamSignIn': return t('files.transfers.failureReasons.teamSignIn');
        case 'updateRequired': return t('files.transfers.failureReasons.updateRequired', { machine: machineName });
        case 'executionUnavailable': return t('errors.agentIsolationUnavailable');
        case 'permission': return t('errors.permissionDenied');
        case 'tooLarge': return t('files.transfers.failureReasons.tooLarge');
        case 'unconfirmed': return t('files.transfers.failureReasons.unconfirmed');
        case 'other': return t('files.transfers.failureReasons.other', { machine: machineName });
    }
}

export function describeUploadFailure(reason: TransferFailureReason, machineName: string): string {
    return `${t('files.transfers.uploadFailed')} · ${describeUploadFailureReason(reason, machineName)}`;
}
