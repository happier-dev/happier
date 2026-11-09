import { describe, expect, it } from 'vitest';
import { resolveThemeProfileEditorTarget } from './themeProfileEditorModel';

describe('theme profile editor identity', () => {
    it('follows a captured legacy origin after account fetch remaps the displayed id', () => {
        expect(resolveThemeProfileEditorTarget({ routeId: 'ocean', capturedLegacyProfileId: 'ocean',
            legacyProfileIds: { ocean_2: 'ocean' } })).toBe('ocean_2');
    });
    it('keeps an expired legacy origin separate from an account row at the old route', () => {
        expect(resolveThemeProfileEditorTarget({ routeId: 'ocean', capturedLegacyProfileId: 'ocean',
            legacyProfileIds: {} })).toBeNull();
        expect(resolveThemeProfileEditorTarget({ routeId: 'ocean', legacyProfileIds: {} })).toBe('ocean');
    });
});
