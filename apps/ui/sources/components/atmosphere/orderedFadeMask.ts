import { orderedFade } from '@happier-dev/brand/atmosphere';

/**
 * The brand's ordered fade as an alpha mask: an opaque strip run through `orderedFade`, so a drawing
 * layer can apply berthd's lattice to anything it composites. The lattice repeats every 8 cells across,
 * so the strip is one period wide and tiles horizontally. `height`, `from` and `to` are css px.
 */
export function orderedFadeMask(
  height: number,
  from: number,
  to: number,
  dpr: number,
  /** A canvas's exact backing-store rows, when the caller already snapped them. */
  pixelHeight = Math.max(1, Math.ceil(height * dpr)),
) {
  const cell = Math.max(1, Math.round(2 * dpr));
  const width = 8 * cell;
  const rgba = new Uint8ClampedArray(width * pixelHeight * 4).fill(255);
  orderedFade(rgba, width, pixelHeight, from, to, dpr);
  return {
    rgba,
    width,
    height: pixelHeight,
    cssWidth: width / dpr,
    cssHeight: pixelHeight / dpr,
    period: width / dpr,
  };
}
