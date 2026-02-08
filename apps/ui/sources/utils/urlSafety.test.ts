import { describe, expect, it } from 'vitest';
import { isSafeBadgeUrl } from './urlSafety';

describe('isSafeBadgeUrl', () => {
    it('accepts https links', () => {
        expect(isSafeBadgeUrl('https://github.com/happier-dev')).toBe(true);
    });

    it('accepts localhost http links for local development', () => {
        expect(isSafeBadgeUrl('http://localhost:3000/profile')).toBe(true);
    });

    it('accepts ipv6 localhost http links for local development', () => {
        expect(isSafeBadgeUrl('http://[::1]:3000/profile')).toBe(true);
    });

    it('rejects non-http protocols and malformed URLs', () => {
        expect(isSafeBadgeUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeBadgeUrl('happier://deep-link')).toBe(false);
        expect(isSafeBadgeUrl('not-a-url')).toBe(false);
    });
});
