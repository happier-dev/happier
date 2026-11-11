import { describe, expect, it } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_ERROR_STATUSES_V1 } from '@happier-dev/protocol/sessions/control/sessionUsageLimitRecoveryOperationResultV1';

import { t } from '@/text';

import { formatUsageLimitRecoveryOperationError } from './formatUsageLimitRecoveryOperationError';

describe('formatUsageLimitRecoveryOperationError', () => {
    it.each(SESSION_USAGE_LIMIT_RECOVERY_OPERATION_RESULT_ERROR_STATUSES_V1)(
        'presents the specific recovery reason for %s', (status) => {
            const message = formatUsageLimitRecoveryOperationError({
                status,
                errorCode: 'session_usage_limit_recovery_control_failed',
            });
            expect(message).toBe(t(`session.usageLimitRecovery.operationErrors.${status}`));
            expect(message).not.toBe(t('errors.operationFailed'));
            expect(message).not.toContain('session.usageLimitRecovery.operationErrors.');
        },
    );

    it('maps recovery-control transport errors away from raw internal codes', () => {
        const message = formatUsageLimitRecoveryOperationError({
            error: 'session_usage_limit_recovery_control_remote_unavailable',
            errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
        });

        expect(message).toBe(t('session.usageLimitRecovery.operationErrors.session_unreachable'));
        expect(message).not.toContain('session_usage_limit_recovery_control_remote_unavailable');
        expect(message).not.toContain('_');
    });

    it('maps unknown error codes to generic product copy instead of forwarding boundary detail', () => {
        const rawCode = '/private/runner/session?token=never-render-this';
        const message = formatUsageLimitRecoveryOperationError({
            error: 'provider is still rate limited',
            errorCode: rawCode,
        });

        expect(message).toBe(t('errors.operationFailed'));
        expect(message).not.toContain('/private/runner/session');
        expect(message).not.toContain('token=never-render-this');
    });
});
