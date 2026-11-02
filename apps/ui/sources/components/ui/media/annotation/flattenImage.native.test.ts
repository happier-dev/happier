import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageMarksDocumentV1Schema } from '@happier-dev/protocol';

import { pixelateSourcePixels, blurBlockEdge } from './pixelate';
import type { SkiaMockBoundary } from '@/dev/testkit/mocks/skia';

/** Skia's native surfaces can't run here: this fake records what the flatten asks of them. */
const native = vi.hoisted(() => ({ boundary: null as SkiaMockBoundary | null }));

vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ localUri: 'file:///inter.ttf' }) } }));
vi.mock('@shopify/react-native-skia', async () => {
  const { createSkiaModuleMock } = await import('@/dev/testkit/mocks/skia');
  const mock = createSkiaModuleMock();
  native.boundary = mock.boundary;
  return mock.module;
});

const { flattenAnnotatedImage } = await import('./flattenImage.native');
const calls = native.boundary!;

const source = { uri: 'file:///picture.png', width: 4, height: 4, scale: 1 };

describe('flattenAnnotatedImage (native)', () => {
  beforeEach(() => {
    calls.log.length = 0;
    calls.burned = null;
    calls.decodable = true;
    calls.svgDecodable = false;
    calls.pixelsAvailable = true;
    calls.rasterAvailable = true;
    calls.encodes = 0;
  });

  it.each(['pixelsAvailable', 'rasterAvailable'] as const)('returns a typed failure without encoding any PNG when a nonempty blur fails at %s', async boundary => {
    calls[boundary] = false;
    const result = await flattenAnnotatedImage(source, ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 4, height: 4, scale: 1 }, marks: [
      { id: 'privacy', kind: 'blur', rect: { x: 0, y: 0, width: 4, height: 4 }, size: 'm' },
    ] }));
    expect(result).toEqual({ ok: false, reason: 'canvasUnavailable' });
    expect(calls.encodes).toBe(0);
  });

  it('does not mistake an empty clipped blur for a failed raster', async () => {
    calls.pixelsAvailable = false;
    expect(await flattenAnnotatedImage(source, ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 4, height: 4, scale: 1 }, marks: [
      { id: 'outside', kind: 'blur', rect: { x: 6, y: 6, width: 2, height: 2 }, size: 'm' },
    ] }))).toMatchObject({ ok: true });
    expect(calls.encodes).toBe(1);
  });

  it('burns blur from the untouched raster with the shared block means, before any vector, inside the crop', async () => {
    const result = await flattenAnnotatedImage(source, {
      v: 1,
      image: { width: 4, height: 4, scale: 1 },
      crop: { x: 1, y: 1, width: 3, height: 3 },
      marks: [
        { id: 'a', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 3, y: 3 }, color: 'red', size: 'm' },
        { id: 'b', kind: 'blur', rect: { x: 1, y: 1, width: 2, height: 2 }, size: 'm' },
      ],
    });
    expect(result).toEqual({ ok: true, png: new Uint8Array([137, 80]), width: 3, height: 3 });
    expect(calls.log.indexOf('burned 0,0')).toBeGreaterThan(calls.log.indexOf('untouched -1,-1'));
    expect(calls.log.indexOf('path')).toBeGreaterThan(calls.log.indexOf('burned 0,0'));
    const read = Uint8ClampedArray.from({ length: 16 }, (_, index) => (index * 37) % 255);
    expect(Array.from(calls.burned!)).toEqual(Array.from(pixelateSourcePixels(read, 2, 2, blurBlockEdge('m', 1))));
    const blockMean = [95, 132, 105, 78];
    expect(Array.from(calls.burned!)).toEqual([...blockMean, ...blockMean, ...blockMean, ...blockMean]);
    for (let pixel = 0; pixel < 16; pixel += 4) {
      expect(Array.from(calls.burned!.slice(pixel, pixel + 4))).not.toEqual(Array.from(read.slice(pixel, pixel + 4)));
    }
  });

  it('says the picture could not be decoded', async () => {
    calls.decodable = false;
    expect(await flattenAnnotatedImage(source, { v: 1, image: { width: 4, height: 4, scale: 1 }, marks: [] })).toEqual({ ok: false, reason: 'decodeFailed' });
  });

  it.each([
    'data:image/svg+xml;charset=utf-8,%3Csvg%3E%C3%A9%3C%2Fsvg%3E',
    'data:image/svg+xml;base64,PHN2Zz7DqTwvc3ZnPg==',
  ])('flattens admitted data URI bytes without the unsupported Android URL stream: %s', async uri => {
    calls.decodable = false;
    calls.svgDecodable = true;
    const result = await flattenAnnotatedImage({ ...source, uri }, {
      v: 1, image: { width: 4, height: 4, scale: 1 }, marks: [],
    });
    expect(result).toMatchObject({ ok: true, width: 4, height: 4 });
    expect(new TextDecoder().decode(calls.burned!)).toBe('<svg>é</svg>');
  });

  it('rasterizes an SVG image admitted by MediaStage before flattening its annotations', async () => {
    calls.decodable = false;
    calls.svgDecodable = true;
    const result = await flattenAnnotatedImage({ ...source, uri: 'file:///picture.svg' }, {
      v: 1, image: { width: 4, height: 4, scale: 1 }, marks: [
        { id: 'box', kind: 'rectangle', rect: { x: 1, y: 1, width: 2, height: 2 }, color: 'red', size: 'm' },
      ],
    });
    expect(result).toMatchObject({ ok: true, width: 4, height: 4 });
    expect(calls.log.indexOf('svg')).toBeGreaterThanOrEqual(0);
    // Native SVG text is omitted when Skia has no font manager.
    expect(calls.log).toContain('svg text');
    expect(calls.log.indexOf('path')).toBeGreaterThan(calls.log.indexOf('svg'));
  });
});
