import { AlphaType, BlendMode, ClipOp, ColorType, FilterMode, MipmapMode, Skia, TileMode, createPicture } from '@shopify/react-native-skia';
import type { SkCanvas, SkColor, SkImage, SkRSXform, SkRect } from '@shopify/react-native-skia';
import { glyphSmallDigitHeight, type GlyphFrame, type GlyphGrid } from '@happier-dev/brand/glyph-scene';

import { glyphAtlas } from './glyphAtlas.native';
import { glyphAtlasChars, glyphAtlasColumns, glyphPlanetChars, glyphRampHeight, packGlyphAtlas } from './glyphAtlasLayout';

function makeImage(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray) {
    const data = Skia.Data.fromBytes(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    const image = Skia.Image.MakeImage({ width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }, data, width * 4);
    data.dispose();
    return image;
}

export async function createNativeGlyphPainter(grid: GlyphGrid, dpr: number) {
    const [w, h] = grid.cell;
    const [regular, small, ramp] = await Promise.all([
        glyphAtlas({ w: w / dpr, h: h / dpr, chars: glyphAtlasChars }, dpr),
        glyphAtlas({ w: w * 0.75 / dpr, h: h * glyphSmallDigitHeight / dpr, chars: glyphAtlasChars }, dpr),
        glyphAtlas({ w: w / dpr, h: h * glyphRampHeight / dpr, chars: glyphPlanetChars }, dpr),
    ]);
    const pixels = packGlyphAtlas(grid, regular, small, ramp, dpr);
    const atlasImage = makeImage(pixels.width, pixels.height, pixels.pixels);
    if (!atlasImage) throw new Error('Could not create the glyph atlas');
    const atlas = atlasImage;
    const glyphRects = Array.from({ length: glyphAtlasColumns }, (_, index) => Skia.XYWHRect(index * w, 0, w, h));
    const source: SkRect[] = [], destination: SkRSXform[] = [], colours: SkColor[] = [];
    const transforms = [Skia.RSXform(1, 0, 0, 0)];
    const ink: SkColor[] = [new Float32Array(4)];
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    const path = Skia.Path.Make();
    let previousBody: GlyphFrame['body'];
    let previousMask: NonNullable<GlyphFrame['body']>['fadeMask'] = null;
    let bodyImage: SkImage | null = null, fadeImage: SkImage | null = null;
    const maskPaint = Skia.Paint();
    maskPaint.setBlendMode(BlendMode.DstIn);
    const fieldPaint = Skia.Paint();
    fieldPaint.setBlendMode(BlendMode.DstIn);
    let fieldImage: SkImage | null = null;
    let previousField: GlyphFrame['field'] = null, previousFieldRevision = -1;
    function reserveSpriteBatch(width: number, height: number) {
        const cols = Math.ceil(Math.round(width * dpr) / w);
        const rows = Math.ceil(Math.round(height * dpr) / h);
        const slots = cols * rows;
        for (let i = transforms.length; i < slots; i++) {
            transforms.push(Skia.RSXform(1, 0, 0, 0));
            ink.push(new Float32Array(4));
        }
    }
    function drawSprites(canvas: SkCanvas, sprites: GlyphFrame['sprites']) {
        // Skia takes equal-length JS arrays and copies their entries synchronously. Refill
        // the layout-sized batch in order when several layers share the same cells.
        const slots = transforms.length;
        for (let start = 0; start < sprites.glyph.length; start += slots) {
            const length = Math.min(slots, sprites.glyph.length - start);
            for (let slot = 0; slot < length; slot++) {
                const i = start + slot;
                const transform = transforms[slot];
                transform.set(1, 0, sprites.at[i * 2] - w / 2, sprites.at[i * 2 + 1] - h / 2);
                const colour = ink[slot];
                for (let channel = 0; channel < 4; channel++) colour[channel] = sprites.rgba[i * 4 + channel] / 255;
                destination[slot] = transform;
                colours[slot] = colour;
                source[slot] = glyphRects[sprites.glyph[i]];
            }
            source.length = destination.length = colours.length = length;
            canvas.drawAtlas(atlas, source, destination, paint, BlendMode.Modulate, colours);
        }
    }
    function draw(canvas: SkCanvas, frame: GlyphFrame) {
        const { body, field, sprites } = frame;
        if (field !== previousField || (field && field.revision !== previousFieldRevision)) {
            fieldImage?.dispose();
            fieldImage = field ? makeImage(field.mask.width, field.mask.height, field.mask.rgba) : null;
            previousField = field;
            previousFieldRevision = field?.revision ?? -1;
        }
        if (body !== previousBody) {
            bodyImage?.dispose();
            bodyImage = body ? makeImage(body.cols, body.rows, body.rgba) : null;
            previousBody = body;
        }
        const fadeMask = body?.fadeMask ?? null;
        if (fadeMask !== previousMask) {
            fadeImage?.dispose();
            fadeImage = fadeMask ? makeImage(fadeMask.width, fadeMask.height, fadeMask.rgba) : null;
            const shader = fadeImage?.makeShaderOptions(TileMode.Repeat, TileMode.Clamp, FilterMode.Nearest, MipmapMode.None);
            maskPaint.setShader(shader ?? null);
            shader?.dispose();
            previousMask = fadeMask;
        }
        const bounds = Skia.XYWHRect(0, 0, frame.width, frame.height);
        canvas.save();
        try {
            canvas.scale(1 / dpr, 1 / dpr);
            if (field && fieldImage) {
                const { mask, maskExtent } = field;
                canvas.saveLayer();
                drawSprites(canvas, field.sprites);
                canvas.drawImageRectOptions(fieldImage, Skia.XYWHRect(0, 0, mask.width, mask.height),
                    Skia.XYWHRect(0, 0, ...maskExtent), FilterMode.Linear, MipmapMode.None, fieldPaint);
                canvas.restore();
            }
            if (body && bodyImage) {
                if (fadeImage) canvas.saveLayer();
                canvas.save();
                path.reset();
                path.addCircle(body.disc.cx, body.disc.cy, body.disc.R);
                canvas.clipPath(path, ClipOp.Intersect, true);
                canvas.drawImageRectOptions(bodyImage, Skia.XYWHRect(0, 0, body.cols, body.rows),
                    Skia.XYWHRect(0, 0, body.cols * w, body.rows * h), FilterMode.Linear, MipmapMode.None, paint);
                canvas.restore();
                if (fadeImage) {
                    canvas.drawRect(bounds, maskPaint);
                    canvas.restore();
                }
            }
            drawSprites(canvas, sprites);
        } finally {
            canvas.restore();
        }
    }
    return {
        reserveSpriteBatch,
        draw,
        paint(frame: GlyphFrame) {
            return createPicture(canvas => draw(canvas, frame), { width: frame.width / dpr, height: frame.height / dpr });
        },
        dispose() {
            atlas.dispose();
            bodyImage?.dispose();
            fadeImage?.dispose();
            fieldImage?.dispose();
            fieldPaint.dispose();
            path.dispose();
            paint.dispose();
            maskPaint.dispose();
            for (const transform of transforms) transform.dispose();
        },
    };
}
