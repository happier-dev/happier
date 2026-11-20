import { glyphDotRadii, glyphLatticeRadius, glyphLatticeTile, glyphRampChars, glyphRampFirstTile, type GlyphGrid } from '@happier-dev/brand/glyph-scene';
import type { AtmosphereGlyphAtlas } from '@happier-dev/brand/atmosphere';

export const glyphAtlasChars = '0123456789';
/** Tiles: digits, small digits, a block, the field's dots, the planet's light ramp, its digits and its lattice dot (Brand's vocabulary). */
export const glyphAtlasColumns = glyphLatticeTile + 1;
/** The planet's ramp and digits are set smaller than the other digits, inside their cell (the first-open lab's glyph planet). */
export const glyphRampHeight = 0.72 / 0.94;
/** The planet atlas's characters, in tile order from `glyphRampFirstTile`: Brand's light ramp, then the digits. */
export const glyphPlanetChars = `${glyphRampChars}0123456789`;

/** White coverage tiles. Painters tint and composite them with the frame's sprite colours. */
export function packGlyphAtlas(grid: GlyphGrid, regular: AtmosphereGlyphAtlas, small: AtmosphereGlyphAtlas, ramp: AtmosphereGlyphAtlas, dpr: number) {
    const [cellW, cellH] = grid.cell;
    const width = cellW * glyphAtlasColumns;
    const pixels = new Uint8Array(width * cellH * 4);
    for (let tile = 0; tile < glyphAtlasColumns; tile++) {
        const isRamp = tile >= glyphRampFirstTile && tile < glyphLatticeTile;
        const source = isRamp ? ramp : tile < 10 ? regular : small;
        const index = isRamp ? tile - glyphRampFirstTile : tile % 10;
        const left = Math.floor((cellW - source.cw) / 2);
        const top = Math.floor((cellH - source.ch) / 2);
        for (let y = 0; y < cellH; y++) {
            for (let x = 0; x < cellW; x++) {
                let alpha = 255;
                if (tile < 20 || isRamp) {
                    const sx = x - left, sy = y - top;
                    alpha = sx >= 0 && sy >= 0 && sx < source.cw && sy < source.ch
                        ? source.masks[(index * source.ch + sy) * source.cw + sx] : 0;
                } else if (tile > 20) {
                    const radius = (tile === glyphLatticeTile ? glyphLatticeRadius : glyphDotRadii[tile - 21]) * dpr;
                    alpha = Math.round(255 * Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x + 0.5 - cellW / 2, y + 0.5 - cellH / 2))));
                }
                pixels.fill(255, (y * width + tile * cellW + x) * 4, (y * width + tile * cellW + x) * 4 + 3);
                pixels[(y * width + tile * cellW + x) * 4 + 3] = alpha;
            }
        }
    }
    return { width, height: cellH, pixels };
}
