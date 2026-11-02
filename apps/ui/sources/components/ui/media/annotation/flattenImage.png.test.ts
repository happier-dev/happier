import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flattenAnnotatedImage as flattenWeb } from './flattenImage.web';

// Exercise the native Skia API with its real WASM raster backend, and browser Canvas
// with the same engine's Canvas2D adapter. Only the OS/DOM and asset boundaries vary.
const requireSkia = createRequire(import.meta.url);
const { LoadSkiaWeb }: typeof import('@shopify/react-native-skia/lib/typescript/src/web/LoadSkiaWeb') = requireSkia('@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb');
const { JsiSkApi }: typeof import('@shopify/react-native-skia/lib/typescript/src/skia/web/JsiSkia') = requireSkia('@shopify/react-native-skia/lib/commonjs/skia/web/JsiSkia');
const skiaTypes: typeof import('@shopify/react-native-skia/lib/typescript/src/skia/types') = requireSkia('@shopify/react-native-skia/lib/commonjs/skia/types');
type CanvasKit = Parameters<typeof JsiSkApi>[0];
let canvasKit: CanvasKit;
let skia: ReturnType<typeof JsiSkApi>;
let png: Uint8Array;
let uri: string;
let flattenNative: typeof flattenWeb;

vi.mock('@shopify/react-native-skia', () => ({
    ...skiaTypes,
    Skia: skia,
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({
    localUri: `data:font/ttf;base64,${readFileSync(new URL('../../../../assets/fonts/Inter-SemiBold.ttf', import.meta.url)).toString('base64')}`,
}) } }));

beforeAll(async () => {
    await LoadSkiaWeb({ locateFile: file => requireSkia.resolve(`canvaskit-wasm/bin/full/${file}`) });
    canvasKit = globalThis.CanvasKit;
    skia = JsiSkApi(canvasKit);
    const surface = skia.Surface.Make(3, 3)!;
    const canvas = surface.getCanvas();
    canvas.clear(skia.Color('transparent'));
    const paint = skia.Paint();
    paint.setColor(skia.Color('red'));
    canvas.drawRect(skia.XYWHRect(1, 1, 1, 1), paint);
    surface.flush();
    png = surface.makeImageSnapshot().encodeToBytes();
    uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    flattenNative = (await import('./flattenImage.native')).flattenAnnotatedImage;
});
afterEach(() => vi.unstubAllGlobals());

function installCanvasBoundary() {
    const canvases = new WeakMap<object, () => string>();
    vi.stubGlobal('OffscreenCanvas', class {
        constructor(width: number, height: number) {
            const canvas = canvasKit.MakeCanvas(width, height);
            canvases.set(canvas, () => canvas.toDataURL());
            const context = canvas.getContext('2d')!;
            const drawImage = context.drawImage;
            // The WASM Canvas2D adapter accepts decoded images; browsers also accept
            // another canvas, whose current pixels are snapshotted by drawImage.
            Object.defineProperty(context, 'drawImage', { value: (image: object, ...args: number[]) => {
                const snapshot = canvases.get(image)?.();
                const input = snapshot ? canvas.decodeImage(Buffer.from(snapshot.split(',')[1]!, 'base64')) : image;
                Reflect.apply(drawImage, context, [input, ...args]);
            } });
            return Object.assign(canvas, {
                convertToBlob: async () => new Blob([Buffer.from(canvas.toDataURL().split(',')[1]!, 'base64')], { type: 'image/png' }),
            });
        }
    });
    vi.stubGlobal('Image', class {
        constructor() {
            const image = Object.assign(canvasKit.MakeCanvas(1, 1).decodeImage(png), { onload: null as (() => void) | null });
            Object.defineProperty(image, 'src', { set: () => queueMicrotask(() => image.onload?.()) });
            return image;
        }
    });
}

describe('transparent window PNGs through sending flatten', () => {
    it.each(['web', 'native'] as const)('keeps four corner alphas zero and window content opaque (%s)', async platform => {
        if (platform === 'web') installCanvasBoundary();
        const flattenAnnotatedImage = platform === 'web' ? flattenWeb : flattenNative;
        const result = await flattenAnnotatedImage({ uri, width: 3, height: 3, scale: 1 }, {
            v: 1, image: { width: 3, height: 3, scale: 1 }, marks: [],
        });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(Array.from(result.png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const image = skia.Image.MakeImageFromEncoded(skia.Data.fromBytes(result.png))!;
        const pixels = image.readPixels(0, 0, { width: 3, height: 3,
            colorType: skiaTypes.ColorType.RGBA_8888, alphaType: skiaTypes.AlphaType.Unpremul })!;
        for (const pixel of [0, 2, 6, 8]) expect(pixels[pixel * 4 + 3]).toBe(0);
        expect(pixels[4 * 4 + 3]).toBe(255);
    });
});
