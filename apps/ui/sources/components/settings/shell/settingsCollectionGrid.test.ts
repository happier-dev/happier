import { describe, expect, it } from 'vitest';

import { resolveSettingsCollectionGridColumns } from './settingsCollectionGrid';

describe('resolveSettingsCollectionGridColumns', () => {
    it('lays a standalone collection out about three to a phone row and more as the sheet widens (R6)', () => {
        // A 390 phone's sheet (390 − 2 × 16), a 520 window's, a wide page's, and an unmeasured sheet.
        expect(resolveSettingsCollectionGridColumns(358)).toBe(3);
        expect(resolveSettingsCollectionGridColumns(488)).toBe(4);
        expect(resolveSettingsCollectionGridColumns(868)).toBe(6);
        expect(resolveSettingsCollectionGridColumns(1200)).toBe(6);
        expect(resolveSettingsCollectionGridColumns(0)).toBe(1);
    });
});
