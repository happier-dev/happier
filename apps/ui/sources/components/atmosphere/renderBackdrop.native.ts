import { Directory, File, Paths } from 'expo-file-system';
import { AlphaType, BlendMode, ColorType, FilterMode, ImageFormat, MipmapMode, Skia, TileMode, type SkImage } from '@shopify/react-native-skia';
import type { AtmospherePixels, AtmosphereRgb, AtmosphereTheme, AtmosphereTransitionFrames, AtmosphereRippleOptions } from '@happier-dev/brand/atmosphere';
import { createWorkletRuntime, runOnRuntimeAsync, type WorkletRuntime } from 'react-native-worklets';
import { createAtmosphereWorkletCore } from './backdropWorkletCore.generated';
import { backdropRequestKey } from './backdropRenderRequest';
import { readPictureBase64 } from './pictureBytes.native';
import type { BackdropRenderRequest } from './backdropCanvas.types';
import { createBackdropRenderCache } from './backdropRenderCache';
import { randomUUID } from '@/platform/randomUUID';

let runtime: WorkletRuntime | undefined;
function createNativeRenderer(initial: BackdropRenderRequest) {
    let current = initial;
    const cache = createBackdropRenderCache((_key, signal) => renderNativeBackdrop(current, signal),
        uri => { const file = new File(uri); if (file.exists) file.delete(); });
    return { acquire(request: BackdropRenderRequest) { current = request; return cache.acquire(backdropRequestKey(request)); } };
}
const renders = new WeakMap<BackdropRenderRequest['source'], ReturnType<typeof createNativeRenderer>>();

/** Source identity comes from the byte owner; recognising a current render never reopens its file. */
export function acquireNativeBackdrop(request: BackdropRenderRequest) {
    let renderer = renders.get(request.source);
    if (!renderer) {
        renderer = createNativeRenderer(request);
        renders.set(request.source, renderer);
    }
    return renderer.acquire(request);
}
export type NativeBackdropRender = ReturnType<typeof acquireNativeBackdrop>;

declare global {
    /** Transient prepared pixel frames live only on the existing backdrop worker runtime. */
    var __happierAtmosphereTransitions: Map<number, AtmosphereTransitionFrames> | undefined;
}
let nextTransitionId = 0;

function backdropRuntime() {
    return runtime ??= createWorkletRuntime({ name: 'happier-atmosphere-backdrops' });
}

export function renderNativeWallpaperHaze(image: SkImage, input: Readonly<{
    width: number; height: number; x: number; y: number; dpr: number;
    layers: readonly Readonly<{ blur: number; rx: number; ry: number; solid: number }>[];
    /** The page colour over the picture in its own ellipse (`resolveWallpaperHaze`). */
    veil: Readonly<{ color: string; alpha: number; at: Readonly<{ x: number; y: number }>; rx: number; ry: number; solid: number }> | null;
}>): Promise<SkImage> {
    const api = Skia, dstIn = BlendMode.DstIn, clamp = TileMode.Clamp, decal = TileMode.Decal;
    return runOnRuntimeAsync(backdropRuntime(), (source: SkImage, options: typeof input) => {
        'worklet';
        const width = Math.max(1, Math.round(options.width * options.dpr)), height = Math.max(1, Math.round(options.height * options.dpr));
        const surface = api.Surface.Make(width, height);
        if (!surface) throw new Error('Atmosphere haze surface is unavailable');
        try {
            const canvas = surface.getCanvas();
            const rect = api.XYWHRect(0, 0, width, height);
            for (const layer of options.layers) {
                const paint = api.Paint(), mask = api.Paint();
                const blur = api.ImageFilter.MakeBlur(layer.blur * options.dpr, layer.blur * options.dpr, decal);
                const matrix = api.Matrix([layer.rx * width, 0, options.x * options.dpr, 0, layer.ry * height, options.y * options.dpr, 0, 0, 1]);
                const shader = api.Shader.MakeRadialGradient({ x: 0, y: 0 }, 1, [api.Color('#000'), api.Color('#000'), api.Color('transparent')], [0, layer.solid, 1], clamp, matrix);
                try {
                    canvas.saveLayer();
                    paint.setImageFilter(blur);
                    canvas.drawImageRect(source, api.XYWHRect(0, 0, source.width(), source.height()), rect, paint);
                    mask.setShader(shader); mask.setBlendMode(dstIn); canvas.drawRect(rect, mask);
                    canvas.restore();
                } finally { paint.dispose(); mask.dispose(); blur.dispose(); matrix.dispose(); shader.dispose(); }
            }
            const veil = options.veil;
            if (veil) {
                const paint = api.Paint(), mask = api.Paint();
                const matrix = api.Matrix([veil.rx * width, 0, veil.at.x * width, 0, veil.ry * height, veil.at.y * height, 0, 0, 1]);
                const shader = api.Shader.MakeRadialGradient({ x: 0, y: 0 }, 1, [api.Color('#000'), api.Color('#000'), api.Color('transparent')], [0, veil.solid, 1], clamp, matrix);
                try {
                    canvas.saveLayer();
                    paint.setColor(api.Color(veil.color));
                    paint.setAlphaf(veil.alpha);
                    canvas.drawRect(rect, paint);
                    mask.setShader(shader); mask.setBlendMode(dstIn); canvas.drawRect(rect, mask);
                    canvas.restore();
                } finally { paint.dispose(); mask.dispose(); matrix.dispose(); shader.dispose(); }
            }
            surface.flush();
            return surface.makeImageSnapshot();
        } finally { surface.dispose(); }
    }, image, input);
}

/**
 * A rendered picture's pixels at a small size, for the atmosphere's tone: the same measurement the web reads
 * from its canvas. The picture is smooth at that scale; reading it whole would copy megabytes per render.
 */
/** The longest side the tone reads at; the measurement samples a few thousand points of it. */
export const NATIVE_TONE_SIDE = 256;

export function readNativePicturePixels(image: SkImage, maxSide: number): Promise<AtmospherePixels> {
    const api = Skia, colorType = ColorType.RGBA_8888, alphaType = AlphaType.Unpremul;
    const linear = FilterMode.Linear, mipmap = MipmapMode.None;
    return runOnRuntimeAsync(backdropRuntime(), (source: SkImage, side: number) => {
        'worklet';
        const scale = Math.min(1, side / Math.max(source.width(), source.height()));
        const w = Math.max(1, Math.round(source.width() * scale)), h = Math.max(1, Math.round(source.height() * scale));
        const surface = api.Surface.Make(w, h);
        if (!surface) throw new Error('Atmosphere tone surface is unavailable');
        try {
            surface.getCanvas().drawImageRectOptions(source, api.XYWHRect(0, 0, source.width(), source.height()), api.XYWHRect(0, 0, w, h), linear, mipmap);
            surface.flush();
            const snapshot = surface.makeImageSnapshot();
            try {
                const bytes = snapshot.readPixels(0, 0, { width: w, height: h, colorType, alphaType });
                if (!(bytes instanceof Uint8Array)) throw new Error('Atmosphere tone pixels are unavailable');
                return { rgba: new Uint8ClampedArray(bytes), w, h };
            } finally { snapshot.dispose(); }
        } finally { surface.dispose(); }
    }, image, maxSide);
}

/** One static ordered mask; its subsequent lattice-step travel is native-driven, with no per-frame pixels. */
export function renderNativeOrderedMask(width: number, height: number, from: number, to: number, dpr: number): Promise<string> {
    const api = Skia, colorType = ColorType.RGBA_8888, alphaType = AlphaType.Unpremul, png = ImageFormat.PNG;
    return runOnRuntimeAsync(backdropRuntime(), (w: number, h: number, y0: number, y1: number, ratio: number) => {
        'worklet';
        const pixels = new Uint8ClampedArray(w * h * 4).fill(255);
        createAtmosphereWorkletCore().orderedFade(pixels, w, h, y0, y1, ratio);
        const data = api.Data.fromBytes(new Uint8Array(pixels.buffer));
        try {
            const image = api.Image.MakeImage({ width: w, height: h, colorType, alphaType }, data, w * 4);
            if (!image) throw new Error('Atmosphere ordered mask is unavailable');
            try {
                const bytes = image.encodeToBase64(png);
                if (!bytes) throw new Error('Atmosphere ordered mask could not be encoded');
                return `data:image/png;base64,${bytes}`;
            } finally { image.dispose(); }
        } finally { data.dispose(); }
    }, Math.max(1, Math.round(width * dpr)), Math.max(1, Math.ceil(height * dpr)), from, to, dpr);
}

/** No PNG encoding or file per animation frame: Skia image handles are Worklets HostObjects. */
export async function renderNativeRipple(progress: number, options: AtmosphereRippleOptions): Promise<SkImage> {
    const api = Skia, colorType = ColorType.RGBA_8888, alphaType = AlphaType.Unpremul;
    return runOnRuntimeAsync(backdropRuntime(), (t: number, input: AtmosphereRippleOptions) => {
        'worklet';
        const output = createAtmosphereWorkletCore().atmosphereRipple(t, input);
        const data = api.Data.fromBytes(new Uint8Array(output.rgba.buffer, output.rgba.byteOffset, output.rgba.byteLength));
        try {
            const image = api.Image.MakeImage({ width: output.w, height: output.h, colorType, alphaType }, data, output.w * 4);
            if (!image) throw new Error('Atmosphere ripple image is unavailable');
            return image;
        } finally { data.dispose(); }
    }, progress, options);
}

/** Prepare the brand's blue-noise map and source/target pixels once, on the canonical native worker. */
export async function createNativeBackdropTransition(input: Readonly<{
    from: SkImage; to: SkImage; kind: 'resettle' | 'crossfade'; dpr: number; page: AtmosphereRgb; theme: AtmosphereTheme;
}>) {
    const id = ++nextTransitionId;
    const worker = backdropRuntime();
    const api = Skia, colorType = ColorType.RGBA_8888, alphaType = AlphaType.Unpremul;
    await runOnRuntimeAsync(worker, (key: number, options: typeof input) => {
        'worklet';
        const read = (image: SkImage) => {
            const w = image.width(), h = image.height();
            const bytes = image.readPixels(0, 0, { width: w, height: h, colorType, alphaType });
            if (!(bytes instanceof Uint8Array)) throw new Error('Atmosphere transition pixels are unavailable');
            return { rgba: new Uint8ClampedArray(bytes), w, h };
        };
        globalThis.__happierAtmosphereTransitions ??= new Map();
        globalThis.__happierAtmosphereTransitions.set(key, createAtmosphereWorkletCore().createAtmosphereTransition(options.kind,
            { from: read(options.from), to: read(options.to), dpr: options.dpr, page: options.page, theme: options.theme }));
    }, id, input);
    return {
        frame: (progress: number): Promise<SkImage> => runOnRuntimeAsync(worker, (key: number, t: number) => {
            'worklet';
            const frames = globalThis.__happierAtmosphereTransitions?.get(key);
            if (!frames) throw new Error('Atmosphere transition was released');
            const rgba = frames.frame(t);
            const data = api.Data.fromBytes(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
            try {
                const image = api.Image.MakeImage({ width: frames.w, height: frames.h, colorType, alphaType }, data, frames.w * 4);
                if (!image) throw new Error('Atmosphere transition image is unavailable');
                return image;
            } finally { data.dispose(); }
        }, id, progress),
        dispose: (): Promise<void> => runOnRuntimeAsync(worker, (key: number) => { 'worklet'; globalThis.__happierAtmosphereTransitions?.delete(key); }, id),
    };
}

/** Decoding, crop, canonical JS effects and PNG encoding all run on the existing worker-runtime mechanism. */
async function renderNativeBackdrop(request: BackdropRenderRequest, signal: AbortSignal): Promise<string> {
    const source = request.source;
    const encoded = 'data' in source ? await readPictureBase64(source.data) : null;
    if (signal.aborted) throw new Error('Atmosphere render cancelled');
    const directory = 'data' in source && typeof source.data === 'string' && !source.data.startsWith('data:')
        ? new File(source.data).parentDirectory
        : new Directory(Paths.document, 'atmosphere', 'renders');
    const file = new File(directory, `render-${randomUUID()}.png`);
    const worker = backdropRuntime();
    const api = Skia;
    const rgbaType = ColorType.RGBA_8888, unpremul = AlphaType.Unpremul;
    const linear = FilterMode.Linear, mipmap = MipmapMode.None, png = ImageFormat.PNG;
    const result: unknown = await runOnRuntimeAsync(worker, (input: BackdropRenderRequest, bytes: string | null) => {
        'worklet';
        const core = createAtmosphereWorkletCore();
        let pixels;
        // The grade's horizon row in the cropped band (lab `compute`).
        const sourceGrade = input.job.grade;
        let grade: { from: number; to: number; hz: number } | null | undefined = sourceGrade && sourceGrade.hz !== undefined
            ? { from: sourceGrade.from, to: sourceGrade.to, hz: sourceGrade.hz } : null;
        const bandGrade = (crop: ReturnType<typeof core.cropOf>) => {
            grade = core.backdropBandGrade(sourceGrade, crop, input.horizon);
        };
        if (bytes === null && 'rgba' in input.source && input.source.w === input.width && input.source.h === input.height) {
            pixels = input.source;
            bandGrade(core.cropOf({ w: pixels.w, h: pixels.h }, input.job.span?.W ?? input.width, input.job.span?.H ?? input.height, input.focus, input.horizon));
        } else {
            const raw = 'rgba' in input.source ? input.source : null;
            const data = raw ? api.Data.fromBytes(new Uint8Array(raw.rgba.buffer, raw.rgba.byteOffset, raw.rgba.byteLength)) : api.Data.fromBase64(bytes!);
            try {
                const image = raw ? api.Image.MakeImage({ width: raw.w, height: raw.h, colorType: rgbaType, alphaType: unpremul }, data, raw.w * 4) : api.Image.MakeImageFromEncoded(data);
                if (!image) throw new Error('Atmosphere picture could not be decoded');
                try {
                    const crop = core.cropOf({ w: image.width(), h: image.height() }, input.job.span?.W ?? input.width, input.job.span?.H ?? input.height, input.focus, input.horizon);
                    bandGrade(crop);
                    const surface = api.Surface.Make(input.width, input.height);
                    if (!surface) throw new Error('Atmosphere raster surface is unavailable');
                    try {
                        surface.getCanvas().drawImageRectOptions(image,
                            api.XYWHRect(crop.sx + (input.job.span?.x ?? 0) / crop.s, crop.sy + (input.job.span?.y ?? 0) / crop.s, input.width / crop.s, input.height / crop.s),
                            api.XYWHRect(0, 0, input.width, input.height), linear, mipmap);
                        surface.flush();
                        const sampled = surface.makeImageSnapshot();
                        try {
                            const rgba = sampled.readPixels(0, 0, { width: input.width, height: input.height, colorType: rgbaType, alphaType: unpremul });
                            if (!rgba || !(rgba instanceof Uint8Array)) throw new Error('Atmosphere source pixels are unavailable');
                            pixels = { rgba: new Uint8ClampedArray(rgba), w: input.width, h: input.height };
                        } finally { sampled.dispose(); }
                    } finally { surface.dispose(); }
                } finally { image.dispose(); }
            } finally { data.dispose(); }
        }
        const output = core.renderBackdrop({ ...input.job, grade, source: pixels });
        const data = api.Data.fromBytes(new Uint8Array(output.rgba.buffer, output.rgba.byteOffset, output.rgba.byteLength));
        try {
            const image = api.Image.MakeImage({ width: output.w, height: output.h, colorType: rgbaType, alphaType: unpremul }, data, output.w * 4);
            if (!image) throw new Error('Atmosphere result image is unavailable');
            try { return image.encodeToBase64(png); } finally { image.dispose(); }
        } finally { data.dispose(); }
    }, request, encoded);
    if (signal.aborted) throw new Error('Atmosphere render cancelled');
    if (typeof result !== 'string') throw new Error('Atmosphere result could not be encoded as PNG');
    // A removed picture must not be resurrected by a late render.
    if ('data' in source && typeof source.data === 'string' && !source.data.startsWith('data:') && !new File(source.data).exists) throw new Error('Atmosphere source was removed');
    directory.create({ intermediates: true, idempotent: true });
    file.write(result, { encoding: 'base64' });
    return file.uri;
}
