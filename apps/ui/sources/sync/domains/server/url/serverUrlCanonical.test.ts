import { describe, expect, it } from 'vitest';
import { createServerUrlComparableKey as createProtocolServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';

import {
    canonicalizeServerUrl,
    createDiagnosticServerUrlKey,
    createServerUrlComparableKey,
    resolveIndependentHttpsServerOrigin,
} from './serverUrlCanonical';
import { toServerUrlDisplay } from './serverUrlDisplay';

describe('serverUrlCanonical', () => {
    it('compares diagnostic endpoints with paths while retaining loopback equivalence', () => {
        expect(createDiagnosticServerUrlKey('http://localhost:3005/relay/')).toBe(createDiagnosticServerUrlKey('http://127.0.0.1:3005/relay'));
        expect(createDiagnosticServerUrlKey('https://relay.example.com/one')).not.toBe(createDiagnosticServerUrlKey('https://relay.example.com/two'));
        expect(createDiagnosticServerUrlKey('https://RELAY.example.com:443/')).toBe(createDiagnosticServerUrlKey('https://relay.example.com'));
    });

    it('keeps missing diagnostic URLs unknown and malformed endpoints distinct', () => {
        expect(createDiagnosticServerUrlKey('')).toBe('');
        expect(createDiagnosticServerUrlKey('https://[invalid')).not.toBe('');
        expect(createDiagnosticServerUrlKey('https://[invalid')).not.toBe(createDiagnosticServerUrlKey('https://[other'));
        expect(createDiagnosticServerUrlKey('https://[invalid')).not.toBe(createDiagnosticServerUrlKey('https://relay.example.com'));
    });

    it('strips userinfo, query, and hash', () => {
        expect(
            canonicalizeServerUrl('https://admin:secret@example.com:8443/api?token=abc#frag'),
        ).toBe('https://example.com:8443/api');
    });

    it('accepts remote hostnames without a scheme and defaults to https', () => {
        expect(canonicalizeServerUrl('api.happier.dev')).toBe('https://api.happier.dev');
        expect(canonicalizeServerUrl('example.com:8443/path')).toBe('https://example.com:8443/path');
    });

    it('defaults to http for loopback + private LAN hosts when the scheme is omitted', () => {
        expect(canonicalizeServerUrl('localhost:3005')).toBe('http://localhost:3005');
        expect(canonicalizeServerUrl('qa-stack.localhost:3012')).toBe('http://qa-stack.localhost:3012');
        expect(canonicalizeServerUrl('127.0.0.1:3005')).toBe('http://127.0.0.1:3005');
        expect(canonicalizeServerUrl('192.168.1.20:3005')).toBe('http://192.168.1.20:3005');
        expect(canonicalizeServerUrl('10.0.0.5:53288')).toBe('http://10.0.0.5:53288');
        expect(canonicalizeServerUrl('172.16.0.5:53288')).toBe('http://172.16.0.5:53288');
        expect(canonicalizeServerUrl('172.31.255.254:53288')).toBe('http://172.31.255.254:53288');
        expect(canonicalizeServerUrl('[::1]:3005')).toBe('http://[::1]:3005');
        expect(canonicalizeServerUrl('happier-dev.local:3005/path')).toBe('http://happier-dev.local:3005/path');
        expect(canonicalizeServerUrl('my-nas:3005/path')).toBe('http://my-nas:3005/path');
    });

    it('lowercases the host and strips repeated trailing slashes', () => {
        expect(canonicalizeServerUrl(' https://Example.COM:8443/ ')).toBe('https://example.com:8443');
        expect(canonicalizeServerUrl('http://localhost:3012////')).toBe('http://localhost:3012');
        expect(canonicalizeServerUrl('https://example.com/path/')).toBe('https://example.com/path');
    });

    it('rejects non-http protocols and unparseable input', () => {
        expect(canonicalizeServerUrl('ftp://example.com')).toBe('');
        expect(canonicalizeServerUrl('file:///tmp/server')).toBe('');
        expect(canonicalizeServerUrl('javascript:alert(1)')).toBe('');
        expect(canonicalizeServerUrl('not a url')).toBe('');
        expect(canonicalizeServerUrl('')).toBe('');
    });

    it('normalizes an independent HTTPS fallback while rejecting embedded credentials', () => {
        expect(resolveIndependentHttpsServerOrigin(
            '  HTTPS://Public.Example.test:443/api///?token=secret#fragment  ',
        )).toBe('https://public.example.test/api');
        expect(resolveIndependentHttpsServerOrigin('https://admin:secret@example.test/api')).toBeNull();
        expect(resolveIndependentHttpsServerOrigin('http://example.test/api')).toBeNull();
    });

    it('normalizes loopback host equivalence for comparable identity keys', () => {
        const a = createServerUrlComparableKey('http://127.0.0.1:3012/path');
        const b = createServerUrlComparableKey('http://localhost:3012/path/');
        expect(a).toBe(b);

        const c = createServerUrlComparableKey('http://qa-stack.localhost:3012/path');
        expect(c).toBe(b);

        const d = createServerUrlComparableKey('http://qa-stack.localhost.:3012/path');
        expect(d).toBe(b);
    });

    it('normalizes explicit default ports for comparable identity keys', () => {
        const httpsA = createServerUrlComparableKey('https://example.com/path');
        const httpsB = createServerUrlComparableKey('https://example.com:443/path/');
        expect(httpsA).toBe(httpsB);

        const httpA = createServerUrlComparableKey('http://example.com/path');
        const httpB = createServerUrlComparableKey('http://example.com:80/path/');
        expect(httpA).toBe(httpB);
    });

    it('strips path/query/hash from comparable identity keys to match the shared protocol helper', () => {
        const rawUrl = 'https://Example.com:443/relay/path?x=1#fragment';

        expect(createServerUrlComparableKey(rawUrl)).toBe('https://example.com');
        expect(createServerUrlComparableKey(rawUrl)).toBe(createProtocolServerUrlComparableKey(rawUrl));
    });
});

describe('serverUrlDisplay', () => {
    it('redacts userinfo from display output', () => {
        expect(
            toServerUrlDisplay('https://admin:secret@example.com:8443/path?token=abc#frag'),
        ).toBe('https://example.com:8443/path');
    });
});
