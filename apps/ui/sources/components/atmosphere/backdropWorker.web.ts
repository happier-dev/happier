import type { AtmospherePixels } from '@happier-dev/brand/atmosphere';
import type { BackdropRenderRequest, BackdropWorkerResponse } from './backdropCanvas.types';

type SourceBytes = AtmospherePixels | Blob | string;
type HeldSource = { bytes: SourceBytes; id: number; users: number };
type PendingRender = {
    request: BackdropRenderRequest;
    sourceId: number;
    owner: Set<number>;
    replacementUsed: boolean;
    resolve: (pixels: AtmospherePixels) => void;
    reject: (error: Error) => void;
};

// Physical startup belongs to the mounted canvas lifetime, not to a picture or effect variant.
let worker: Worker | null = null;
let users = 0;
let activeRequestId: number | null = null;
let requestId = 0;
let sourceId = 0;
// Preview records can wrap the same thumbnail bytes. Share decode by those held bytes.
const sources = new Map<SourceBytes, HeldSource>();
const pending = new Map<number, PendingRender>();

function dropWorker() {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
    activeRequestId = null;
}

/** Keep the lazy physical worker through source changes; the last mounted canvas releases it. */
export function retainBackdropWorker(): () => void {
    users++;
    let held = true;
    return () => {
        if (!held) return;
        held = false;
        if (--users === 0) dropWorker();
    };
}

function currentWorker(): Worker {
    if (worker) return worker;
    const created = new Worker('/happier-atmosphere-worker.js');
    worker = created;
    created.onmessage = (event: MessageEvent<BackdropWorkerResponse>) => {
        if (worker !== created) return;
        const reply = event.data;
        if (typeof reply.id !== 'number') return;
        if (reply.id !== activeRequestId) return;
        activeRequestId = null;
        const job = pending.get(reply.id);
        if (job) {
            pending.delete(reply.id);
            job.owner.delete(reply.id);
            if (reply.ok) job.resolve(reply.result); else job.reject(new Error(reply.error));
        }
        dispatch();
    };
    created.onerror = event => {
        if (worker !== created) return;
        const error = new Error(event.message || 'Atmosphere worker failed');
        const id = activeRequestId;
        const failed = id === null ? undefined : pending.get(id);
        dropWorker();
        // Only the dispatched request used this worker. Queued demand has not attempted it yet.
        if (failed && id !== null) {
            if (failed.replacementUsed) {
                pending.delete(id); failed.owner.delete(id); failed.reject(error);
            } else failed.replacementUsed = true;
        }
        dispatch();
    };
    return created;
}

/** The physical worker runs one synchronous raster at a time. Keep waiting demand cancellable here. */
function dispatch() {
    if (activeRequestId !== null) return;
    const next = pending.entries().next().value;
    if (!next) return;
    const [id, job] = next;
    try {
        const active = currentWorker();
        activeRequestId = id;
        active.postMessage({ id, sourceId: job.sourceId, request: job.request });
    } catch (error) {
        activeRequestId = null;
        pending.delete(id);
        job.owner.delete(id);
        job.reject(error instanceof Error ? error : new Error(String(error)));
        dispatch();
    }
}

function cancel(id: number, error: Error) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    job.owner.delete(id);
    job.reject(error);
    // A pending decode can stop before rasterization. Its reply releases the worker's active slot.
    if (activeRequestId === id) worker?.postMessage({ cancel: id });
}

function releaseSource(held: HeldSource) {
    if (--held.users !== 0) return;
    sources.delete(held.bytes);
    worker?.postMessage({ releaseSource: held.id });
}

/** Source-scoped demand uses one shared physical worker. No main-thread fallback. */
export function createBackdropWorker() {
    const releaseWorker = retainBackdropWorker();
    const owner = new Set<number>();
    let stopped: Error | undefined;
    let heldSource: HeldSource | undefined;
    return {
        render(request: BackdropRenderRequest, signal?: AbortSignal): Promise<AtmospherePixels> {
            if (stopped) return Promise.reject(stopped);
            if (signal?.aborted) return Promise.reject(signal.reason);
            const bytes = 'data' in request.source ? request.source.data : request.source;
            if (!heldSource || heldSource.bytes !== bytes) {
                if (heldSource) releaseSource(heldSource);
                heldSource = sources.get(bytes);
                if (!heldSource) {
                    heldSource = { bytes, id: ++sourceId, users: 0 };
                    sources.set(bytes, heldSource);
                }
                heldSource.users++;
            }
            const id = ++requestId;
            const currentSourceId = heldSource.id;
            owner.add(id);
            return new Promise((resolve, reject) => {
                const aborted = () => cancel(id, new Error('Atmosphere render cancelled'));
                const release = () => signal?.removeEventListener('abort', aborted);
                pending.set(id, { request, sourceId: currentSourceId, owner, replacementUsed: false,
                    resolve: pixels => { release(); resolve(pixels); },
                    reject: error => { release(); reject(error); },
                });
                signal?.addEventListener('abort', aborted, { once: true });
                dispatch();
            });
        },
        dispose() {
            if (stopped) return;
            stopped = new Error('Atmosphere canvas unmounted');
            for (const id of owner) {
                cancel(id, stopped);
            }
            owner.clear();
            if (heldSource) { releaseSource(heldSource); heldSource = undefined; }
            releaseWorker();
        },
    };
}
