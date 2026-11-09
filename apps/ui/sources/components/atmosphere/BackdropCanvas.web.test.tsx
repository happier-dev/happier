import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { BackdropCanvas } from './BackdropCanvas.web';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';
import { WallpaperHaze } from './WallpaperHaze.web';
import { WALLPAPER_HAZE_LAYERS } from './wallpaperHaze';
import { act } from 'react-test-renderer';

// Node does not perform Metro's .web resolution; exercise the real web paint adapter.
vi.mock('./BackdropCanvas', () => import('./BackdropCanvas.web'));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('submits one coherent frame geometry request after a cold horizon-changing resize settles', async () => {
    vi.useFakeTimers();
    const requests: BackdropRenderRequest[] = [];
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            requests.push(message.request);
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    let source = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };
    const picture = (width: number, x = 0, at = width / 20, src = 0.55) => <BackdropCanvas source={source}
        size={{ width, height: 4 }} span={{ x, y: 0, W: width * 2, H: 4 }}
        horizon={{ src, at }}
        look="original" page={[245, 245, 245]} theme="light" dpr={1} />;
    const screen = await renderScreen(picture(8), { createNodeMock: element => element.type === 'canvas'
        ? { getContext: () => ({ putImageData() {} }) } : null });
    requests.length = 0;
    await screen.update(picture(10));
    await act(async () => { vi.advanceTimersByTime(119); });
    expect(requests).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ width: 10, height: 4, horizon: { src: 0.55, at: 0.5 },
        job: { span: { x: 0, y: 0, W: 20, H: 4 } } });
    // Moving a pane crop with unchanged dimensions must also settle at the same owner.
    await screen.update(picture(10, 3));
    expect(requests).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(120); });
    expect(requests).toHaveLength(2);
    expect(requests[1].job.span?.x).toBe(3);
    // A frame can change its horizon without changing size or pane span.
    await screen.update(picture(10, 3, 0.6));
    expect(requests).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(120); });
    expect(requests).toHaveLength(3);
    expect(requests[2].horizon?.at).toBe(0.6);
    // A picture selection is a new source, whose horizon applies immediately as one snapshot.
    source = { ...source, rgba: new Uint8ClampedArray(16).fill(90) };
    await screen.update(picture(10, 3, 0.7, 0.75));
    expect(requests).toHaveLength(4);
    expect(requests[3].horizon).toEqual({ src: 0.75, at: 0.7 });
    await act(async () => { vi.advanceTimersByTime(120); });
    expect(requests).toHaveLength(4);
    await screen.unmount();
});

it.each([false, true])('replaces a crashed shared picture worker once (replacement also fails: %s)', async (replacementFails) => {
    const handles: { stopped: boolean }[] = [];
    let posts = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        stopped = false;
        readonly index = handles.length;
        constructor() { handles.push(this); }
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            posts++;
            queueMicrotask(() => {
                if (this.index === 0 || replacementFails) { this.onerror?.({ message: 'worker startup failed' }); return; }
                const { width: w, height: h } = message.request;
                this.onmessage?.({ data: { id: message.id, ok: true,
                    result: { rgba: new Uint8ClampedArray(w * h * 4).fill(125), w, h } } });
            });
        }
        terminate() { this.stopped = true; }
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const painted: unknown[] = [];
    const failed = vi.fn();
    const source = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };
    const renderGroup = {};
    const picture = (id: string) => <BackdropCanvas key={id} source={source} size={{ width: 8, height: 4 }}
        look="original" page={[245, 245, 245]} theme="light" dpr={1} renderGroup={renderGroup} onError={failed} />;
    const screen = await renderScreen(<>{picture('home')}{picture('project')}</>, { createNodeMock: element => element.type === 'canvas'
        ? { getContext: () => ({ putImageData: (pixels: unknown) => painted.push(pixels) }) } : null });
    expect(painted).toHaveLength(replacementFails ? 0 : 2);
    expect(handles).toHaveLength(2);
    expect(posts).toBe(2);
    expect(handles[0].stopped).toBe(true);
    expect(failed).toHaveBeenCalledTimes(replacementFails ? 2 : 0);
    await screen.unmount();
    expect(handles.every(handle => handle.stopped)).toBe(true);
});

it('shares current pane pixels, retires superseded variants, and releases the last projection', async () => {
    const workers: { stopped: boolean }[] = [];
    let jobs = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        stopped = false;
        constructor() { workers.push(this); }
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h, source } = message.request;
            const value = 'rgba' in source ? source.rgba[0] : 125;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4).fill(value), w, h } } }));
        }
        terminate() { this.stopped = true; }
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const painted: unknown[] = [];
    let source = { rgba: new Uint8ClampedArray(16).fill(10), w: 2, h: 2 };
    const renderGroup = {};
    const picture = (id: string, strength = 1) => <BackdropCanvas key={id} source={source} size={{ width: 8, height: 4 }}
        look="original" params={{ strength }} page={[245, 245, 245]} theme="light" dpr={1} renderGroup={renderGroup} testID={id} />;
    const screen = await renderScreen(<>{picture('home')}{picture('project')}</>, {
        createNodeMock: element => element.type === 'canvas' ? {
            getContext: () => ({ putImageData: (pixels: unknown) => painted.push(pixels) }),
        } : null,
    });
    expect(painted).toHaveLength(2);
    expect(jobs).toBe(1);
    expect(workers).toHaveLength(1);
    await screen.update(<>{picture('home', 0.5)}{picture('project', 0.5)}</>);
    expect(jobs).toBe(2);
    await screen.update(<>{picture('home')}{picture('project')}</>);
    expect(jobs).toBe(3);
    await screen.update(<>{picture('project')}</>);
    expect(workers[0].stopped).toBe(false);
    source = { ...source, rgba: new Uint8ClampedArray(16).fill(90) };
    await screen.update(<>{picture('project')}</>);
    expect(painted.at(-1)).toMatchObject({ data: new Uint8ClampedArray(8 * 4 * 4).fill(90) });
    expect(jobs).toBe(4);
    expect(workers).toHaveLength(1);
    expect(workers[0].stopped).toBe(false);
    await screen.unmount();
    expect(workers.every(worker => worker.stopped)).toBe(true);
});

it('computes one pixel render for the Wallpaper haze layers and releases their shared worker', async () => {
    const workers: { stopped: boolean }[] = [];
    let jobs = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        stopped = false;
        constructor() { workers.push(this); }
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4).fill(125), w, h } } }));
        }
        terminate() { this.stopped = true; }
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const painted: unknown[] = [];
    const onRendered = vi.fn();
    const screen = await renderScreen(<WallpaperHaze
        source={{ rgba: new Uint8ClampedArray(16), w: 2, h: 2 }}
        size={{ width: 32, height: 16 }} focus={{ x: 16, y: 8 }}
        haze={{ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' }}
        job={{ look: 'original', page: [245, 245, 245], theme: 'light', params: {},
            dissolve: null, focus: { x: 0.5, y: 0.5 }, grade: null, adjust: null }}
        onRendered={onRendered}
    />, { createNodeMock: element => element.type === 'canvas' ? {
        getContext: () => ({ putImageData: (pixels: unknown) => painted.push(pixels) }),
    } : null });
    expect(painted).toHaveLength(WALLPAPER_HAZE_LAYERS.length);
    expect(jobs).toBe(1);
    expect(workers).toHaveLength(1);
    expect(onRendered).toHaveBeenCalledTimes(1);
    await screen.unmount();
    expect(workers.every(worker => worker.stopped)).toBe(true);
});

it('retires intermediate strength requests through the real canvas lease and paints its final value', async () => {
    const requests: Extract<BackdropWorkerRequest, { request: unknown }>[] = [];
    let reply!: (data: BackdropWorkerResponse) => void;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        constructor() { reply = data => this.onmessage?.({ data }); }
        postMessage(message: BackdropWorkerRequest) { if ('request' in message) requests.push(message); }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const source = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };
    const rendered = vi.fn();
    const paints: number[] = [];
    const picture = (strength: number) => <BackdropCanvas source={source} size={{ width: 4, height: 4 }}
        look="fine" params={{ strength }} page={[245, 245, 245]} theme="light" dpr={1} onRendered={rendered} />;
    const screen = await renderScreen(picture(0), { createNodeMock: element => element.type === 'canvas'
        ? { getContext: () => ({ putImageData(image: ImageData) { paints.push(image.data[0]); } }) } : null });
    const finish = (index: number, pixel: number) => reply({ id: requests[index].id, ok: true,
        result: { rgba: new Uint8ClampedArray(64).fill(pixel), w: 4, h: 4 } });
    try {
        for (let step = 1; step <= 15; step++) await screen.update(picture(step / 15));
        expect(requests).toHaveLength(1);
        await act(async () => { finish(0, 10); });
        expect(rendered).not.toHaveBeenCalled();
        expect(paints).toEqual([]);
        expect(requests).toHaveLength(2);
        expect(requests[1].request.job.params?.strength).toBe(1);
        await act(async () => { finish(1, 200); });
        expect(rendered).toHaveBeenCalledOnce();
        expect(paints).toEqual([200]);
    } finally { await screen.unmount(); }
});
