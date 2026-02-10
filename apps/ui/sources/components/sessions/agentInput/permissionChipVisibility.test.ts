import { describe, expect, it } from 'vitest';
import { shouldRenderPermissionChip } from './permissionChipVisibility';

describe('shouldRenderPermissionChip', () => {
    it('returns false for empty values', () => {
        expect(shouldRenderPermissionChip('')).toBe(false);
        expect(shouldRenderPermissionChip('   ')).toBe(false);
        expect(shouldRenderPermissionChip(null)).toBe(false);
        expect(shouldRenderPermissionChip(undefined)).toBe(false);
    });

    it('returns true for non-empty labels', () => {
        expect(shouldRenderPermissionChip('Default')).toBe(true);
    });
});
