import { describe, expect, it } from 'vitest';

import { coerceRelativeRoute } from './routeUtils';

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
});
