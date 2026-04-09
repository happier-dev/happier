import { describe, expect, it, vi } from 'vitest';

import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';

describe('normalizeTrimmedStringArrayWithSharedEmpty', () => {
    it('returns the original array without allocating duplicate-tracking state when the values are already normalized and unique', () => {
        const values = ['server-a', 'server-b', 'server-c'];
        const setSpy = vi.spyOn(globalThis, 'Set');

        try {
            const normalized = normalizeTrimmedStringArrayWithSharedEmpty(values);

            expect(normalized).toBe(values);
            expect(setSpy).not.toHaveBeenCalled();
        } finally {
            setSpy.mockRestore();
        }
    });

    it('deduplicates and trims values while preserving first-seen order', () => {
        const normalized = normalizeTrimmedStringArrayWithSharedEmpty([' server-a ', 'server-b', 'server-a', '', 'server-c']);

        expect(normalized).toEqual(['server-a', 'server-b', 'server-c']);
    });

    it('reuses the same normalized array for repeated normalization of the same source array', () => {
        const values = [' server-a ', 'server-b', 'server-a', '', 'server-c'];

        const first = normalizeTrimmedStringArrayWithSharedEmpty(values);
        const second = normalizeTrimmedStringArrayWithSharedEmpty(values);

        expect(first).toBe(second);
        expect(first).toEqual(['server-a', 'server-b', 'server-c']);
    });
});
