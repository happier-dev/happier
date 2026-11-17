import { describe, expect, it } from 'vitest';
import { inspectPetAtlasRgbaPixelsV1 } from './atlasPixelInspection.js';
import { PET_ANIMATION_ROWS_V1 } from './constants.js';

describe('v2 atlas pixels', () => {
  it('accepts look cells without requiring a neutral cell and includes look poses in bounds', () => {
    const width = 1536;
    const height = 2288;
    const data = new Uint8Array(width * height * 4);
    const mark = (row: number, frame: number, x = 96) => {
      data[((row * 208 + 104) * width + frame * 192 + x) * 4 + 3] = 255;
    };
    for (const row of PET_ANIMATION_ROWS_V1) {
      for (let frame = 0; frame < row.frames; frame++) mark(row.row, frame);
    }
    for (let direction = 0; direction < 16; direction++) mark(9 + Math.floor(direction / 8), direction % 8, 120);
    const inspect = () => inspectPetAtlasRgbaPixelsV1({ data, width, height, channels: 4 });
    expect(inspect()).toMatchObject({
      hasVisibleUsedCells: true, hasTransparentUnusedCells: true,
      hasOpaqueBackground: false, hasNeutralLookCell: false,
      opaqueBounds: { x: 96, y: 104, width: 25, height: 1 },
    });
    mark(0, 6);
    expect(inspect()).toMatchObject({ hasNeutralLookCell: true, hasOpaqueBackground: false });
    mark(0, 7);
    expect(inspect()).toMatchObject({ hasTransparentUnusedCells: false, hasOpaqueBackground: true });
  });
});
