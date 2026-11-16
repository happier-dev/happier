import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { readActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { t } from '@/text';
import { HappyError } from './errors';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/connectedAccountCatalogOperationError';
import { resolveConnectedServiceSettingsErrorMessage } from '@/components/settings/connectedServices/connectedServiceSettingsErrors';

export function getErrorMessage(err: unknown): string {
    if (err === null || err === undefined) return '';

    const message = typeof err === 'string' ? err : err instanceof Error ? err.message : null;
    if (message === 'reviewed_marks_unavailable') return t('hunkReview.keepUnavailable');
    if (message === 'account_encryption_currentness_unavailable') {
        return t('settingsAccount.encryptionFactUnread');
    }

    if (typeof err === 'string') return err;

    if (err instanceof HappyError || err instanceof WorkflowActionError) {
        const refusal = readActionFailurePresentationV1(err.code,
            err instanceof HappyError ? err.details : err.rawDetails);
        if (refusal) return refusal.message ?? t('common.requestFailed');
    }

    if (err instanceof HappyError) {
        if (err.code === 'action_disabled') return t('common.disabled');
        if (err.code === 'approval_request_created') return t('approvals.status.open');
        if (err.code === 'invalid_parameters' && err.message === err.code) return t('common.requestFailed');
    }

    if (err instanceof ConnectedAccountCatalogOperationError) return resolveConnectedServiceSettingsErrorMessage(err);

    if (isRpcMethodNotAvailableError(err)) {
        return t('errors.daemonUnavailableBody');
    }

    if (err instanceof Error) {
        // Error.message is often the most user-meaningful; fall back to String(err) for empty messages.
        return err.message || String(err);
    }

    if (typeof err === 'object') {
        const maybeMessage = (err as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }

    return String(err);
}
