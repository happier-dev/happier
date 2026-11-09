import { describe, expect, it, vi } from 'vitest';
import { createBuiltinPictureAcquisition } from './ensureBuiltinPicture';
import type { PictureInput, PictureRecord } from './pictureStore.types';

// Persistence and HTTP are the boundaries; the download/reuse decisions run unchanged.
function harness() {
    const records = new Map<string, PictureRecord>();
    const store = {
        get: async (id: string) => records.get(id),
        put: async (input: PictureInput): Promise<PictureRecord> => {
            const record = { ...input, createdAtMs: 1, size: 1 };
            records.set(input.localId, record); return record;
        },
    };
    const fetchPicture = vi.fn(async (url: string) => new Response(new Blob([url])));
    const prepare = async (data: Blob | string) => data;
    return { records, store, fetchPicture, prepare,
        full: () => createBuiltinPictureAcquisition(store, prepare, fetchPicture).ensureBuiltin,
        thumb: () => createBuiltinPictureAcquisition(store, prepare, fetchPicture).ensureBuiltinThumbnail };
}
const old = { id: 'com.acme/sky', src: { full: 'https://images/old-full', thumb: 'https://images/old-thumb' } };
const updated = { ...old, src: { full: 'https://images/new-full', thumb: 'https://images/new-thumb' } };
async function bytes(data: Blob | string) { return typeof data === 'string' ? data : data.text(); }

describe('source-aware picture reuse', () => {
    it('reuses matching sources after reload but refreshes a stable id when its sources change', async () => {
        const h = harness();
        const first = await h.full()(old);
        expect(await h.full()(old)).toBe(first);
        expect(h.fetchPicture).toHaveBeenCalledTimes(2);
        const next = await h.full()(updated);
        expect(await bytes(next.data)).toBe(updated.src.full);
        expect(await bytes(next.thumb!)).toBe(updated.src.thumb);
        expect(next.localId).toBe(first.localId);
        expect(h.fetchPicture).toHaveBeenCalledTimes(4);
    });
    it('persists the small thumbnail before starting the full download, sharing both acquisitions', async () => {
        const h = harness();
        let release!: (response: Response) => void;
        const full = new Promise<Response>(resolve => { release = resolve; });
        const fetchPicture = vi.fn(async (url: string) => {
            if (url === old.src.full) {
                expect(h.records.has('builtin-thumb:' + old.id)).toBe(true);
                return full;
            }
            return new Response(new Blob([url]));
        });
        const acquisition = createBuiltinPictureAcquisition(h.store, h.prepare, fetchPicture);
        const first = acquisition.ensureBuiltin(old);
        const second = acquisition.ensureBuiltin(old);
        const settled = Promise.allSettled([first, second]);
        await vi.waitFor(() => expect(fetchPicture).toHaveBeenCalledWith(old.src.full));
        expect(fetchPicture.mock.calls.map(([url]) => url)).toEqual([old.src.thumb, old.src.full]);
        expect(h.records.has('builtin:' + old.id)).toBe(false);
        release(new Response(new Blob(['full'])));
        await settled;
        expect(await first).toBe(await second);
        expect(fetchPicture).toHaveBeenCalledTimes(2);
    });
    it('rejects stale full thumbnails and standalone thumbnails and reuses current ones', async () => {
        const h = harness();
        await h.full()(old);
        expect(await bytes(await h.thumb()(updated))).toBe(updated.src.thumb);
        expect(await bytes(await h.thumb()(updated))).toBe(updated.src.thumb);
        expect(h.fetchPicture).toHaveBeenCalledTimes(3);
        await h.full()(updated);
        expect(await bytes(await h.thumb()(updated))).toBe(updated.src.thumb);
        expect(h.fetchPicture).toHaveBeenCalledTimes(4);
    });
    it('does not coalesce a changed source with the pending previous source or let its late completion overwrite it', async () => {
        const h = harness();
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        const fetchPicture = async (url: string) => {
            if (url.includes('old-')) await wait;
            return new Response(new Blob([url]));
        };
        const ensure = createBuiltinPictureAcquisition(h.store, h.prepare, fetchPicture).ensureBuiltin;
        const previous = ensure(old);
        const next = ensure(updated);
        release();
        expect(await bytes((await next).data)).toBe(updated.src.full);
        await previous;
        expect(await bytes((await ensure(updated)).data)).toBe(updated.src.full);
    });
});
