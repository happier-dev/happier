import type { ImageMarkSizeV1 } from '@happier-dev/protocol';
import { MARK_STROKE, MARK_TEXT_SIZE } from './markGeometry';

/** Smallest block covers one body-text line; larger tool sizes scale the same content unit. */
export function blurBlockEdge(size: ImageMarkSizeV1, scale: number): number {
  return Math.ceil(MARK_TEXT_SIZE.m * 1.25 * scale * MARK_STROKE[size] / MARK_STROKE.s);
}

/** The caller supplies untouched source pixels, including for overlapping blur marks. */
export function pixelateSourcePixels(source: Uint8ClampedArray, width: number, height: number, blockEdge: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  for (let top = 0; top < height; top += blockEdge) {
    for (let left = 0; left < width; left += blockEdge) {
      const right = Math.min(width, left + blockEdge), bottom = Math.min(height, top + blockEdge);
      const mean = [0, 0, 0, 0];
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 4; channel++) mean[channel]! += source[offset + channel]!;
      }
      const count = (right - left) * (bottom - top);
      for (let channel = 0; channel < 4; channel++) mean[channel] = Math.round(mean[channel]! / count);
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) output.set(mean, (y * width + x) * 4);
    }
  }
  return output;
}
