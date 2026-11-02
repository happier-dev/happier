/** Native Skia is the system boundary: keep geometry, pixelation and React consumers real. */
export type RecordedSkiaDraw = Readonly<{
    kind: 'image' | 'path' | 'text';
    tag?: string;
    path?: string;
    fillType?: number;
    x?: number;
    y?: number;
}>;
export type RecordedSkiaPicture = Readonly<{ draws: RecordedSkiaDraw[] }>;

export function createSkiaModuleMock() {
    const boundary = {
        log: [] as string[], burned: null as Uint8Array | null,
        decodable: true, svgDecodable: false, pixelsAvailable: true, rasterAvailable: true,
        encodes: 0, rasterizations: 0, sourceReads: [] as string[],
        pictures: [] as RecordedSkiaPicture[],
    };
    const paint = () => ({ setAntiAlias() {}, setAlphaf() {}, setBlendMode() {}, setStyle() {}, setColor() {},
        setStrokeWidth() {}, setStrokeCap() {}, setStrokeJoin() {} });
    const image = (tag: string, width = 4, height = 4) => ({
        tag, width: () => width, height: () => height,
        readPixels: (x: number, y: number, info: { width: number; height: number }) => {
            boundary.log.push(`read ${x},${y} ${info.width}x${info.height}`);
            return boundary.pixelsAvailable
                ? Uint8Array.from({ length: info.width * info.height * 4 }, (_, index) => (index * 37) % 255)
                : null;
        },
        encodeToBytes: () => { boundary.encodes++; return new Uint8Array([137, 80]); },
    });
    type TestImage = ReturnType<typeof image>;
    const source = image('source');
    const path = (d = '') => ({ d, fillType: 0, setIsVolatile() {}, setFillType(value: number) { this.fillType = value; }, rewind() {}, moveTo() {}, quadTo() {} });
    const canvas = (draws: RecordedSkiaDraw[] = []) => ({
        scale() {}, save() {}, restore() {}, drawCircle() {}, drawRect() {},
        drawSvg: (svg: { hasFonts: boolean }) => {
            boundary.log.push('svg');
            if (svg.hasFonts) boundary.log.push('svg text');
        },
        translate: (x: number, y: number) => boundary.log.push(`translate ${x},${y}`),
        drawImageRect: (raster: TestImage) => {
            boundary.log.push(raster.tag);
            draws.push({ kind: 'image', tag: raster.tag });
        },
        drawImage: (raster: TestImage, x: number, y: number) => {
            boundary.log.push(`${raster.tag} ${x},${y}`);
            draws.push({ kind: 'image', tag: raster.tag, x, y });
        },
        drawPath: (shape: ReturnType<typeof path>) => {
            boundary.log.push('path');
            draws.push({ kind: 'path', path: shape.d, fillType: shape.fillType });
        },
        drawText: () => { boundary.log.push('text'); draws.push({ kind: 'text' }); },
    });
    const module = {
        Canvas: 'SkiaCanvas', Group: 'SkiaGroup', Path: 'SkiaPath', Picture: 'SkiaPicture',
        useImage: () => source,
        useRawData: (uri: string, factory: (data: { uri: string }) => TestImage | null) => factory({ uri }),
        notifyChange() {},
        createPicture: (draw: (value: ReturnType<typeof canvas>) => void) => {
            const picture: RecordedSkiaPicture = { draws: [] };
            draw(canvas(picture.draws));
            boundary.pictures.push(picture);
            return picture;
        },
        AlphaType: { Unpremul: 'unpremul' }, ColorType: { RGBA_8888: 'rgba' }, ImageFormat: { PNG: 'png' },
        BlendMode: { Multiply: 'multiply' }, PaintStyle: { Fill: 0, Stroke: 1 }, StrokeCap: { Round: 1 }, StrokeJoin: { Round: 1 },
        Skia: {
            SVG: { MakeFromData: (_data: unknown, fontMgr?: unknown) => boundary.svgDecodable ? { hasFonts: Boolean(fontMgr) } : null },
            FontMgr: { System: () => ({}) },
            Data: {
                fromURI: async (uri: string) => {
                    boundary.sourceReads.push(uri);
                    // Android's URL stream boundary cannot open the data: scheme.
                    if (uri.startsWith('data:')) throw new Error('Unsupported URI scheme');
                    return { uri };
                },
                fromBytes: (bytes: Uint8Array) => { boundary.burned = bytes; return { bytes }; },
            },
            Image: {
                MakeImageFromEncoded: (data: { uri?: string }) => boundary.decodable
                    ? data.uri ? source : image('preview') : null,
                MakeImage: (info: { width: number; height: number }) => {
                    boundary.rasterizations++;
                    return boundary.rasterAvailable ? image('burned', info.width, info.height) : null;
                },
            },
            Surface: { Make: (width: number, height: number) => {
                const drawing = canvas();
                return { getCanvas: () => drawing, makeImageSnapshot: () => image('untouched', width, height), flush() {} };
            } },
            Typeface: { MakeFreeTypeFaceFromData: () => ({}) },
            Font: () => ({ getTextWidth: () => 10, dispose() {} }),
            Paint: paint, Color: (value: string) => value,
            XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
            Path: { Make: () => path(), MakeFromSVGString: (d: string) => path(d) },
        },
    };
    return { boundary, module };
}

export type SkiaMockBoundary = ReturnType<typeof createSkiaModuleMock>['boundary'];
