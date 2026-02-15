import { describe, expect, it } from 'vitest';

import { ensureKokoroCacheApiAvailable } from '@/voice/kokoro/assets/kokoroCacheApi';

describe('kokoroCacheApi', () => {
  it('installs a minimal Cache API polyfill when missing', async () => {
    // Ensure the global Cache API isn't present for this test.
    (globalThis as any).caches = undefined;

    await ensureKokoroCacheApiAvailable();

    expect((globalThis as any).caches).toBeTruthy();
    expect(typeof (globalThis as any).caches.open).toBe('function');
    expect(typeof (globalThis as any).caches.delete).toBe('function');

    const cache = await (globalThis as any).caches.open('transformers-cache');
    expect(typeof cache.match).toBe('function');
    expect(typeof cache.put).toBe('function');
    expect(typeof cache.keys).toBe('function');

    const bytes = new TextEncoder().encode('hello');
    const response = {
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
      arrayBuffer: async () => bytes.buffer,
      body: null,
    } as any;

    await cache.put('https://example.com/file.bin', response);
    const hit = await cache.match('https://example.com/file.bin');
    expect(hit).toBeTruthy();
    const hitBytes = new Uint8Array(await (hit as Response).arrayBuffer());
    expect(Array.from(hitBytes)).toEqual(Array.from(bytes));

    const keys = await cache.keys();
    expect(keys).toContain('https://example.com/file.bin');

    await (globalThis as any).caches.delete('transformers-cache');
    const cache2 = await (globalThis as any).caches.open('transformers-cache');
    expect(await cache2.match('https://example.com/file.bin')).toBeUndefined();
  });
});

