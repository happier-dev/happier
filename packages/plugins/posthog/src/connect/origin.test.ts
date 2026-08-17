import { describe, expect, it } from 'vitest';

import {
    isSameNormalizedOrigin,
    normalizePosthogApiOrigin,
    selectPosthogApiOrigin,
} from './origin.js';

describe('normalizePosthogApiOrigin', () => {
    it('lowercases scheme and host and drops the default HTTPS port', () => {
        expect(normalizePosthogApiOrigin('HTTPS://EU.PostHog.CoM')).toEqual({
            ok: true,
            origin: 'https://eu.posthog.com',
        });
        expect(normalizePosthogApiOrigin('https://us.posthog.com:443')).toEqual({
            ok: true,
            origin: 'https://us.posthog.com',
        });
        expect(normalizePosthogApiOrigin('https://eu.posthog.com/')).toEqual({
            ok: true,
            origin: 'https://eu.posthog.com',
        });
    });

    it('preserves an explicit non-default port for a self-hosted deployment', () => {
        expect(normalizePosthogApiOrigin('https://Analytics.Internal.Example:8443')).toEqual({
            ok: true,
            origin: 'https://analytics.internal.example:8443',
        });
    });

    it('rejects every non-HTTPS scheme so a bearer credential can never travel in cleartext', () => {
        for (const raw of [
            'http://eu.posthog.com',
            'ws://eu.posthog.com',
            'file:///etc/passwd',
            'javascript:alert(1)',
        ]) {
            expect(normalizePosthogApiOrigin(raw)).toEqual({ ok: false, reason: 'notHttps' });
        }
    });

    it('rejects user info, path, query and fragment rather than silently discarding them', () => {
        expect(normalizePosthogApiOrigin('https://user:pass@eu.posthog.com'))
            .toEqual({ ok: false, reason: 'containsUserInfo' });
        expect(normalizePosthogApiOrigin('https://eu.posthog.com/API/'))
            .toEqual({ ok: false, reason: 'containsPath' });
        expect(normalizePosthogApiOrigin('https://eu.posthog.com/?a=1'))
            .toEqual({ ok: false, reason: 'containsQuery' });
        expect(normalizePosthogApiOrigin('https://eu.posthog.com/#x'))
            .toEqual({ ok: false, reason: 'containsFragment' });
    });

    it('rejects the public ingest host family, which cannot read Error Tracking', () => {
        for (const raw of [
            'https://eu.i.posthog.com',
            'https://us.i.posthog.com',
            'https://i.posthog.com',
        ]) {
            expect(normalizePosthogApiOrigin(raw)).toEqual({ ok: false, reason: 'ingestHost' });
        }
    });

    it('rejects malformed input without throwing', () => {
        expect(normalizePosthogApiOrigin('')).toEqual({ ok: false, reason: 'malformed' });
        expect(normalizePosthogApiOrigin('not a url')).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('selectPosthogApiOrigin', () => {
    it('accepts exactly one normalized value from the Connected Account', () => {
        expect(selectPosthogApiOrigin(['https://EU.posthog.com'])).toEqual({
            ok: true,
            origin: 'https://eu.posthog.com',
        });
    });

    it('fails closed on zero and on multiple values instead of picking one', () => {
        expect(selectPosthogApiOrigin([])).toEqual({ ok: false, reason: 'noOrigin' });
        expect(selectPosthogApiOrigin(['https://eu.posthog.com', 'https://us.posthog.com']))
            .toEqual({ ok: false, reason: 'multipleOrigins' });
    });

    it('treats two spellings of the same origin as one selectable value', () => {
        expect(selectPosthogApiOrigin(['https://eu.posthog.com', 'HTTPS://EU.POSTHOG.COM:443/']))
            .toEqual({ ok: true, origin: 'https://eu.posthog.com' });
    });

    it('propagates the exact rejection of a single invalid value', () => {
        expect(selectPosthogApiOrigin(['http://eu.posthog.com']))
            .toEqual({ ok: false, reason: 'notHttps' });
    });
});

describe('isSameNormalizedOrigin', () => {
    const origin = (() => {
        const resolved = normalizePosthogApiOrigin('https://eu.posthog.com');
        if (!resolved.ok) throw new Error('fixture origin must normalize');
        return resolved.origin;
    })();

    it('accepts a provider next URL on the exact materialized origin', () => {
        expect(isSameNormalizedOrigin(
            origin,
            'https://eu.posthog.com/api/organizations/?limit=100&offset=100',
        )).toBe(true);
        expect(isSameNormalizedOrigin(origin, 'https://EU.POSTHOG.COM:443/api/organizations/'))
            .toBe(true);
    });

    it('rejects a cross-origin, downgraded, or malformed next URL', () => {
        expect(isSameNormalizedOrigin(origin, 'https://us.posthog.com/api/organizations/')).toBe(false);
        expect(isSameNormalizedOrigin(origin, 'http://eu.posthog.com/api/organizations/')).toBe(false);
        expect(isSameNormalizedOrigin(origin, 'https://eu.posthog.com.evil.test/api/')).toBe(false);
        expect(isSameNormalizedOrigin(origin, '/api/organizations/?offset=100')).toBe(false);
        expect(isSameNormalizedOrigin(origin, 'nonsense')).toBe(false);
    });

    it('does not lowercase the API path when comparing origins', () => {
        // The provider owns path case; only scheme and host are case-insensitive.
        expect(isSameNormalizedOrigin(origin, 'https://eu.posthog.com/api/Projects/1/')).toBe(true);
    });
});
