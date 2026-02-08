import { describe, expect, it } from 'vitest';

import { isSafeExternalAuthUrl } from './externalAuthUrl';

describe('isSafeExternalAuthUrl', () => {
    it('accepts https links', () => {
        expect(isSafeExternalAuthUrl('https://example.test/oauth')).toBe(true);
    });

    it('accepts localhost http for local development', () => {
        expect(isSafeExternalAuthUrl('http://localhost:3005/oauth')).toBe(true);
    });

    it('accepts bracketed IPv6 localhost for local development', () => {
        expect(isSafeExternalAuthUrl('http://[::1]:3005/oauth')).toBe(true);
    });

    it('rejects unsafe protocols', () => {
        expect(isSafeExternalAuthUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeExternalAuthUrl('data:text/html,hi')).toBe(false);
        expect(isSafeExternalAuthUrl('ftp://example.test')).toBe(false);
    });
});
