import { describe, expect, it } from 'vitest';

describe('getPierreDiffWorkerPool', () => {
    it('fails closed (returns null) when workers cannot be constructed', async () => {
        (globalThis as any).window = {};
        (globalThis as any).document = { baseURI: 'http://localhost/' };
        (globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
        (globalThis as any).Worker = function Worker() {
            throw new Error('worker disabled');
        } as any;

        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');

        expect(() => getPierreDiffWorkerPool({ style: 'unified' })).not.toThrow();
        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(() => getPierreDiffWorkerPool({ style: 'split' })).not.toThrow();
        expect(getPierreDiffWorkerPool({ style: 'split' })).toBeNull();
    });
});
