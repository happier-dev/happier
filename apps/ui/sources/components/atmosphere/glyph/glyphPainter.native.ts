import { AlphaType, BlendMode, ClipOp, ColorType, FilterMode, MipmapMode, Skia, TileMode, createPicture } from '@shopify/react-native-skia';
import type { SkColor, SkImage, SkRSXform, SkRect } from '@shopify/react-native-skia';
import type { GlyphFrame, GlyphGrid } from '@happier-dev/brand/glyph-scene';

import { glyphAtlas } from './glyphAtlas.native';
import { glyphAtlasChars, glyphAtlasColumns, packGlyphAtlas } from './glyphAtlasLayout';

function makeImage(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray) {
    const data = Skia.Data.fromBytes(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    const image = Skia.Image.MakeImage({ width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }, data, width * 4);
    data.dispose();
    return image;
}

export async function createNativeGlyphPainter(grid: GlyphGrid, dpr: number) {
    const [w, h] = grid.cell;
    const [regular, small] = await Promise.all([
        glyphAtlas({ w: w / dpr, h: h / dpr, chars: glyphAtlasChars }, dpr),
        glyphAtlas({ w: w * 0.75 / dpr, h: h * 0.625 / dpr, chars: glyphAtlasChars }, dpr),
    ]);
    const pixels = packGlyphAtlas(grid, regular, small, dpr);
    const atlas = makeImage(pixels.width, pixels.height, pixels.pixels);
    if (!atlas) throw new Error('Could not create the glyph atlas');
    const glyphRects = Array.from({ length: glyphAtlasColumns }, (_, index) => Skia.XYWHRect(index * w, 0, w, h));
    const source: SkRect[] = [], destination: SkRSXform[] = [], colours: SkColor[] = [];
    const transforms: SkRSXform[] = [], ink: SkColor[] = [];
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    const path = Skia.Path.Make();
    let previousBody: GlyphFrame['body'];
    let previousMask: NonNullable<GlyphFrame['body']>['fadeMask'];
    let bodyImage: SkImage | null = null, fadeImage: SkImage | null = null;
    const maskPaint = Skia.Paint();
    maskPaint.setBlendMode(BlendMode.DstIn);
    const fieldPaint = Skia.Paint();
    fieldPaint.setBlendMode(BlendMode.DstIn);
    let fieldImage: SkImage | null = null;
    let previousField: GlyphFrame['field'] = null, previousFieldRevision = -1;
    function fillAtlasBatch(sprites: GlyphFrame['sprites']) {
        for (let i = 0; i < sprites.glyph.length; i++) {
            const transform = transforms[i] ?? (transforms[i] = Skia.RSXform(1, 0, 0, 0));
            transform.set(1, 0, sprites.at[i * 2] - w / 2, sprites.at[i * 2 + 1] - h / 2);
            const colour = ink[i] ?? (ink[i] = new Float32Array(4));
            for (let channel = 0; channel < 4; channel++) colour[channel] = sprites.rgba[i * 4 + channel] / 255;
            destination[i] = transform;
            colours[i] = colour;
            source[i] = glyphRects[sprites.glyph[i]];
        }
        source.length = destination.length = colours.length = sprites.glyph.length;
    }
    return {
        paint(frame: GlyphFrame) {
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
            if (body?.fadeMask !== previousMask) {
                fadeImage?.dispose();
                fadeImage = body?.fadeMask ? makeImage(body.fadeMask.width, body.fadeMask.height, body.fadeMask.rgba) : null;
                const shader = fadeImage?.makeShaderOptions(TileMode.Repeat, TileMode.Clamp, FilterMode.Nearest, MipmapMode.None);
                maskPaint.setShader(shader ?? null);
                shader?.dispose();
                previousMask = body?.fadeMask;
            }
            const bounds = Skia.XYWHRect(0, 0, frame.width, frame.height);
            return createPicture(canvas => {
                canvas.scale(1 / dpr, 1 / dpr);
                if (field && fieldImage) {
                    const { mask, maskExtent } = field;
                    canvas.saveLayer();
                    fillAtlasBatch(field.sprites);
                    canvas.drawAtlas(atlas, source, destination, paint, BlendMode.Modulate, colours);
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
                if (sprites.glyph.length) {
                    fillAtlasBatch(sprites);
                    canvas.drawAtlas(atlas, source, destination, paint, BlendMode.Modulate, colours);
                }
            }, { width: frame.width / dpr, height: frame.height / dpr });
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
