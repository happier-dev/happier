import { describe, expect, it } from 'vitest';

import { classifyPosthogResponseStatus, parseRetryAfterMs } from './errors.js';

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

function headers(entries: Readonly<Record<string, string>>): Headers {
    return new Headers(entries);
}

describe('parseRetryAfterMs', () => {
    it('accepts delay-seconds and returns an absolute deadline', () => {
        expect(parseRetryAfterMs(headers({ 'retry-after': '30' }), NOW)).toBe(NOW + 30_000);
        expect(parseRetryAfterMs(headers({ 'retry-after': '0' }), NOW)).toBe(NOW);
    });

    it('accepts an HTTP-date and returns that absolute instant', () => {
        const at = NOW + 90_000;
        expect(parseRetryAfterMs(
            headers({ 'retry-after': new Date(at).toUTCString() }),
            NOW,
        )).toBe(at);
    });

    it('returns null rather than inventing a deadline for absent or malformed evidence', () => {
        expect(parseRetryAfterMs(headers({}), NOW)).toBeNull();
        expect(parseRetryAfterMs(headers({ 'retry-after': '' }), NOW)).toBeNull();
        expect(parseRetryAfterMs(headers({ 'retry-after': 'soon' }), NOW)).toBeNull();
        expect(parseRetryAfterMs(headers({ 'retry-after': '-5' }), NOW)).toBeNull();
        expect(parseRetryAfterMs(headers({ 'retry-after': '1.5' }), NOW)).toBeNull();
    });

    it('ignores an HTTP-date already in the past instead of producing a stale deadline', () => {
        expect(parseRetryAfterMs(
            headers({ 'retry-after': new Date(NOW - 60_000).toUTCString() }),
            NOW,
        )).toBeNull();
    });
});

describe('classifyPosthogResponseStatus', () => {
    it('classifies 429 as rate limited and carries only provider-supplied retry evidence', () => {
        expect(classifyPosthogResponseStatus(429, headers({ 'retry-after': '12' }), NOW)).toEqual({
            kind: 'rateLimited',
            status: 429,
            retryNotBeforeMs: NOW + 12_000,
        });
        expect(classifyPosthogResponseStatus(429, headers({}), NOW)).toEqual({
            kind: 'rateLimited',
            status: 429,
        });
        expect(classifyPosthogResponseStatus(429, headers({ 'retry-after': 'later' }), NOW)).toEqual({
            kind: 'rateLimited',
            status: 429,
        });
    });

    it('classifies a bare 403 as a permission failure, never as a guessed throttle', () => {
        expect(classifyPosthogResponseStatus(403, headers({}), NOW)).toEqual({
            kind: 'forbidden',
            status: 403,
        });
    });

    it('classifies a 403 as rate limited only when it carries real retry evidence', () => {
        expect(classifyPosthogResponseStatus(403, headers({ 'retry-after': '45' }), NOW)).toEqual({
            kind: 'rateLimited',
            status: 403,
            retryNotBeforeMs: NOW + 45_000,
        });
    });

    it('classifies 401, 404, redirects and 5xx distinctly', () => {
        expect(classifyPosthogResponseStatus(401, headers({}), NOW))
            .toEqual({ kind: 'unauthorized', status: 401 });
        expect(classifyPosthogResponseStatus(404, headers({}), NOW))
            .toEqual({ kind: 'notFound', status: 404 });
        expect(classifyPosthogResponseStatus(308, headers({ location: '/elsewhere' }), NOW))
            .toEqual({ kind: 'redirected', status: 308 });
        expect(classifyPosthogResponseStatus(503, headers({}), NOW))
            .toEqual({ kind: 'server', status: 503 });
        expect(classifyPosthogResponseStatus(418, headers({}), NOW))
            .toEqual({ kind: 'unexpectedStatus', status: 418 });
    });

    it('returns null for a success status so the caller parses the body', () => {
        expect(classifyPosthogResponseStatus(200, headers({}), NOW)).toBeNull();
        expect(classifyPosthogResponseStatus(204, headers({}), NOW)).toBeNull();
    });
});
