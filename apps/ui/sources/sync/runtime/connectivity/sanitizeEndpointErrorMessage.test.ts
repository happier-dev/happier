import { describe, expect, it } from 'vitest';

import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

describe('sanitizeEndpointErrorMessage', () => {
    it('redacts Bearer tokens', () => {
        expect(
            sanitizeEndpointErrorMessage('Authorization: Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig'),
        ).toBe('Authorization: Bearer [REDACTED]');
    });

    it('redacts Basic tokens', () => {
        expect(sanitizeEndpointErrorMessage('Basic dXNlcjpwYXNz')).toBe('Basic [REDACTED]');
    });

    it('redacts URL userinfo and strips query/hash', () => {
        const message =
            'request failed: https://admin:secret@custom.example.test:9443/path/?token=abc#frag (timeout)';

        expect(sanitizeEndpointErrorMessage(message)).toBe(
            'request failed: https://custom.example.test:9443/path (timeout)',
        );
    });
});
