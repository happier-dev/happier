import { describe, expect, it } from 'vitest';

import { clampMediaSize } from './StoryDeckMediaFrame';

describe('clampMediaSize', () => {
    it('clamps below the minimum', () => {
        expect(clampMediaSize(120)).toBe(300 - 60);
    });

    it('uses the full available width by default', () => {
        expect(clampMediaSize(2000)).toBe(2000 - 60);
    });

    it('supports an explicit maximum cap when needed', () => {
        expect(clampMediaSize(2000, 440)).toBe(440 - 60);
    });

    it('supports unpadded media sizing for wide story cards', () => {
        expect(clampMediaSize(370, 370, 0)).toBe(370);
    });

    it('uses the container width when within range', () => {
        expect(clampMediaSize(360)).toBe(360 - 60);
    });

    it('never returns a negative size', () => {
        expect(clampMediaSize(0)).toBeGreaterThan(0);
    });
});
