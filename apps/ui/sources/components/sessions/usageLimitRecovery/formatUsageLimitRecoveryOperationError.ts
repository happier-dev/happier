import {
    normalizeSessionUsageLimitRecoveryOperationResultV1,
    type SessionUsageLimitRecoveryOperationResultErrorStatusV1,
} from '@happier-dev/protocol/sessions/control/sessionUsageLimitRecoveryOperationResultV1';

import { t } from '@/text';

export function formatUsageLimitRecoveryOperationError(result: Readonly<{
    error?: string;
    errorCode?: string;
    status?: SessionUsageLimitRecoveryOperationResultErrorStatusV1;
}>): string {
    if (result.status !== undefined) {
        return t(`session.usageLimitRecovery.operationErrors.${result.status}`);
    }

    const normalized = normalizeSessionUsageLimitRecoveryOperationResultV1({
        ok: false,
        errorCode: result.errorCode ?? result.error ?? 'session_usage_limit_recovery_control_failed',
    });
    return !normalized.ok && normalized.status !== 'unsupported'
        ? t(`session.usageLimitRecovery.operationErrors.${normalized.status}`)
        : t('errors.operationFailed');
}
