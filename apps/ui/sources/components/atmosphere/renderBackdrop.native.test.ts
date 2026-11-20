import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createAtmosphereTransition, orderedFade, renderBackdrop, type AtmosphereBackdropJob } from '@happier-dev/brand/atmosphere';
import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import { orderedDissolve } from './orderedDissolve';
import type { BackdropRenderRequest } from './backdropCanvas.types';
import type { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';
import './renderBackdrop.native';
import type { NativeBackdropRender } from './renderBackdrop.native';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ PixelRatio: { get: () => 2 } }));
vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));

const boundary = vi.hoisted(() => ({
    fs: null as ReturnType<typeof createExpoFileSystemFileMock> | null,
    encodeFails: false,
    release: null as (() => void) | null,
    pause: null as Promise<void> | null,
    readPause: null as Promise<void> | null,
    sourceReads: 0,
    writes: 0,
    runtimeEntered: 0,
}));

// Native file custody, Skia codec handles and Worklets scheduling are genuine boundaries.
// Canonical crop, effects, keying, pending coordination and cache reads/writes stay real.
vi.mock('expo-file-system', async () => {
    boundary.fs = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    const base = boundary.fs.module;
    const path = (parts: (string | { uri: string })[]) => parts.map((part, index) => {
        const value = typeof part === 'string' ? part : part.uri;
        return index ? value.replace(/^\/+|\/+$/g, '') : value.replace(/\/+$/, '');
    }).join('/');
    class Directory extends base.Directory {
        constructor(...parts: (string | { uri: string })[]) { super(path(parts)); }
    }
    class File extends base.File {
        constructor(...parts: (string | { uri: string })[]) { super(path(parts)); }
        get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))); }
        async base64() { boundary.sourceReads++; if (boundary.readPause) await boundary.readPause; return Buffer.from(await this.bytes()).toString('base64'); }
        override write(content: string | Uint8Array, options?: { encoding?: string; append?: boolean }) {
            boundary.writes++;
            super.write(typeof content === 'string' && options?.encoding === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : content, options);
        }
    }
    return { Directory, File, Paths: { document: new Directory('file:///documents') } };
});

vi.mock('react-native-worklets', () => ({
    createWorkletRuntime: () => ({ name: 'native-render-test' }),
    runOnRuntimeAsync: async <Args extends unknown[], Result>(_runtime: unknown, job: (...args: Args) => Result, ...args: Args) => {
        boundary.runtimeEntered++;
        if (boundary.pause) await boundary.pause;
        return job(...args);
    },
}));

vi.mock('@shopify/react-native-skia', async () => {
    const data = (bytes: Uint8Array) => ({ bytes, dispose() {} });
    const image = (bytes: Uint8Array, width: number, height: number) => ({
        width: () => width, height: () => height, dispose() {},
        // The codec is unavailable in Node; inspect the exact RGBA fed to its PNG boundary.
        encodeToBase64: (format: string) => boundary.encodeFails ? null
            : Buffer.from(JSON.stringify({ format, width, height, rgba: Array.from(bytes) })).toString('base64'),
        readPixels: () => bytes,
    });
    let sampled: Uint8Array = new Uint8Array();
    return {
        ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
        AlphaType: { Unpremul: 1 }, ColorType: { RGBA_8888: 4 }, FilterMode: { Linear: 1 }, MipmapMode: { None: 0 }, ImageFormat: { PNG: 'PNG' },
        Skia: {
            Data: { fromBytes: data, fromBase64: (encoded: string) => data(new Uint8Array(Buffer.from(encoded, 'base64'))) },
            Image: {
                MakeImage: (info: { width: number; height: number }, input: ReturnType<typeof data>) => image(input.bytes, info.width, info.height),
                MakeImageFromEncoded: (input: ReturnType<typeof data>) => { sampled = input.bytes; return image(input.bytes, 2, 2); },
            },
            XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
            Surface: { Make: (width: number, height: number) => ({
                getCanvas: () => ({ drawImageRectOptions() {} }), flush() {}, dispose() {},
                makeImageSnapshot: () => image(sampled, width, height),
            }) },
        },
    };
});

const source = { rgba: new Uint8ClampedArray([42, 84, 126, 255, 100, 50, 25, 255, 20, 40, 80, 255, 160, 180, 200, 255]), w: 2, h: 2 };
const job = { look: 'original', theme: 'light', page: [245, 245, 245], dissolve: { style: 'ordered', from: 0, to: 1 } } satisfies Omit<AtmosphereBackdropJob, 'source'>;
const request: BackdropRenderRequest = { source, width: 2, height: 2, job };
const held = new Set<NativeBackdropRender>();
async function render(request: BackdropRenderRequest) {
    const lease = (await import('./renderBackdrop.native')).acquireNativeBackdrop(request);
    held.add(lease);
    return lease.promise;
}
afterEach(() => { for (const lease of held) lease.release(); held.clear(); });

beforeEach(() => { boundary.fs!.files.clear(); boundary.encodeFails = false; boundary.pause = null; boundary.release = null; boundary.readPause = null; boundary.sourceReads = 0; boundary.writes = 0; boundary.runtimeEntered = 0; vi.resetModules(); });

it.each(['replace', 'unmount', 'sibling'] as const)('withdraws pending native canvas demand on %s before rasterizing or writing, and paints current demand', async mode => {
    const { BackdropCanvas } = await import('./BackdropCanvas.native');
    const uri = 'file:///documents/atmosphere/cancel/full.image';
    boundary.fs!.files.set(uri, Array.from(source.rgba));
    const picture = { localId: 'cancel', kind: 'user' as const, createdAtMs: 0, size: source.rgba.length, data: uri };
    let release!: () => void;
    boundary.readPause = new Promise<void>(resolve => { release = resolve; });
    const failed = vi.fn();
    const canvas = (strength: number, id = 'primary') => React.createElement(BackdropCanvas, {
        source: picture, size: { width: 2, height: 2 }, dpr: 1,
        look: 'original', params: { strength }, adjust: { exposure: strength }, page: [245, 245, 245], theme: 'light', resettle: false,
        onError: failed, testID: id,
    });
    const screen = await renderScreen(canvas(0));
    const sibling = mode === 'sibling' ? await renderScreen(canvas(0, 'sibling')) : null;
    try {
        expect(boundary.sourceReads).toBe(1);
        expect(boundary.runtimeEntered).toBe(0);
        if (mode === 'unmount') await screen.unmount();
        else await screen.update(canvas(0.5));
        // A second supersession must not multiply obsolete native work.
        if (mode !== 'unmount') await screen.update(canvas(1));
        await act(async () => { release(); });
        expect(boundary.runtimeEntered).toBe(mode === 'unmount' ? 0 : mode === 'sibling' ? 2 : 1);
        expect(boundary.writes).toBe(mode === 'unmount' ? 0 : mode === 'sibling' ? 2 : 1);
        if (mode !== 'unmount') {
            const painted = screen.findAllByType('ExpoImage');
            expect(painted).toHaveLength(1);
            const saved = JSON.parse(Buffer.from(boundary.fs!.files.get(painted[0].props.source.uri)!).toString());
            expect(saved.rgba).toEqual(Array.from(renderBackdrop({ look: 'original', theme: 'light', page: job.page, params: { strength: 1 }, adjust: { exposure: 1 }, source }).rgba));
            expect(saved.rgba).not.toEqual(Array.from(source.rgba));
            // A promoted displayed lease stays alive across a pending replacement.
            boundary.readPause = new Promise<void>(resolve => { release = resolve; });
            await screen.update(canvas(0.75));
            expect(boundary.fs!.files.has(painted[0].props.source.uri)).toBe(true);
            await act(async () => { release(); });
        }
        if (sibling) expect(sibling.findAllByType('ExpoImage')).toHaveLength(1);
        expect(failed).not.toHaveBeenCalled();
    } finally {
        release();
        await screen.unmount();
        await sibling?.unmount();
    }
    expect([...boundary.fs!.files.keys()]).toEqual([uri]);
});

it('withdraws pending native wallpaper haze demand through the same cache', async () => {
    const { WallpaperHaze } = await import('./WallpaperHaze.native');
    const uri = 'file:///documents/atmosphere/haze-cancel/full.image';
    boundary.fs!.files.set(uri, Array.from(source.rgba));
    let release!: () => void;
    boundary.readPause = new Promise<void>(resolve => { release = resolve; });
    const screen = await renderScreen(React.createElement(WallpaperHaze, {
        source: { localId: 'haze-cancel', kind: 'user', createdAtMs: 0, size: source.rgba.length, data: uri },
        size: { width: 8, height: 8 }, job: { look: 'original', page: [245, 245, 245], theme: 'light' },
        focus: { x: 4, y: 4 }, haze: { layers: [], veil: null, ink: 'theme' },
    }));
    expect(boundary.sourceReads).toBe(1);
    await screen.unmount();
    await act(async () => { release(); });
    expect(boundary.runtimeEntered).toBe(0);
    expect(boundary.writes).toBe(0);
});

it('does not write a native render cancelled after worker scheduling', async () => {
    const { BackdropCanvas } = await import('./BackdropCanvas.native');
    boundary.pause = new Promise<void>(resolve => { boundary.release = resolve; });
    const screen = await renderScreen(React.createElement(BackdropCanvas, {
        source, size: { width: 2, height: 2 }, dpr: 1, look: 'original',
        page: [245, 245, 245], theme: 'light', resettle: false,
    }));
    expect(boundary.runtimeEntered).toBe(1);
    await screen.unmount();
    await act(async () => { boundary.release!(); });
    expect(boundary.writes).toBe(0);
    expect(boundary.fs!.files.size).toBe(0);
});

it('recognizes current native renders without rereading source bytes', async () => {
    const uri = 'file:///documents/atmosphere/read-cost/full.image';
    boundary.fs!.files.set(uri, Array.from(source.rgba));
    const picture = { ...request, source: { localId: 'read-cost', kind: 'user' as const, createdAtMs: 0, size: source.rgba.length, data: uri } };
    const first = await render(picture);
    expect(await render(picture)).toBe(first);
    expect(boundary.sourceReads).toBe(1);
});

it('shares canonical RGBA while demanded and retires its file after the final consumer', async () => {
    const { acquireNativeBackdrop } = await import('./renderBackdrop.native');
    const firstPane = acquireNativeBackdrop(request), secondPane = acquireNativeBackdrop(request);
    expect(firstPane.promise).toBe(secondPane.promise);
    const first = await firstPane.promise;
    const saved = JSON.parse(Buffer.from(boundary.fs!.files.get(first)!).toString());
    expect(saved).toEqual({ format: 'PNG', width: 2, height: 2, rgba: Array.from(renderBackdrop({ ...job, source }).rgba) });
    firstPane.release();
    expect(boundary.fs!.files.size).toBe(1);
    secondPane.release();
    expect(boundary.fs!.files.size).toBe(0);
    expect(await render(request)).not.toBe(first);
});

it('never caches an encoder failure and recovers on the next visit', async () => {
    const renderer = render;
    boundary.encodeFails = true;
    await expect(renderer(request)).rejects.toThrow('encoded as PNG');
    expect(boundary.fs!.files.size).toBe(0);
    boundary.encodeFails = false;
    expect(await renderer(request)).toMatch(/render-.*\.png$/);
});

it('retains simultaneous native configurations only until their actual consumers release them', async () => {
    const { acquireNativeBackdrop } = await import('./renderBackdrop.native');
    const first = acquireNativeBackdrop(request);
    const changed = acquireNativeBackdrop({ ...request, job: { ...request.job, params: { strength: 0.5 } } });
    const [oldUri, currentUri] = await Promise.all([first.promise, changed.promise]);
    expect(boundary.fs!.files.size).toBe(2);
    first.release();
    expect(boundary.fs!.files.has(oldUri)).toBe(false);
    expect(boundary.fs!.files.has(currentUri)).toBe(true);
    const revisited = acquireNativeBackdrop(request);
    expect(await revisited.promise).not.toBe(oldUri);
    changed.release(); revisited.release();
    expect(boundary.fs!.files.size).toBe(0);
});

it('keeps resettle pixels on the worker until release, without persisting frame files', async () => {
    const { createNativeBackdropTransition } = await import('./renderBackdrop.native');
    const w = 32, h = 24;
    const from = { rgba: new Uint8ClampedArray(w * h * 4).fill(40), w, h };
    const to = { rgba: new Uint8ClampedArray(w * h * 4).fill(190), w, h };
    const image = (rgba: Uint8ClampedArray) => Skia.Image.MakeImage({ width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }, Skia.Data.fromBytes(new Uint8Array(rgba)), w * 4)!;
    const input = { from: image(from.rgba), to: image(to.rgba), kind: 'resettle' as const, dpr: 2, page: [245, 245, 245] as const, theme: 'light' as const };
    const transition = await createNativeBackdropTransition(input);
    const reference = createAtmosphereTransition('resettle', { ...input, from, to });
    for (const t of [0, 0.3, 0.55, 1]) {
        const frame = await transition.frame(t);
        expect(Array.from(frame.readPixels()!)).toEqual(Array.from(reference.frame(t)));
        frame.dispose();
    }
    await transition.dispose();
    await expect(transition.frame(0.5)).rejects.toThrow('released');
    expect(boundary.fs!.files.size).toBe(0);
    input.from.dispose(); input.to.dispose();
});

it('delivers the ordered send mask as one encoded lattice', async () => {
    const { renderNativeOrderedMask } = await import('./renderBackdrop.native');
    const dissolve = orderedDissolve(24, 2);
    const uri = await renderNativeOrderedMask(32, dissolve.mask.cssHeight, dissolve.from, dissolve.to, 2);
    const mask = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString()) as { width: number; height: number; rgba: number[] };
    const rgba = new Uint8ClampedArray(mask.width * mask.height * 4).fill(255);
    orderedFade(rgba, mask.width, mask.height, dissolve.from, dissolve.to, 2);
    expect(mask.rgba).toEqual(Array.from(rgba));
    const alphaAt = (y: number) => mask.rgba.filter((_v, i) => i % 4 === 3 && Math.floor(i / 4 / mask.width) === y);
    expect(new Set(alphaAt(0))).toEqual(new Set([255]));
    expect(new Set(alphaAt(mask.height - 1))).toEqual(new Set([0]));
    const middle = new Set(alphaAt(Math.round(dissolve.from + dissolve.to)));
    expect(middle.has(0)).toBe(true);
    expect([...middle].some(alpha => alpha > 0)).toBe(true);
    expect(dissolve.travel % dissolve.mask.period).toBe(0);
    expect(boundary.fs!.files.size).toBe(0);
});

it('stores derived pixels beside the picture and refuses a late write after its removal', async () => {
    const uri = 'file:///documents/atmosphere/picture/full.image';
    boundary.fs!.files.set(uri, Array.from(source.rgba));
    const picture = { ...request, source: { localId: 'picture', kind: 'user' as const, createdAtMs: 0, size: source.rgba.length, data: uri } };
    const renderer = render;
    const saved = await renderer(picture);
    expect(saved).toMatch(/^file:\/\/\/documents\/atmosphere\/picture\/render-/);
    for (const lease of held) lease.release(); held.clear();
    boundary.pause = new Promise(resolve => { boundary.release = resolve; });
    const entered = boundary.runtimeEntered;
    const late = renderer(picture);
    // Remove the file only after the actual worker boundary has received its source bytes.
    await vi.waitFor(() => expect(boundary.runtimeEntered).toBeGreaterThan(entered));
    boundary.fs!.files.delete(uri);
    boundary.release!();
    await expect(late).rejects.toThrow('source was removed');
    expect(boundary.fs!.files.size).toBe(0);
});

it('keeps native display boxes on the same device-pixel grid as their backing pixels', async () => {
    const { BackdropCanvas } = await import('./BackdropCanvas.native');
    const raw = { rgba: new Uint8ClampedArray(4 * 5 * 4), w: 4, h: 5 };
    const backdrop = await renderScreen(React.createElement(BackdropCanvas, { source: raw, size: { width: 2.37, height: 2.61 },
        look: 'original', theme: 'light', page: [245, 245, 245], dpr: 2, testID: 'box' }));
    expect(backdrop.findByTestId('box')!.props.style.at(-1)).toEqual({ width: 2, height: 2.5 });
    expect(boundary.fs!.files.size).toBe(1);
    await backdrop.unmount();
    expect(boundary.fs!.files.size).toBe(0);
    const { PlanetCanvas } = await import('./PlanetCanvas.native');
    const planet = await renderScreen(React.createElement(PlanetCanvas, { dots: [], width: 2.37, height: 2.61, testID: 'box' }));
    expect(planet.findByTestId('box')!.props.style.at(-1)).toEqual({ width: 2, height: 2.5 });
    await planet.unmount();
});
