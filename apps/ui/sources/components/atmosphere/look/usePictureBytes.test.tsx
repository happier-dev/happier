import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { pictureStore } from '../pictureStore.web';
import { useBuiltinThumbnail, useStoredPicture, useUserPictures } from './usePictureBytes';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';

// Exercise the real browser persistence adapter instead of Node's native platform default.
vi.mock('../pictureStore', () => import('../pictureStore.web'));

it('keeps user picture readers and the user library asleep during builtin thumbnail writes', async () => {
    const localId = 'picker-locality-user';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['user pixels']) });
    let current: { stored: ReturnType<typeof useStoredPicture>; users: ReturnType<typeof useUserPictures> } | undefined;
    function Probe() {
        current = { stored: useStoredPicture(localId), users: useUserPictures() };
        return null;
    }
    const screen = await renderScreen(<Probe />);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    try {
        await vi.waitFor(() => expect(current?.stored.status).toBe('present'));
        await vi.waitFor(() => expect(current?.users.some(value => value.localId === localId)).toBe(true));
        get.mockClear(); cursor.mockClear();
        for (let index = 0; index < 19; index++) {
            await act(async () => { await pictureStore.put({ localId: `builtin-thumb:picker-locality-${index}`,
                kind: 'builtin', data: new Blob(['thumbnail']) }); });
        }
        expect(get.mock.calls.filter(([id]) => id === localId)).toHaveLength(0);
        expect(cursor).toHaveBeenCalledTimes(0);
        await act(async () => { await pictureStore.remove(localId); });
        await vi.waitFor(() => expect(current?.stored.status).toBe('missing'));
        await vi.waitFor(() => expect(current?.users.some(value => value.localId === localId)).toBe(false));
    } finally {
        get.mockRestore(); cursor.mockRestore();
        await screen.unmount();
        await pictureStore.remove(localId);
        for (let index = 0; index < 19; index++) await pictureStore.remove(`builtin-thumb:picker-locality-${index}`);
    }
});


it('settles failed gallery thumbnails independently, stays quiet, and retries on the next visit', async () => {
    // HTTP, image decoding and browser encoding are the boundaries; acquisition and persistence are real.
    let offline = true;
    const failedSources = new Set(ATMOSPHERE_PICTURES.slice(0, 5).map(picture => picture.src.thumb));
    const fetchPicture = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        url.searchParams.delete('happier-atmosphere');
        return new Response(new Blob([url.pathname]), { status: offline && failedSources.has(url.href) ? 503 : 200 });
    });
    vi.stubGlobal('fetch', fetchPicture);
    vi.stubGlobal('createImageBitmap', async () => ({ width: 288, height: 192, close() {} }));
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
        getContext: () => ({ drawImage() {} }),
        toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob(['pixels'], { type })),
    }) });
    const pictures = ATMOSPHERE_PICTURES.map(picture => ({ ...picture, id: 'fx17-gallery:' + picture.id }));
    const results = new Map<string, ReturnType<typeof useBuiltinThumbnail>>();
    function Tile({ index }: { index: number }) {
        const picture = pictures[index]!;
        results.set(picture.id, useBuiltinThumbnail({ ...picture }));
        return null;
    }
    function Gallery({ revision }: { revision: number }) {
        return <React.Fragment key={revision}>{pictures.map((picture, index) => <Tile key={picture.id} index={index} />)}</React.Fragment>;
    }
    const screen = await renderScreen(<Gallery revision={0} />);
    try {
        await vi.waitFor(() => expect(fetchPicture).toHaveBeenCalledTimes(19));
        await vi.waitFor(() => expect([...results.values()].map(value => value.status)).toEqual(
            pictures.map((_, index) => index < 5 ? 'failed' : 'present')));
        await screen.update(<Gallery revision={0} />);
        expect(fetchPicture).toHaveBeenCalledTimes(19);
        offline = false;
        await screen.update(<Gallery revision={1} />);
        await vi.waitFor(() => expect([...results.values()].every(value => value?.status === 'present')).toBe(true));
        expect(fetchPicture).toHaveBeenCalledTimes(24);
    } finally {
        await screen.unmount();
        vi.unstubAllGlobals();
        for (const picture of pictures) await pictureStore.remove('builtin-thumb:' + picture.id);
    }
});
