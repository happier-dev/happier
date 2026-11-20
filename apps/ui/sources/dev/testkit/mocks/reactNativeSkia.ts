/** Skia renderer/native handles cannot be loaded in the Node test process. */
export function createReactNativeSkiaMock() {
    return {
        Canvas: 'Canvas', Circle: 'Circle', Image: 'SkiaImage', Rect: 'Rect', Group: 'Group',
        LinearGradient: 'LinearGradient', RadialGradient: 'RadialGradient', Path: 'Path',
        RoundedRect: 'RoundedRect', DiffRect: 'DiffRect', Picture: 'Picture', ColorMatrix: 'ColorMatrix',
        // A recorded picture is opaque native state; the stub records nothing.
        createPicture: () => ({ dispose: () => undefined }),
        useFont: () => null,
        useTypeface: () => null,
        AlphaType: { Unpremul: 'unpremul' },
        ColorType: { RGBA_8888: 'rgba' },
        Skia: {
            Data: { fromBytes: (bytes: Uint8Array) => ({ bytes }) },
            Image: {
                MakeImage: () => ({ dispose: () => undefined }),
            },
            Path: { Make: () => ({ addRect: () => undefined, addRRect: () => undefined }) },
            XYWHRect: () => ({}), RRectXY: () => ({}),
        },
        FilterMode: { Nearest: 'nearest', Linear: 'linear' },
        MipmapMode: { None: 'none', Nearest: 'nearest', Linear: 'linear' },
        rect: () => ({}), rrect: () => ({}),
        useImage: (source: unknown) => source == null ? null : `skia-image:${String(source)}`,
        vec: (x: number, y: number) => ({ x, y }),
    };
}

/** Executes the real glyph paint callback against opaque native picture, image and transform handles. */
export function createReactNativeSkiaGlyphMock(observe: {
    onImage?: (info: { width: number; height: number }, bytes: Uint8Array) => void;
    onPicture?: () => void;
} = {}) {
    const boundary = createReactNativeSkiaMock();
    const dispose = () => undefined;
    const canvas = {
        save() {}, saveLayer() {}, restore() {}, scale() {}, clipPath() {},
        drawAtlas() {}, drawImageRectOptions() {}, drawRect() {}, drawCircle() {},
    };
    return {
        ...boundary,
        BlendMode: { Modulate: 1, DstIn: 2, SrcOver: 3 }, ClipOp: { Intersect: 1 }, TileMode: { Repeat: 1, Clamp: 0 },
        Skia: {
            ...boundary.Skia,
            Data: { fromBytes: (bytes: Uint8Array) => ({ bytes, dispose }) },
            Image: { MakeImage: (info: { width: number; height: number }, { bytes }: { bytes: Uint8Array }) => {
                observe.onImage?.(info, bytes);
                return { dispose, makeShaderOptions: () => ({ dispose }) };
            } },
            Color: (value: string) => value,
            Paint: () => ({ dispose, setAntiAlias() {}, setBlendMode() {}, setShader() {}, setColor() {}, setAlphaf() {} }),
            Path: { Make: () => ({ dispose, reset() {}, addCircle() {} }) },
            RSXform: () => ({ dispose, set() {} }),
        },
        createPicture: (draw: (value: typeof canvas) => void) => {
            draw(canvas);
            observe.onPicture?.();
            return { dispose };
        },
    };
}

/** Font rasterization runs in a native worker. Preserve the atlas dimensions at that boundary. */
export async function createGlyphAtlasRasterMock({ w, h, chars }: { w: number; h: number; chars: string }, dpr: number) {
    const cw = Math.max(3, Math.round(w * dpr));
    const ch = Math.max(5, Math.round(h * dpr));
    return { cw, ch, chars, masks: new Uint8Array(cw * ch * chars.length) };
}
