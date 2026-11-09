import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/atmosphere/pictureStore', async () => import('./pictureStore.native'));

const boundary = vi.hoisted(() => ({
    files: new Map<string, Uint8Array>(),
    directories: new Set<string>(),
    decodeFails: false,
    encodeFails: false,
    runtimeJobs: 0,
    infoReads: 0,
    infoProbes: 0,
    pictureProbes: 0,
}));

// The native filesystem, Skia handles and worker runtime are unavailable in Node.
// Domain storage, download coordination and image dimensions remain real below these boundaries.
vi.mock('expo-file-system', () => {
    const path = (parts: (string | { uri: string })[]) => parts.map((part, index) => {
        const uri = typeof part === 'string' ? part : part.uri;
        return index === 0 ? uri.replace(/\/+$/, '') : uri.replace(/^\/+|\/+$/g, '');
    }).join('/');
    class File {
        uri: string;
        constructor(...parts: (string | { uri: string })[]) { this.uri = path(parts); }
        get exists() { if (this.uri.endsWith('/info.json')) boundary.infoProbes++; if (this.uri.endsWith('/full.image') || this.uri.endsWith('/thumb.image')) boundary.pictureProbes++; return boundary.files.has(this.uri); }
        get size() { return boundary.files.get(this.uri)?.byteLength ?? 0; }
        async text() { if (this.uri.endsWith('/info.json')) boundary.infoReads++; return new TextDecoder().decode(await this.bytes()); }
        async base64() { return Buffer.from(await this.bytes()).toString('base64'); }
        async bytes() {
            const bytes = boundary.files.get(this.uri);
            if (!bytes) throw new Error('File missing');
            return bytes.slice();
        }
        write(content: string | Uint8Array, options?: { encoding: string }) { boundary.files.set(this.uri, typeof content === 'string' ? options?.encoding === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : new TextEncoder().encode(content) : content.slice()); }
        copy(destination: File) {
            const bytes = boundary.files.get(this.uri);
            if (!bytes) throw new Error('File missing');
            boundary.files.set(destination.uri, bytes.slice());
        }
        delete() { boundary.files.delete(this.uri); }
    }
    class Directory {
        uri: string;
        constructor(...parts: (string | { uri: string })[]) { this.uri = path(parts); }
        get exists() { return boundary.directories.has(this.uri); }
        create(options?: { intermediates: boolean }) {
            boundary.directories.add(this.uri);
            if (options?.intermediates) {
                const parts = this.uri.split('/');
                for (let index = 4; index < parts.length; index += 1) boundary.directories.add(parts.slice(0, index).join('/'));
            }
        }
        delete() {
            for (const uri of boundary.files.keys()) if (uri.startsWith(`${this.uri}/`)) boundary.files.delete(uri);
            for (const uri of boundary.directories) if (uri === this.uri || uri.startsWith(`${this.uri}/`)) boundary.directories.delete(uri);
        }
        list() {
            return [...boundary.directories].filter((uri) => uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes('/')).map((uri) => new Directory(uri));
        }
    }
    return { Directory, File, Paths: { document: new Directory('file:///documents') } };
});

vi.mock('react-native-worklets', () => ({
    createWorkletRuntime: () => ({ name: 'test-native-worker' }),
    runOnRuntimeAsync: async <Args extends unknown[], Result>(_runtime: unknown, job: (...args: Args) => Result, ...args: Args) => {
        boundary.runtimeJobs += 1;
        return job(...args);
    },
}));

vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    ImageFormat: { WEBP: 6, PNG: 4 },
    Skia: {
        Data: { fromBase64: (base64: string) => ({ bytes: new Uint8Array(Buffer.from(base64, 'base64')), dispose() {} }) },
        Image: { MakeImageFromEncoded: (data: { bytes: Uint8Array }) => boundary.decodeFails ? null : ({
            width: () => data.bytes[0] === 2 ? 288 : 5120,
            height: () => data.bytes[0] === 2 ? 144 : 1280,
            dispose() {},
        }) },
        XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
        Surface: { Make: (width: number, height: number) => ({
            getCanvas: () => ({ drawImageRectOptions() {} }),
            flush() {},
            makeImageSnapshot: () => ({
                // The native Skia encoder can return null despite its TS declaration.
                encodeToBase64: (format: number, quality: number) => boundary.encodeFails ? null : Buffer.from(JSON.stringify({ format, quality, width, height })).toString('base64'),
                dispose() {},
            }),
            dispose() {},
        }) },
    },
}));

async function openStore() {
    vi.resetModules();
    return (await import('./pictureStore.native')).pictureStore;
}

beforeEach(() => {
    boundary.files.clear();
    boundary.directories.clear();
    boundary.decodeFails = false;
    boundary.encodeFails = false;
    boundary.runtimeJobs = 0;
    boundary.infoReads = 0;
    boundary.infoProbes = 0;
    boundary.pictureProbes = 0;
    vi.unstubAllGlobals();
    vi.stubGlobal('FileReader', class {
        result: string | null = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(blob: Blob) {
            blob.arrayBuffer().then((bytes) => {
                this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
                this.onload?.();
            }).catch((error: Error) => { this.error = error; this.onerror?.(); });
        }
    });
});

describe('native picture store', () => {
    it('reads each metadata file once and checks bytes only for the requested kind', async () => {
        const store = await openStore();
        await store.put({ localId: 'kind-user', kind: 'user', data: 'data:image/webp;base64,AQID' });
        for (let index = 0; index < 20; index++) await store.put({ localId: `kind-builtin-${index}`, kind: 'builtin', data: 'data:image/webp;base64,AQID' });
        boundary.infoReads = 0; boundary.pictureProbes = 0;
        expect(await store.list('user')).toEqual([expect.objectContaining({ localId: 'kind-user' })]);
        expect(boundary.infoReads).toBe(21);
        expect(boundary.pictureProbes).toBe(1);
        expect(await store.list()).toHaveLength(21);
    });
    it('shares one physical exact-id read and record across concurrent display consumers', async () => {
        const store = await openStore();
        await store.put({ localId: 'concurrent-display', kind: 'user', data: 'data:image/webp;base64,AQID' });
        boundary.infoReads = 0;
        boundary.pictureProbes = 0;
        const records = await Promise.all(Array.from({ length: 24 }, () => store.get('concurrent-display')));
        expect(boundary.infoReads).toBe(1);
        expect(boundary.pictureProbes).toBe(1);
        expect(records.every(record => record === records[0])).toBe(true);
        await store.put({ localId: 'concurrent-display', kind: 'user', data: 'data:image/webp;base64,BAUG' });
        expect(await store.get('concurrent-display')).not.toBe(records[0]);
        await store.remove('concurrent-display');
        expect(await store.get('concurrent-display')).toBeUndefined();
    });
    it('shares thumbnail fallback reads and replaces them with the available full record', async () => {
        const store = await openStore();
        const fullId = 'builtin:thumbnail-display';
        const thumbnailId = 'builtin-thumb:thumbnail-display';
        await store.put({ localId: thumbnailId, kind: 'builtin', data: 'data:image/webp;base64,AQID' });
        boundary.infoReads = 0;
        boundary.infoProbes = 0;
        boundary.pictureProbes = 0;
        const first = await Promise.all(Array.from({ length: 24 }, () => store.get(fullId, thumbnailId)));
        expect(first.every(record => record === first[0] && record?.localId === thumbnailId)).toBe(true);
        expect(boundary.infoProbes).toBe(2);
        expect(boundary.infoReads).toBe(1);
        expect(boundary.pictureProbes).toBe(1);
        await store.put({ localId: fullId, kind: 'builtin', data: 'data:image/webp;base64,BAUG' });
        boundary.infoReads = 0;
        boundary.infoProbes = 0;
        boundary.pictureProbes = 0;
        const next = await Promise.all(Array.from({ length: 24 }, () => store.get(fullId, thumbnailId)));
        expect(next.every(record => record === next[0] && record?.localId === fullId)).toBe(true);
        expect(boundary.infoProbes).toBe(1);
        expect(boundary.infoReads).toBe(1);
        expect(boundary.pictureProbes).toBe(1);
    });
    it('does not wake a selected-picture reader when another picture changes', async () => {
        const store = await openStore();
        const selected = vi.fn();
        const users = vi.fn();
        const stop = store.subscribe(selected, 'selected-cost');
        const stopUsers = store.subscribe(users, { kind: 'user' });
        try {
            for (let index = 0; index < 20; index += 1) {
                await store.put({ localId: `unrelated-${index}`, kind: 'builtin', data: 'data:image/webp;base64,AQID' });
            }
            expect(selected).toHaveBeenCalledTimes(0);
            expect(users).toHaveBeenCalledTimes(0);
            expect(store.getRevision('user')).toBe(0);
            await store.put({ localId: 'selected-cost', kind: 'user', data: 'data:image/webp;base64,AQID' });
            expect(users).toHaveBeenCalledTimes(1);
            await store.put({ localId: 'selected-cost', kind: 'builtin', data: 'data:image/webp;base64,AQID' });
            expect(users).toHaveBeenCalledTimes(2);
            await store.remove('selected-cost');
            expect(selected).toHaveBeenCalledTimes(3);
            expect(users).toHaveBeenCalledTimes(2);
        } finally { stop(); stopUsers(); }
    });
    it('prepares a PNG review copy on the native worker without changing device custody', async () => {
        boundary.files.set('file:///picker/review.webp', new Uint8Array([1, 2, 3]));
        const store = await openStore();
        const revision = store.getRevision();
        const result = await store.prepare('file:///picker/review.webp', { format: 'png' });
        expect(result).toMatch(/^data:image\/png;base64,/);
        if (typeof result !== 'string') throw new Error('Expected a native PNG data URL');
        expect(JSON.parse(Buffer.from(result.split(',')[1]!, 'base64').toString())).toEqual({
            format: 4, quality: 86, width: 2560, height: 640,
        });
        expect(store.getRevision()).toBe(revision);
        expect(await store.list()).toEqual([]);
        expect([...boundary.files.keys()]).toEqual(['file:///picker/review.webp']);
    });
    it('prepares picked JPEG bytes once through the real user ingress and persists the worker WebP', async () => {
        boundary.files.set('file:///picker/large.jpeg', new Uint8Array([1, 255, 4, 6]));
        const store = await openStore();
        const { storeUserAtmospherePicture } = await import('./atmosphereSettings');
        const id = await storeUserAtmospherePicture('file:///picker/large.jpeg');
        const stored = await store.get(id);
        expect(JSON.parse(new TextDecoder().decode(boundary.files.get(String(stored?.data))))).toEqual({ format: 6, quality: 86, width: 2560, height: 640 });
        expect(boundary.runtimeJobs).toBe(1);
        expect(await (await openStore()).get(id)).toEqual(stored);
        await store.remove(id);
        expect([...boundary.files.keys()]).toEqual(['file:///picker/large.jpeg']);
    });
    it('keeps user bytes and metadata across store reloads and removes only owned bytes', async () => {
        boundary.files.set('file:///picker/photo.jpeg', new Uint8Array([0, 255, 4, 6]));
        const store = await openStore();
        const listener = vi.fn();
        store.subscribe(listener);
        const record = await store.put({ localId: '../my/photo', kind: 'user', data: 'file:///picker/photo.jpeg', thumb: new Blob([new Uint8Array([9, 8])]) });
        expect(record).toMatchObject({ localId: '../my/photo', kind: 'user', size: 6 });
        expect(record.data).toMatch(/^file:\/\/\/documents\/atmosphere\//);
        expect(boundary.files.get(String(record.data))).toEqual(new Uint8Array([0, 255, 4, 6]));
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getRevision()).toBe(1);
        const reopened = await openStore();
        expect(await reopened.get('../my/photo')).toEqual(record);
        expect(await reopened.list()).toEqual([{ localId: record.localId, kind: 'user', createdAtMs: record.createdAtMs, size: 6 }]);
        await reopened.remove('../my/photo');
        expect(await reopened.get('../my/photo')).toBeUndefined();
        expect(await reopened.list()).toEqual([]);
        expect([...boundary.files.keys()]).toEqual(['file:///picker/photo.jpeg']);
    });

    it('fetches full and thumb once, persists bounded WebP images and reuses them after reload', async () => {
        const fetch = vi.fn(async (url: string) => new Response(new Uint8Array([url.endsWith('/thumb') ? 2 : 1])));
        vi.stubGlobal('fetch', fetch);
        const store = await openStore();
        const picture = { id: 'ocean', src: { full: 'https://pictures/full', thumb: 'https://pictures/thumb' } };
        const [first, second] = await Promise.all([store.ensureBuiltin(picture), store.ensureBuiltin(picture)]);
        expect(second).toEqual(first);
        expect(first.localId).toBe('builtin:ocean');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(new TextDecoder().decode(boundary.files.get(String(first.data))))).toEqual({ format: 6, quality: 86, width: 2560, height: 640 });
        expect(JSON.parse(new TextDecoder().decode(boundary.files.get(String(first.thumb))))).toEqual({ format: 6, quality: 86, width: 288, height: 144 });
        expect(boundary.runtimeJobs).toBe(2);
        expect(await (await openStore()).ensureBuiltin(picture)).toEqual(first);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('leaves failures uncached and retries on the next visit', async () => {
        const fetch = vi.fn(async () => new Response(new Uint8Array([1])));
        vi.stubGlobal('fetch', fetch);
        const store = await openStore();
        const picture = { id: 'bad', src: { full: 'https://pictures/full', thumb: 'https://pictures/thumb' } };
        boundary.decodeFails = true;
        await expect(store.ensureBuiltin(picture)).rejects.toThrow();
        expect(await store.list()).toEqual([]);
        boundary.decodeFails = false;
        expect(await store.ensureBuiltin(picture)).toMatchObject({ kind: 'builtin' });
    });

    it('does not cache corrupt bytes when the native encoder returns null', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
        boundary.encodeFails = true;
        const store = await openStore();
        const picture = { id: 'encoding-failure', src: { full: 'https://pictures/full', thumb: 'https://pictures/thumb' } };
        await expect(store.ensureBuiltin(picture)).rejects.toThrow();
        expect(await store.get('builtin:encoding-failure')).toBeUndefined();
        expect(await store.list()).toEqual([]);
    });
});
