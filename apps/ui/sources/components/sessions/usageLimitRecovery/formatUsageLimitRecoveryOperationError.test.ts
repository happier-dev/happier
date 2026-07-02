import { describe, expect, it } from 'vitest';

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

    it('preserves non-control provider errors', () => {
        expect(formatUsageLimitRecoveryOperationError({
            error: 'provider is still rate limited',
        })).toBe('provider is still rate limited');
    });
});
