import { describe, expect, it } from 'vitest';

import {
    redactSidecarContextUrl,
    redactSidecarDiagnosticsHeaders,
    redactSidecarDiagnosticsUrl,
} from './redaction';

describe('redactSidecarDiagnosticsHeaders', () => {
    it('drops credential-bearing headers and keeps only safe metadata header values', () => {
        const redacted = redactSidecarDiagnosticsHeaders({
            Authorization: 'Bearer secret-token',
            Cookie: 'sid=secret',
            'Set-Cookie': 'sid=secret',
            'X-Api-Key': 'secret',
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Request-Id': 'request-123',
        });

        expect(redacted).toEqual({
            'content-type': 'application/json',
            accept: 'application/json',
            'x-request-id': 'request-123',
        });
        expect(JSON.stringify(redacted)).not.toContain('secret');
    });

    it('never surfaces a Sec-WebSocket-Protocol value (a documented bearer-token smuggling vector)', () => {
        // Browsers cannot set Authorization on a WebSocket handshake, so clients smuggle bearer
        // tokens through the subprotocol header (e.g. Kubernetes `base64url.bearer.authorization…`).
        // Surfacing its value would leak a credential, so it must not be in the safe allowlist.
        const redacted = redactSidecarDiagnosticsHeaders({
            'Sec-WebSocket-Protocol': 'base64url.bearer.authorization.k8s.io.SECRETTOKEN, v1.channel.k8s.io',
        });

        expect(redacted).toEqual({});
        expect(JSON.stringify(redacted)).not.toContain('SECRETTOKEN');
    });

    it('returns an empty record for absent or empty headers', () => {
        expect(redactSidecarDiagnosticsHeaders(undefined)).toEqual({});
        expect(redactSidecarDiagnosticsHeaders({ Authorization: 'Bearer secret' })).toEqual({});
    });
});

describe('redactSidecarDiagnosticsUrl', () => {
    it('keeps origin/path and only safe query keys, dropping query values and sensitive keys', () => {
        expect(redactSidecarDiagnosticsUrl('https://example.test/api/search?q=hello&token=secret&api_key=secret'))
            .toEqual({ origin: 'https://example.test', path: '/api/search', queryKeys: ['q'] });
    });

    it('fails closed to an opaque origin when the URL cannot be parsed', () => {
        expect(redactSidecarDiagnosticsUrl('not a url')).toEqual({ origin: 'unknown:', path: '/', queryKeys: [] });
    });
});

describe('redactSidecarContextUrl', () => {
    it('drops sensitive query keys and never surfaces query values', () => {
        const redacted = redactSidecarContextUrl('https://example.test/p?q=hello&token=secret');
        expect(redacted).toBe('https://example.test/p?q');
        expect(redacted).not.toContain('secret');
        expect(redacted).not.toContain('hello');
    });

    it('redacts token-shaped path segments before page references reach agent context', () => {
        const redacted = redactSidecarContextUrl(
            'https://example.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?project=one&token=secret',
        );
        expect(redacted).toBe('https://example.test/reset/:redacted?project');
        expect(redacted).not.toContain('tok9f8e7d6c5b4a3210ffeeddcc');
        expect(redacted).not.toContain('secret');
    });
});
