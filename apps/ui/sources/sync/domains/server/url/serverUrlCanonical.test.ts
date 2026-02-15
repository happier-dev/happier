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

    it('rejects non-http protocols', () => {
        expect(canonicalizeServerUrl('ftp://example.com')).toBe('');
        expect(canonicalizeServerUrl('file:///tmp/server')).toBe('');
    });

    it('normalizes loopback host equivalence for comparable identity keys', () => {
        const a = createServerUrlComparableKey('http://127.0.0.1:3012/path');
        const b = createServerUrlComparableKey('http://localhost:3012/path/');
        expect(a).toBe(b);
    });
});

describe('serverUrlDisplay', () => {
    it('redacts userinfo from display output', () => {
        expect(
            toServerUrlDisplay('https://admin:secret@example.com:8443/path?token=abc#frag'),
        ).toBe('https://example.com:8443/path');
    });
});
