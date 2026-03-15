import { describe, expect, it } from 'vitest';

import {
    canonicalizeServerUrl,
    createServerUrlComparableKey,
} from './serverUrlCanonical';
import { toServerUrlDisplay } from './serverUrlDisplay';

describe('serverUrlCanonical', () => {
    it('strips query and hash while preserving userinfo for request usage', () => {
        expect(
            canonicalizeServerUrl('https://admin:secret@example.com:8443/api?token=abc#frag'),
        ).toBe('https://admin:secret@example.com:8443/api');
    });

    it('accepts hostnames without a scheme and defaults to https', () => {
        expect(canonicalizeServerUrl('api.happier.dev')).toBe('https://api.happier.dev');
        expect(canonicalizeServerUrl('example.com:8443/path')).toBe('https://example.com:8443/path');
    });

    it('rejects non-http protocols', () => {
        expect(canonicalizeServerUrl('ftp://example.com')).toBe('');
        expect(canonicalizeServerUrl('file:///tmp/server')).toBe('');
    });

    it('normalizes loopback host equivalence for comparable identity keys', () => {
        const a = createServerUrlComparableKey('http://127.0.0.1:3012/path');
        const b = createServerUrlComparableKey('http://localhost:3012/path/');
        expect(a).toBe(b);
    });

    it('normalizes explicit default ports for comparable identity keys', () => {
        const httpsA = createServerUrlComparableKey('https://example.com/path');
        const httpsB = createServerUrlComparableKey('https://example.com:443/path/');
        expect(httpsA).toBe(httpsB);

        const httpA = createServerUrlComparableKey('http://example.com/path');
        const httpB = createServerUrlComparableKey('http://example.com:80/path/');
        expect(httpA).toBe(httpB);
    });
});

describe('serverUrlDisplay', () => {
    it('redacts userinfo from display output', () => {
        expect(
            toServerUrlDisplay('https://admin:secret@example.com:8443/path?token=abc#frag'),
        ).toBe('https://example.com:8443/path');
    });
});
