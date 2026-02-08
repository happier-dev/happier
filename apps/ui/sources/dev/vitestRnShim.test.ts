import { describe, expect, it } from 'vitest';

describe('vitestRnShim', () => {
    it('resolves aliased asset requires in Node test runtime', () => {
        const asset = (globalThis as any).require('@/assets/images/logo-black.png');
        expect(typeof asset).toBe('string');
        expect(asset).toContain('logo-black.png');
    });

    it('fails loudly for non-asset aliased requires outside the allowlist', () => {
        expect(() => (globalThis as any).require('@/sync/storageStore')).toThrow(
            /Unsupported alias require/i,
        );
    });
});
