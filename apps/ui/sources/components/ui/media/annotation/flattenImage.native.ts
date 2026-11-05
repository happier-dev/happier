import { AlphaType, ColorType, ImageFormat, Skia, type SkImage } from '@shopify/react-native-skia';
import { stepNumbers, type ImageMarksDocumentV1, type ImageMarkSizeV1, type ImageRectV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { drawMarkGeometry } from './drawMarkSkia.native';
import { annotationImageDataSource, decodeAnnotationImage } from './decodeAnnotationImage.native';
import type { FlattenImageResult } from './flattenImage.types';
import { getMarkGeometry } from './markGeometry';
import { loadMarkTypeface, measureMarkText } from './markTextFont.native';
import { blurBlockEdge, pixelateSourcePixels } from './pixelate';
import type { ImageAnnotationSource } from './types';

export type { FlattenImageResult, FlattenAnnotatedImage } from './flattenImage.types';

function clippedRect(rect: ImageRectV1, source: ImageAnnotationSource): ImageRectV1 {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  return { x, y, width: Math.max(0, Math.min(source.width, Math.ceil(rect.x + rect.width)) - x), height: Math.max(0, Math.min(source.height, Math.ceil(rect.y + rect.height)) - y) };
}

async function decodeSource(source: ImageAnnotationSource): Promise<SkImage | null> {
  try {
    const input = annotationImageDataSource(source.uri);
    if (input === null) return null;
    const data = input instanceof Uint8Array ? Skia.Data.fromBytes(input) : await Skia.Data.fromURI(input);
    return decodeAnnotationImage(data, source);
  } catch {
    return null;
  }
}

/** The same block means as the web flatten: both hand the untouched pixels to `pixelateSourcePixels`. */
function blurredRegion(untouched: SkImage, rect: ImageRectV1, size: ImageMarkSizeV1, source: ImageAnnotationSource) {
  const region = clippedRect(rect, source);
  if (!region.width || !region.height) return null;
  const info = { width: region.width, height: region.height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
  const pixels = untouched.readPixels(region.x, region.y, info);
  // Null means only an empty clipped region. A nonempty blur must never fall
  // through to encoding the untouched source; the flatten owner reports failure.
  if (!(pixels instanceof Uint8Array)) throw new Error('Blur pixels unavailable');
  const raw = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length);
  const burned = pixelateSourcePixels(raw, region.width, region.height, blurBlockEdge(size, source.scale));
  const image = Skia.Image.MakeImage(info, Skia.Data.fromBytes(new Uint8Array(burned.buffer, burned.byteOffset, burned.length)), region.width * 4);
  if (!image) throw new Error('Blur raster unavailable');
  return { image, region };
}

/** Blur reads only the untouched raster; every vector is drawn afterwards in document order (D4). */
export async function flattenAnnotatedImage(source: ImageAnnotationSource, document: ImageMarksDocumentV1): Promise<FlattenImageResult> {
  const image = await decodeSource(source);
  if (!image) return { ok: false, reason: 'decodeFailed' };
  try {
    await loadMarkTypeface();
    const crop = clippedRect(document.crop ?? { x: 0, y: 0, width: source.width, height: source.height }, source);
    if (!crop.width || !crop.height) return { ok: false, reason: 'canvasUnavailable' };
    const original = Skia.Surface.Make(source.width, source.height);
    const output = Skia.Surface.Make(crop.width, crop.height);
    if (!original || !output) return { ok: false, reason: 'canvasUnavailable' };
    original.getCanvas().drawImageRect(
      image,
      Skia.XYWHRect(0, 0, image.width(), image.height()),
      Skia.XYWHRect(0, 0, source.width, source.height),
      Skia.Paint(),
    );
    const untouched = original.makeImageSnapshot();
    const canvas = output.getCanvas();
    canvas.drawImage(untouched, -crop.x, -crop.y);
    for (const mark of document.marks) {
      if (mark.kind !== 'blur') continue;
      const burned = blurredRegion(untouched, mark.rect, mark.size, source);
      if (burned) canvas.drawImage(burned.image, burned.region.x - crop.x, burned.region.y - crop.y);
    }
    canvas.translate(-crop.x, -crop.y);
    const numbers = stepNumbers(document);
    for (const mark of document.marks) {
      if (mark.kind !== 'blur') drawMarkGeometry(canvas, getMarkGeometry(mark, source.scale, numbers[mark.id], measureMarkText));
    }
    output.flush();
    return { ok: true, png: output.makeImageSnapshot().encodeToBytes(ImageFormat.PNG), width: crop.width, height: crop.height };
  } catch {
    return { ok: false, reason: 'canvasUnavailable' };
  }
}

export async function rasterizeBlurPreview(source: ImageAnnotationSource, rect: ImageRectV1, size: ImageMarkSizeV1): Promise<FlattenImageResult> {
  return flattenAnnotatedImage(source, { v: 1, image: { width: source.width, height: source.height, scale: source.scale }, crop: rect, marks: [{ kind: 'blur', id: 'preview', rect, size }] });
}
