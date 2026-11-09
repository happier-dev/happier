import { afterEach, expect, it, vi } from 'vitest';
import { createBackdropWorker } from './backdropWorker.web';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

afterEach(() => vi.unstubAllGlobals());

function workerBoundary() {
    const handles: WorkerBoundary[] = [];
    // Physical workers, error events and message delivery are the browser boundary.
    class WorkerBoundary {
        onerror: ((event: { message: string }) => void) | null = null;
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        requests: Extract<BackdropWorkerRequest, { request: unknown }>[] = [];
        released: number[] = [];
        stopped = false;
        constructor() { handles.push(this); }
        postMessage(message: BackdropWorkerRequest) {
            if ('request' in message) this.requests.push(message);
            else if ('releaseSource' in message && typeof message.releaseSource === 'number') this.released.push(message.releaseSource);
        }
        terminate() { this.stopped = true; }
        reply(index = 0) {
            const { id, request } = this.requests[index];
            this.onmessage?.({ data: { id, ok: true, result: {
                rgba: new Uint8ClampedArray(request.width * request.height * 4), w: request.width, h: request.height,
            } } });
        }
    }
    vi.stubGlobal('Worker', WorkerBoundary);
    return handles;
}

const request: BackdropRenderRequest = { source: { rgba: new Uint8ClampedArray(4), w: 1, h: 1 }, width: 1, height: 1,
    job: { look: 'original', theme: 'light', page: [245, 245, 245] } };

it('renders only the current leases after 90 superseded strength requests and paints every final canvas', async () => {
    const handles = workerBoundary();
    const blocker = createBackdropWorker();
    const canvases = Array.from({ length: 6 }, () => createBackdropWorker());
    const blocking = blocker.render(request);
    const outcomes: Promise<unknown>[] = [blocking];
    const final: Promise<unknown>[] = [];
    try {
        for (const [canvas, owner] of canvases.entries()) {
            let previous: AbortController | undefined;
            for (let step = 0; step < 15; step++) {
                previous?.abort();
                const current = new AbortController();
                const pixels = owner.render({ ...request, width: canvas + 2, job: { ...request.job, params: { strength: step / 14 } } }, current.signal);
                outcomes.push(pixels.catch(error => error));
                if (step === 14) final.push(pixels);
                previous = current;
            }
        }
        // The single physical worker is occupied. No obsolete variant crosses its boundary.
        expect(handles[0].requests).toHaveLength(1);
        handles[0].reply();
        await blocking;
        for (let canvas = 0; canvas < canvases.length; canvas++) {
            expect(handles[0].requests).toHaveLength(canvas + 2);
            expect(handles[0].requests[canvas + 1].request.job.params?.strength).toBe(1);
            handles[0].reply(canvas + 1);
        }
        await expect(Promise.all(final)).resolves.toMatchObject(canvases.map((_, index) => ({ w: index + 2 })));
        expect(handles[0].requests).toHaveLength(7);
    } finally {
        blocker.dispose();
        for (const canvas of canvases) canvas.dispose();
        await Promise.allSettled(outcomes);
    }
});

it('shares one physical worker across the measured Appearance canvas demand and routes every result', async () => {
    const handles = workerBoundary();
    // DIAG-LOOK Appearance cached run 1 mounted 28 independent render owners.
    const owners = Array.from({ length: 28 }, () => createBackdropWorker());
    const renders = owners.map((owner, index) => owner.render({ ...request, width: index + 1 }));
    const outcomes = Promise.allSettled(renders);
    try {
        expect(handles).toHaveLength(1);
        for (let index = 0; index < owners.length; index++) handles[0].reply(index);
        await expect(Promise.all(renders)).resolves.toEqual(owners.map((_, index) => expect.objectContaining({ w: index + 1 })));
        owners[0].dispose();
        expect(handles[0].stopped).toBe(false);
        const changed = owners[1].render({ ...request, width: 100 });
        handles[0].reply(owners.length);
        await expect(changed).resolves.toMatchObject({ w: 100 });
        expect(handles).toHaveLength(1);
    } finally {
        for (const owner of owners) owner.dispose();
        await outcomes;
    }
    expect(handles[0].stopped).toBe(true);
});

it('cancels only the retiring owner and replays the surviving owners together after a crash', async () => {
    const handles = workerBoundary();
    const retired = createBackdropWorker();
    const first = createBackdropWorker();
    const second = createBackdropWorker();
    const cancelled = retired.render(request).then(() => null, (error: Error) => error);
    const renders = [first.render({ ...request, width: 2 }), second.render({ ...request, width: 3 })];
    const outcomes = Promise.allSettled(renders);
    try {
        expect(handles).toHaveLength(1);
        retired.dispose();
        expect(await cancelled).toMatchObject({ message: expect.stringContaining('unmounted') });
        expect(handles[0].stopped).toBe(false);
        handles[0].reply(); // A late reply cannot settle another owner's request.
        handles[0].onerror!({ message: 'shared worker crashed' });
        expect(handles).toHaveLength(2);
        expect(handles[1].requests.map(message => message.request.width)).toEqual([2]);
        handles[1].reply(); handles[1].reply(1);
        await expect(Promise.all(renders)).resolves.toMatchObject([{ w: 2 }, { w: 3 }]);
    } finally {
        retired.dispose(); first.dispose(); second.dispose();
        await outcomes;
    }
    expect(handles.every(handle => handle.stopped)).toBe(true);
});

it('shares source identity until its last owner retires and keeps replacement bytes distinct', async () => {
    const handles = workerBoundary();
    const first = createBackdropWorker();
    const second = createBackdropWorker();
    const renders = [first.render(request), second.render(request)];
    const outcomes = Promise.allSettled(renders);
    try {
        expect(handles).toHaveLength(1);
        const sourceId = handles[0].requests[0].sourceId;
        expect(sourceId).toEqual(expect.any(Number));
        handles[0].reply();
        expect(handles[0].requests[1].sourceId).toBe(sourceId);
        handles[0].reply(1);
        await Promise.all(renders);
        first.dispose();
        expect(handles[0].released).toEqual([]);
        const changed = second.render({ ...request, source: { ...request.source } });
        expect(handles[0].requests[2].sourceId).not.toBe(sourceId);
        expect(handles[0].released).toEqual([sourceId]);
        handles[0].reply(2);
        await changed;
    } finally {
        first.dispose(); second.dispose();
        await outcomes;
    }
    expect(handles[0].released).toHaveLength(2);
});

it('replays failed in-flight demand on one fresh worker and reuses it for later demand', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const first = worker.render(request);
    const second = worker.render({ ...request, width: 2 });
    // Observe both outcomes even when the assertion below catches a missing replacement first.
    const outcomes = Promise.allSettled([first, second]);
    handles[0].onerror!({ message: 'worker crashed' });
    expect(handles).toHaveLength(2);
    expect(handles[0].stopped).toBe(true);
    expect(handles[1].requests.map(message => message.request)).toEqual([request]);
    expect(handles[1].requests[0].sourceId).toBe(handles[0].requests[0].sourceId);
    handles[1].reply();
    expect(handles[1].requests[1].request).toEqual({ ...request, width: 2 });
    handles[1].reply(1);
    await expect(first).resolves.toMatchObject({ w: 1, h: 1 });
    await expect(second).resolves.toMatchObject({ w: 2, h: 1 });
    expect((await outcomes).every(outcome => outcome.status === 'fulfilled')).toBe(true);
    const next = worker.render(request);
    handles[1].reply(2);
    await expect(next).resolves.toMatchObject({ w: 1 });
    expect(handles).toHaveLength(2);
    worker.dispose();
    expect(handles[1].released).toEqual([handles[0].requests[0].sourceId]);
});

it('settles a failed replacement without further attempts and admits subsequent new demand', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const outcome = worker.render(request).then(() => null, (error: Error) => error);
    handles[0].onerror!({ message: 'initial crash' });
    expect(handles).toHaveLength(2);
    handles[1].onerror!({ message: 'replacement crashed' });
    expect(await outcome).toMatchObject({ message: 'replacement crashed' });
    expect(handles).toHaveLength(2);
    expect(handles.every(handle => handle.stopped)).toBe(true);
    const next = worker.render(request);
    expect(handles).toHaveLength(3);
    handles[2].reply();
    await expect(next).resolves.toMatchObject({ w: 1 });
    worker.dispose();
});

it('does not retry a replied render error or discard its healthy worker', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const failure = expect(worker.render(request)).rejects.toThrow('decode failed');
    handles[0].onmessage!({ data: { id: handles[0].requests[0].id, ok: false, error: 'decode failed' } });
    await failure;
    expect(handles).toHaveLength(1);
    expect(handles[0].requests).toHaveLength(1);
    expect(handles[0].stopped).toBe(false);
    const next = worker.render(request);
    handles[0].reply(1);
    await expect(next).resolves.toMatchObject({ w: 1 });
    worker.dispose();
});

it('keeps disposal terminal even if a queued crash callback arrives afterwards', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const failure = expect(worker.render(request)).rejects.toThrow('unmounted');
    const lateError = handles[0].onerror;
    worker.dispose();
    lateError?.({ message: 'late crash' });
    await failure;
    await expect(worker.render(request)).rejects.toThrow('unmounted');
    expect(handles).toHaveLength(1);
});

it('replies ok:false for asynchronous decoding rejection and synchronous Brand render failure', async () => {
    const replies: BackdropWorkerResponse[] = [];
    const entry: {
        onmessage: ((event: { data: BackdropWorkerRequest }) => Promise<void>) | null;
        postMessage: (message: BackdropWorkerResponse) => void;
    } = { onmessage: null, postMessage: message => { replies.push(message); } };
    vi.stubGlobal('self', entry);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    await import('./atmosphere.worker');
    await expect(entry.onmessage!({ data: { id: 1, sourceId: 1, request: { ...request, source: {
        localId: 'entry-decode', kind: 'builtin', data: new Blob(['picture']), size: 7, createdAtMs: 1,
    } } } })).resolves.toBeUndefined();
    // A negative source dimension reaches the real Brand allocation and raises RangeError.
    await expect(entry.onmessage!({ data: { id: 2, job: { ...request.job,
        source: { rgba: new Uint8ClampedArray(4), w: -1, h: 1 }, grade: null,
    } } })).resolves.toBeUndefined();
    expect(replies).toEqual([
        expect.objectContaining({ id: 1, ok: false, error: 'decode failed' }),
        expect.objectContaining({ id: 2, ok: false, error: expect.any(String) }),
    ]);
});
