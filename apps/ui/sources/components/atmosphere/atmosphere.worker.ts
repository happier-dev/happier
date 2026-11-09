import { cropOf, backdropBandGrade, renderBackdrop, type AtmosphereGrade, type AtmospherePixels } from '@happier-dev/brand/atmosphere';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

// This file is bundled as a dedicated public worker; it is never imported by the UI.
const worker = self as unknown as {
    onmessage: ((event: MessageEvent<BackdropWorkerRequest>) => void) | null;
    postMessage: (message: BackdropWorkerResponse, transfer?: Transferable[]) => void;
};

/** The grade's horizon row in the cropped band (lab `compute`). */
function bandGrade(request: BackdropRenderRequest, source: { w: number; h: number }) {
    const grade = request.job.grade;
    const crop = cropOf(source, request.job.span?.W ?? request.width, request.job.span?.H ?? request.height, request.focus, request.horizon);
    return backdropBandGrade(grade, crop, request.horizon);
}

// A decoded source lives only while its renderer owners consume it. Concurrent variants join decode.
const sources = new Map<number, Promise<ImageBitmap>>();
function decodedSource(sourceId: number, source: BackdropRenderRequest['source']) {
    let decoding = sources.get(sourceId);
    if (!decoding) {
        decoding = 'rgba' in source
            ? createImageBitmap(new ImageData(new Uint8ClampedArray(source.rgba), source.w, source.h))
            : (async () => createImageBitmap(typeof source.data === 'string' ? await (await fetch(source.data)).blob() : source.data))();
        sources.set(sourceId, decoding);
        const started = decoding;
        void started.catch(() => { if (sources.get(sourceId) === started) sources.delete(sourceId); });
    }
    return decoding;
}

async function sourcePixels(request: BackdropRenderRequest, sourceId: number, signal: AbortSignal): Promise<Readonly<{ pixels: AtmospherePixels; grade: AtmosphereGrade | null | undefined }>> {
    const source = request.source;
    if ('rgba' in source && source.w === request.width && source.h === request.height) return { pixels: source, grade: bandGrade(request, source) };
    const decoding = decodedSource(sourceId, source);
    const bitmap = await decoding;
    signal.throwIfAborted();
    if (sources.get(sourceId) !== decoding) throw new Error('Atmosphere source released');
    const crop = cropOf({ w: bitmap.width, h: bitmap.height }, request.job.span?.W ?? request.width,
        request.job.span?.H ?? request.height, request.focus, request.horizon);
    const canvas = new OffscreenCanvas(request.width, request.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Atmosphere source canvas is unavailable');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, crop.sx + (request.job.span?.x ?? 0) / crop.s, crop.sy + (request.job.span?.y ?? 0) / crop.s,
        request.width / crop.s, request.height / crop.s, 0, 0, request.width, request.height);
    return { pixels: { rgba: context.getImageData(0, 0, request.width, request.height).data, w: request.width, h: request.height },
        grade: bandGrade(request, { w: bitmap.width, h: bitmap.height }) };
}

// Cancellation can arrive while decoding yields; synchronous Brand work runs to completion.
const running = new Map<string | number, AbortController>();
worker.onmessage = async event => {
    const message = event.data;
    if ('cancel' in message) { running.get(message.cancel)?.abort(); return; }
    if ('releaseSource' in message) {
        const decoding = sources.get(message.releaseSource);
        sources.delete(message.releaseSource);
        if (decoding) void decoding.then(bitmap => bitmap.close(), () => {});
        return;
    }
    const controller = new AbortController();
    running.set(message.id, controller);
    try {
        let job;
        if ('job' in message) job = message.job;
        else { const { pixels, grade } = await sourcePixels(message.request, message.sourceId, controller.signal); job = { ...message.request.job, grade, source: pixels }; }
        controller.signal.throwIfAborted();
        const result = renderBackdrop(job);
        worker.postMessage({ id: message.id, ok: true, result }, [result.rgba.buffer]);
    } catch (error) {
        worker.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally { running.delete(message.id); }
};
