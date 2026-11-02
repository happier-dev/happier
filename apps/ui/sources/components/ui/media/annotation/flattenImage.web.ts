import { stepNumbers, type ImageMarksDocumentV1, type ImageRectV1, type ImageMarkSizeV1 } from '@happier-dev/protocol';
import type { ImageAnnotationSource } from './types';
import type { FlattenImageResult } from './flattenImage.types';
import { getMarkGeometry } from './markGeometry';
import { markTextFont } from './markTextFont';
import { blurBlockEdge, pixelateSourcePixels } from './pixelate';

type Raster = OffscreenCanvas | HTMLCanvasElement;
function createRaster(width: number, height: number): Raster | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}
function context2d(canvas: Raster) {
  return canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}
async function decodeSource(source: ImageAnnotationSource): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error('decodeFailed'));
    image.src = source.uri;
  });
  return image;
}
async function encodePng(canvas: Raster): Promise<Uint8Array | null> {
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
function clippedRect(rect: ImageRectV1, source: ImageAnnotationSource): ImageRectV1 {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  return { x, y, width: Math.max(0, Math.min(source.width, Math.ceil(rect.x + rect.width)) - x), height: Math.max(0, Math.min(source.height, Math.ceil(rect.y + rect.height)) - y) };
}

function burnBlur(untouched: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, output: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, rect: ImageRectV1, size: ImageMarkSizeV1, source: ImageAnnotationSource, crop: ImageRectV1): void {
  const region = clippedRect(rect, source);
  if (!region.width || !region.height) return;
  const pixels = untouched.getImageData(region.x, region.y, region.width, region.height);
  pixels.data.set(pixelateSourcePixels(pixels.data, region.width, region.height, blurBlockEdge(size, source.scale)));
  // putImageData ignores transforms, and the canvas clips to the cropped output.
  output.putImageData(pixels, region.x - crop.x, region.y - crop.y);
}

/** Blur reads only the untouched raster; every vector is drawn afterwards in document order. */
export async function flattenAnnotatedImage(source: ImageAnnotationSource, document: ImageMarksDocumentV1): Promise<FlattenImageResult> {
  let image: HTMLImageElement;
  try { image = await decodeSource(source); }
  catch { return { ok: false, reason: 'decodeFailed' }; }
  try {
    const crop = clippedRect(document.crop ?? { x: 0, y: 0, width: source.width, height: source.height }, source);
    if (!crop.width || !crop.height) return { ok: false, reason: 'canvasUnavailable' };
    const original = createRaster(source.width, source.height), output = createRaster(crop.width, crop.height);
    if (!original || !output) return { ok: false, reason: 'canvasUnavailable' };
    const untouched = context2d(original), context = context2d(output);
    if (!untouched || !context) return { ok: false, reason: 'canvasUnavailable' };
    untouched.drawImage(image, 0, 0, source.width, source.height);
    context.drawImage(original, -crop.x, -crop.y);
    for (const mark of document.marks) if (mark.kind === 'blur') burnBlur(untouched, context, mark.rect, mark.size, source, crop);
    context.translate(-crop.x, -crop.y);
    const numbers = stepNumbers(document);
    for (const mark of document.marks) {
      if (mark.kind === 'blur') continue;
      const geometry = getMarkGeometry(mark, source.scale, numbers[mark.id], (text, fontSize) => {
        context.font = markTextFont(fontSize);
        return context.measureText(text).width;
      });
      for (const path of geometry.paths) {
        context.save();
        context.globalAlpha = path.opacity ?? 1;
        context.globalCompositeOperation = path.blendMode ?? 'source-over';
        const shape = new Path2D(path.d);
        if (path.fill) { context.fillStyle = path.fill; context.fill(shape); }
        if (path.stroke) {
          context.strokeStyle = path.stroke; context.lineWidth = path.strokeWidth ?? 1;
          context.lineCap = 'round'; context.lineJoin = 'round'; context.stroke(shape);
        }
        context.restore();
      }
      for (const text of geometry.texts) {
        context.font = markTextFont(text.fontSize);
        context.fillStyle = text.color; context.textAlign = text.align; context.textBaseline = 'alphabetic';
        context.fillText(text.text, text.x, text.y);
      }
    }
    const png = await encodePng(output);
    return png ? { ok: true, png, width: crop.width, height: crop.height } : { ok: false, reason: 'canvasUnavailable' };
  } catch { return { ok: false, reason: 'canvasUnavailable' }; }
}

export async function rasterizeBlurPreview(source: ImageAnnotationSource, rect: ImageRectV1, size: ImageMarkSizeV1): Promise<FlattenImageResult> {
  return flattenAnnotatedImage(source, { v: 1, image: { width: source.width, height: source.height, scale: source.scale }, crop: rect, marks: [{ kind: 'blur', id: 'preview', rect, size }] });
}
export type { FlattenImageResult } from './flattenImage.types';
