import { describe, expect, it } from 'vitest';

import { sanitizeUrlForLog } from './sanitizeUrlForLog';

describe('sanitizeUrlForLog', () => {
    it('strips userinfo/query/hash from URLs', () => {
        expect(
            sanitizeUrlForLog('https://user:pass@example.com:8443/v1/auth/ping?token=abc#section'),
        ).toBe('https://example.com:8443/v1/auth/ping');
    });

    it('sanitizes URL-like strings even when URL parsing fails', () => {
        // Invalid URL (missing host), but still must not leak credentials into logs.
        const out = sanitizeUrlForLog('https://user:pass@');
        expect(out).not.toContain('user');
        expect(out).not.toContain('pass');
        expect(out).not.toContain('@');
    });

    it('returns the input for non-URL values', () => {
        expect(sanitizeUrlForLog('not-a-url')).toBe('not-a-url');
    });
});
