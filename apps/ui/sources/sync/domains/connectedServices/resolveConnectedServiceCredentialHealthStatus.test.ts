import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceCredentialHealthStatus } from './resolveConnectedServiceCredentialHealthStatus';

describe('resolveConnectedServiceCredentialHealthStatus', () => {
    it('passes through known credential health statuses', () => {
        expect(resolveConnectedServiceCredentialHealthStatus('connected')).toBe('connected');
        expect(resolveConnectedServiceCredentialHealthStatus('refreshing')).toBe('refreshing');
        expect(resolveConnectedServiceCredentialHealthStatus('refresh_failed_retryable')).toBe(
            'refresh_failed_retryable',
        );
        expect(resolveConnectedServiceCredentialHealthStatus('needs_reauth')).toBe('needs_reauth');
    });

    it('fails closed to needs_reauth for unknown status values', () => {
        expect(resolveConnectedServiceCredentialHealthStatus('disconnected')).toBe('needs_reauth');
        expect(resolveConnectedServiceCredentialHealthStatus('')).toBe('needs_reauth');
        expect(resolveConnectedServiceCredentialHealthStatus(undefined)).toBe('needs_reauth');
        expect(resolveConnectedServiceCredentialHealthStatus(null)).toBe('needs_reauth');
        expect(resolveConnectedServiceCredentialHealthStatus(42)).toBe('needs_reauth');
    });
});
