import { describe, expect, it } from 'vitest';

import { ImagePreviewCache } from './imagePreviewCache';

describe('ImagePreviewCache', () => {
    it('evicts least-recently used entries when maxEntries is exceeded', () => {
        const cache = new ImagePreviewCache({ maxEntries: 1, maxTotalBytes: 1_000_000, now: () => 1_000 });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'data:image/png;base64,aaa' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })?.status).toBe('loaded');

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: 'data:image/png;base64,bbb' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })).toBeNull();
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' })?.status).toBe('loaded');
    });

    it('evicts entries to satisfy maxTotalBytes', () => {
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 20, now: () => 1_000 });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: '12345' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })?.status).toBe('loaded');

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: '123456' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })).toBeNull();
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' })?.status).toBe('loaded');
    });
});
