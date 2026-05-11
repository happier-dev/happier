import { describe, expect, it, vi } from 'vitest';

import { ImagePreviewCache } from './imagePreviewCache';

describe('ImagePreviewCache', () => {
    it('evicts least-recently used entries when maxEntries is exceeded', () => {
        const cleanup = vi.fn();
        const cache = new ImagePreviewCache({ maxEntries: 1, maxTotalBytes: 1_000_000, now: () => 1_000 });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'blob:a', cleanup });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })?.status).toBe('loaded');

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: 'blob:b' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })).toBeNull();
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' })?.status).toBe('loaded');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('evicts entries to satisfy maxTotalBytes', () => {
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 20, now: () => 1_000 });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: '12345' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })?.status).toBe('loaded');

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: '123456' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })).toBeNull();
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' })?.status).toBe('loaded');
    });

    it('cleans up replaced loaded entries', () => {
        const cleanup = vi.fn();
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 1_000_000, now: () => 1_000 });

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'blob:a', cleanup });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'blob:a2' });

        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('suppresses async cleanup rejections during eviction', async () => {
        const cache = new ImagePreviewCache({ maxEntries: 1, maxTotalBytes: 1_000_000, now: () => 1_000 });

        cache.set(
            { sessionId: 's1', signature: 'sig1', filePath: 'a.png' },
            { status: 'loaded', uri: 'blob:a', cleanup: async () => { throw new Error('cleanup failed'); } },
        );

        expect(() => {
            cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: 'blob:b' });
        }).not.toThrow();
        await Promise.resolve();
    });
});
