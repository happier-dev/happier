import { describe, expect, it } from 'vitest';

import { parseDisplayableCredentialHealthStatus } from './parseDisplayableCredentialHealthStatus';

describe('parseDisplayableCredentialHealthStatus', () => {
    it('returns every recognized status unchanged', () => {
        expect(parseDisplayableCredentialHealthStatus('connected')).toBe('connected');
        expect(parseDisplayableCredentialHealthStatus('refreshing')).toBe('refreshing');
        expect(parseDisplayableCredentialHealthStatus('refresh_failed_retryable')).toBe('refresh_failed_retryable');
        expect(parseDisplayableCredentialHealthStatus('needs_reauth')).toBe('needs_reauth');
    });

    it('fails OPEN: absent or unrecognized values yield null, never needs_reauth', () => {
        expect(parseDisplayableCredentialHealthStatus(undefined)).toBeNull();
        expect(parseDisplayableCredentialHealthStatus(null)).toBeNull();
        expect(parseDisplayableCredentialHealthStatus('')).toBeNull();
        expect(parseDisplayableCredentialHealthStatus('disconnected')).toBeNull();
        expect(parseDisplayableCredentialHealthStatus(42)).toBeNull();
    });
});
