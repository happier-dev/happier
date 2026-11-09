import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createBackdropWorker } from './backdropWorker.web';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

const replies: BackdropWorkerResponse[] = [];
const entry: {
    onmessage: ((event: { data: unknown }) => Promise<void>) | null;
    postMessage: (message: BackdropWorkerResponse) => void;
} = { onmessage: null, postMessage: message => { replies.push(message); } };

beforeAll(async () => {
    vi.stubGlobal('self', entry);
    await import('./atmosphere.worker');
});
beforeEach(() => {
    vi.stubGlobal('self', entry);
    entry.postMessage = message => { replies.push(message); };
    // Canvas rasterization and ImageBitmap lifetime are browser boundaries; Brand maths stays real.
    vi.stubGlobal('OffscreenCanvas', class {
        constructor(readonly width: number, readonly height: number) {}
        getContext() {
            return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(120) }) };
        }
    });
});
afterAll(() => vi.unstubAllGlobals());

const request: BackdropRenderRequest = {
    source: { localId: 'same-picture', kind: 'builtin', data: new Blob(['picture']), size: 7, createdAtMs: 1 },
    width: 1, height: 1, job: { look: 'original', theme: 'light', page: [245, 245, 245] },
};
const send = (data: unknown) => entry.onmessage!({ data });

it('decodes one held source once across concurrent render variants and closes it at its release boundary', async () => {
    replies.length = 0;
    const close = vi.fn();
    const decode = vi.fn().mockResolvedValue({ width: 2, height: 2, close });
    vi.stubGlobal('createImageBitmap', decode);
    await Promise.all([
        send({ id: 1, sourceId: 1, request }),
        send({ id: 2, sourceId: 1, request: { ...request, width: 2 } }),
    ]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(0);
    expect(replies).toEqual([
        expect.objectContaining({ id: 1, ok: true, result: expect.objectContaining({ w: 1 }) }),
        expect.objectContaining({ id: 2, ok: true, result: expect.objectContaining({ w: 2 }) }),
    ]);
    await send({ releaseSource: 1 });
    expect(close).toHaveBeenCalledTimes(1);
    await send({ id: 3, sourceId: 1, request });
    expect(decode).toHaveBeenCalledTimes(2);
    await send({ releaseSource: 1 });
    expect(close).toHaveBeenCalledTimes(2);
});

it('keeps replaced bytes under the same local id distinct and allows a new render after decoding fails', async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const decode = vi.fn().mockRejectedValueOnce(new Error('decode failed'))
        .mockResolvedValueOnce({ width: 2, height: 2, close: firstClose })
        .mockResolvedValueOnce({ width: 2, height: 2, close: secondClose });
    vi.stubGlobal('createImageBitmap', decode);
    await send({ id: 4, sourceId: 2, request });
    expect(replies.at(-1)).toMatchObject({ id: 4, ok: false, error: 'decode failed' });
    await send({ id: 5, sourceId: 2, request });
    await send({ id: 6, sourceId: 3, request: { ...request, source: { ...request.source, data: new Blob(['replacement']) } } });
    expect(decode).toHaveBeenCalledTimes(3);
    expect(replies.at(-1)).toMatchObject({ id: 6, ok: true });
    expect(firstClose).not.toHaveBeenCalled();
    await send({ releaseSource: 2 });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
    await send({ releaseSource: 3 });
    expect(secondClose).toHaveBeenCalledOnce();
});

it('closes a source retired during decode and never paints that cancelled work', async () => {
    let decoded!: (bitmap: { width: number; height: number; close: () => void }) => void;
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { decoded = resolve; })));
    const pending = send({ id: 7, sourceId: 4, request });
    await send({ releaseSource: 4 });
    decoded({ width: 2, height: 2, close });
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(replies.find(reply => reply.id === 7)).toMatchObject({ ok: false });
});

it('composes separate preview wrappers through the real worker entry with one startup and one decode per held bytes', async () => {
    const handles: WorkerBoundary[] = [];
    const deliveries: Promise<void>[] = [];
    class WorkerBoundary {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        stopped = false;
        constructor() {
            handles.push(this);
            entry.postMessage = message => this.onmessage?.({ data: message });
        }
        postMessage(message: BackdropWorkerRequest) { deliveries.push(send(structuredClone(message))); }
        terminate() { this.stopped = true; }
    }
    vi.stubGlobal('Worker', WorkerBoundary);
    const close = vi.fn();
    const decode = vi.fn().mockResolvedValue({ width: 2, height: 2, close });
    vi.stubGlobal('createImageBitmap', decode);
    const first = createBackdropWorker();
    const second = createBackdropWorker();
    try {
        await expect(Promise.all([first.render(request), second.render({ ...request, source: { ...request.source }, width: 2 })]))
            .resolves.toMatchObject([{ w: 1 }, { w: 2 }]);
        expect(handles).toHaveLength(1);
        expect(decode).toHaveBeenCalledOnce();
        first.dispose();
        expect(close).not.toHaveBeenCalled();
        await expect(second.render({ ...request, job: { ...request.job, theme: 'dark' } })).resolves.toMatchObject({ w: 1 });
        expect(decode).toHaveBeenCalledOnce();
    } finally {
        first.dispose(); second.dispose();
        await Promise.all(deliveries);
    }
    expect(close).toHaveBeenCalledOnce();
    expect(handles[0].stopped).toBe(true);
});

it('skips rasterization and pixel delivery when the current request is cancelled during decode', async () => {
    replies.length = 0;
    let finish!: (bitmap: { width: number; height: number; close(): void }) => void;
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const cancelled = send({ id: 90, sourceId: 90, request });
    await send({ cancel: 90 });
    finish({ width: 2, height: 2, close });
    await cancelled;
    expect(replies).toEqual([expect.objectContaining({ id: 90, ok: false })]);
    await send({ id: 91, sourceId: 90, request: { ...request, width: 2 } });
    expect(replies.at(-1)).toMatchObject({ id: 91, ok: true, result: { w: 2 } });
    await send({ releaseSource: 90 });
    expect(close).toHaveBeenCalledOnce();
});
