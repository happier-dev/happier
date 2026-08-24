import { describe, expect, it } from 'vitest';

import {
  HAPPIER_MAX_RENDERABLE_IMAGE_BYTES,
  HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS,
  materializeHappierRenderableImage,
  readHappierPngPixelCount,
  readHappierRenderableImageSource,
} from './renderableImage.js';
import { createAdmittedBrandPngFixture } from '../../surfaceFixture.testSupport.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** A PNG prefix that declares `width x height` and pads to `byteLength`. */
function pngBytes(width: number, height: number, byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(byteLength, 45));
  bytes.set(PNG_SIGNATURE, 0);
  // IHDR chunk length, then its type.
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 24; index < bytes.length; index += 1) bytes[index] = index % 251;
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], bytes.length - 12);
  return bytes;
}

describe('renderable image admission', () => {
  it('encodes admitted PNG bytes to the canonical base64 data URI', () => {
    const bytes = createAdmittedBrandPngFixture({ admit: false });
    const admission = materializeHappierRenderableImage(bytes);

    // Node's own encoder is the independent oracle for the hand-rolled one.
    const expected = Buffer.from(bytes).toString('base64');
    expect(admission.admitted && admission.source.uri).toBe(`data:image/png;base64,${expected}`);
  });

  it('refuses a truncated IHDR prefix instead of handing undecodable bytes to the platform', () => {
    const complete = createAdmittedBrandPngFixture({ admit: false });
    const truncated = complete.subarray(0, 24);

    expect(readHappierPngPixelCount(truncated)).toBeNull();
    expect(materializeHappierRenderableImage(truncated)).toMatchObject({
      admitted: false,
      refusal: { code: 'plugin_renderable_image_not_png' },
    });
  });

  it('encodes every byte-length remainder identically to the platform encoder', () => {
    for (const length of [45, 46, 47, 48, 49, 50, 1_021, 1_022, 1_023]) {
      const bytes = pngBytes(8, 8, length);
      const admission = materializeHappierRenderableImage(bytes);
      expect(admission.admitted && admission.source.uri)
        .toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    }
  });

  it('refuses bytes whose declared canvas exceeds the decode ceiling', () => {
    // 8 KiB of bytes, but a canvas that would decode to gigabytes of RGBA.
    const side = Math.ceil(Math.sqrt(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS)) + 1;
    const bytes = pngBytes(side, side, 8 * 1024);

    expect(side * side).toBeGreaterThan(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS);
    expect(bytes.byteLength).toBeLessThan(HAPPIER_MAX_RENDERABLE_IMAGE_BYTES);
    expect(materializeHappierRenderableImage(bytes)).toEqual({
      admitted: false,
      refusal: {
        code: 'plugin_renderable_image_too_many_pixels',
        severity: 'warning',
        message: expect.any(String),
        details: {
          byteLength: bytes.byteLength,
          pixels: side * side,
          limit: HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS,
        },
      },
    });
    expect(readHappierRenderableImageSource(bytes)).toBeUndefined();
  });

  it('admits a canvas exactly at the decode ceiling', () => {
    const side = Math.sqrt(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS);
    expect(Number.isInteger(side)).toBe(true);

    expect(materializeHappierRenderableImage(pngBytes(side, side, 1_024)).admitted).toBe(true);
  });

  it('refuses bytes past the encoded-size ceiling', () => {
    const bytes = pngBytes(8, 8, HAPPIER_MAX_RENDERABLE_IMAGE_BYTES + 1);

    // The refusal must name the bound that decided it and the value it measured:
    // an author whose image never appears has no other way to learn which one.
    expect(materializeHappierRenderableImage(bytes)).toEqual({
      admitted: false,
      refusal: {
        code: 'plugin_renderable_image_too_many_bytes',
        severity: 'warning',
        message: expect.any(String),
        details: {
          byteLength: HAPPIER_MAX_RENDERABLE_IMAGE_BYTES + 1,
          limit: HAPPIER_MAX_RENDERABLE_IMAGE_BYTES,
        },
      },
    });
    expect(
      materializeHappierRenderableImage(pngBytes(8, 8, HAPPIER_MAX_RENDERABLE_IMAGE_BYTES)).admitted,
    ).toBe(true);
  });

  it('refuses bytes that are not a PNG, whatever a caller declared them to be', () => {
    const notPng = new Uint8Array(256).fill(0x42);

    expect(readHappierPngPixelCount(notPng)).toBeNull();
    expect(materializeHappierRenderableImage(notPng)).toMatchObject({
      admitted: false,
      refusal: { code: 'plugin_renderable_image_not_png', details: { byteLength: 256 } },
    });
  });

  it('distinguishes every refusal so an author learns which bound rejected their image', () => {
    // One assertion per bound, because the whole point of the refusal is that
    // "nothing rendered" cannot tell these four cases apart.
    expect(materializeHappierRenderableImage(new Uint8Array(0)))
      .toMatchObject({ admitted: false, refusal: { code: 'plugin_renderable_image_empty' } });
    expect(materializeHappierRenderableImage(new Uint8Array(64).fill(0x42)))
      .toMatchObject({ admitted: false, refusal: { code: 'plugin_renderable_image_not_png' } });
    // A byte-ceiling refusal must win over the pixel read: at 16 MiB the encode
    // is the cost being refused, and parsing further would not change it.
    expect(materializeHappierRenderableImage(pngBytes(8, 8, HAPPIER_MAX_RENDERABLE_IMAGE_BYTES + 1)))
      .toMatchObject({ admitted: false, refusal: { code: 'plugin_renderable_image_too_many_bytes' } });
    expect(materializeHappierRenderableImage(pngBytes(4_096, 4_096, 1_024)))
      .toMatchObject({ admitted: false, refusal: { code: 'plugin_renderable_image_too_many_pixels' } });
  });

  it('refuses a PNG signature whose first chunk is not IHDR', () => {
    const bytes = pngBytes(8, 8, 64);
    // Rename the first chunk to `sRGB`; its width/height offsets no longer mean anything.
    bytes.set([0x73, 0x52, 0x47, 0x42], 12);

    expect(readHappierPngPixelCount(bytes)).toBeNull();
    expect(materializeHappierRenderableImage(bytes))
      .toMatchObject({ admitted: false, refusal: { code: 'plugin_renderable_image_not_png' } });
  });

  it('records one source per admitted byte identity and reads it back without deriving', () => {
    const bytes = pngBytes(32, 32, 512);
    const admission = materializeHappierRenderableImage(bytes);

    expect(admission.admitted).toBe(true);
    const source = admission.admitted ? admission.source : null;
    expect(readHappierRenderableImageSource(bytes)).toBe(source);
    const again = materializeHappierRenderableImage(bytes);
    expect(again.admitted && again.source).toBe(source);
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
