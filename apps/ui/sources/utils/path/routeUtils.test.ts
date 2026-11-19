import { describe, expect, it } from 'vitest';

import { coerceRelativeRoute, normalizeInternalReturnPath, tryAdmitInternalRouteHref } from './routeUtils';

describe('coerceRelativeRoute', () => {
    it('accepts a single-leading-slash route', () => {
        expect(coerceRelativeRoute('/settings/account')).toBe('/settings/account');
    });

    it('rejects protocol-relative URLs', () => {
        expect(coerceRelativeRoute('//example.com')).toBeNull();
        expect(coerceRelativeRoute('/%2F%2Fexample.com')).toBeNull();
    });

    it('rejects backslashes and percent-encoded backslashes', () => {
        expect(coerceRelativeRoute('/\\example.com')).toBeNull();
        expect(coerceRelativeRoute('/%5cexample.com')).toBeNull();
    });

    it('rejects colon characters and percent-encoded colons', () => {
        expect(coerceRelativeRoute('/foo:bar')).toBeNull();
        expect(coerceRelativeRoute('/%3afoo')).toBeNull();
    });

    it('rejects double-slash segments', () => {
        expect(coerceRelativeRoute('/foo//bar')).toBeNull();
        expect(coerceRelativeRoute('/foo/%2F/bar')).toBeNull();
    });

    it('supports unicode relative routes', () => {
        expect(coerceRelativeRoute('/settings/こんにちは')).toBe('/settings/こんにちは');
        expect(coerceRelativeRoute('/settings/%E6%9D%B1%E4%BA%AC')).toBe('/settings/東京');
    });

    it('rejects malformed percent-encoding', () => {
        expect(coerceRelativeRoute('/settings/%')).toBeNull();
    });

    it('rejects absolute URLs, credentials, and control characters as return paths', () => {
        expect(normalizeInternalReturnPath('https://example.com/settings')).toBeNull();
        expect(normalizeInternalReturnPath('https://user:pass@example.com/settings')).toBeNull();
        expect(normalizeInternalReturnPath('//user:pass@example.com/settings')).toBeNull();
        expect(normalizeInternalReturnPath('/settings\u0000/account')).toBeNull();
        expect(normalizeInternalReturnPath('/settings%0a/account')).toBeNull();
    });
});

describe('tryAdmitInternalRouteHref', () => {
    it('admits internal bearer routes without decoding query or fragment values', () => {
        const verify = '/auth/email/verify?token=token%252Fvalue&target=https%3A%2F%2Fhome.example.test#state%2523';
        expect(tryAdmitInternalRouteHref(verify)).toBe(verify);
        expect(tryAdmitInternalRouteHref('/join/opaque-invitation')).toBe('/join/opaque-invitation');
        expect(tryAdmitInternalRouteHref('/share/opaque-capability#key%2F%3D')).toBe('/share/opaque-capability#key%2F%3D');
    });

    it('declines hostile paths and malformed route input without throwing', () => {
        for (const path of ['https://elsewhere.test', '//elsewhere.test', '%2Felsewhere.test', '/%2Felsewhere.test', '/%5celsewhere.test', '/%', '/settings?state=x\nnext']) {
            expect(tryAdmitInternalRouteHref(path)).toBeNull();
        }
    });
});
