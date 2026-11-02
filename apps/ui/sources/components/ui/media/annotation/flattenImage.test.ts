import { afterEach, describe, expect, it, vi } from 'vitest';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import { flattenAnnotatedImage, rasterizeBlurPreview } from './flattenImage.web';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import { getMarkGeometry } from './markGeometry';

afterEach(() => vi.unstubAllGlobals());
const source = { uri: 'blob:fixture', width: 6, height: 4, scale: 1 };
const pixels = new Uint8ClampedArray(Array.from({ length: 6 * 4 }, (_, i) => [i * 7, i * 3, i * 5, 255]).flat());
const rect = { x: 1, y: 1, width: 4, height: 2 };
const document: ImageMarksDocumentV1 = { v: 1, image: { width: 6, height: 4, scale: 1 }, marks: [{ id: 'private', kind: 'blur', rect, size: 's' }] };

describe('flatten image across the Canvas platform boundary', () => {
  it('exports the highlighter path with the same multiply and opacity as the preview geometry', async () => {
    const boundary = installImageAnnotationCanvasBoundary({ ...source, pixels });
    const mark = { id: 'highlight', kind: 'highlighter' as const, points: [{ x: 0, y: 1 }, { x: 5, y: 3 }], color: 'yellow' as const, size: 's' as const };
    await flattenAnnotatedImage(source, { ...document, marks: [mark] });
    const path = getMarkGeometry(mark).paths[0]!;
    expect(boundary.draws).toEqual([{ kind: 'stroke', d: path.d, blendMode: path.blendMode, opacity: path.opacity }]);
  });
  it('burns untouched block means only inside the blur and previews the same pixels', async () => {
    const boundary = installImageAnnotationCanvasBoundary({ ...source, pixels });
    const before = pixels.slice();
    expect(await flattenAnnotatedImage(source, document)).toMatchObject({ ok: true, width: 6, height: 4 });
    const expectedMean = [81, 35, 58, 255];
    const output = boundary.outputs[0]!;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
      const offset = (y * 6 + x) * 4;
      expect(Array.from(output.slice(offset, offset + 4))).toEqual(x >= 1 && x < 5 && y >= 1 && y < 3 ? expectedMean : Array.from(pixels.slice(offset, offset + 4)));
      if (x >= 1 && x < 5 && y >= 1 && y < 3) expect(output.slice(offset, offset + 4)).not.toEqual(pixels.slice(offset, offset + 4));
    }
    expect(pixels).toEqual(before);
    expect(await rasterizeBlurPreview(source, rect, 's')).toMatchObject({ ok: true, width: 4, height: 2 });
    expect(Array.from(boundary.outputs[1]!)).toEqual(Array.from({ length: 8 }, () => expectedMean).flat());
    expect(boundary.encodeCount()).toBe(2);
  });
  it('composites all blur before arrow geometry even when document z-order puts blur last', async () => {
    const arrowSource = { ...source, width: 40, height: 30 };
    const boundary = installImageAnnotationCanvasBoundary({ ...arrowSource, pixels: new Uint8ClampedArray(40 * 30 * 4) });
    expect(await flattenAnnotatedImage(arrowSource, { ...document, image: { width: 40, height: 30, scale: 1 }, marks: [
      { id: 'short', kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 5, y: 3 }, color: 'red', size: 's' },
      { id: 'long', kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 35, y: 3 }, color: 'red', size: 's' }, ...document.marks,
    ] })).toMatchObject({ ok: true });
    expect(boundary.events.indexOf('burnBlur')).toBeLessThan(boundary.events.indexOf('vectorFill'));
    expect(boundary.events.indexOf('burnBlur')).toBeLessThan(boundary.events.indexOf('vectorStroke'));
    expect(boundary.encodeCount()).toBe(1);
  });
  it('settles decode and canvas failures as typed results without encoding', async () => {
    for (const [failure, reason] of [['decodeFailed', 'decodeFailed'], ['canvasUnavailable', 'canvasUnavailable']] as const) {
      const boundary = installImageAnnotationCanvasBoundary({ ...source, pixels, [failure]: true });
      expect(await flattenAnnotatedImage(source, document)).toEqual({ ok: false, reason });
      expect(boundary.encodeCount()).toBe(0);
    }
  });
});
