import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { pictureStore } from './pictureStore.web';
vi.mock('@/components/atmosphere/pictureStore', async () => import('./pictureStore.web'));

describe('device-local picture bytes', () => {
    it('shares one physical exact-id read and record across concurrent display consumers', async () => {
        await pictureStore.put({ localId: 'concurrent-display', kind: 'user', data: new Blob(['first']) });
        const gets = vi.spyOn(IDBObjectStore.prototype, 'get');
        try {
            const records = await Promise.all(Array.from({ length: 24 }, () => pictureStore.get('concurrent-display')));
            expect(gets).toHaveBeenCalledTimes(1);
            expect(records.every(record => record === records[0])).toBe(true);
            gets.mockClear();
            const missing = await Promise.all(Array.from({ length: 24 }, () => pictureStore.get('concurrent-missing')));
            expect(missing.every(record => record === undefined)).toBe(true);
            expect(gets).toHaveBeenCalledTimes(1);
            await pictureStore.put({ localId: 'concurrent-display', kind: 'user', data: new Blob(['replacement']) });
            expect(await (await pictureStore.get('concurrent-display'))?.data.text()).toBe('replacement');
            await pictureStore.remove('concurrent-display');
            expect(await pictureStore.get('concurrent-display')).toBeUndefined();
        } finally { gets.mockRestore(); await pictureStore.remove('concurrent-display'); }
    });
    it('shares full and thumbnail reads, preferring the full record as soon as it lands', async () => {
        const fullId = 'builtin:thumbnail-display';
        const thumbnailId = 'builtin-thumb:thumbnail-display';
        await pictureStore.put({ localId: thumbnailId, kind: 'builtin', data: new Blob(['small']) });
        const gets = vi.spyOn(IDBObjectStore.prototype, 'get');
        try {
            const first = await Promise.all(Array.from({ length: 24 }, () => pictureStore.get(fullId, thumbnailId)));
            expect(first.every(record => record === first[0] && record?.localId === thumbnailId)).toBe(true);
            expect(gets).toHaveBeenCalledTimes(2);
            await pictureStore.put({ localId: fullId, kind: 'builtin', data: new Blob(['full']) });
            gets.mockClear();
            const next = await Promise.all(Array.from({ length: 24 }, () => pictureStore.get(fullId, thumbnailId)));
            expect(next.every(record => record === next[0] && record?.localId === fullId)).toBe(true);
            expect(gets).toHaveBeenCalledTimes(1);
        } finally {
            gets.mockRestore();
            await pictureStore.remove(fullId);
            await pictureStore.remove(thumbnailId);
        }
    });
    it('shares a failed exact-id read and allows the next demand to recover', async () => {
        const gets = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => { throw new Error('device read unavailable'); });
        try {
            const results = await Promise.allSettled(Array.from({ length: 24 }, () => pictureStore.get('concurrent-failure')));
            expect(results.every(result => result.status === 'rejected')).toBe(true);
            expect(gets).toHaveBeenCalledTimes(1);
        } finally { gets.mockRestore(); }
        expect(await pictureStore.get('concurrent-failure')).toBeUndefined();
    });
    it('selects user metadata without visiting stored built-in records', async () => {
        const data = new Blob(['pixels']);
        await pictureStore.put({ localId: 'kind-user', kind: 'user', data });
        for (let index = 0; index < 20; index++) await pictureStore.put({ localId: `kind-builtin-${index}`, kind: 'builtin', data });
        const cursorVisits = vi.spyOn(IDBCursor.prototype, 'continue');
        try {
            const users = await pictureStore.list('user');
            expect(users).toEqual(expect.arrayContaining([expect.objectContaining({ localId: 'kind-user' })]));
            expect(users.every(info => info.kind === 'user')).toBe(true);
            expect(cursorVisits).toHaveBeenCalledTimes(users.length);
        } finally {
            cursorVisits.mockRestore();
            await pictureStore.remove('kind-user');
            for (let index = 0; index < 20; index++) await pictureStore.remove(`kind-builtin-${index}`);
        }
    });
    afterEach(() => vi.unstubAllGlobals());
    it('publishes only to readers of the changed picture while library readers see every write', async () => {
        const selected = vi.fn();
        const library = vi.fn();
        const users = vi.fn();
        const stopSelected = pictureStore.subscribe(selected, 'selected-cost');
        const stopLibrary = pictureStore.subscribe(library);
        const stopUsers = pictureStore.subscribe(users, { kind: 'user' });
        const userRevision = pictureStore.getRevision('user');
        try {
            for (let index = 0; index < 20; index += 1) {
                await pictureStore.put({ localId: `unrelated-cost-${index}`, kind: 'builtin', data: new Blob(['pixels']) });
            }
            expect(selected).toHaveBeenCalledTimes(0);
            expect(library).toHaveBeenCalledTimes(20);
            expect(users).toHaveBeenCalledTimes(0);
            expect(pictureStore.getRevision('user')).toBe(userRevision);
            await pictureStore.put({ localId: 'selected-cost', kind: 'user', data: new Blob(['selected']) });
            expect(users).toHaveBeenCalledTimes(1);
            await pictureStore.put({ localId: 'selected-cost', kind: 'builtin', data: new Blob(['replacement']) });
            expect(users).toHaveBeenCalledTimes(2);
            await pictureStore.remove('selected-cost');
            expect(users).toHaveBeenCalledTimes(2);
            expect(selected).toHaveBeenCalledTimes(3);
        } finally { stopSelected(); stopLibrary(); stopUsers(); }
    });
    it('prepares a lossless reviewed copy without writing or replacing the device library', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1200, height: 800, close() {} })));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void, mime: string) => done(new Blob(['reviewed pixels'], { type: mime })),
        }) });
        const source = new Blob(['device pixels'], { type: 'image/webp' });
        await pictureStore.put({ localId: 'review-source', kind: 'user', data: source });
        try {
            const revision = pictureStore.getRevision();
            const prepared = await pictureStore.prepare(source, { format: 'png' });
            expect(prepared.type).toBe('image/png');
            expect(await prepared.text()).toBe('reviewed pixels');
            expect(await (await pictureStore.get('review-source'))?.data.text()).toBe('device pixels');
            expect(pictureStore.getRevision()).toBe(revision);
        } finally { await pictureStore.remove('review-source'); }
    });
    it('prepares a large PNG exactly once at the shared user ingress before persisting WebP', async () => {
        const canvases: Array<{ width: number; height: number }> = [];
        const decode = vi.fn(async (data: Blob) => {
            expect(data.type).toBe('image/png');
            return { width: 5120, height: 2560, close() {} };
        });
        vi.stubGlobal('createImageBitmap', decode);
        vi.stubGlobal('document', { createElement: () => {
            const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
                toBlob: (callback: (blob: Blob) => void, mime: string, quality: number) => {
                    expect(mime).toBe('image/webp'); expect(quality).toBe(0.86);
                    callback(new Blob([JSON.stringify({ width: canvas.width, height: canvas.height })], { type: mime }));
                } };
            canvases.push(canvas); return canvas;
        } });
        const { storeUserAtmospherePicture } = await import('./atmosphereSettings');
        const id = await storeUserAtmospherePicture(new Blob(['large PNG'], { type: 'image/png' }));
        try {
            const stored = await pictureStore.get(id);
            expect(stored?.data.type).toBe('image/webp');
            expect(JSON.parse(await stored!.data.text())).toEqual({ width: 2560, height: 1280 });
            expect(canvases).toHaveLength(1);
            expect(decode).toHaveBeenCalledTimes(1);
        } finally { await pictureStore.remove(id); }
    });
    it('round-trips user bytes durably and removes only the selected picture', async () => {
        const data = new Blob(['user photo'], { type: 'image/webp' });
        await pictureStore.put({ localId: 'user-a', kind: 'user', data });
        await pictureStore.put({ localId: 'user-b', kind: 'user', data });
        expect(await (await pictureStore.get('user-a'))?.data.text()).toBe('user photo');
        expect(await pictureStore.list()).toEqual(expect.arrayContaining([expect.objectContaining({ localId: 'user-a', size: data.size })]));
        await pictureStore.remove('user-a');
        expect(await pictureStore.get('user-a')).toBeUndefined();
        expect(await pictureStore.get('user-b')).toBeDefined();
    });
    it('shares thumbnail acquisition between a pending full picture and concurrent picker readers', async () => {
        let releaseFull!: () => void;
        const fullReady = new Promise<void>(resolve => { releaseFull = resolve; });
        const fetchBoundary = vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).pathname === '/full') await fullReady;
            return new Response(new Blob(['remote picture']));
        });
        vi.stubGlobal('fetch', fetchBoundary);
        vi.stubGlobal('createImageBitmap', async () => ({ width: 288, height: 192, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob(['pixels'], { type })),
        }) });
        const picture = { id: 'shared-acquisition', src: { full: 'https://picture/full', thumb: 'https://picture/thumb' } };
        const full = pictureStore.ensureBuiltin(picture);
        try {
            await vi.waitFor(() => expect(fetchBoundary).toHaveBeenCalledTimes(2));
            const [first, second] = await Promise.all([
                pictureStore.ensureBuiltinThumbnail(picture), pictureStore.ensureBuiltinThumbnail(picture),
            ]);
            expect(first).toBe(second);
            releaseFull();
            await full;
            expect(await (await pictureStore.get('builtin:shared-acquisition'))?.thumb?.text()).toBe('pixels');
            expect(fetchBoundary).toHaveBeenCalledTimes(2);
        } finally {
            releaseFull();
            await full;
            await pictureStore.remove('builtin:shared-acquisition');
            await pictureStore.remove('builtin-thumb:shared-acquisition');
        }
    });
    it('downloads full and thumb once, encodes WebP at the approved size, and stores both durably', async () => {
        const canvases: Array<{ width: number; height: number }> = [];
        const fetchBoundary = vi.fn(async () => new Response(new Blob(['remote picture'])));
        vi.stubGlobal('fetch', fetchBoundary);
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 5120, height: 2560, close() {} })));
        vi.stubGlobal('document', { createElement: () => {
            const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
                toBlob: (callback: (blob: Blob) => void, mime: string, quality: number) => {
                    expect(mime).toBe('image/webp'); expect(quality).toBe(0.86);
                    callback(new Blob(['encoded picture'], { type: mime }));
                } };
            canvases.push(canvas); return canvas;
        } });
        const picture = { id: 'downloaded', src: { full: 'https://picture/full', thumb: 'https://picture/thumb' } };
        const [a, b] = await Promise.all([pictureStore.ensureBuiltin(picture), pictureStore.ensureBuiltin(picture)]);
        expect(a).toEqual(b);
        expect(fetchBoundary.mock.calls).toHaveLength(2);
        expect(canvases).toMatchObject([{ width: 2560, height: 1280 }, { width: 2560, height: 1280 }]);
        const stored = await pictureStore.get('builtin:downloaded');
        expect(await stored?.data.text()).toBe('encoded picture');
        expect(await stored?.thumb?.text()).toBe('encoded picture');
        await pictureStore.ensureBuiltin(picture);
        expect(fetchBoundary.mock.calls).toHaveLength(2);
    });
    it('leaves missing bytes absent after a failed download and retries only on a later invocation', async () => {
        const fetchBoundary = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', fetchBoundary);
        const picture = { id: 'offline', src: { full: 'https://picture/full?w=2560&fm=webp#image', thumb: 'https://picture/thumb?w=288' } };
        // Concurrent consumers share the thumbnail failure; full acquisition stops there.
        const visit = () => Promise.all([
            expect(pictureStore.ensureBuiltin(picture)).rejects.toThrow('503'),
            expect(pictureStore.ensureBuiltinThumbnail(picture)).rejects.toThrow('503'),
        ]);
        await visit();
        expect(await pictureStore.get('builtin:offline')).toBeUndefined();
        expect(fetchBoundary.mock.calls).toHaveLength(1);
        await visit();
        expect(fetchBoundary.mock.calls).toHaveLength(2);
        await expect(pictureStore.ensureBuiltinThumbnail(picture)).rejects.toThrow('503');
        await expect(pictureStore.ensureBuiltinThumbnail(picture)).rejects.toThrow('503');
        const sources = [picture.src.thumb, picture.src.thumb, picture.src.thumb, picture.src.thumb];
        const nonces = fetchBoundary.mock.calls.map((call, index) => {
            const downloaded = new URL(String(call[0]));
            const nonce = downloaded.searchParams.get('happier-atmosphere');
            expect(nonce).toBeTruthy();
            downloaded.searchParams.delete('happier-atmosphere');
            expect(downloaded.href).toBe(sources[index]);
            return nonce;
        });
        expect(new Set(nonces).size).toBe(sources.length);
    });
    it('does not cache a browser encoder fallback in place of the required WebP bytes', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['remote']))));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 600, height: 300, close() {} })));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['fallback'], { type: 'image/png' })),
        }) });
        const picture = { id: 'no-webp', src: { full: 'https://picture/full', thumb: 'https://picture/thumb' } };
        await expect(pictureStore.ensureBuiltin(picture)).rejects.toThrow();
        expect(await pictureStore.get('builtin:no-webp')).toBeUndefined();
    });
    it('caches a picker thumbnail from the thumb source only, reusing a full download when one exists', async () => {
        const fetchBoundary = vi.fn(async (_input: RequestInfo | URL) => new Response(new Blob(['remote thumb'])));
        vi.stubGlobal('fetch', fetchBoundary);
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 288, height: 192, close() {} })));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob: (callback: (blob: Blob) => void, mime: string) => callback(new Blob(['encoded thumb'], { type: mime })) }) });
        const picture = { id: 'thumb-only', src: { full: 'https://picture/full', thumb: 'https://picture/thumb' } };
        const [a, b] = await Promise.all([pictureStore.ensureBuiltinThumbnail(picture), pictureStore.ensureBuiltinThumbnail(picture)]);
        expect(a).toBe(b);
        const downloaded = new URL(String(fetchBoundary.mock.calls[0]?.[0]));
        expect(downloaded.searchParams.get('happier-atmosphere')).toBeTruthy();
        downloaded.searchParams.delete('happier-atmosphere');
        expect(downloaded.href).toBe(picture.src.thumb);
        expect(await (a as Blob).text()).toBe('encoded thumb');
        expect(await pictureStore.get('builtin:thumb-only')).toBeUndefined();
        await pictureStore.ensureBuiltinThumbnail(picture);
        expect(fetchBoundary.mock.calls).toHaveLength(1);
        await pictureStore.put({ localId: 'builtin:has-full', kind: 'builtin', data: new Blob(['full']), thumb: new Blob(['full thumb']), source: picture.src });
        const reused = await pictureStore.ensureBuiltinThumbnail({ id: 'has-full', src: picture.src });
        expect(await (reused as Blob).text()).toBe('full thumb');
        expect(fetchBoundary.mock.calls).toHaveLength(1);
    });
});
