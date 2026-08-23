import { describe, expect, it } from 'vitest';

import {
  HAPPIER_MAX_RENDERABLE_IMAGE_BYTES,
  HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS,
  materializeHappierRenderableImage,
  readHappierPngPixelCount,
  readHappierRenderableImageSource,
} from './renderableImage.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** A PNG prefix that declares `width x height` and pads to `byteLength`. */
function pngBytes(width: number, height: number, byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(byteLength, 24));
  bytes.set(PNG_SIGNATURE, 0);
  // IHDR chunk length, then its type.
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 24; index < bytes.length; index += 1) bytes[index] = index % 251;
  return bytes;
}

describe('renderable image admission', () => {
  it('encodes admitted PNG bytes to the canonical base64 data URI', () => {
    const bytes = pngBytes(16, 16, 128);
    const source = materializeHappierRenderableImage(bytes);

    // Node's own encoder is the independent oracle for the hand-rolled one.
    const expected = Buffer.from(bytes).toString('base64');
    expect(source?.uri).toBe(`data:image/png;base64,${expected}`);
  });

  it('encodes every byte-length remainder identically to the platform encoder', () => {
    for (const length of [24, 25, 26, 27, 28, 29, 1_021, 1_022, 1_023]) {
      const bytes = pngBytes(8, 8, length);
      expect(materializeHappierRenderableImage(bytes)?.uri)
        .toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    }
  });

  it('refuses bytes whose declared canvas exceeds the decode ceiling', () => {
    // 8 KiB of bytes, but a canvas that would decode to gigabytes of RGBA.
    const side = Math.ceil(Math.sqrt(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS)) + 1;
    const bytes = pngBytes(side, side, 8 * 1024);

    expect(side * side).toBeGreaterThan(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS);
    expect(bytes.byteLength).toBeLessThan(HAPPIER_MAX_RENDERABLE_IMAGE_BYTES);
    expect(materializeHappierRenderableImage(bytes)).toBeNull();
    expect(readHappierRenderableImageSource(bytes)).toBeUndefined();
  });

  it('admits a canvas exactly at the decode ceiling', () => {
    const side = Math.sqrt(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS);
    expect(Number.isInteger(side)).toBe(true);

    expect(materializeHappierRenderableImage(pngBytes(side, side, 1_024))).not.toBeNull();
  });

  it('refuses bytes past the encoded-size ceiling', () => {
    const bytes = pngBytes(8, 8, HAPPIER_MAX_RENDERABLE_IMAGE_BYTES + 1);

    expect(materializeHappierRenderableImage(bytes)).toBeNull();
    expect(materializeHappierRenderableImage(pngBytes(8, 8, HAPPIER_MAX_RENDERABLE_IMAGE_BYTES))).not.toBeNull();
  });

  it('refuses bytes that are not a PNG, whatever a caller declared them to be', () => {
    const notPng = new Uint8Array(256).fill(0x42);

    expect(readHappierPngPixelCount(notPng)).toBeNull();
    expect(materializeHappierRenderableImage(notPng)).toBeNull();
  });

  it('refuses a PNG signature whose first chunk is not IHDR', () => {
    const bytes = pngBytes(8, 8, 64);
    // Rename the first chunk to `sRGB`; its width/height offsets no longer mean anything.
    bytes.set([0x73, 0x52, 0x47, 0x42], 12);

    expect(readHappierPngPixelCount(bytes)).toBeNull();
    expect(materializeHappierRenderableImage(bytes)).toBeNull();
  });

  it('records one source per admitted byte identity and reads it back without deriving', () => {
    const bytes = pngBytes(32, 32, 512);
    const admitted = materializeHappierRenderableImage(bytes);

    expect(admitted).not.toBeNull();
    expect(readHappierRenderableImageSource(bytes)).toBe(admitted);
    expect(materializeHappierRenderableImage(bytes)).toBe(admitted);
  });

  it('never derives from an unadmitted byte identity', () => {
    let indexedReads = 0;
    const bytes = pngBytes(32, 32, 512);
    const watched = new Proxy(bytes, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/u.test(key)) indexedReads += 1;
        return Reflect.get(target, key, target) as unknown;
      },
    }) as Uint8Array;

    expect(readHappierRenderableImageSource(watched)).toBeUndefined();
    expect(indexedReads).toBe(0);
  });
});
