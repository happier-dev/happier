import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { formatUsageLimitRecoveryOperationError } from './formatUsageLimitRecoveryOperationError';

describe('formatUsageLimitRecoveryOperationError', () => {
    it('maps recovery-control transport errors away from raw internal codes', () => {
        const message = formatUsageLimitRecoveryOperationError({
            error: 'session_usage_limit_recovery_control_remote_unavailable',
            errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
        });

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
