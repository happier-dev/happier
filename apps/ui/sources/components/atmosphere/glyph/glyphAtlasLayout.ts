import { glyphDotRadii, type GlyphGrid } from '@happier-dev/brand/glyph-scene';
import type { AtmosphereGlyphAtlas } from '@happier-dev/brand/atmosphere';

export const glyphAtlasChars = '0123456789';
export const glyphAtlasColumns = 21 + glyphDotRadii.length;

/** White coverage tiles. Painters tint and composite them with the frame's sprite colours. */
export function packGlyphAtlas(grid: GlyphGrid, regular: AtmosphereGlyphAtlas, small: AtmosphereGlyphAtlas, dpr: number) {
    const [cellW, cellH] = grid.cell;
    const width = cellW * glyphAtlasColumns;
    const pixels = new Uint8Array(width * cellH * 4);
    for (let tile = 0; tile < glyphAtlasColumns; tile++) {
        const source = tile < 10 ? regular : small;
        const left = Math.floor((cellW - source.cw) / 2);
        const top = Math.floor((cellH - source.ch) / 2);
        for (let y = 0; y < cellH; y++) {
            for (let x = 0; x < cellW; x++) {
                let alpha = 255;
                if (tile < 20) {
                    const sx = x - left, sy = y - top;
                    alpha = sx >= 0 && sy >= 0 && sx < source.cw && sy < source.ch
                        ? source.masks[((tile % 10) * source.ch + sy) * source.cw + sx] : 0;
                } else if (tile > 20) {
                    const radius = glyphDotRadii[tile - 21] * dpr;
                    alpha = Math.round(255 * Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x + 0.5 - cellW / 2, y + 0.5 - cellH / 2))));
                }
                pixels.fill(255, (y * width + tile * cellW + x) * 4, (y * width + tile * cellW + x) * 4 + 3);
                pixels[(y * width + tile * cellW + x) * 4 + 3] = alpha;
            }
        }
    }
    return { width, height: cellH, pixels };
}
